import { MAX_SIGNAL_TIMEOUT_MS } from "./web-access.ts";

const MODULE_NAME = "wreq-js";
const DEFAULT_PROFILE = "chrome_145";
const DEFAULT_OS = "windows";
const TRANSPORT_CACHE_LIMIT = 8;

const HOP_HEADER_EXCLUSIONS = new Set(["host", "user-agent", "accept-encoding", "content-length"]);
const PDF_MAGIC = Buffer.from("%PDF-");
const MAGIC_HEAD_BYTES = 1024;
const SKIPPED_MAGIC_PREFIX_BYTES = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);
const BOM_PREFIXES = [
  Buffer.from([0xff, 0xfe, 0x00, 0x00]),
  Buffer.from([0x00, 0x00, 0xfe, 0xff]),
  Buffer.from([0xff, 0xfe]),
  Buffer.from([0xfe, 0xff]),
  Buffer.from([0xef, 0xbb, 0xbf]),
];

function looksLikePdf(head: Buffer): boolean {
  let start = 0;
  while (start < head.length && SKIPPED_MAGIC_PREFIX_BYTES.has(head[start])) start++;
  for (const bom of BOM_PREFIXES) {
    if (head.subarray(start).length >= bom.length && head.subarray(start, start + bom.length).equals(bom)) {
      start += bom.length;
      while (start < head.length && SKIPPED_MAGIC_PREFIX_BYTES.has(head[start])) start++;
      break;
    }
  }
  const magic = head.subarray(start);
  return magic.length >= PDF_MAGIC.length && magic.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

interface ImpersonationResponse {
  status: number;
  url: string;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
}

interface ImpersonationTransport {
  close?(): Promise<void>;
}

interface ImpersonationModule {
  createTransport(options: Record<string, unknown>): Promise<ImpersonationTransport>;
  fetch(input: string, init: Record<string, unknown>): Promise<ImpersonationResponse>;
}

export type ImpersonationLoader = () => Promise<ImpersonationModule | null>;

export interface TlsHopOptions {
  url: URL;
  pinnedIp: string;
  family: number;
  timeoutMs: number;
  signal?: AbortSignal;
  maxBytes: number;
  maxPdfBytes?: number;
  profile?: string;
  extraHeaders?: Record<string, string>;
  loader?: ImpersonationLoader;
}

export interface TlsHopResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
}

let cachedModule: Promise<ImpersonationModule | null> | null = null;

async function loadImpersonationModule(): Promise<ImpersonationModule | null> {
  cachedModule ??= (async () => {
    try {
      return (await import(MODULE_NAME)) as unknown as ImpersonationModule;
    } catch {
      return null;
    }
  })();
  return cachedModule;
}

const transports = new Map<string, Promise<ImpersonationTransport>>();

function transportKey(options: TlsHopOptions): string {
  return `${options.profile ?? DEFAULT_PROFILE}|${options.url.hostname}|${options.pinnedIp}|${options.family}`;
}

function evictTransports(): void {
  while (transports.size > TRANSPORT_CACHE_LIMIT) {
    const oldestKey = transports.keys().next().value as string | undefined;
    if (oldestKey === undefined) return;
    const oldest = transports.get(oldestKey);
    transports.delete(oldestKey);
    void oldest
      ?.then((transport) => transport.close?.())
      .catch(() => {});
  }
}

async function transportFor(
  module: ImpersonationModule,
  options: TlsHopOptions,
): Promise<ImpersonationTransport> {
  const key = transportKey(options);
  const existing = transports.get(key);
  if (existing) return existing;
  const created = module
    .createTransport({
      resolve: { [options.url.hostname]: options.pinnedIp },
      browser: options.profile ?? DEFAULT_PROFILE,
      os: DEFAULT_OS,
    })
    .catch((error: unknown) => {
      transports.delete(key);
      throw error;
    });
  transports.set(key, created);
  evictTransports();
  return created;
}

async function readCapped(
  body: AsyncIterable<Uint8Array> | null,
  maxBytes: number,
  maxPdfBytes: number,
): Promise<{ buffer: Buffer; truncated: boolean }> {
  if (!body) return { buffer: Buffer.alloc(0), truncated: false };
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  let head = Buffer.alloc(0);
  let limit = maxBytes;
  for await (const chunk of body) {
    const buffer = Buffer.from(chunk);
    if (head.length < MAGIC_HEAD_BYTES) {
      head = Buffer.concat([head, buffer.subarray(0, MAGIC_HEAD_BYTES - head.length)]);
      if (limit === maxBytes && looksLikePdf(head)) limit = maxPdfBytes;
    }
    if (total + buffer.length > limit) {
      const take = buffer.subarray(0, limit - total);
      chunks.push(take);
      total += take.length;
      truncated = true;
      break;
    }
    chunks.push(buffer);
    total += buffer.length;
  }
  return { buffer: Buffer.concat(chunks), truncated };
}

function failureMessage(error: unknown, caller: AbortSignal | undefined, attempt: AbortSignal): string {
  if (caller?.aborted) return "cancelled";
  if (attempt.aborted) return "timed out";
  if (error instanceof Error && error.name === "TimeoutError") return "timed out";
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  return error instanceof Error ? error.message : String(error);
}

function hopHeaders(extraHeaders: Record<string, string> | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(extraHeaders ?? {})) {
    if (HOP_HEADER_EXCLUSIONS.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  return headers;
}

export async function impersonatedRequest(options: TlsHopOptions): Promise<TlsHopResponse | null> {
  const load = options.loader ?? loadImpersonationModule;
  const module = await load();
  if (!module) return null;
  const transport = await transportFor(module, options);
  const timeoutMs = Math.min(MAX_SIGNAL_TIMEOUT_MS, Math.max(1, Math.floor(options.timeoutMs)));
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let response: ImpersonationResponse;
  try {
    response = await module.fetch(options.url.toString(), {
      transport,
      redirect: "manual",
      signal,
      headers: hopHeaders(options.extraHeaders),
    });
  } catch (error) {
    throw new Error(failureMessage(error, options.signal, signal));
  }
  if (response.status < 200) return null;
  const { buffer, truncated } = await readCapped(
    response.body,
    options.maxBytes,
    options.maxPdfBytes ?? options.maxBytes,
  );
  const headers: Record<string, string> = {};
  const contentType = response.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (location) headers.location = location;
  }
  return { status: response.status, headers, body: buffer, truncated };
}
