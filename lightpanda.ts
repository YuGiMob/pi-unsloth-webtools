import { spawn as spawnProcess } from "node:child_process";
import { visibleChars } from "./html-to-md.ts";
import {
  checkUrlAccess,
  MAX_SIGNAL_TIMEOUT_MS,
  normalizeUrlScheme,
  type WebsitePolicy,
} from "./web-access.ts";
import {
  pagePrefixedMarkdown,
  parseLocalPath,
  resolveAndValidateHost,
  TRUNCATED_BODY_NOTICE,
  truncatePageText,
  type ResolvedHost,
} from "./web-fetch.ts";

const DEFAULT_BINARY = "lightpanda";
const DEFAULT_WAIT_UNTIL = "networkidle";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_DUMP_BYTES = 4 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 5_000;
const METADATA_LINE_RE = /^(?:Title|Author|Date|Site|URL|Rendered via): /;
const PROVENANCE = "Rendered via Lightpanda (local browser; nothing sent to a third party).";
const CANCELLED_MESSAGE = "Failed to render URL: cancelled.";
const TIMED_OUT_MESSAGE = "Failed to render URL: timed out.";
const LOCAL_FILE_MESSAGE = "Blocked: the local renderer cannot fetch local files.";
const NO_TEXT_MESSAGE = "(page returned no readable text)";

export type LightpandaDump = "html" | "markdown";
export type LightpandaWaitUntil = "networkidle" | "load" | "domcontentloaded" | "done";

export interface LightpandaSettings {
  enabled: boolean;
  binaryPath: string | null;
}

interface LightpandaProcess {
  stdout: AsyncIterable<Buffer> | null;
  stderr: AsyncIterable<Buffer> | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal?: string): unknown;
}

export type LightpandaSpawn = (
  binary: string,
  args: string[],
  options: { stdio: ["ignore", "pipe", "pipe"] },
) => LightpandaProcess;

export interface LightpandaRenderOptions {
  timeoutMs?: number;
  maxChars?: number;
  signal?: AbortSignal;
  websitePolicy?: WebsitePolicy | null;
  settings?: LightpandaSettings | null;
  binaryPath?: string | null;
  dump?: LightpandaDump;
  waitUntil?: LightpandaWaitUntil;
  spawn?: LightpandaSpawn;
  resolve?: (hostname: string, signal?: AbortSignal, allowPrivateAddresses?: boolean) => Promise<ResolvedHost>;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  missing: boolean;
}

const availability = new Map<string, Promise<boolean>>();

function binaryAvailable(binary: string, spawn: LightpandaSpawn): Promise<boolean> {
  const cached = availability.get(binary);
  if (cached) return cached;
  const probe = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(false);
    }, PROBE_TIMEOUT_MS);
    let child: LightpandaProcess;
    try {
      child = spawn(binary, ["version"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      finish(false);
      return;
    }
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
  availability.set(binary, probe);
  return probe;
}

function runLightpanda(
  binary: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal; spawn: LightpandaSpawn },
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const state = {
      code: null as number | null,
      stdout: [] as Buffer[],
      stderr: [] as string[],
      timedOut: false,
      cancelled: false,
      truncated: false,
      missing: false,
      bytes: 0,
    };
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") state.missing = true;
      const stdout = Buffer.concat(state.stdout).toString("utf-8");
      resolve({ ...state, stdout, stderr: state.stderr.join("") });
    };
    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {}
    };
    const onAbort = () => {
      state.cancelled = true;
      kill();
    };
    const timer = setTimeout(() => {
      state.timedOut = true;
      kill();
    }, options.timeoutMs);
    let child: LightpandaProcess;
    try {
      child = options.spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const collect = async (stream: AsyncIterable<Buffer> | null, push: (chunk: Buffer) => void): Promise<void> => {
      if (!stream) return;
      try {
        for await (const chunk of stream) push(chunk);
      } catch {}
    };
    const stdoutDone = collect(child.stdout, (chunk) => {
      if (state.bytes >= MAX_DUMP_BYTES) {
        state.truncated = true;
        return;
      }
      state.bytes += chunk.length;
      if (state.bytes > MAX_DUMP_BYTES) {
        state.truncated = true;
        state.stdout.push(chunk.subarray(0, chunk.length - (state.bytes - MAX_DUMP_BYTES)));
        return;
      }
      state.stdout.push(chunk);
    });
    const stderrDone = collect(child.stderr, (chunk) => state.stderr.push(chunk.toString("utf-8")));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      state.code = code;
      void Promise.all([stdoutDone, stderrDone]).then(() => finish(null));
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

function bodyChars(text: string): number {
  const body = text
    .split("\n")
    .filter((line) => !METADATA_LINE_RE.test(line))
    .join("\n");
  return visibleChars(body);
}

function withProvenance(prefixed: string, url: string): string {
  const lines = prefixed.split("\n");
  let index = 0;
  while (index < lines.length && METADATA_LINE_RE.test(lines[index])) index++;
  const header = [`URL: ${url}`, PROVENANCE];
  if (index === 0) return `${header.join("\n")}\n\n${prefixed}`;
  return [...lines.slice(0, index), ...header, ...lines.slice(index)].join("\n");
}

export function lightpandaBinary(options: LightpandaRenderOptions = {}): string {
  return (
    options.binaryPath ??
    options.settings?.binaryPath ??
    process.env.PI_LIGHTPANDA_BIN?.trim() ??
    DEFAULT_BINARY
  );
}

export async function renderPageWithLightpanda(
  url: string,
  options: LightpandaRenderOptions = {},
): Promise<string | null> {
  if (options.settings && options.settings.enabled === false) return null;
  const target = typeof url === "string" ? url.trim() : "";
  const policy = options.websitePolicy ?? null;
  if (!target) return checkUrlAccess("", policy)[1];
  if (parseLocalPath(target) !== null) return LOCAL_FILE_MESSAGE;
  const normalized = normalizeUrlScheme(target);
  const [allowed, reason, hostname] = checkUrlAccess(normalized, policy);
  if (!allowed) return reason;
  const binary = lightpandaBinary(options);
  const spawn = options.spawn ?? (spawnProcess as unknown as LightpandaSpawn);
  if (!(await binaryAvailable(binary, spawn))) return null;
  const timeoutMs = Math.min(
    MAX_SIGNAL_TIMEOUT_MS,
    Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
  );
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const resolve = options.resolve ?? resolveAndValidateHost;
  const resolved = await resolve(hostname, signal, false);
  if (options.signal?.aborted) return CANCELLED_MESSAGE;
  if (timeoutSignal.aborted) return TIMED_OUT_MESSAGE;
  if (!resolved.ok) {
    return resolved.reason.startsWith("Blocked:") ? resolved.reason : `Failed to render URL: ${resolved.reason}`;
  }
  const dump = options.dump ?? "html";
  const result = await runLightpanda(
    binary,
    [
      "fetch",
      "--dump",
      dump,
      "--wait-until",
      options.waitUntil ?? DEFAULT_WAIT_UNTIL,
      "--block-private-networks",
      "--http-timeout",
      String(timeoutMs),
      normalized,
    ],
    { timeoutMs, signal: options.signal, spawn },
  );
  if (result.missing) return null;
  if (result.cancelled) return CANCELLED_MESSAGE;
  if (result.timedOut) return TIMED_OUT_MESSAGE;
  if (result.code !== 0) {
    return `Failed to render URL: Lightpanda exited with code ${result.code ?? "unknown"}.`;
  }
  const raw = result.stdout;
  const rendered =
    dump === "html" ? pagePrefixedMarkdown(result.truncated ? raw + TRUNCATED_BODY_NOTICE : raw) : raw.trim();
  if (bodyChars(rendered) === 0) return NO_TEXT_MESSAGE;
  const withHeader =
    dump === "html" || !result.truncated ? withProvenance(rendered, normalized) : withProvenance(rendered + TRUNCATED_BODY_NOTICE, normalized);
  return truncatePageText(withHeader, options.maxChars);
}
