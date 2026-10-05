import { defineTool, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { openEngineConfig } from "./engine-config.ts";
import { collapseWhitespace, visibleChars } from "./html-to-md.ts";
import { SEARCH_TIMEOUT_MS, webSearch as defaultWebSearch } from "./web-search.ts";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchPageOutcome as defaultFetchPageOutcome,
  fetchPageText as defaultFetchPageText,
  type FetchPageOutcome,
} from "./web-fetch.ts";
import { renderPageWithLightpanda as defaultRenderLocalPageText } from "./lightpanda.ts";
import {
  loadDefaultEngines,
  loadDefaultEngineWeights,
  loadDefaultFetchSettings,
  loadDefaultMaxPerHost,
  loadLightpandaSettings,
} from "./settings.ts";

function toolCallLine(theme: Theme, name: string, detail: string) {
  const line = theme.fg("toolTitle", theme.bold(name)) + (detail ? ` ${theme.fg("accent", detail)}` : "");
  return { render: (width: number) => [truncateToWidth(line, width)], invalidate: () => {} };
}

function collapsedArg(value: unknown): string {
  return collapseWhitespace(typeof value === "string" ? value : "");
}

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
    transport: defaults.transport,
  };
}

function fetchWasForbidden(text: string): boolean {
  return /^Failed to fetch URL: HTTP 403\b/m.test(text);
}

function renderFailed(rendered: string): boolean {
  return (
    rendered.startsWith("Failed to render URL:") ||
    rendered.startsWith("Blocked:") ||
    rendered.startsWith("(page returned no readable text)")
  );
}

function renderImprovesPage(rendered: string, fetched: string): boolean {
  return visibleChars(rendered) > visibleChars(fetched) * 1.5;
}

const LOCAL_FORBIDDEN_NOTE = "Direct fetch failed with HTTP 403; rendered locally with Lightpanda instead.";
const LOCAL_THIN_NOTE = "Direct fetch returned little content; rendered locally with Lightpanda instead.";
const INCOMPLETE_NOTE = "\n\n*(JavaScript-rendered page; content may be incomplete)*";
const RENDER_HEADER_LINE_RE = /^(?:URL: |Rendered via |Title: |Author: |Date: |Site: )/;

function renderedProseChars(text: string): number {
  const prose = text
    .split("\n")
    .filter((line) => !RENDER_HEADER_LINE_RE.test(line))
    .join("\n");
  return visibleChars(prose);
}

const INTERSTITIAL_MAX_PROSE_CHARS = 4000;
const INTERSTITIAL_MARKERS = [
  "just a moment",
  "attention required",
  "you have been blocked",
  "enable javascript and cookies to continue",
  "checking if the site connection is secure",
  "access denied",
  "please enable cookies",
  "cf-error-details",
];

function looksLikeInterstitial(text: string): boolean {
  if (renderedProseChars(text) > INTERSTITIAL_MAX_PROSE_CHARS) return false;
  const lowered = text.toLowerCase();
  return INTERSTITIAL_MARKERS.some((marker) => lowered.includes(marker));
}

const WebSearchParams = Type.Object({
  query: Type.Optional(
    Type.String({ description: "The search query" }),
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
  fetchPageOutcome?: typeof defaultFetchPageOutcome;
  webSearch?: typeof defaultWebSearch;
  renderLocalPageText?: typeof defaultRenderLocalPageText;
}

export function createWebTools(deps: WebToolsDeps = {}) {
  const webSearch = deps.webSearch ?? defaultWebSearch;
  const renderLocalPageText = deps.renderLocalPageText ?? defaultRenderLocalPageText;
  const legacyFetchPageText = deps.fetchPageText;
  const fetchOutcome: typeof defaultFetchPageOutcome =
    deps.fetchPageOutcome ??
    (legacyFetchPageText
      ? async (url, options) => ({ text: await legacyFetchPageText(url, options), hint: null })
      : defaultFetchPageOutcome);

  const renderFallback = async (
    url: string,
    outcome: FetchPageOutcome,
    options: { timeoutMs: number; maxChars?: number; signal?: AbortSignal; cwd?: string },
  ): Promise<string | null> => {
    const forbidden = fetchWasForbidden(outcome.text);
    const thin = outcome.hint !== null && !forbidden;
    if (!forbidden && !thin) return null;
    const incomplete = outcome.text + INCOMPLETE_NOTE;
    const settings = await loadLightpandaSettings(options.cwd).catch(() => null);
    const rendered = await renderLocalPageText(url, {
      timeoutMs: options.timeoutMs,
      maxChars: options.maxChars,
      signal: options.signal,
      settings,
    }).catch(() => null);
    if (rendered === null) return thin ? incomplete : null;
    if (renderFailed(rendered) || looksLikeInterstitial(rendered)) return thin ? incomplete : null;
    if (thin && !renderImprovesPage(rendered, outcome.text)) return incomplete;
    return (forbidden ? LOCAL_FORBIDDEN_NOTE : LOCAL_THIN_NOTE) + "\n\n" + rendered;
  };

  return {
    webSearchTool: defineTool({
      name: "web_search",
      label: "Web Search",
      description:
        "Search the web and return snippets for the top results. Use web_fetch to read a page found in the results.",
      promptSnippet: "Search the web and return snippets",
      promptGuidelines: [
        "Web tool order: web_search to discover, then web_fetch to read a page.",
      ],
      parameters: WebSearchParams,
      renderCall(args, theme) {
        const query = collapsedArg(args.query);
        return toolCallLine(theme, "web_search", query ? `"${query}"` : "");
      },
      async execute(_toolCallId, params, signal, onUpdate, _ctx) {
        onUpdate?.({ content: [{ type: "text", text: "Searching the web..." }], details: {} });
        const timeoutParam = positiveNumber(params.timeoutMs);
        const searchCwd = (_ctx as ExtensionContext | undefined)?.cwd;
        const searchSettings = await loadDefaultFetchSettings(searchCwd);
        const searchEngines = await loadDefaultEngines(searchCwd);
        const searchEngineWeights = await loadDefaultEngineWeights(searchCwd);
        const searchMaxPerHost = await loadDefaultMaxPerHost(searchCwd);
        const searchTimeoutMs = timeoutParam ?? searchSettings.timeoutMs ?? SEARCH_TIMEOUT_MS;
        const text = await webSearch(params.query, {
          signal: signal ?? undefined,
          timeoutMs: searchTimeoutMs,
          maxResults: positiveNumber(params.maxResults),
          cwd: searchCwd,
          transport: searchSettings.transport,
          engines: searchEngines,
          engineWeights: searchEngineWeights,
          maxPerHost: searchMaxPerHost,
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
        "stripping. HTTP 403 responses are retried over a browser-fingerprint transport, and pages " +
        "that look JavaScript-rendered (or still refused) are rendered locally with Lightpanda when " +
        "the binary is installed; no third-party rendering service is involved. " +
        "Non-HTML text is returned as-is. GitHub repo root pages are rewritten to the " +
        "README API, so the README is returned instead of the repo page's UI chrome. " +
        "Private/loopback/link-local targets and local files (file:// URLs, absolute, ~/ or ./ paths, including " +
        "PDFs) are supported by default; opt out with webFetch.allowPrivateAddresses: false or " +
        "webFetch.allowLocalFiles: false in settings. The download size is capped.",
      promptGuidelines: [
        "web_fetch renders JavaScript-rendered pages locally with Lightpanda when its binary is installed; it never calls a third-party rendering service.",
      ],
      promptSnippet: "Fetch a web page and return readable text content",
      parameters: WebFetchParams,
      renderCall(args, theme) {
        return toolCallLine(theme, "web_fetch", collapsedArg(args.url));
      },
      async execute(_toolCallId, params, signal, onUpdate, _ctx) {
        onUpdate?.({ content: [{ type: "text", text: `Fetching ${params.url}...` }], details: {} });
        const cwd = (_ctx as ExtensionContext | undefined)?.cwd;
        const { timeoutMs, maxChars, allowPrivateAddresses, allowLocalFiles, transport } = await fetchDefaults(cwd, params);
        const deadlineMs = Date.now() + timeoutMs;
        const outcome = await fetchOutcome(params.url, {
          timeoutMs,
          deadlineMs,
          signal: signal ?? undefined,
          maxChars,
          allowPrivateAddresses,
          allowLocalFiles,
          transport,
        });
        const rendered = await renderFallback(params.url, outcome, {
          timeoutMs: Math.max(1, deadlineMs - Date.now()),
          maxChars,
          signal: signal ?? undefined,
          cwd,
        });
        return { content: [{ type: "text", text: rendered ?? outcome.text }], details: {} };
      },
    }),
  };
}

export default function (pi: ExtensionAPI) {
  const { webSearchTool, webFetchTool } = createWebTools();
  pi.registerTool(webSearchTool);
  pi.registerTool(webFetchTool);
  pi.registerCommand("search-engines", {
    description: "Toggle which engines web_search queries (duckduckgo and startpage by default; yandex opt-in)",
    handler: async (_args, ctx) => {
      await openEngineConfig(ctx);
    },
  });
}
