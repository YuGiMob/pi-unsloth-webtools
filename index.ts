import { defineTool, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { collapseWhitespace, visibleChars } from "./html-to-md.ts";
import { SEARCH_TIMEOUT_MS, webSearch as defaultWebSearch } from "./web-search.ts";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchPageOutcome as defaultFetchPageOutcome,
  fetchPageText as defaultFetchPageText,
  type FetchPageOutcome,
} from "./web-fetch.ts";
import { renderPageText as defaultRenderPageText } from "./web-render.ts";
import { loadDefaultFetchSettings, loadDefaultFetchTimeoutMs, loadJinaApiKey } from "./settings.ts";
import { readConfig, readConfigWithStatus, toggleWebRender } from "./config.ts";
import { WebToolsConfigOverlay } from "./config-ui.ts";

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

const FORBIDDEN_FALLBACK_NOTE = "Direct fetch failed with HTTP 403; rendered via the Jina Reader instead.";
const THIN_FALLBACK_NOTE = "Direct fetch returned little content; rendered via the Jina Reader instead.";
const INCOMPLETE_NOTE = "\n\n*(JavaScript-rendered page; content may be incomplete)*";

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
  renderPageText?: typeof defaultRenderPageText;
  webRenderEnabled?: () => Promise<boolean>;
}

export function createWebTools(deps: WebToolsDeps = {}) {
  const webSearch = deps.webSearch ?? defaultWebSearch;
  const renderPageText = deps.renderPageText ?? defaultRenderPageText;
  const legacyFetchPageText = deps.fetchPageText;
  const fetchOutcome: typeof defaultFetchPageOutcome =
    deps.fetchPageOutcome ??
    (legacyFetchPageText
      ? async (url, options) => ({ text: await legacyFetchPageText(url, options), hint: null })
      : defaultFetchPageOutcome);
  const webRenderEnabled =
    deps.webRenderEnabled ?? (async () => (await readConfig()).webRenderEnabled !== false);

  const renderFallback = async (
    url: string,
    outcome: FetchPageOutcome,
    options: { timeoutMs: number; maxChars?: number; signal?: AbortSignal; cwd?: string },
  ): Promise<string | null> => {
    const forbidden = fetchWasForbidden(outcome.text);
    const thin = outcome.hint !== null && !forbidden;
    if (!forbidden && !thin) return null;
    const incomplete = outcome.text + INCOMPLETE_NOTE;
    try {
      if (!(await webRenderEnabled())) return thin ? incomplete : null;
      const apiKey = await loadJinaApiKey(options.cwd);
      const rendered = await renderPageText(url, {
        timeoutMs: options.timeoutMs,
        maxChars: options.maxChars,
        signal: options.signal,
        apiKey,
      });
      if (renderFailed(rendered)) return thin ? incomplete : null;
      if (thin && !renderImprovesPage(rendered, outcome.text)) return incomplete;
      return (forbidden ? FORBIDDEN_FALLBACK_NOTE : THIN_FALLBACK_NOTE) + "\n\n" + rendered;
    } catch {
      return thin ? incomplete : null;
    }
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
        "stripping. Pages that look JavaScript-rendered are retried through the Jina Reader " +
        "automatically when rendering is enabled, as are HTTP 403 responses. " +
        "Non-HTML text is returned as-is. GitHub repo root pages are rewritten to the " +
        "README API, so the README is returned instead of the repo page's UI chrome. " +
        "Private/loopback/link-local targets and local files (file:// URLs, absolute, ~/ or ./ paths, including " +
        "PDFs) are supported by default; opt out with webFetch.allowPrivateAddresses: false or " +
        "webFetch.allowLocalFiles: false in settings. The download size is capped.",
      promptGuidelines: [
        "web_fetch escalates JavaScript-rendered pages and HTTP 403 responses to the Jina Reader automatically when rendering is enabled.",
      ],
      promptSnippet: "Fetch a web page and return readable text content",
      parameters: WebFetchParams,
      renderCall(args, theme) {
        return toolCallLine(theme, "web_fetch", collapsedArg(args.url));
      },
      async execute(_toolCallId, params, signal, onUpdate, _ctx) {
        onUpdate?.({ content: [{ type: "text", text: `Fetching ${params.url}...` }], details: {} });
        const cwd = (_ctx as ExtensionContext | undefined)?.cwd;
        const { timeoutMs, maxChars, allowPrivateAddresses, allowLocalFiles } = await fetchDefaults(cwd, params);
        const deadlineMs = Date.now() + timeoutMs;
        const outcome = await fetchOutcome(params.url, {
          timeoutMs,
          deadlineMs,
          signal: signal ?? undefined,
          maxChars,
          allowPrivateAddresses,
          allowLocalFiles,
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

  pi.on("session_start", async (_event, ctx) => {
    try {
      const { corrupted } = await readConfigWithStatus();
      if (corrupted && ctx.hasUI) {
        ctx.ui.notify("Web tools config was corrupt and was reset to defaults", "warning");
      }
    } catch (error) {
      console.error("Failed to load web tools config:", error);
    }
  });

  pi.registerCommand("webtools-config", {
    description: "Open the web tools settings window (JavaScript rendering on/off)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/webtools-config requires interactive mode", "error");
        return;
      }
      await ctx.ui.custom<void>(
        async (tui, theme, _keybindings, done) => {
          const overlay = new WebToolsConfigOverlay({
            tui,
            theme,
            done,
            onToggle: async (key) => {
              if (key !== "webRenderEnabled") return;
              await toggleWebRender();
            },
          });
          await overlay.load();
          return overlay;
        },
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "90%", minWidth: 60, maxHeight: "90%" },
        },
      );
    },
  });
}
