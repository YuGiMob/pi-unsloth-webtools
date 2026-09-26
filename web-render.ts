import { collapseWhitespace } from "./html-to-md.ts";
import { checkUrlAccess, MAX_SIGNAL_TIMEOUT_MS, normalizeUrlScheme, type WebsitePolicy } from "./web-access.ts";
import { parseLocalPath, resolveAndValidateHost, truncatePageText } from "./web-fetch.ts";

const DEFAULT_RENDER_TIMEOUT_MS = 60_000;
const JINA_READER_URL = "https://r.jina.ai/";
const CANCELLED_MESSAGE = "Failed to render URL: cancelled.";
const TIMED_OUT_MESSAGE = "Failed to render URL: timed out.";
const LOCAL_FILE_MESSAGE = "Blocked: the Jina Reader cannot fetch local files.";
const EMPTY_READER_MESSAGE = "Failed to render URL: the Jina Reader returned no content.";

export interface RenderPageOptions {
  timeoutMs?: number;
  maxChars?: number;
  signal?: AbortSignal;
  websitePolicy?: WebsitePolicy | null;
  apiKey?: string;
}

interface JinaReaderData {
  title?: string;
  url?: string;
  content?: string;
}

interface JinaReaderPayload {
  data?: JinaReaderData;
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_RENDER_TIMEOUT_MS;
  return Math.min(MAX_SIGNAL_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}

function budgetMessage(caller: AbortSignal | undefined, signal: AbortSignal): string | null {
  if (caller?.aborted) return CANCELLED_MESSAGE;
  if (signal.aborted) return TIMED_OUT_MESSAGE;
  return null;
}

async function readerErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { readableMessage?: unknown; message?: unknown; detail?: unknown };
    const detail = [body.readableMessage, body.message, body.detail].find(
      (value) => typeof value === "string" && value.trim().length > 0,
    );
    if (detail) return `${response.status} ${detail}`;
  } catch {}
  return `${response.status} ${response.statusText}`.trim();
}

function formatRenderedPage(data: JinaReaderData, fallbackUrl: string, maxChars: number | undefined): string {
  const title = collapseWhitespace(String(data.title ?? ""));
  const finalUrl = collapseWhitespace(String(data.url ?? "")) || fallbackUrl;
  const content = String(data.content ?? "").trim();
  if (!content) return truncatePageText("", maxChars);
  const header: string[] = [];
  if (title) header.push(`Title: ${title}`);
  header.push(`URL: ${finalUrl}`);
  header.push("Rendered via the Jina Reader (r.jina.ai).");
  return truncatePageText(`${header.join("\n")}\n\n${content}`, maxChars);
}

export async function renderPageText(url: string, options: RenderPageOptions = {}): Promise<string> {
  const target = typeof url === "string" ? url.trim() : "";
  const policy = options.websitePolicy ?? null;
  if (!target) return checkUrlAccess("", policy)[1];
  if (parseLocalPath(target) !== null) return LOCAL_FILE_MESSAGE;
  const normalized = normalizeUrlScheme(target);
  const [allowed, reason, hostname] = checkUrlAccess(normalized, policy);
  if (!allowed) return reason;
  const timeoutSignal = AbortSignal.timeout(clampTimeout(options.timeoutMs));
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const resolved = await resolveAndValidateHost(hostname, signal, false);
  const resolutionBudget = budgetMessage(options.signal, signal);
  if (resolutionBudget !== null) return resolutionBudget;
  if (!resolved.ok) return resolved.reason;
  const headers: Record<string, string> = { Accept: "application/json" };
  const apiKey = options.apiKey?.trim();
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  let response: Response;
  try {
    response = await fetch(JINA_READER_URL + encodeURIComponent(normalized), { headers, signal });
  } catch (err) {
    const budget = budgetMessage(options.signal, signal);
    if (budget !== null) return budget;
    return `Failed to render URL: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!response.ok) return `Failed to render URL: ${await readerErrorDetail(response)}`;
  let payload: JinaReaderPayload;
  try {
    payload = (await response.json()) as JinaReaderPayload;
  } catch {
    const budget = budgetMessage(options.signal, signal);
    if (budget !== null) return budget;
    return `Failed to render URL: the Jina Reader returned a non-JSON response (HTTP ${response.status}).`;
  }
  if (!payload || !payload.data) return EMPTY_READER_MESSAGE;
  return formatRenderedPage(payload.data, normalized, options.maxChars);
}