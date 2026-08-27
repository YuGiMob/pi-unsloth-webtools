import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkUrlAccess, scopeSearchQuery, type WebsitePolicy } from "./web-access.ts";
import { collapseWhitespace } from "./html-to-md.ts";
import { agentDir } from "./agent-dir.ts";
import {
  autoTextSearch,
  EmptySweepError,
  SearchCancelled,
  SearchTimeoutError,
  type SearchResult,
} from "./engines.ts";

export { EmptySweepError, SearchCancelled, SearchTimeoutError } from "./engines.ts";

const SEARCH_TIMEOUT_MS = 300_000;
const MAX_RESULTS = 5;

export const EMPTY_SEARCH_RESULTS = [
  "No results found.",
  "No results found within the website access limits.",
];

export type SearchClient = (
  query: string,
  maxResults: number,
  signal?: AbortSignal,
) => Promise<SearchResult[]>;

export async function ddgSearch(
  query: string,
  maxResults = MAX_RESULTS,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  if (signal?.aborted) throw new SearchCancelled();
  return autoTextSearch(query, maxResults, SEARCH_TIMEOUT_MS, signal);
}

const POLICY_OVERFETCH = 4;

export interface WebSearchOptions {
  maxResults?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  websitePolicy?: WebsitePolicy | null;
  client?: SearchClient;
  cwd?: string;
}

async function readMaxResultsFromFile(file: string): Promise<number | undefined> {
  try {
    const raw = await readFile(file, "utf-8");
    const data = JSON.parse(raw) as {
      unslothWebTools?: { maxResults?: unknown };
      webSearch?: { maxResults?: unknown };
      smartWebSearch?: { resultsPerQuery?: unknown };
    };
    const candidate =
      data.unslothWebTools?.maxResults ??
      data.webSearch?.maxResults ??
      data.smartWebSearch?.resultsPerQuery;
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) return undefined;
    return Math.floor(candidate);
  } catch {
    return undefined;
  }
}

function clampMaxResults(value: number): number {
  return Math.min(20, Math.max(1, value));
}

export async function loadDefaultMaxResults(cwd?: string): Promise<number> {
  let result = MAX_RESULTS;
  const base = agentDir();
  const globalFile = base ? join(base, "settings.json") : "";
  const files = globalFile ? [globalFile] : [];
  if (cwd) files.push(join(cwd, ".pi", "settings.json"));
  for (const file of files) {
    const configured = await readMaxResultsFromFile(file);
    if (configured !== undefined) result = clampMaxResults(configured);
  }
  return result;
}

export async function webSearch(
  query: string | undefined,
  options: WebSearchOptions = {},
): Promise<string> {
  const maxResults = options.maxResults ?? (await loadDefaultMaxResults(options.cwd));
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const signal = options.signal;
  const policy = options.websitePolicy ?? null;
  const client = options.client ?? ddgSearch;

  if (!query || !query.trim()) return "No query provided.";
  if (signal?.aborted) return "Search cancelled.";
  try {
    const effectiveQuery = scopeSearchQuery(query, policy);
    const restricted = Boolean(
      (policy?.allowedDomains?.length ?? 0) > 0 ||
        (policy?.blockedDomains?.length ?? 0) > 0,
    );
    const wanted = restricted ? maxResults * POLICY_OVERFETCH : maxResults;
    const results = await client(effectiveQuery, wanted, signal);
    if (signal?.aborted) return "Search cancelled.";
    if (!results.length) return EMPTY_SEARCH_RESULTS[0];
    const allowed: SearchResult[] = [];
    for (const result of results) {
      if (allowed.length >= maxResults) break;
      const href = String(result.href ?? "").trim();
      if (href && !checkUrlAccess(href, policy)[0]) continue;
      allowed.push(result);
    }
    if (!allowed.length) return EMPTY_SEARCH_RESULTS[1];
    return formatSearchResults(allowed);
  } catch (err) {
    if (signal?.aborted) return "Search cancelled.";
    return searchFailureMessage(err, timeoutMs);
  }
}

export function searchFailureMessage(exc: unknown, timeoutMs = SEARCH_TIMEOUT_MS): string {
  if (exc instanceof SearchCancelled) return "Search cancelled.";
  if (exc instanceof SearchTimeoutError) {
    const providers = [...((exc as SearchTimeoutError).providers ?? [])].sort();
    if (providers.length) return `Search failed: the search engines (${providers.join(", ")}) did not respond within ${Math.round(timeoutMs / 1000)} seconds.`;
    return `Search failed: the search engines did not respond within ${Math.round(timeoutMs / 1000)} seconds.`;
  }
  if (exc instanceof EmptySweepError || (exc instanceof Error && exc.message.includes("No results found"))) {
    return EMPTY_SEARCH_RESULTS[0];
  }
  return `Search failed: ${exc instanceof Error ? exc.message : String(exc)}`;
}

export function formatSearchResults(results: SearchResult[]): string {
  const parts = results.map((result) => {
    const title = collapseWhitespace(String(result.title ?? ""));
    const href = collapseWhitespace(String(result.href ?? ""));
    const snippet = collapseWhitespace(String(result.body ?? ""));
    return `Title: ${title}\nURL: ${href}\nSnippet: ${snippet}`;
  });
  const text = parts.join("\n\n---\n\n");
  return (
    text +
    "\n\n---\n\nThese are only short snippets. " +
    'To get the full page content, call web_search with the url parameter (e.g. {"url": "<URL>"}).'
  );
}
