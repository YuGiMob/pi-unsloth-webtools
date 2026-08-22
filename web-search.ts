import { decodeHtmlEntities } from "./html-to-md.ts";
import { checkUrlAccess, scopeSearchQuery, type WebsitePolicy } from "./web-access.ts";

const SEARCH_URL = "https://html.duckduckgo.com/html/";
const SEARCH_TIMEOUT_MS = 20_000;
const MAX_RESULTS = 5;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
];

export const EMPTY_SEARCH_RESULTS = [
  "No results found.",
  "No results found within the website access limits.",
];

export interface SearchResult {
  title: string;
  href: string;
  body: string;
}

const RESULT_ANCHOR_RE = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
const SNIPPET_RE = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/;

function stripTags(text: string): string {
  return decodeHtmlEntities(text.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}


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
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html,application/xhtml+xml",
      },
      body: new URLSearchParams({ q: query }).toString(),
      signal: controller.signal,
      redirect: "follow",
    });
    if (response.status === 403 || response.status === 429 || response.status === 202) {
      throw new RateLimitError();
    }
    const html = await response.text();
    if (/anomaly|unusual traffic|blocked/i.test(html.slice(0, 4000))) {
      throw new RateLimitError();
    }
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    const anchors = [...html.matchAll(RESULT_ANCHOR_RE)];
    for (const anchor of anchors) {
      if (results.length >= maxResults) break;
      const href = decodeDdgHref(anchor[1]);
      if (seen.has(href)) continue;
      seen.add(href);
      const title = stripTags(anchor[2]);
      if (!title || !href) continue;
      const windowStart = (anchor.index ?? 0) + anchor[0].length;
      const windowHtml = html.slice(windowStart, windowStart + 4000);
      const snippetMatch = SNIPPET_RE.exec(windowHtml);
      const body = snippetMatch ? stripTags(snippetMatch[1] ?? snippetMatch[2] ?? "") : "";
      results.push({ title, href, body });
    }
    return results;
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    if (signal?.aborted) throw new SearchCancelled();
    if (controller.signal.aborted) throw new SearchTimeoutError();
    throw err;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

function decodeDdgHref(href: string): string {
  const uddg = /[?&]uddg=([^&]+)/.exec(href);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]);
    } catch {
      return href;
    }
  }
  return href;
}

export class RateLimitError extends Error {
  constructor() {
    super("rate limited");
  }
}

export class EmptySweepError extends Error {
  constructor() {
    super("No results found");
  }
}

export class SearchCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

export class SearchTimeoutError extends Error {
  constructor() {
    super("timed out");
  }
}

const POLICY_OVERFETCH = 4;

export interface WebSearchOptions {
  maxResults?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  websitePolicy?: WebsitePolicy | null;
  client?: SearchClient;
}

export async function webSearch(
  query: string | undefined,
  options: WebSearchOptions = {},
): Promise<string> {
  const maxResults = options.maxResults ?? 5;
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
    const parts: string[] = [];
    for (const result of results) {
      if (parts.length >= maxResults) break;
      const href = String(result.href ?? "").trim();
      if (href && !checkUrlAccess(href, policy)[0]) continue;
      const title = String(result.title ?? "").replace(/\s+/g, " ");
      const snippet = String(result.body ?? "").replace(/\s+/g, " ");
      parts.push(`Title: ${title}\nURL: ${href}\nSnippet: ${snippet}`);
    }
    if (!parts.length) return EMPTY_SEARCH_RESULTS[1];
    const text = parts.join("\n\n---\n\n");
    return (
      text +
      "\n\n---\n\nIMPORTANT: These are only short snippets. " +
      'To get the full page content, call web_search with the url parameter (e.g. {"url": "<URL>"}).'
    );
  } catch (err) {
    return searchFailureMessage(err, timeoutMs);
  }
}

export function searchFailureMessage(exc: unknown, timeoutMs = SEARCH_TIMEOUT_MS): string {
  if (exc instanceof RateLimitError) {
    return (
      "Search failed: the search engines are rate limiting this machine. Wait a minute " +
      'before searching again, or read a known page directly with {"url": "<URL>"}.'
    );
  }
  if (exc instanceof SearchCancelled) return "Search cancelled.";
  if (exc instanceof SearchTimeoutError) {
    return `Search failed: the search engines did not respond within ${Math.round(timeoutMs / 1000)}s.`;
  }
  if (exc instanceof EmptySweepError || (exc instanceof Error && exc.message.includes("No results found"))) {
    return EMPTY_SEARCH_RESULTS[0];
  }
  return `Search failed: ${exc instanceof Error ? exc.message : String(exc)}`;
}

export function formatSearchResults(results: SearchResult[]): string {
  const parts = results.map((result) => {
    const title = result.title.replace(/\s+/g, " ");
    const href = result.href.trim();
    const snippet = result.body.replace(/\s+/g, " ");
    return `Title: ${title}\nURL: ${href}\nSnippet: ${snippet}`;
  });
  const text = parts.join("\n\n---\n\n");
  return (
    text +
    "\n\n---\n\nIMPORTANT: These are only short snippets. " +
    'To get the full page content, call web_search with the url parameter (e.g. {"url": "<URL>"}).'
  );
}
