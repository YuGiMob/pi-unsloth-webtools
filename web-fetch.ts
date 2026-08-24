import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import {
  checkUrlAccess,
  githubRepoReadmeApiUrl,
  isPublicIp,
  normalizeUrlScheme,
  type WebsitePolicy,
} from "./web-access.ts";
import { htmlToMarkdown } from "./html-to-md.ts";
import { INVALID_CHARREFS } from "./entities.ts";
import { extractPdfText, PdfParseError } from "./pdf.ts";
import { randomUserAgent } from "./user-agents.ts";

const MAX_FETCH_BYTES = 512 * 1024;
const MAX_PDF_FETCH_BYTES = 10 * 1024 * 1024;
const MAX_REQUESTS = 5;

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
}

export interface ResolvedHost {
  ok: boolean;
  reason: string;
  ip: string;
  family: number;
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

export function looksLikeHtml(body: string): boolean {
  const probe = body.replace(/^[ \t\n\r\f\v]+/, "").slice(0, 256).toLowerCase();
  return HTML_LEADING_RE.test(probe);
}

export function looksLikeHtmlDocument(body: string): boolean {
  const probe = body.replace(/^[ \t\n\r\f\v]+/, "").slice(0, 256).toLowerCase();
  return HTML_DOCUMENT_RE.test(probe);
}

export function isTextCandidateContentType(contentType: string | null): boolean {
  const match = /^[\w.+-]+\/[\w.+-]+/.exec(contentType ?? "");
  if (!match) return true;
  const ct = match[0].toLowerCase();
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

function decodeUtf32(bytes: Buffer, littleEndian: boolean): string {
  let out = "";
  for (let i = 0; i + 3 < bytes.length; i += 4) {
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
  for (let i = 0; i + 1 < bytes.length; i += 2) {
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
    addresses = await dnsLookup(hostname, { all: true, verbatim: true });
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
  const first = addresses[0];
  return { ok: true, reason: "", ip: first.address, family: first.family };
}


function fetchBudgetExceeded(
  deadline: number | null,
  signal: AbortSignal | undefined,
  now: () => number = Date.now,
): string | null {
  if (signal?.aborted) return "Failed to fetch URL: cancelled.";
  if (deadline !== null && now() >= deadline) return "Failed to fetch URL: timed out.";
  return null;
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
      const chunks: Buffer[] = [];
      let total = 0;
      const declaredPdf = String(res.headers["content-type"] ?? "").toLowerCase().includes("pdf");
      let limit = declaredPdf ? opts.maxPdfBytes : opts.maxBytes;
      let extendedForPdf = false;
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
            });
          }
        });
      };
      res.on("data", (chunk: Buffer) => {
        if (settled) return;
        const now = opts.nowMs ?? Date.now;
        if (opts.deadlineMs !== undefined && now() >= opts.deadlineMs) {
          res.destroy();
          finish("timed out", Buffer.concat(chunks));
          return;
        }
        if (!declaredPdf && !extendedForPdf && total + chunk.length > opts.maxBytes) {
          if (hasPdfMagic(Buffer.concat(chunks))) {
            limit = opts.maxPdfBytes;
            extendedForPdf = true;
          }
        }
        const space = limit - total;
        if (space <= 0) {
          res.destroy();
          finish(null, Buffer.concat(chunks));
          return;
        }
        const take = chunk.subarray(0, Math.min(chunk.length, space));
        chunks.push(take);
        total += take.length;
        if (total >= limit) {
          res.destroy();
          finish(null, Buffer.concat(chunks));
        }
      });
      res.on("end", () => finish(null, Buffer.concat(chunks)));
      res.on("error", (err) => finish(err.message, Buffer.concat(chunks)));
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

  url = normalizeUrlScheme(url);
  const [allowed, reason, hostname] = checkUrlAccess(url, policy);
  if (!allowed) return { error: reason, body: "", contentType: "" };

  let budgetError = fetchBudgetExceeded(deadline, signal, now);
  if (budgetError !== null) return { error: budgetError, body: "", contentType: "" };
  let resolved = await resolveHost(hostname, signal);
  if (!resolved.ok) return { error: resolved.reason, body: "", contentType: "" };

  let currentUrl = url;
  let pinnedIp = resolved.ip;
  let pinnedFamily = resolved.family;
  const userAgent = randomUserAgent();

  for (let hop = 0; hop < MAX_REQUESTS; hop++) {
    budgetError = fetchBudgetExceeded(deadline, signal, now);
    if (budgetError !== null) return { error: budgetError, body: "", contentType: "" };
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
      if (err instanceof FetchCancelledError)
        return { error: "Failed to fetch URL: cancelled.", body: "", contentType: "" };
      if (err instanceof FetchTimeoutError)
        return { error: "Failed to fetch URL: timed out.", body: "", contentType: "" };
      const message = err instanceof Error ? err.message : String(err);
      if (message === "cancelled")
        return { error: "Failed to fetch URL: cancelled.", body: "", contentType: "" };
      if (message === "timed out")
        return { error: "Failed to fetch URL: timed out.", body: "", contentType: "" };
      return { error: `Failed to fetch URL: ${message}`, body: "", contentType: "" };
    }

    if (response.status >= 300 && response.status < 400) {
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        const reason = http.STATUS_CODES[response.status] ?? "";
        return {
          error: `Failed to fetch URL: HTTP ${response.status}${reason ? ` ${reason}` : ""}`,
          body: "",
          contentType: "",
        };
      }
      const rawLocation = response.headers.location;
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
      if (!location) {
        return {
          error: "Failed to fetch URL: the redirect is missing a Location header.",
          body: "",
          contentType: "",
        };
      }
      try {
        currentUrl = new URL(location, currentUrl).toString();
      } catch {
        return { error: "Failed to fetch URL: the redirect has an invalid Location.", body: "", contentType: "" };
      }
      const [redirectAllowed, redirectReason, redirectHost] = checkUrlAccess(
        currentUrl,
        policy,
      );
      if (!redirectAllowed) return { error: redirectReason, body: "", contentType: "" };
      const redirected = await resolveHost(redirectHost, signal);
      if (!redirected.ok) return { error: redirected.reason, body: "", contentType: "" };
      pinnedIp = redirected.ip;
      pinnedFamily = redirected.family;
      continue;
    }

    budgetError = fetchBudgetExceeded(deadline, signal, now);
    if (budgetError !== null) return { error: budgetError, body: "", contentType: "" };

    const contentTypeHeader = response.headers["content-type"];
    const contentType = contentTypeHeader
      ? (/^[\w.+-]+\/[\w.+-]+/.exec(String(contentTypeHeader).toLowerCase()) ?? [""])[0]
      : "";
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
        return { error: "(PDF content could not be read as text)", body: "", contentType };
      }
      budgetError = fetchBudgetExceeded(deadline, signal, now);
      if (budgetError !== null) return { error: budgetError, body: "", contentType };
      if (!pdfText) pdfText = "(PDF contains no extractable text)";
      return { error: null, body: pdfText, contentType: "application/pdf" };
    }

    if (!isTextCandidateContentType(contentType)) {
      const safeType = /^[\w.+-]+\/[\w.+-]+/.exec(contentType ?? "")?.[0] ?? "unknown type";
      return {
        error: `(non-text content: ${safeType}, ${response.body.length} bytes; not readable as text)`,
        body: "",
        contentType,
      };
    }

    if (hasBinaryMagic(response.body)) {
      return {
        error: `(binary content, ${response.body.length} bytes; not readable as text)`,
        body: "",
        contentType,
      };
    }

    const declaredCodec = declaredCharset ? normalizeCharset(declaredCharset) : null;
    const bomCodec = bomCodecFor(response.body);
    const rawHtml = decodeWithCodec(
      response.body,
      declaredCodec ?? bomCodec ?? sniffMetaCharsetForHtml(response.body, contentType) ?? "utf-8",
    );

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
        return { error: null, body: alt, contentType };
      }
      return {
        error: `(binary content, ${response.body.length} bytes; not readable as text)`,
        body: "",
        contentType,
      };
    }

    return { error: null, body: rawHtml, contentType };
  }
  return { error: "Failed to fetch URL: too many redirects.", body: "", contentType: "" };
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
    return text.slice(0, maxChars) + `\n\n... (truncated, ${text.length} chars total)`;
  }
  return text;
}

export async function fetchPageText(
  url: string,
  options: FetchPageOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const now = options.nowMs ?? Date.now;
  const deadlineMs = options.deadlineMs ?? now() + timeoutMs;
  const signal = options.signal;
  const policy = options.websitePolicy ?? null;
  const maxChars = options.maxChars;
  const rawFetch = options.rawFetch ?? fetchUrlRaw;

  url = normalizeUrlScheme(url);
  const [allowed, reason] = checkUrlAccess(url, policy);
  if (!allowed) return reason;

  const readmeApiUrl = githubRepoReadmeApiUrl(url);
  if (readmeApiUrl) {
    const readmeResult = await rawFetch(readmeApiUrl, {
      deadlineMs,
      signal,
      websitePolicy: policy,
      maxBytes: options.maxBytes,
      maxPdfBytes: options.maxPdfBytes,
      seams: options.seams,
      extraHeaders: {
        Accept: "application/vnd.github.raw+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (readmeResult.error === null && readmeResult.body.trim()) {
      let readmeBody = readmeResult.body;
      if (looksLikeHtmlDocument(readmeBody)) {
        const converted = htmlToMarkdown(readmeBody, true);
        if (converted.trim()) readmeBody = converted;
      }
      if (readmeBody.trim()) {
        return truncatePageText(
          `README of ${url} (fetched via the GitHub README API):\n\n` + readmeBody,
          maxChars,
        );
      }
    }
  }

  const result = await rawFetch(url, {
    deadlineMs,
    signal,
    websitePolicy: policy,
    maxBytes: options.maxBytes,
    maxPdfBytes: options.maxPdfBytes,
    seams: options.seams,
  });
  if (result.error !== null) return result.error;

  const isHtml = result.contentType.includes("html") || looksLikeHtml(result.body);
  if (!isHtml) return truncatePageText(result.body.trim(), maxChars);

  return truncatePageText(htmlToMarkdown(result.body, true), maxChars);
}
