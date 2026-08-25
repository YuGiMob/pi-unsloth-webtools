import type {
  FetchSeams,
  RawFetchOptions,
  RawFetchResult,
  ResolvedHost,
} from "../web-fetch.ts";
import { fetchPageText } from "../web-fetch.ts";
import { deflateSync } from "node:zlib";

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

export interface PdfLine {
  text: string;
  x?: number;
  y?: number;
  size?: number;
}

export function makePdf(
  pages: Array<string | string[] | PdfLine[]>,
  options: { encrypt?: boolean; flate?: boolean } = {},
): Buffer {
  const objects: string[] = [];
  const kids: string[] = [];
  for (let pi = 0; pi < pages.length; pi++) {
    const pageNum = 3 + 4 * pi;
    const streamNum = 4 + 4 * pi;
    const rawLines = pages[pi];
    const lines: (string | PdfLine)[] = Array.isArray(rawLines) ? rawLines : [rawLines];
    const content = lines
      .map((entry, i) => {
        const line = typeof entry === "string" ? { text: entry } : entry;
        const x = line.x ?? 72;
        const y = line.y ?? 720 - i * 16;
        const size = line.size ?? 12;
        const font = size >= 20 ? "F2" : "F1";
        return `BT /${font} ${size} Tf ${x} ${y} Td (${line.text}) Tj ET`;
      })
      .join("\n");
    const raw = Buffer.from(content, "latin1");
    const streamBytes = options.flate === true ? deflateSync(raw) : raw;
    const filter = options.flate === true ? " /Filter /FlateDecode" : "";
    kids.push(`${pageNum} 0 R`);
    objects.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents ${streamNum} 0 R >>\nendobj`,
    );
    objects.push(
      `${streamNum} 0 obj\n<< /Length ${streamBytes.length}${filter} >>\nstream\n${streamBytes.toString("latin1")}\nendstream\nendobj`,
    );
  }
  objects.push("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj");
  objects.push("6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj");
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

export type RawFetchSeam = (
  url: string,
  options: RawFetchOptions,
) => Promise<RawFetchResult>;
