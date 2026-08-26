import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { webSearch as defaultWebSearch } from "./web-search.ts";
import { DEFAULT_FETCH_TIMEOUT_MS, fetchPageText as defaultFetchPageText } from "./web-fetch.ts";

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
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
          return {
            content: [
              {
                type: "text",
                text: await fetchPageText(url, {
                  timeoutMs: positiveNumber(params.timeoutMs) ?? DEFAULT_FETCH_TIMEOUT_MS,
                  signal: signal ?? undefined,
                  maxChars: positiveNumber(params.maxChars),
                }),
              },
            ],
            details: {},
          };
        }
        onUpdate?.({ content: [{ type: "text", text: "Searching the web..." }], details: {} });
        const text = await webSearch(params.query, {
          signal: signal ?? undefined,
          timeoutMs: positiveNumber(params.timeoutMs),
          maxResults: positiveNumber(params.maxResults),
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
        "Private/loopback/link-local targets are blocked (SSRF protection), and the download size " +
        "is capped.",
      promptSnippet: "Fetch a web page and return readable text content",
      parameters: WebFetchParams,
      async execute(_toolCallId, params, signal, onUpdate, _ctx) {
        onUpdate?.({ content: [{ type: "text", text: `Fetching ${params.url}...` }], details: {} });
        const text = await fetchPageText(params.url, {
          timeoutMs: positiveNumber(params.timeoutMs) ?? DEFAULT_FETCH_TIMEOUT_MS,
          signal: signal ?? undefined,
          maxChars: positiveNumber(params.maxChars),
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
