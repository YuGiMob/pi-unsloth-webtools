import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { webSearch } from "./web-search.ts";
import { DEFAULT_FETCH_TIMEOUT_MS, fetchPageText } from "./web-fetch.ts";

function positiveMaxChars(value: unknown): number | undefined {
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
});

const WebFetchParams = Type.Object({
  url: Type.String({ description: "URL of the page to fetch" }),
  maxChars: Type.Optional(
    Type.Number({
      description: "Truncate the returned content to this many characters (default: no limit)",
    }),
  ),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web and fetch page content. Returns snippets for all results. " +
      "Use the url parameter to fetch full page text from a specific URL.",
    promptSnippet: "Search the web and fetch page content",
    promptGuidelines: [
      "Use web_search with the url parameter (e.g. {\"url\": \"<URL>\"}) to read the full text of a page found in search results.",
    ],
    parameters: WebSearchParams,
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      if (params.url?.trim()) {
        return {
          content: [
            {
              type: "text",
              text: await fetchPageText(params.url.trim(), {
                timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
                signal: signal ?? undefined,
                maxChars: positiveMaxChars(params.maxChars),
              }),
            },
          ],
          details: {},
        };
      }
      const text = await webSearch(params.query, { signal: signal ?? undefined });
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
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
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const maxChars = positiveMaxChars(params.maxChars);
      const text = await fetchPageText(params.url, {
        timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
        signal: signal ?? undefined,
        maxChars,
      });
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
