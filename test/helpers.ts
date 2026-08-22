import type {
  FetchSeams,
  HopResponse,
  RawFetchOptions,
  RawFetchResult,
  ResolvedHost,
} from "../web-fetch.ts";
import { fetchPageText } from "../web-fetch.ts";
import { deflateSync } from "node:zlib";

const deflate = deflateSync;

export function fakeResolve(ip = "93.184.216.34"): ResolvedHost {
  return { ok: true, reason: "", ip, family: 4 };
}

export function seamWithResponse(
  body: Buffer,
  contentType: string | null,
  status = 200,
  extraHeaders: Record<string, string> = {},
): FetchSeams {
  const headers: Record<string, string> = { ...extraHeaders };
  if (contentType !== null) headers["content-type"] = contentType;
  return {
    resolve: async () => fakeResolve(),
    request: async () => ({ status, headers, body }),
  };
}

export function fetchWith(
  body: Buffer,
  contentType: string | null,
  options: {
    timeoutMs?: number;
    nowMs?: () => number;
    maxBytes?: number;
    maxPdfBytes?: number;
    seams?: FetchSeams;
  } = {},
): Promise<string> {
  return fetchPageText("https://example.com/thing", {
    timeoutMs: options.timeoutMs ?? 5_000,
    nowMs: options.nowMs,
    maxBytes: options.maxBytes,
    maxPdfBytes: options.maxPdfBytes,
    seams: options.seams ?? seamFor(body, contentType),
  });
}

function seamFor(body: Buffer, contentType: string | null): FetchSeams {
  return seamWithResponse(body, contentType);
}

export function makePdf(
  pages: string[],
  options: { encrypt?: boolean; flate?: boolean } = {},
): Buffer {
  const objects: string[] = [];
  const kids: string[] = [];
  for (const text of pages) {
    const pageNum = 3 + objects.length;
    const streamNum = pageNum + 1;
    const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    const raw = Buffer.from(content, "latin1");
    const streamBytes =
      options.flate === true ? deflate(raw) : raw;
    const filter = options.flate === true ? " /Filter /FlateDecode" : "";
    kids.push(`${pageNum} 0 R`);
    objects.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${streamNum} 0 R >>\nendobj`,
    );
    objects.push(
      `${streamNum} 0 obj\n<< /Length ${streamBytes.length}${filter} >>\nstream\n${streamBytes.toString("latin1")}\nendstream\nendobj`,
    );
  }
  const encryptObj = options.encrypt
    ? "99 0 obj\n<< /Filter /Standard /V 2 /Length 128 >>\nendobj\n"
    : "";
  const encryptRef = options.encrypt ? " /Encrypt 99 0 R" : "";
  return Buffer.from(
    "%PDF-1.4\n" +
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
      `2 0 obj\n<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>\nendobj\n` +
      objects.join("\n") +
      "\n" +
      encryptObj +
      `trailer\n<< /Root 1 0 R${encryptRef} >>\n%%EOF\n`,
    "latin1",
  );
}

export async function rawFetchWith(
  body: Buffer,
  contentType: string | null,
  options: {
    status?: number;
    extraHeaders?: Record<string, string>;
    resolve?: (hostname: string, signal?: AbortSignal) => Promise<ResolvedHost>;
    request?: (opts: {
      url: URL;
      pinnedIp: string;
      family: number;
      headers: Record<string, string>;
      maxBytes: number;
      maxPdfBytes: number;
      inactivityMs: number;
      signal?: AbortSignal;
    }) => Promise<HopResponse>;
  } = {},
) {
  const seam: FetchSeams = {
    resolve: options.resolve ?? (async () => fakeResolve()),
    request: options.request,
  };
  if (!options.request) {
    seam.request = async () => ({
      status: options.status ?? 200,
      headers: {
        ...(options.extraHeaders ?? {}),
        ...(contentType !== null ? { "content-type": contentType } : {}),
      },
      body,
    });
  }
  return fetchWith(body, contentType, { seams: seam, maxBytes: 1_000_000 });
}

export type RawFetchSeam = (
  url: string,
  options: RawFetchOptions,
) => Promise<RawFetchResult>;
