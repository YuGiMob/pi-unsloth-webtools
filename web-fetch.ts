import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { inflateSync } from "node:zlib";
import type { IncomingMessage } from "node:http";
import {
  checkUrlAccess,
  githubRepoReadmeApiUrl,
  isPublicIp,
  normalizeUrlScheme,
  type WebsitePolicy,
} from "./web-access.ts";
import { htmlToMarkdown } from "./html-to-md.ts";

const MAX_PAGE_CHARS = 16000;
const MIN_PAGE_CHARS = 2000;
const MAX_FETCH_BYTES = 512 * 1024;
const MAX_PDF_FETCH_BYTES = 10 * 1024 * 1024;
const MAX_WEB_PDF_PAGES = 50;
const MAX_REDIRECTS = 5;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
];

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
  `<(?:!doctype\\s+html|/?(?:${HTML_LEADING_TAGS.join("|")})\\b)`,
);
const HTML_DOCUMENT_RE = /<(?:!doctype\s+html\b|\/?(?:html|head|body)\b)/;

const MIN_SINGLE_BYTE_ASCII_RATIO = 3 / 4;
const ASCII_TEXT_BYTES = new Set<number>([
  ...Array.from({ length: 0x7f - 0x20 }, (_, i) => i + 0x20),
  0x09,
  0x0a,
  0x0d,
  0x1b,
]);

const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

export interface FetchPageOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  websitePolicy?: WebsitePolicy | null;
  maxChars?: number;
}

interface RawFetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  extraHeaders?: Record<string, string>;
  websitePolicy?: WebsitePolicy | null;
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

function looksLikeHtmlDocument(body: string): boolean {
  const probe = body.replace(/^[ \t\n\r\f\v]+/, "").slice(0, 256).toLowerCase();
  return HTML_DOCUMENT_RE.test(probe);
}

function isTextCandidateContentType(contentType: string | null): boolean {
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

function hasPdfMagic(data: Buffer): boolean {
  const head = magicHead(data);
  const magic = Buffer.from(PDF_MAGIC);
  return head.length >= magic.length && head.subarray(0, magic.length).equals(magic);
}

function hasBinaryMagic(data: Buffer): boolean {
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
      return null;
  }
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
    } else if (cp1252 && byte in CP1252_HIGH) {
      out += String.fromCodePoint(CP1252_HIGH[byte]);
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
    default:
      return decodeSingleByte(bytes, false);
  }
}

interface ResolvedHost {
  ok: boolean;
  reason: string;
  ip: string;
  family: number;
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
      return { ok: false, reason: `Blocked: refusing to fetch non-public address ${entry.address}.`, ip: "", family: 0 };
    }
  }
  const first = addresses[0];
  return { ok: true, reason: "", ip: first.address, family: first.family };
}


function fetchBudgetExceeded(deadline: number | null, signal?: AbortSignal): string | null {
  if (signal?.aborted) return "Failed to fetch URL: cancelled.";
  if (deadline !== null && Date.now() >= deadline) return "Failed to fetch URL: timed out.";
  return null;
}

interface HopResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function requestHop(
  url: URL,
  pinnedIp: string,
  family: number,
  headers: Record<string, string>,
  maxBytes: number,
  inactivityMs: number,
  signal?: AbortSignal,
): Promise<HopResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const options: https.RequestOptions = {
      method: "GET",
      host: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
      path: url.pathname + url.search,
      headers,
      timeout: inactivityMs,
      servername: url.protocol === "https:" ? url.hostname : undefined,
      lookup: (_host, _opts, callback) => callback(null, [{ address: pinnedIp, family }]),
    };
    const request = transport.request(options, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let limit = maxBytes;
      let done = false;
      const finish = (err: string | null, body: Buffer) => {
        if (done) return;
        done = true;
        if (err) reject(new Error(err));
        else resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      };
      res.on("data", (chunk: Buffer) => {
        if (done) return;
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
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", (err) => reject(err));
    const onAbort = () => request.destroy(new Error("cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    request.end();
  });
}



function decodePdfString(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\") {
      const n = raw[i + 1];
      if (n === "n") { out += "\n"; i++; }
      else if (n === "r") { out += "\r"; i++; }
      else if (n === "t") { out += "\t"; i++; }
      else if (n === "b") { out += "\b"; i++; }
      else if (n === "f") { out += "\f"; i++; }
      else if (n === "(" || n === ")" || n === "\\") { out += n; i++; }
      else if (n >= "0" && n <= "7") {
        let octal = n;
        i++;
        let count = 1;
        while (count < 3 && i + 1 < raw.length && raw[i + 1] >= "0" && raw[i + 1] <= "7") {
          octal += raw[i + 1];
          i++;
          count++;
        }
        out += String.fromCharCode(parseInt(octal, 8));
      }
      else if (n === "\n" || n === "\r") {
        i++;
        if (raw[i + 1] === "\n") i++;
      }
      else if (n !== undefined) { out += n; i++; }
    } else {
      out += c;
    }
  }
  return out;
}

function pdfStreams(data: Buffer): Buffer[] {
  const text = data.toString("latin1");
  const streams: Buffer[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(text)) !== null) {
    const start = match.index;
    const dictStart = Math.max(0, text.lastIndexOf("<<", start));
    const dictText = text.slice(dictStart, start);
    const isFlate = /\/Filter\s*\/FlateDecode|\/FlateDecode/.test(dictText);
    const raw = Buffer.from(match[1], "latin1");
    let bytes = raw;
    if (isFlate) {
      try {
        bytes = inflateSync(raw);
      } catch {
        continue;
      }
    }
    streams.push(bytes);
  }
  return streams;
}

export function extractPdfText(data: Buffer): string {
  const streams = pdfStreams(data);
  const parts: string[] = [];
  let length = 0;
  for (let index = 0; index < streams.length && index < MAX_WEB_PDF_PAGES; index++) {
    const text = extractTextOps(streams[index]);
    if (!text) continue;
    const section = `## Page ${index + 1}\n\n${text}`;
    const remaining = MAX_PAGE_CHARS - length;
    if (remaining <= 0) break;
    if (section.length <= remaining) {
      parts.push(section);
      length += section.length;
    } else {
      parts.push(section.slice(0, remaining) + "\n\n... (truncated)");
      length = MAX_PAGE_CHARS;
      break;
    }
  }
  return parts.join("\n\n");
}

function extractTextOps(bytes: Buffer): string {
  const text = bytes.toString("latin1");
  const out: string[] = [];
  let inText = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "%") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "(") {
      let depth = 1;
      let j = i + 1;
      let raw = "";
      while (j < n && depth) {
        const ch = text[j];
        if (ch === "\\") {
          raw += ch + (text[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (depth) raw += ch;
        j++;
      }
      if (inText) out.push(decodePdfString(raw));
      i = j;
      continue;
    }
    if (c === "[") {
      const parts: string[] = [];
      let depth = 1;
      let j = i + 1;
      while (j < n && depth) {
        const ch = text[j];
        if (ch === "(") {
          let k = j + 1;
          let inner = "";
          let innerDepth = 1;
          while (k < n && innerDepth) {
            const ic = text[k];
            if (ic === "\\") { inner += ic + (text[k + 1] ?? ""); k += 2; continue; }
            if (ic === "(") innerDepth++;
            if (ic === ")") innerDepth--;
            if (innerDepth) inner += ic;
            k++;
          }
          parts.push(decodePdfString(inner));
          j = k;
          continue;
        }
        if (ch === "]") depth--;
        if (ch === "[") depth++;
        j++;
      }
      if (inText) out.push(parts.join(""));
      i = j;
      continue;
    }
    if (c === "<") {
      const close = text.indexOf(">", i + 1);
      if (close !== -1) {
        const hex = text.slice(i + 1, close).replace(/\s+/g, "");
        if (/^[0-9a-fA-F]*$/.test(hex) && hex.length % 2 === 0) {
          if (inText) out.push(Buffer.from(hex, "hex").toString("latin1"));
          i = close + 1;
          continue;
        }
      }
    }
    const token = text.slice(i, i + 3);
    if (token === "BT") { inText = true; i += 2; continue; }
    if (token === "ET") { inText = false; i += 2; continue; }
    if (token === "Td" || token === "TD" || token === "Tm" || token === "T*") {
      if (inText) out.push("\n");
      i += 2;
      continue;
    }
    i++;
  }
  return out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function fetchUrlRaw(
  url: string,
  options: RawFetchOptions = {},
): Promise<RawFetchResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const signal = options.signal;
  const deadline = Date.now() + timeoutMs;
  const policy = options.websitePolicy ?? null;

  url = normalizeUrlScheme(url);
  const [allowed, reason, hostname] = checkUrlAccess(url, policy);
  if (!allowed) return { error: reason, body: "", contentType: "" };

  let resolved = await resolveAndValidate(hostname, signal);
  if (!resolved.ok) return { error: resolved.reason, body: "", contentType: "" };

  let currentUrl = url;
  let pinnedIp = resolved.ip;
  let pinnedFamily = resolved.family;
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const budgetError = fetchBudgetExceeded(deadline, signal);
    if (budgetError !== null) return { error: budgetError, body: "", contentType: "" };
    const parsed = new URL(currentUrl);
    const hostHeader = parsed.hostname + (parsed.port ? `:${parsed.port}` : "");
    const headers: Record<string, string> = {
      "User-Agent": userAgent,
      Host: hostHeader,
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
    };
    if (options.extraHeaders) Object.assign(headers, options.extraHeaders);
    const inactivity = Math.max(1, deadline - Date.now());
    let response: HopResponse;
    try {
      response = await requestHop(
        parsed,
        pinnedIp,
        pinnedFamily,
        headers,
        MAX_FETCH_BYTES,
        inactivity,
        signal,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "cancelled") return { error: "Failed to fetch URL: cancelled.", body: "", contentType: "" };
      if (message === "timed out") return { error: "Failed to fetch URL: timed out.", body: "", contentType: "" };
      return { error: `Failed to fetch URL: ${message}`, body: "", contentType: "" };
    }

    if (response.status >= 300 && response.status < 400) {
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return {
          error: `Failed to fetch URL: HTTP ${response.status} ${statusReason(response.status)}`,
          body: "",
          contentType: "",
        };
      }
      const location = response.headers.location;
      if (!location) {
        return { error: "Failed to fetch URL: redirect missing Location header.", body: "", contentType: "" };
      }
      currentUrl = new URL(location, currentUrl).toString();
      const [redirectAllowed, redirectReason, redirectHost] = checkUrlAccess(currentUrl, policy);
      if (!redirectAllowed) return { error: redirectReason, body: "", contentType: "" };
      const redirected = await resolveAndValidate(redirectHost, signal);
      if (!redirected.ok) return { error: redirected.reason, body: "", contentType: "" };
      pinnedIp = redirected.ip;
      pinnedFamily = redirected.family;
      continue;
    }

    const contentTypeHeader = response.headers["content-type"];
    const contentType = contentTypeHeader
      ? (/^[\w.+-]+\/[\w.+-]+/.exec(contentTypeHeader.toLowerCase()) ?? [""])[0]
      : "";
    const declaredCharset = contentTypeHeader
      ? (/charset=([^;\s]+)/i.exec(contentTypeHeader)?.[1] ?? null)
      : null;

    const declaredPdf = contentType === "application/pdf";
    if (declaredPdf && response.body.length > MAX_PDF_FETCH_BYTES) {
      return { error: "(PDF content exceeds the download limit; not readable as text)", body: "", contentType };
    }
    const isPdf = declaredPdf || hasPdfMagic(response.body);
    if (isPdf) {
      let pdfText: string;
      try {
        pdfText = extractPdfText(response.body);
      } catch {
        return { error: "(PDF content could not be read as text)", body: "", contentType };
      }
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
    const rawHtml = decodeWithCodec(response.body, declaredCodec ?? bomCodec ?? "utf-8");

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

function statusReason(status: number): string {
  const reasons: Record<number, string> = {
    301: "Moved Permanently", 302: "Found", 303: "See Other", 307: "Temporary Redirect", 308: "Permanent Redirect",
  };
  return reasons[status] ?? "";
}

export function truncatePageText(text: string, maxChars: number): string {
  if (!text) return "(page returned no readable text)";
  if (text.length > maxChars) {
    return text.slice(0, maxChars) + `\n\n... (truncated, ${text.length} chars total)`;
  }
  return text;
}

export async function fetchPageText(
  url: string,
  options: FetchPageOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const signal = options.signal;
  const deadline = Date.now() + timeoutMs;
  const policy = options.websitePolicy ?? null;
  const maxChars = options.maxChars ?? MAX_PAGE_CHARS;

  url = normalizeUrlScheme(url);
  const [allowed, reason] = checkUrlAccess(url, policy);
  if (!allowed) return reason;

  const readmeApiUrl = githubRepoReadmeApiUrl(url);
  if (readmeApiUrl) {
    const readmeResult = await fetchUrlRaw(readmeApiUrl, {
      timeoutMs: Math.max(1, deadline - Date.now()),
      signal,
      websitePolicy: policy,
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

  const result = await fetchUrlRaw(url, {
    timeoutMs: Math.max(1, deadline - Date.now()),
    signal,
    websitePolicy: policy,
  });
  if (result.error !== null) return result.error;

  const isHtml = result.contentType.includes("html") || looksLikeHtml(result.body);
  if (!isHtml) return truncatePageText(result.body.trim(), maxChars);

  return truncatePageText(htmlToMarkdown(result.body, true), maxChars);
}
