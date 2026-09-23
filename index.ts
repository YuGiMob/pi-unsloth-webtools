import { defineTool, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { collapseWhitespace } from "./html-to-md.ts";
import { SEARCH_TIMEOUT_MS, webSearch as defaultWebSearch } from "./web-search.ts";
import { DEFAULT_FETCH_TIMEOUT_MS, fetchPageText as defaultFetchPageText } from "./web-fetch.ts";
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

const FORBIDDEN_FALLBACK_NOTE = "Direct fetch failed with HTTP 403; rendered via the Jina Reader instead.";

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

const WebRenderParams = Type.Object({
  url: Type.String({ description: "Public URL of the page to render" }),
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
  renderPageText?: typeof defaultRenderPageText;
  webRenderEnabled?: () => Promise<boolean>;
}

export function createWebTools(deps: WebToolsDeps = {}) {
  const fetchPageText = deps.fetchPageText ?? defaultFetchPageText;
  const webSearch = deps.webSearch ?? defaultWebSearch;
  const renderPageText = deps.renderPageText ?? defaultRenderPageText;
  const webRenderEnabled =
    deps.webRenderEnabled ?? (async () => (await readConfig()).webRenderEnabled !== false);

  const renderOnForbidden = async (
    url: string,
    failedText: string,
    options: { timeoutMs: number; maxChars?: number; signal?: AbortSignal; cwd?: string },
  ): Promise<string | null> => {
    if (!fetchWasForbidden(failedText)) return null;
    try {
      if (!(await webRenderEnabled())) return null;
      const apiKey = await loadJinaApiKey(options.cwd);
      const rendered = await renderPageText(url, {
        timeoutMs: options.timeoutMs,
        maxChars: options.maxChars,
        signal: options.signal,
        apiKey,
      });
      if (rendered.startsWith("Failed to render URL:") || rendered.startsWith("Blocked:")) return null;
      return FORBIDDEN_FALLBACK_NOTE + "\n\n" + rendered;
    } catch {
      return null;
    }
  };

  return {
    webSearchTool: defineTool({
      name: "web_search",
      label: "Web Search",
      description:
        "Search the web and return snippets for the top results. Pass url instead of query to read a page found in the same search; use web_fetch for known URLs.",
      promptSnippet: "Search the web and return snippets",
      promptGuidelines: [
        "Web tool order: web_search to discover, web_fetch for a known URL, web_render only when web_fetch cannot read the page.",
      ],
      parameters: WebSearchParams,
      renderCall(args, theme) {
        const url = collapsedArg(args.url);
        const query = collapsedArg(args.query);
        return toolCallLine(theme, "web_search", url || (query ? `"${query}"` : ""));
      },
      async execute(_toolCallId, params, signal, onUpdate, _ctx) {
        if (params.url?.trim()) {
          const url = params.url.trim();
          onUpdate?.({ content: [{ type: "text", text: `Fetching ${url}...` }], details: {} });
          const cwd = (_ctx as ExtensionContext | undefined)?.cwd;
          const { timeoutMs, maxChars, allowPrivateAddresses, allowLocalFiles } = await fetchDefaults(cwd, params);
          const text = await fetchPageText(url, {
            timeoutMs,
            signal: signal ?? undefined,
            maxChars,
            allowPrivateAddresses,
            allowLocalFiles,
          });
          const rendered = await renderOnForbidden(url, text, {
            timeoutMs,
            maxChars,
            signal: signal ?? undefined,
            cwd,
          });
          return { content: [{ type: "text", text: rendered ?? text }], details: {} };
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
        "Private/loopback/link-local targets and local files (file:// URLs, absolute, ~/ or ./ paths, including " +
        "PDFs) are supported by default; opt out with webFetch.allowPrivateAddresses: false or " +
        "webFetch.allowLocalFiles: false in settings. The download size is capped.",
      promptGuidelines: [
        "web_fetch retries an HTTP 403 through web_render automatically; never call web_render again for the same URL after a 403.",
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
        const text = await fetchPageText(params.url, {
          timeoutMs,
          signal: signal ?? undefined,
          maxChars,
          allowPrivateAddresses,
          allowLocalFiles,
        });
        const rendered = await renderOnForbidden(params.url, text, {
          timeoutMs,
          maxChars,
          signal: signal ?? undefined,
          cwd,
        });
        return { content: [{ type: "text", text: rendered ?? text }], details: {} };
      },
    }),
    webRenderTool: defineTool({
      name: "web_render",
      label: "Web Render",
      description:
        "Render a public web page to Markdown through the third-party Jina Reader (r.jina.ai). " +
        "Use it when web_fetch cannot read the page: JavaScript-rendered pages, or pages where web_fetch returned \"(page returned no readable text)\". " +
        "The target URL is sent to Jina; local files and non-public addresses are refused. " +
        "An optional JINA_API_KEY or unslothWebTools.jinaApiKey raises the Reader's rate limits.",
      promptSnippet: "Render a JavaScript-rendered page to Markdown via the Jina Reader",
      parameters: WebRenderParams,
      renderCall(args, theme) {
        return toolCallLine(theme, "web_render", collapsedArg(args.url));
      },
      async execute(_toolCallId, params, signal, onUpdate, _ctx) {
        onUpdate?.({ content: [{ type: "text", text: `Rendering ${params.url}...` }], details: {} });
        const cwd = (_ctx as ExtensionContext | undefined)?.cwd;
        const { timeoutMs, maxChars } = await fetchDefaults(cwd, params);
        const apiKey = await loadJinaApiKey(cwd);
        const text = await renderPageText(params.url, {
          timeoutMs,
          maxChars,
          signal: signal ?? undefined,
          apiKey,
        });
        return { content: [{ type: "text", text }], details: {} };
      },
    }),
  };
}

export default function (pi: ExtensionAPI) {
  const { webSearchTool, webFetchTool, webRenderTool } = createWebTools();
  pi.registerTool(webSearchTool);
  pi.registerTool(webFetchTool);
  pi.registerTool(webRenderTool);

  pi.on("session_start", async (_event, ctx) => {
    try {
      const { config, corrupted } = await readConfigWithStatus();
      if (corrupted && ctx.hasUI) {
        ctx.ui.notify("Web tools config was corrupt and was reset to defaults", "warning");
      }
      if (!config.webRenderEnabled) {
        pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "web_render"));
      }
    } catch (error) {
      console.error("Failed to load web tools config:", error);
    }
  });

  pi.registerCommand("webtools-config", {
    description: "Open the web tools settings window (web_render on/off)",
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
              const enabled = await toggleWebRender();
              const active = pi.getActiveTools();
              pi.setActiveTools(
                enabled
                  ? [...new Set([...active, "web_render"])]
                  : active.filter((name) => name !== "web_render"),
              );
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
