import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SEARCH_TIMEOUT_MS, webSearch as defaultWebSearch } from "./web-search.ts";
import { DEFAULT_FETCH_TIMEOUT_MS, fetchPageText as defaultFetchPageText } from "./web-fetch.ts";
import { loadDefaultFetchSettings, loadDefaultFetchTimeoutMs } from "./settings.ts";

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n > 0 ? n : undefined;
}
async function fetchDefaults(cwd: string | undefined, params: { timeoutMs?: unknown; maxChars?: unknown }) {
  const timeoutParam = positiveNumber(params.timeoutMs);
  const maxCharsParam = positiveNumber(params.maxChars);
  const defaults = await loadDefaultFetchSettings(cwd);
  return {
    timeoutMs: timeoutParam ?? defaults.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    maxChars: maxCharsParam ?? defaults.maxChars,
    allowPrivateAddresses: defaults.allowPrivateAddresses,
    allowLocalFiles: defaults.allowLocalFiles,
  };
}

const WebSearchParams = Type.Object({
  query: Type.Optional(
    Type.String({ description: "The search query" }),
  ),
  url: Type.Optional(
    Type.String({
      description:
        "A URL to fetch full page content from (instead of searching). Use this to read a page found in search results.",
    }),
  ),
  maxChars: Type.Optional(
    Type.Number({
      description:
        "Truncate the fetched page to this many characters (only used with the url parameter)",
    }),
  ),
  maxResults: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 20,
      description: "Maximum number of search results to return (default: 5)",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      minimum: 1000,
      description: "Overall timeout in milliseconds for the search or fetch",
    }),
  ),
});

const WebFetchParams = Type.Object({
  url: Type.String({ description: "URL of the page to fetch" }),
  maxChars: Type.Optional(
    Type.Number({
      description: "Truncate the returned content to this many characters (default: no limit)",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      minimum: 1000,
      description: "Overall timeout in milliseconds (default: 60000)",
    }),
  ),
});

export interface WebToolsDeps {
  fetchPageText?: typeof defaultFetchPageText;
  webSearch?: typeof defaultWebSearch;
}

export function createWebTools(deps: WebToolsDeps = {}) {
  const fetchPageText = deps.fetchPageText ?? defaultFetchPageText;
  const webSearch = deps.webSearch ?? defaultWebSearch;
  return {
    webSearchTool: defineTool({
      name: "web_search",
      label: "Web Search",
      description:
        "Search the web and fetch page content. Returns snippets for all results. " +
        "Use the url parameter to fetch full page text from a specific URL.",
      promptSnippet: "Search the web and fetch page content",
      promptGuidelines: [
        'Use web_search with the url parameter (e.g. {"url": "<URL>"}) to read the full text of a page found in search results.',
      ],
      parameters: WebSearchParams,
      async execute(_toolCallId, params, signal, onUpdate, _ctx) {
        if (params.url?.trim()) {
          const url = params.url.trim();
          onUpdate?.({ content: [{ type: "text", text: `Fetching ${url}...` }], details: {} });
          const cwd = (_ctx as ExtensionContext | undefined)?.cwd;
          const { timeoutMs, maxChars, allowPrivateAddresses, allowLocalFiles } = await fetchDefaults(cwd, params);
          return {
            content: [
              {
                type: "text",
                text: await fetchPageText(url, {
                  timeoutMs,
                  signal: signal ?? undefined,
                  maxChars,
                  allowPrivateAddresses,
                  allowLocalFiles,
                }),
              },
            ],
            details: {},
          };
        }
        onUpdate?.({ content: [{ type: "text", text: "Searching the web..." }], details: {} });
        const timeoutParam = positiveNumber(params.timeoutMs);
        const searchCwd = (_ctx as ExtensionContext | undefined)?.cwd;
        const searchTimeoutMs = timeoutParam ?? (await loadDefaultFetchTimeoutMs(searchCwd)) ?? SEARCH_TIMEOUT_MS;
        const text = await webSearch(params.query, {
          signal: signal ?? undefined,
          timeoutMs: searchTimeoutMs,
          maxResults: positiveNumber(params.maxResults),
          cwd: searchCwd,
        });
        return { content: [{ type: "text", text }], details: {} };
      },
    }),
    webFetchTool: defineTool({
      name: "web_fetch",
      label: "Web Fetch",
      description:
        "Fetch a URL and return its readable text. HTML pages are converted to Markdown using a " +
        "main-content heuristic: article/main scoping plus hidden-element and boilerplate " +
        "stripping. Non-HTML text is returned as-is. GitHub repo root pages are rewritten to the " +
        "README API, so the README is returned instead of the repo page's UI chrome. " +
        "Private/loopback/link-local targets are blocked (SSRF protection) unless webFetch.allowPrivateAddresses is " +
        "enabled in settings, and reading local files (file:// URLs, absolute, ~/ or ./ paths, including PDFs) needs " +
        "webFetch.allowLocalFiles. The download size is capped.",
      promptSnippet: "Fetch a web page and return readable text content",
      parameters: WebFetchParams,
      async execute(_toolCallId, params, signal, onUpdate, _ctx) {
        onUpdate?.({ content: [{ type: "text", text: `Fetching ${params.url}...` }], details: {} });
        const cwd = (_ctx as ExtensionContext | undefined)?.cwd;
        const { timeoutMs, maxChars, allowPrivateAddresses, allowLocalFiles } = await fetchDefaults(cwd, params);
        const text = await fetchPageText(params.url, {
          timeoutMs,
          signal: signal ?? undefined,
          maxChars,
          allowPrivateAddresses,
          allowLocalFiles,
        });
        return { content: [{ type: "text", text }], details: {} };
      },
    }),
  };
}

export default function (pi: ExtensionAPI) {
  const { webSearchTool, webFetchTool } = createWebTools();
  pi.registerTool(webSearchTool);
  pi.registerTool(webFetchTool);
}
