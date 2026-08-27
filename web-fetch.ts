import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAllOptions } from "node:dns";
import http from "node:http";
import https from "node:https";

import { createBrotliDecompress, createGunzip, createInflate, createInflateRaw } from "node:zlib";
import type { IncomingMessage } from "node:http";
import type { Transform } from "node:stream";
import {
  checkUrlAccess,
  githubRawContentUrl,
  githubRepoRawReadmeUrl,
  githubRepoReadmeApiUrl,
  isPublicIp,
  MAX_SIGNAL_TIMEOUT_MS,
  normalizeUrlScheme,
  type WebsitePolicy,
} from "./web-access.ts";
import { collapseWhitespace, decodeHtmlEntities, feedHtml, htmlToMarkdown } from "./html-to-md.ts";
import type { AttrDict } from "./html-to-md.ts";
import { INVALID_CHARREFS } from "./entities.ts";
import { getCached, isFresh, setCached, staleNotice } from "./cache.ts";
import { extractPdfText } from "./pdf.ts";
import { randomUserAgent } from "./user-agents.ts";

const MAX_FETCH_BYTES = 512 * 1024;
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
const META_VALUE_MAX_CHARS = 300;
const MAX_PDF_FETCH_BYTES = 10 * 1024 * 1024;
const MAX_REQUESTS = 5;
export const DEFAULT_FETCH_TIMEOUT_MS = 60_000;
export { loadDefaultFetchMaxChars, loadDefaultFetchTimeoutMs, loadDefaultFetchSettings } from "./settings.ts";

const UTF32_LE_BOM = Buffer.from([0xff, 0xfe, 0x00, 0x00]);
const UTF32_BE_BOM = Buffer.from([0x00, 0x00, 0xfe, 0xff]);
const UTF16_LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16_BE_BOM = Buffer.from([0xfe, 0xff]);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const BINARY_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f-\x9f\ufffd]/g;
const MIN_BINARY_CHARS = 16;
const BINARY_CHAR_DIVISOR = 8;
const PDF_MAGIC = "%PDF-";
const BINARY_MAGICS = [
  Buffer.from("%PDF-"),
  Buffer.from("PK\x03\x04"),
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.from("GIF87a"),
  Buffer.from("GIF89a"),
  Buffer.from([0x1f, 0x8b]),
  Buffer.from("BZh"),
  Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
  Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
];

const BINARY_APPLICATION_SUBTYPES = new Set([
  "epub+zip",
  "gzip",
  "java-archive",
  "pdf",
  "vnd.apple.installer+xml",
  "wasm",
  "x-7z-compressed",
  "x-bzip2",
  "x-gzip",
  "x-rar-compressed",
  "x-tar",
  "x-xz",
  "zip",
  "zstd",
]);

const HTML_LEADING_TAGS = [
  "html",
  "head",
  "body",
  "title",
  "meta",
  "link",
  "script",
  "style",
  "article",
  "section",
  "main",
  "header",
  "footer",
  "nav",
  "aside",
  "figure",
  "form",
  "ul",
  "ol",
  "dl",
  "pre",
  "blockquote",
];

const HTML_LEADING_RE = new RegExp(
  `^<(?:!doctype\\s+html|/?(?:${HTML_LEADING_TAGS.join("|")})\\b)`,
);
const HTML_DOCUMENT_RE = /^<(?:!doctype\s+html\b|\/?(?:html|head|body)\b)/;

const MIN_SINGLE_BYTE_ASCII_RATIO = 3 / 4;
const ASCII_TEXT_BYTES = new Set<number>([
  ...Array.from({ length: 0x7f - 0x20 }, (_, i) => i + 0x20),
  0x09,
  0x0a,
  0x0d,
  0x1b,
]);

export class FetchCancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

export class FetchTimeoutError extends Error {
  constructor() {
    super("timed out");
  }
}
const FETCH_CANCELLED_MESSAGE = "Failed to fetch URL: cancelled.";
const FETCH_TIMEOUT_MESSAGE = "Failed to fetch URL: timed out.";
const TRUNCATED_BODY_SUFFIX = "... (page truncated at the download limit)";
const TRUNCATED_BODY_NOTICE = "\n\n" + TRUNCATED_BODY_SUFFIX;

function fetchErrorMessage(err: unknown): string {
  if (err instanceof FetchCancelledError) return FETCH_CANCELLED_MESSAGE;
  if (err instanceof FetchTimeoutError) return FETCH_TIMEOUT_MESSAGE;
  const message = err instanceof Error ? err.message : String(err);
  if (message === "cancelled") return FETCH_CANCELLED_MESSAGE;
  if (message === "timed out") return FETCH_TIMEOUT_MESSAGE;
  return `Failed to fetch URL: ${message}`;
}

function emptyResult(error: string, contentType = ""): RawFetchResult {
  return { error, body: "", contentType };
}

function statusErrorResult(status: number): RawFetchResult {
  const reason = http.STATUS_CODES[status] ?? "";
  return emptyResult(`Failed to fetch URL: HTTP ${status}${reason ? ` ${reason}` : ""}`);
}

export interface FetchPageOptions {
  timeoutMs?: number;
  deadlineMs?: number;
  nowMs?: () => number;
  signal?: AbortSignal;
  websitePolicy?: WebsitePolicy | null;
  maxChars?: number;
  maxBytes?: number;
  maxPdfBytes?: number;
  seams?: FetchSeams;
  rawFetch?: (url: string, options: RawFetchOptions) => Promise<RawFetchResult>;
}

export interface HopResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  truncated?: boolean;
}

export interface ResolvedHost {
  ok: boolean;
  reason: string;
  ip: string;
  family: number;
  alternates?: { ip: string; family: number }[];
}

export interface FetchSeams {
  resolve?: (hostname: string, signal?: AbortSignal) => Promise<ResolvedHost>;
  request?: (opts: HopOptions) => Promise<HopResponse>;
}

export interface HopOptions {
  url: URL;
  pinnedIp: string;
  family: number;
  headers: Record<string, string>;
  maxBytes: number;
  maxPdfBytes: number;
  inactivityMs: number;
  deadlineMs?: number;
  nowMs?: () => number;
  signal?: AbortSignal;
}

export interface RawFetchOptions {
  timeoutMs?: number;
  deadlineMs?: number;
  nowMs?: () => number;
  signal?: AbortSignal;
  extraHeaders?: Record<string, string>;
  websitePolicy?: WebsitePolicy | null;
  maxBytes?: number;
  maxPdfBytes?: number;
  seams?: FetchSeams;
}

export interface RawFetchResult {
  error: string | null;
  body: string;
  contentType: string;
}

function htmlProbe(body: string, re: RegExp): boolean {
  let i = 0;
  const n = body.length;
  while (i < n) {
    while (i < n && /[ \t\n\r\f\v]/.test(body[i])) i++;
    if (body.startsWith("<!--", i)) {
      const close = body.indexOf("-->", i + 4);
      if (close === -1) break;
      i = close + 3;
      continue;
    }
    if (body.startsWith("<?", i)) {
      const close = body.indexOf("?>", i + 2);
      if (close === -1) break;
      i = close + 2;
      continue;
    }
    break;
  }
  return re.test(body.slice(i, i + 256).toLowerCase());
}

export function looksLikeHtml(body: string): boolean {
  return htmlProbe(body, HTML_LEADING_RE);
}

export function looksLikeHtmlDocument(body: string): boolean {
  return htmlProbe(body, HTML_DOCUMENT_RE);
}

function parseContentType(value: string | null | undefined): string {
  return /^[\w.+-]+\/[\w.+-]+/.exec(value ?? "")?.[0] ?? "";
}

export function isTextCandidateContentType(contentType: string | null): boolean {
  const ct = parseContentType(contentType).toLowerCase();
  if (!ct) return true;
  if (ct.startsWith("text/")) return true;
  if (ct.startsWith("application/")) {
    const subtype = ct.slice("application/".length);
    return !BINARY_APPLICATION_SUBTYPES.has(subtype);
  }
  return false;
}

function looksBinary(text: string): boolean {
  return (text.match(BINARY_CHAR_RE) ?? []).length > Math.max(MIN_BINARY_CHARS, Math.floor(text.length / BINARY_CHAR_DIVISOR));
}

function magicHead(data: Buffer): Buffer {
  let head = data.subarray(0, 1024);
  let start = 0;
  while (start < head.length && [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20].includes(head[start])) start++;
  for (const bom of [UTF32_LE_BOM, UTF32_BE_BOM, UTF16_LE_BOM, UTF16_BE_BOM, UTF8_BOM]) {
    if (head.subarray(start).length >= bom.length && head.subarray(start, start + bom.length).equals(bom)) {
      start += bom.length;
      while (start < head.length && [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20].includes(head[start])) start++;
      break;
    }
  }
  return head.subarray(start);
}

export function hasPdfMagic(data: Buffer): boolean {
  const head = magicHead(data);
  const magic = Buffer.from(PDF_MAGIC);
  return head.length >= magic.length && head.subarray(0, magic.length).equals(magic);
}

export function hasBinaryMagic(data: Buffer): boolean {
  const head = magicHead(data);
  return BINARY_MAGICS.some((magic) =>
    head.length >= magic.length && head.subarray(0, magic.length).equals(magic),
  );
}

function hasSingleByteTextEvidence(data: Buffer): boolean {
  if (!data.length) return true;
  let ascii = 0;
  for (const byte of data) {
    if (ASCII_TEXT_BYTES.has(byte)) ascii++;
  }
  return ascii / data.length >= MIN_SINGLE_BYTE_ASCII_RATIO;
}

const CHARSET_ALIASES: Record<string, string> = {
  gbk: "gbk",
  gb2312: "gbk",
  "gb-2312": "gbk",
  cp936: "gbk",
  "x-gbk": "gbk",
  gb18030: "gb18030",
  big5: "big5",
  "big5-hkscs": "big5",
  sjis: "shift_jis",
  "x-sjis": "shift_jis",
  cp932: "shift_jis",
  "shift-jis": "shift_jis",
  "euc-jp": "euc-jp",
  "euc-kr": "euc-kr",
  ksc5601: "euc-kr",
  "ks_c_5601-1987": "euc-kr",
  "ks_c_5601-1989": "euc-kr",
  "iso-2022-jp": "iso-2022-jp",
  "koi8-r": "koi8-r",
  "koi8-u": "koi8-u",
  cp866: "cp866",
  "x-mac-cyrillic": "x-mac-cyrillic",
  "windows-874": "windows-874",
  cp874: "windows-874",
  "tis-620": "tis-620",
};

function normalizeCharset(name: string): string | null {
  const n = name.trim().replace(/["']/g, "").toLowerCase();
  switch (n) {
    case "utf-8":
    case "utf8":
    case "utf-8-sig":
      return "utf-8";
    case "iso-8859-1":
    case "iso8859-1":
    case "latin1":
    case "latin-1":
    case "us-ascii":
    case "ascii":
      return "iso8859-1";
    case "windows-1252":
    case "cp1252":
    case "x-cp1252":
      return "cp1252";
    case "utf-16":
    case "utf-16le":
    case "utf16le":
    case "ucs-2":
    case "ucs2":
      return "utf-16le";
    case "utf-16be":
    case "utf16be":
      return "utf-16be";
    case "utf-32":
    case "utf-32le":
      return "utf-32le";
    case "utf-32be":
      return "utf-32be";
    default:
      break;
  }
  const alias = CHARSET_ALIASES[n];
  if (alias !== undefined) return alias;
  if (/^windows-125[0-8]$/.test(n) || /^iso-8859-(?:[2-9]|1[0-6])$/.test(n)) return n;
  return null;
}

function sniffMetaCharset(bytes: Buffer): string | null {
  const head = bytes.subarray(0, 1024).toString("latin1").toLowerCase();
  const match =
    /<meta\b[^>]*\bcharset\s*=\s*["']?\s*([a-z0-9_.\-]+)/.exec(head) ??
    /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?content-type["']?[^>]*\bcharset\s*=\s*["']?\s*([a-z0-9_.\-]+)/.exec(head);
  return match ? normalizeCharset(match[1]) : null;
}

function sniffMetaCharsetForHtml(bytes: Buffer, contentType: string): string | null {
  if (!contentType.includes("html")) {
    const probe = bytes.subarray(0, 256).toString("latin1");
    if (!looksLikeHtmlDocument(probe)) return null;
  }
  return sniffMetaCharset(bytes);
}
function extractMetaRefresh(html: string): string | null {
  let refresh: string | null = null;
  const handle = (name: string, attrs: AttrDict) => {
    if (refresh !== null) return;
    if (name !== "meta") return;
    const equiv = (attrs["http-equiv"] ?? "").toLowerCase();
    if (equiv !== "refresh") return;
    const content = attrs["content"] ?? "";
    const match = /;\s*url\s*=\s*(.+)/i.exec(content);
    if (!match) return;
    let url = match[1].trim();
    if ((url.startsWith('"') && url.endsWith('"')) || (url.startsWith("'") && url.endsWith("'"))) url = url.slice(1, -1);
    url = url.trim();
    if (url) refresh = url;
  };
  feedHtml(html, {
    handleStartTag: handle,
    handleStartEndTag: handle,
    handleEndTag() {},
    handleData() {},
    handleEntityRef() {},
    handleCharRef() {},
  });
  return refresh;
}
function metaRefreshUrl(html: string, base: string): string | null {
  const target = extractMetaRefresh(html);
  if (!target) return null;
  try {
    const next = new URL(target, base).toString();
    return next !== base ? next : null;
  } catch {
    return null;
  }
}

function decodeUtf32(bytes: Buffer, littleEndian: boolean): string {
  let out = "";
  let i = 0;
  if (bytes.length >= 4) {
    const first = littleEndian ? bytes.readUInt32LE(0) : bytes.readUInt32BE(0);
    if (first === 0xfeff) i = 4;
  }
  for (; i + 3 < bytes.length; i += 4) {
    const v = littleEndian ? bytes.readUInt32LE(i) : bytes.readUInt32BE(i);
    if (v === 0 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) {
      out += "\ufffd";
    } else {
      out += String.fromCodePoint(v);
    }
  }
  return out;
}

function decodeUtf16Be(bytes: Buffer): string {
  let out = "";
  let i = bytes.length >= 2 && bytes.readUInt16BE(0) === 0xfeff ? 2 : 0;
  for (; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode(bytes.readUInt16BE(i));
  }
  return out;
}

function decodeSingleByte(bytes: Buffer, cp1252: boolean): string {
  let out = "";
  for (const byte of bytes) {
    if (byte < 0x80) {
      out += String.fromCharCode(byte);
    } else if (cp1252 && byte in INVALID_CHARREFS) {
      out += INVALID_CHARREFS[byte];
    } else {
      out += String.fromCharCode(byte);
    }
  }
  return out;
}

function decodeWithCodec(bytes: Buffer, codec: string | null): string {
  switch (codec) {
    case "utf-8":
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    case "utf-16le":
      return new TextDecoder("utf-16le", { fatal: false }).decode(bytes);
    case "utf-16be":
      try {
        return new TextDecoder("utf-16be", { fatal: false }).decode(bytes);
      } catch {
        return decodeUtf16Be(bytes);
      }
    case "utf-32le":
      return decodeUtf32(bytes, true);
    case "utf-32be":
      return decodeUtf32(bytes, false);
    case "cp1252":
      return decodeSingleByte(bytes, true);
    case "iso8859-1":
      return decodeSingleByte(bytes, false);
    default:
      return decodeWithLabel(bytes, codec);
  }
}

function decodeWithLabel(bytes: Buffer, label: string | null): string {
  if (label === null) return decodeSingleByte(bytes, false);
  if (label === "tis-620") return decodeTis620(bytes);
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return decodeSingleByte(bytes, false);
  }
}

function decodeTis620(bytes: Buffer): string {
  let out = "";
  for (const byte of bytes) {
    if (byte < 0x80) {
      out += String.fromCharCode(byte);
    } else if (byte >= 0xa1 && byte <= 0xfb) {
      out += String.fromCodePoint(0x0e01 + byte - 0xa1);
    } else if (byte === 0xa0) {
      out += "\u00a0";
    } else {
      out += "\ufffd";
    }
  }
  return out;
}


async function resolveAndValidate(hostname: string, signal?: AbortSignal): Promise<ResolvedHost> {
  let addresses: { address: string; family: number }[];
  try {
    const lookupOptions: LookupAllOptions & { signal?: AbortSignal } = {
      all: true,
      verbatim: true,
      signal,
    };
    addresses = await dnsLookup(hostname, lookupOptions);
  } catch (err) {
    return { ok: false, reason: `Failed to resolve host: ${err}`, ip: "", family: 0 };
  }
  if (!addresses.length) {
    return { ok: false, reason: `Failed to resolve host: no addresses for '${hostname}'`, ip: "", family: 0 };
  }
  for (const entry of addresses) {
    if (!isPublicIp(entry.address)) {
      return { ok: false, reason: `Blocked: refusing to fetch the non-public address ${entry.address}.`, ip: "", family: 0 };
    }
  }
  addresses.sort((a, b) => (a.family === 4 ? 0 : 1) - (b.family === 4 ? 0 : 1));
  const first = addresses[0];
  return {
    ok: true,
    reason: "",
    ip: first.address,
    family: first.family,
    alternates: addresses.slice(1).map((entry) => ({ ip: entry.address, family: entry.family })),
  };
}
function budgetExceededResult(
  deadline: number | null,
  signal: AbortSignal | undefined,
  now: () => number = Date.now,
  contentType = "",
): RawFetchResult | null {
  if (signal?.aborted) return emptyResult(FETCH_CANCELLED_MESSAGE, contentType);
  if (deadline !== null && now() >= deadline) return emptyResult(FETCH_TIMEOUT_MESSAGE, contentType);
  return null;
}


function contentEncodingCodec(value: string | string[] | undefined): string | null {
  const declared = Array.isArray(value) ? value[0] : value;
  const codec = (declared ?? "").split(",", 1)[0].trim().toLowerCase();
  if (codec === "gzip" || codec === "x-gzip" || codec === "deflate" || codec === "br") return codec;
  return null;
}

function createDecodeStream(codec: string): Transform {
  const options = { maxOutputLength: MAX_DECOMPRESSED_BYTES };
  if (codec === "br") return createBrotliDecompress(options);
  if (codec === "deflate") return createInflate(options);
  return createGunzip(options);
}

export function requestHop(opts: HopOptions): Promise<HopResponse> {
  return new Promise((resolve, reject) => {
    const url = opts.url;
    const transport = url.protocol === "https:" ? https : http;
    const options: https.RequestOptions = {
      method: "GET",
      host: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
      path: url.pathname + url.search,
      headers: opts.headers,
      timeout: opts.inactivityMs,
      servername: url.protocol === "https:" ? url.hostname : undefined,
      lookup: (_host, _opts, callback) =>
        callback(null, [{ address: opts.pinnedIp, family: opts.family }]),
    };
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      action();
    };
    const request = transport.request(options, (res: IncomingMessage) => {
      const codec = contentEncodingCodec(res.headers["content-encoding"]);
      const chunks: Buffer[] = [];
      let total = 0;
      let head = Buffer.alloc(0);
      let truncated = false;
      let decoder: Transform | null = null;
      const declaredPdf = String(res.headers["content-type"] ?? "").toLowerCase().includes("pdf");
      let limit = declaredPdf ? opts.maxPdfBytes : opts.maxBytes;
      let extendedForPdf = false;
      const declaredLengthHeader = res.headers["content-length"];
      const declaredLength =
        declaredLengthHeader === undefined ? NaN : Number(declaredLengthHeader);
      const finish = (err: string | null, body: Buffer) => {
        settle(() => {
          if (err) {
            if (err === "cancelled") reject(new FetchCancelledError());
            else if (err === "timed out") reject(new FetchTimeoutError());
            else reject(new Error(err));
          } else {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers as Record<string, string | string[] | undefined>,
              body,
              truncated,
            });
          }
        });
      };
      const timeoutAndDestroy = () => {
        decoder?.destroy();
        res.destroy();
        finish("timed out", Buffer.concat(chunks));
      };
      const acceptData = (chunk: Buffer) => {
        if (settled) return;
        const now = opts.nowMs ?? Date.now;
        if (opts.deadlineMs !== undefined && now() >= opts.deadlineMs) {
          timeoutAndDestroy();
          return;
        }
        if (head.length < 1024) {
          const need = 1024 - head.length;
          head = Buffer.concat([head, chunk.subarray(0, Math.min(need, chunk.length))]);
        }
        if (!declaredPdf && !extendedForPdf && total + chunk.length > limit) {
          if (hasPdfMagic(head)) {
            limit = opts.maxPdfBytes;
            extendedForPdf = true;
          }
        }
        const space = limit - total;
        const take = chunk.subarray(0, Math.min(chunk.length, space));
        chunks.push(take);
        total += take.length;
        if (total >= limit) {
          truncated =
            codec !== null ||
            take.length < chunk.length ||
            (Number.isFinite(declaredLength) && declaredLength > total);
          decoder?.destroy();
          res.destroy();
          finish(null, Buffer.concat(chunks));
        }
      };
      if (codec === null) {
        res.on("data", (chunk: Buffer) => {
          acceptData(chunk);
        });
        res.on("end", () => finish(null, Buffer.concat(chunks)));
      } else {
        let rawBuffer: Buffer[] = [];
        let rawBufferBytes = 0;
        let outputStarted = false;
        let rawFallbackTried = false;
        let resEnded = false;
        const wire = (d: Transform) => {
          d.on("data", (chunk: Buffer) => {
            outputStarted = true;
            acceptData(chunk);
          });
          d.on("end", () => finish(null, Buffer.concat(chunks)));
          d.on("drain", () => res.resume());
          d.on("error", (err: NodeJS.ErrnoException) => {
            if (settled) return;
            if (
              codec === "deflate" &&
              !rawFallbackTried &&
              !outputStarted &&
              err.code === "Z_DATA_ERROR"
            ) {
              rawFallbackTried = true;
              d.destroy();
              decoder = createInflateRaw({ maxOutputLength: MAX_DECOMPRESSED_BYTES });
              wire(decoder);
              for (const buffered of rawBuffer) decoder.write(buffered);
              if (resEnded) decoder.end();
              return;
            }
            if (outputStarted) {
              truncated = true;
              finish(null, Buffer.concat(chunks));
              return;
            }
            finish(null, Buffer.concat(rawBuffer));
          });
        };
        decoder = createDecodeStream(codec);
        wire(decoder);
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          const now = opts.nowMs ?? Date.now;
          if (opts.deadlineMs !== undefined && now() >= opts.deadlineMs) {
            timeoutAndDestroy();
            return;
          }
          if (!outputStarted && !rawFallbackTried && rawBufferBytes < limit) {
            rawBuffer.push(chunk);
            rawBufferBytes += chunk.length;
          }
          if (!decoder!.write(chunk)) res.pause();
        });
        res.on("end", () => {
          resEnded = true;
          if (!settled) decoder!.end();
        });
      }
      res.on("error", (err) => {
        decoder?.destroy();
        finish(err.message, Buffer.concat(chunks));
      });
    });
    const onAbort = () => request.destroy(new FetchCancelledError());
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    request.on("timeout", () => request.destroy(new FetchTimeoutError()));
    request.on("error", (err) => settle(() => reject(err)));
    request.end();
  });
}



export async function fetchUrlRaw(
  url: string,
  options: RawFetchOptions = {},
): Promise<RawFetchResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const now = options.nowMs ?? Date.now;
  const deadline = options.deadlineMs ?? now() + timeoutMs;
  const signal = options.signal;
  const policy = options.websitePolicy ?? null;
  const maxBytes = options.maxBytes ?? MAX_FETCH_BYTES;
  const maxPdfBytes = options.maxPdfBytes ?? MAX_PDF_FETCH_BYTES;
  const seams = options.seams ?? {};
  const resolveHost = seams.resolve ?? resolveAndValidate;
  const performRequest = seams.request ?? requestHop;
  const resolveWithBudget = async (hostname: string): Promise<ResolvedHost> => {
    const deadlineSignal = AbortSignal.timeout(Math.min(MAX_SIGNAL_TIMEOUT_MS, Math.max(1, deadline - now())));
    const resolveSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
    const resolved = await resolveHost(hostname, resolveSignal);
    if (resolved.ok) return resolved;
    if (signal?.aborted) return { ...resolved, reason: FETCH_CANCELLED_MESSAGE };
    if (resolveSignal.aborted) return { ...resolved, reason: FETCH_TIMEOUT_MESSAGE };
    return resolved;
  };
  url = normalizeUrlScheme(url);
  const [allowed, reason, hostname] = checkUrlAccess(url, policy);
  if (!allowed) return emptyResult(reason);
  const budgetResult = budgetExceededResult(deadline, signal, now);
  if (budgetResult !== null) return budgetResult;
  let resolved = await resolveWithBudget(hostname);
  if (!resolved.ok) return emptyResult(resolved.reason);

  let currentUrl = url;
  let pinnedIp = resolved.ip;
  let pinnedFamily = resolved.family;
  let alternates: { ip: string; family: number }[] = resolved.alternates ?? [];
  let alternateIndex = 0;
  const userAgent = randomUserAgent();
  for (let hop = 0; hop < MAX_REQUESTS; hop++) {
    const budgetResult = budgetExceededResult(deadline, signal, now);
    if (budgetResult !== null) return budgetResult;
    const parsed = new URL(currentUrl);
    const hostHeader = parsed.hostname + (parsed.port ? `:${parsed.port}` : "");
    const headers: Record<string, string> = {
      "User-Agent": userAgent,
      Host: hostHeader,
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      "Accept-Encoding": "identity",
    };
    if (options.extraHeaders) Object.assign(headers, options.extraHeaders);
    const inactivity = Math.max(1, deadline - now());
    let response: HopResponse;
    try {
      response = await performRequest({
        url: parsed,
        pinnedIp,
        family: pinnedFamily,
        headers,
        maxBytes,
        maxPdfBytes,
        inactivityMs: inactivity,
        deadlineMs: deadline,
        nowMs: now,
        signal,
      });
    } catch (err) {
      if (
        !(err instanceof FetchCancelledError) &&
        !(err instanceof FetchTimeoutError) &&
        alternateIndex < alternates.length
      ) {
        const next = alternates[alternateIndex++];
        pinnedIp = next.ip;
        pinnedFamily = next.family;
        continue;
      }
      return emptyResult(fetchErrorMessage(err));
    }

    if (response.status >= 300 && response.status < 400) {
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return statusErrorResult(response.status);
      }
      const rawLocation = response.headers.location;
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
      if (!location) {
        return emptyResult("Failed to fetch URL: the redirect is missing a Location header.");
      }
      try {
        currentUrl = new URL(location, currentUrl).toString();
      } catch {
        return emptyResult("Failed to fetch URL: the redirect has an invalid Location.");
      }
      const [redirectAllowed, redirectReason, redirectHost] = checkUrlAccess(
        currentUrl,
        policy,
      );
      if (!redirectAllowed) return emptyResult(redirectReason);
      const redirected = await resolveWithBudget(redirectHost);
      if (!redirected.ok) return emptyResult(redirected.reason);
      pinnedIp = redirected.ip;
      pinnedFamily = redirected.family;
      alternates = redirected.alternates ?? [];
      alternateIndex = 0;
      continue;
    }

    const postBudgetResult = budgetExceededResult(deadline, signal, now);
    if (postBudgetResult !== null) return postBudgetResult;

    if (response.status >= 400) {
      return statusErrorResult(response.status);
    }

    const contentTypeHeader = response.headers["content-type"];
    const contentType = parseContentType(contentTypeHeader ? String(contentTypeHeader).toLowerCase() : null);
    const declaredCharset = contentTypeHeader
      ? (/charset=([^;\s]+)/i.exec(String(contentTypeHeader))?.[1] ?? null)
      : null;

    const declaredPdf = contentType === "application/pdf";
    if (declaredPdf && response.body.length > maxPdfBytes) {
      return {
        error: "(PDF content exceeds the download limit; not readable as text)",
        body: "",
        contentType,
      };
    }
    const isPdf = declaredPdf || hasPdfMagic(response.body);
    if (isPdf) {
      let pdfText: string;
      try {
        pdfText = await extractPdfText(response.body);
      } catch {
        return emptyResult(
          response.truncated
            ? "(PDF content could not be read as text; the download was truncated at the download limit)"
            : "(PDF content could not be read as text)",
          contentType,
        );
      }
      const budgetResult = budgetExceededResult(deadline, signal, now, contentType);
      if (budgetResult !== null) return budgetResult;
      if (!pdfText) pdfText = "(PDF contains no extractable text)";
      if (response.truncated) pdfText += TRUNCATED_BODY_NOTICE;
      return { error: null, body: pdfText, contentType: "application/pdf" };
    }

    if (!isTextCandidateContentType(contentType)) {
      const safeType = parseContentType(contentType) || "unknown type";
      return emptyResult(
        `(non-text content: ${safeType}, ${response.body.length} bytes; not readable as text)`,
        contentType,
      );
    }

    if (hasBinaryMagic(response.body)) {
      return emptyResult(
        `(binary content, ${response.body.length} bytes; not readable as text)`,
        contentType,
      );
    }

    const declaredCodec = declaredCharset ? normalizeCharset(declaredCharset) : null;
    const bomCodec = bomCodecFor(response.body);
    const rawHtml =
      decodeWithCodec(
        response.body,
        bomCodec ?? declaredCodec ?? sniffMetaCharsetForHtml(response.body, contentType) ?? "utf-8",
      ) + (response.truncated ? TRUNCATED_BODY_NOTICE : "");
    const nextUrl = isHtmlContent(rawHtml, contentType) ? metaRefreshUrl(rawHtml, currentUrl) : null;
    if (nextUrl) {
      const [refreshAllowed, refreshReason, refreshHost] = checkUrlAccess(nextUrl, policy);
      if (!refreshAllowed) return emptyResult(refreshReason);
      const refreshBudget = budgetExceededResult(deadline, signal, now);
      if (refreshBudget !== null) return refreshBudget;
      const redirected = await resolveWithBudget(refreshHost);
      if (!redirected.ok) return emptyResult(redirected.reason);
      currentUrl = nextUrl;
      pinnedIp = redirected.ip;
      pinnedFamily = redirected.family;
      alternates = redirected.alternates ?? [];
      alternateIndex = 0;
      continue;
    }
    if (looksBinary(rawHtml)) {
      let alt: string | null = null;
      if (
        (declaredCodec === null || declaredCodec === "iso8859-1") &&
        hasSingleByteTextEvidence(response.body)
      ) {
        const candidate = decodeWithCodec(response.body, "cp1252");
        if (!looksBinary(candidate)) alt = candidate;
      }
      if (alt !== null) {
        if (response.truncated) alt += TRUNCATED_BODY_NOTICE;
        return { error: null, body: alt, contentType };
      }
      return emptyResult(
        `(binary content, ${response.body.length} bytes; not readable as text)`,
        contentType,
      );
    }

    return { error: null, body: rawHtml, contentType };
  }
  return emptyResult("Failed to fetch URL: too many redirects.");
}

function bomCodecFor(bytes: Buffer): string | null {
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(UTF32_LE_BOM)) return "utf-32le";
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(UTF32_BE_BOM)) return "utf-32be";
  if (bytes.length >= 2 && bytes.subarray(0, 2).equals(UTF16_LE_BOM)) return "utf-16le";
  if (bytes.length >= 2 && bytes.subarray(0, 2).equals(UTF16_BE_BOM)) return "utf-16be";
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(UTF8_BOM)) return "utf-8";
  return null;
}

export function truncatePageText(text: string, maxChars?: number): string {
  if (!text) return "(page returned no readable text)";
  if (typeof maxChars === "number" && maxChars > 0 && text.length > maxChars) {
    const hadCapNotice = text.endsWith(TRUNCATED_BODY_SUFFIX);
    const core = (hadCapNotice ? text.slice(0, -TRUNCATED_BODY_SUFFIX.length) : text).trimEnd();
    return (
      cutAtCharBoundary(core, maxChars) +
      `\n\n... (truncated, ${text.length} chars total)` +
      (hadCapNotice ? TRUNCATED_BODY_NOTICE : "")
    );
  }
  return text;
}

const NON_DOCUMENT_TITLE_TAGS = new Set(["math", "noscript", "svg", "template"]);

function extractPageTitle(html: string): string {
  let inTitle = false;
  let done = false;
  let skipDepth = 0;
  const parts: string[] = [];
  feedHtml(html, {
    handleStartTag(name: string) {
      if (NON_DOCUMENT_TITLE_TAGS.has(name)) {
        skipDepth++;
        return;
      }
      if (skipDepth) return;
      if (name === "title" && !done) {
        inTitle = true;
      } else if (inTitle) {
        inTitle = false;
      }
    },
    handleStartEndTag() {},
    handleEndTag(name: string) {
      if (NON_DOCUMENT_TITLE_TAGS.has(name)) {
        skipDepth = Math.max(0, skipDepth - 1);
        return;
      }
      if (skipDepth) return;
      if (name === "title") {
        inTitle = false;
        done = true;
      }
    },
    handleData(text: string) {
      if (inTitle) parts.push(text);
    },
    handleEntityRef(name: string) {
      if (inTitle) parts.push(decodeHtmlEntities(`&${name};`));
    },
    handleCharRef(name: string) {
      if (inTitle) parts.push(decodeHtmlEntities(`&#${name};`));
    },
  });
  return collapseWhitespace(parts.join(""));
}

interface PageMeta {
  title: string;
  author: string;
  date: string;
  site: string;
}

const META_KEYS: Record<string, keyof PageMeta> = {
  author: "author",
  "article:author": "author",
  "dc.creator": "author",
  "article:published_time": "date",
  date: "date",
  "dc.date": "date",
  datepublished: "date",
  "og:site_name": "site",
  "application-name": "site",
};

function cutAtCharBoundary(text: string, maxChars: number): string {
  const sliced = text.slice(0, maxChars);
  const last = sliced.charCodeAt(sliced.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

function capMetaValue(value: string): string {
  if (value.length <= META_VALUE_MAX_CHARS) return value;
  return cutAtCharBoundary(value, META_VALUE_MAX_CHARS);
}

function extractPageMeta(html: string): PageMeta {
  const meta: PageMeta = { title: extractPageTitle(html), author: "", date: "", site: "" };
  const seen = new Set<string>();
  const record = (name: string, attrs: AttrDict) => {
    if (name !== "meta") return;
    const key = (attrs["property"] ?? attrs["name"] ?? "").toLowerCase();
    const content = collapseWhitespace(attrs["content"] ?? "");
    if (!key || !content || seen.has(key)) return;
    seen.add(key);
    const field = META_KEYS[key];
    if (field && !meta[field]) meta[field] = capMetaValue(content);
  };
  feedHtml(html, {
    handleStartTag(name: string, attrs: AttrDict) {
      record(name, attrs);
    },
    handleStartEndTag(name: string, attrs: AttrDict) {
      record(name, attrs);
    },
    handleEndTag() {},
    handleData() {},
    handleEntityRef() {},
    handleCharRef() {},
  });
  return meta;
}

function pagePrefixedMarkdown(html: string): string {
  const meta = extractPageMeta(html);
  const lines: string[] = [];
  if (meta.title) lines.push(`Title: ${meta.title}`);
  if (meta.author) lines.push(`Author: ${meta.author}`);
  if (meta.date) lines.push(`Date: ${meta.date}`);
  if (meta.site) lines.push(`Site: ${meta.site}`);
  const markdown = htmlToMarkdown(html, true);
  const converted = lines.length ? `${lines.join("\n")}\n\n${markdown}` : markdown;
  if (html.endsWith(TRUNCATED_BODY_SUFFIX) && !converted.endsWith(TRUNCATED_BODY_SUFFIX)) {
    return converted + TRUNCATED_BODY_NOTICE;
  }
  return converted;
}

function formatReadmeBody(body: string): string {
  if (looksLikeHtmlDocument(body)) {
    const converted = pagePrefixedMarkdown(body);
    if (converted.trim()) return converted;
  }
  return body;
}
function isHtmlContent(body: string, contentType: string): boolean {
  return contentType.includes("html") || looksLikeHtml(body);
}
function renderBody(body: string, contentType: string): string {
  return isHtmlContent(body, contentType) ? pagePrefixedMarkdown(body) : body.trim();
}
async function persistCache(url: string, body: string, contentType: string, useCache: boolean): Promise<void> {
  if (!useCache) return;
  try {
    await setCached(url, body, contentType);
  } catch {}
}
function isHttp404Error(error: string): boolean {
  return /HTTP 404\b/.test(error);
}
async function fetchWaybackSnapshot(
  url: string,
  rawFetch: (url: string, options: RawFetchOptions) => Promise<RawFetchResult>,
  options: RawFetchOptions,
  deadlineMs: number,
  now: () => number,
): Promise<{ body: string; contentType: string; timestamp: string } | null> {
  if (now() >= deadlineMs) return null;
  const availUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
  let availResult: RawFetchResult | null = null;
  try {
    availResult = await rawFetch(availUrl, options);
  } catch {
    return null;
  }
  if (!availResult || availResult.error !== null) return null;
  let snapshotUrl: string | null = null;
  let timestamp = "";
  try {
    const data = JSON.parse(availResult.body) as {
      archived_snapshots?: { closest?: { available?: boolean; url?: string; timestamp?: string; status?: string | number } };
    };
    const closest = data.archived_snapshots?.closest;
    if (closest?.available && closest.url && String(closest.status) === "200") {
      snapshotUrl = closest.url;
      timestamp = closest.timestamp ?? "";
    }
  } catch {
    return null;
  }
  if (!snapshotUrl) return null;
  if (now() >= deadlineMs) return null;
  let snapResult: RawFetchResult | null = null;
  try {
    snapResult = await rawFetch(snapshotUrl, options);
  } catch {
    return null;
  }
  if (!snapResult || snapResult.error !== null) return null;
  return { body: snapResult.body, contentType: snapResult.contentType, timestamp };
}
export async function fetchPageText(
  url: string,
  options: FetchPageOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const now = options.nowMs ?? Date.now;
  const deadlineMs = options.deadlineMs ?? now() + timeoutMs;
  const signal = options.signal;
  const policy = options.websitePolicy ?? null;
  const maxChars = options.maxChars;
  const rawFetch = options.rawFetch ?? fetchUrlRaw;
  url = normalizeUrlScheme(url);
  const [allowed, reason] = checkUrlAccess(url, policy);
  if (!allowed) return reason;
  const rawFetchOptions = {
    deadlineMs,
    signal,
    websitePolicy: policy,
    maxBytes: options.maxBytes,
    maxPdfBytes: options.maxPdfBytes,
    seams: options.seams,
  };
  const useCache = !options.seams && !options.rawFetch;
  const githubRaw = githubRawContentUrl(url);
  if (githubRaw) {
    const rawResult = await rawFetch(githubRaw, rawFetchOptions);
    if (rawResult.error === null) {
      const out = renderBody(rawResult.body, rawResult.contentType);
      await persistCache(url, rawResult.body, rawResult.contentType, useCache);
      return truncatePageText(out, maxChars);
    }
  }
  const readmeApiUrl = githubRepoReadmeApiUrl(url);
  if (readmeApiUrl) {
    const readmeResult = await rawFetch(readmeApiUrl, {
      ...rawFetchOptions,
      extraHeaders: {
        Accept: "application/vnd.github.raw+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    const apiBody = readmeResult.error === null ? formatReadmeBody(readmeResult.body) : "";
    if (apiBody.trim()) {
      const rendered = `README of ${url} (fetched via the GitHub README API):\n\n` + apiBody;
      await persistCache(url, rendered, "text/markdown", useCache);
      return truncatePageText(rendered, maxChars);
    }
    const rawReadmeUrl = githubRepoRawReadmeUrl(url);
    if (rawReadmeUrl) {
      const rawResult = await rawFetch(rawReadmeUrl, rawFetchOptions);
      const rawBody = rawResult.error === null ? formatReadmeBody(rawResult.body) : "";
      if (rawBody.trim()) {
        const rendered = `README of ${url} (fetched via the GitHub raw README URL):\n\n` + rawBody;
        await persistCache(url, rendered, "text/markdown", useCache);
        return truncatePageText(rendered, maxChars);
      }
    }
  }
  const originalUrl = url;
  let fetchUrl = url;
  let result = await rawFetch(fetchUrl, rawFetchOptions);
  for (let hop = 1; hop < MAX_REQUESTS; hop++) {
    if (result.error !== null) break;
    if (!isHtmlContent(result.body, result.contentType)) break;
    const nextUrl = metaRefreshUrl(result.body, fetchUrl);
    if (!nextUrl) break;
    fetchUrl = nextUrl;
    const [refreshAllowed, refreshReason] = checkUrlAccess(fetchUrl, policy);
    if (!refreshAllowed) {
      result = { error: refreshReason, body: "", contentType: "" };
      break;
    }
    const refreshBudget = budgetExceededResult(deadlineMs, signal, now);
    if (refreshBudget !== null) {
      result = refreshBudget;
      break;
    }
    result = await rawFetch(fetchUrl, rawFetchOptions);
  }
  if (result.error !== null) {
    if (!result.error.startsWith("Blocked:")) {
      if (useCache) {
        try {
          const cached = await getCached(originalUrl);
          if (cached) {
            let cachedOut = renderBody(cached.body, cached.contentType);
            if (!isFresh(cached, now())) cachedOut += staleNotice(cached);
            else cachedOut += "\n\n*Served from cache — network fetch failed*";
            return truncatePageText(cachedOut, maxChars);
          }
        } catch {}
      }
      if (isHttp404Error(result.error)) {
        try {
          const wb = await fetchWaybackSnapshot(originalUrl, rawFetch, rawFetchOptions, deadlineMs, now);
          if (wb) {
            let out = renderBody(wb.body, wb.contentType);
            const ts = wb.timestamp ? `${wb.timestamp.slice(0, 4)}-${wb.timestamp.slice(4, 6)}-${wb.timestamp.slice(6, 8)}` : "unknown date";
            out = `*Fetched from Wayback Machine snapshot (${ts}) for ${originalUrl}:*\n\n` + out;
            await persistCache(originalUrl, wb.body, wb.contentType, useCache);
            return truncatePageText(out, maxChars);
          }
        } catch {}
      }
    }
    return result.error;
  }
  const finalOut = renderBody(result.body, result.contentType);
  await persistCache(originalUrl, result.body, result.contentType, useCache);
  return truncatePageText(finalOut, maxChars);
}
