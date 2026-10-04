import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerExtension, { createWebTools } from "../index.ts";
import type { FetchPageOptions, RenderHint } from "../web-fetch.ts";
import type { WebSearchOptions } from "../web-search.ts";

function firstText(update: { content: { type: string; text?: string }[] }): string {
  return update.content[0]?.text ?? "";
}

function callText(component: { render(width: number): string[] } | undefined): string {
  return component?.render(80).join("\n") ?? "";
}

function textOf(result: unknown): string {
  const content = (result as { content?: { text?: string }[] } | undefined)?.content;
  return content?.[0]?.text ?? "";
}

function makeHarness(): { tools: string[]; commands: string[]; handlers: string[] } {
  const tools: string[] = [];
  const commands: string[] = [];
  const handlers: string[] = [];
  const pi = {
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerCommand: (name: string) => commands.push(name),
    on: (name: string) => handlers.push(name),
  } as unknown as ExtensionAPI;
  registerExtension(pi);
  return { tools, commands, handlers };
}

describe("extension registration", () => {
  it("registers the web tools and nothing else", () => {
    const harness = makeHarness();
    expect(harness.tools).toEqual(["web_search", "web_fetch"]);
    expect(harness.commands).toEqual([]);
    expect(harness.handlers).toEqual([]);
  });
});

describe("web_search tool", () => {
  it("searches in query mode with maxResults and timeoutMs", async () => {
    const webSearch = vi.fn(
      async (_query: string | undefined, _options?: WebSearchOptions) => "results",
    );
    const { webSearchTool } = createWebTools({ webSearch });
    const result = await webSearchTool.execute(
      "id",
      { query: "llama", maxResults: 10, timeoutMs: 7000 },
      undefined,
      undefined,
      {} as never,
    );
    expect(webSearch).toHaveBeenCalledWith("llama", {
      signal: undefined,
      timeoutMs: 7000,
      maxResults: 10,
      cwd: undefined,
      transport: "tls-first",
    });
    expect(result.content[0]).toMatchObject({ type: "text", text: "results" });
  });
});

describe("web_fetch tool", () => {
  it("fetches with url, maxChars and timeoutMs and reports progress", async () => {
    const fetchPageText = vi.fn(async (_url: string, _options?: FetchPageOptions) => "body");
    const { webFetchTool } = createWebTools({ fetchPageText });
    const updates: string[] = [];
    const result = await webFetchTool.execute(
      "id",
      { url: "https://example.com/", maxChars: 50, timeoutMs: 3000 },
      undefined,
      (update) => updates.push(firstText(update)),
      {} as never,
    );
    expect(fetchPageText).toHaveBeenCalledWith(
      "https://example.com/",
      expect.objectContaining({ maxChars: 50, timeoutMs: 3000 }),
    );
    expect(result.content[0]).toMatchObject({ type: "text", text: "body" });
    expect(updates).toEqual(["Fetching https://example.com/..."]);
  });

  it("drops non-positive option values and keeps the default timeout", async () => {
    const fetchPageText = vi.fn(async (_url: string, _options?: FetchPageOptions) => "body");
    const { webFetchTool } = createWebTools({ fetchPageText });
    await webFetchTool.execute(
      "id",
      { url: "https://example.com/", maxChars: 0, timeoutMs: -5 },
      undefined,
      undefined,
      {} as never,
    );
    const options = fetchPageText.mock.calls[0][1] as FetchPageOptions;
    expect(options.maxChars).toBeUndefined();
    expect(options.timeoutMs).toBe(60000);
  });

  it("passes local access and transport settings to the fetch", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-unsloth-idx-"));
    const previousEnv = process.env.PI_CODING_AGENT_DIR;
    try {
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, "settings.json"),
        JSON.stringify({
          webFetch: { allowPrivateAddresses: false, allowLocalFiles: false, transport: "off" },
        }),
      );
      process.env.PI_CODING_AGENT_DIR = root;
      const fetchPageText = vi.fn(async (_url: string, _options?: FetchPageOptions) => "body");
      const { webFetchTool } = createWebTools({ fetchPageText });
      await webFetchTool.execute("id", { url: "https://example.com/" }, undefined, undefined, {} as never);
      expect(fetchPageText).toHaveBeenCalledWith(
        "https://example.com/",
        expect.objectContaining({ allowPrivateAddresses: false, allowLocalFiles: false, transport: "off" }),
      );
    } finally {
      if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousEnv;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("local render fallback", () => {
  const HINT: RenderHint = { reason: "js-shell", evidence: ["spa-markers"] };
  const FORBIDDEN = "Failed to fetch URL: HTTP 403 Forbidden";
  const LONG_PAGE = "Title: App\n\n" + "Rendered locally body text. ".repeat(50);

  it("renders a 403 locally when the renderer is available", async () => {
    const fetchPageOutcome = vi.fn(async () => ({ text: FORBIDDEN, hint: null }));
    const renderLocalPageText = vi.fn(async () => LONG_PAGE);
    const { webFetchTool } = createWebTools({ fetchPageOutcome, renderLocalPageText });
    const result = await webFetchTool.execute("id", { url: "https://example.com/bot" }, undefined, undefined, {} as never);
    expect(renderLocalPageText).toHaveBeenCalledWith(
      "https://example.com/bot",
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(textOf(result)).toContain("Direct fetch failed with HTTP 403");
    expect(textOf(result)).toContain("rendered locally with Lightpanda instead");
    expect(textOf(result)).toContain("Rendered locally body text.");
  });

  it("keeps the 403 when no local renderer is configured", async () => {
    const fetchPageOutcome = vi.fn(async () => ({ text: FORBIDDEN, hint: null }));
    const renderLocalPageText = vi.fn(async () => null);
    const { webFetchTool } = createWebTools({ fetchPageOutcome, renderLocalPageText });
    const result = await webFetchTool.execute("id", { url: "https://example.com/bot" }, undefined, undefined, {} as never);
    expect(textOf(result)).toBe(FORBIDDEN);
  });

  it("keeps the 403 when the local render fails", async () => {
    const fetchPageOutcome = vi.fn(async () => ({ text: FORBIDDEN, hint: null }));
    const renderLocalPageText = vi.fn(async () => "Failed to render URL: timed out.");
    const { webFetchTool } = createWebTools({ fetchPageOutcome, renderLocalPageText });
    const result = await webFetchTool.execute("id", { url: "https://example.com/bot" }, undefined, undefined, {} as never);
    expect(textOf(result)).toBe(FORBIDDEN);
  });

  it("keeps the 403 when the local render is only a bot challenge page", async () => {
    const fetchPageOutcome = vi.fn(async () => ({ text: FORBIDDEN, hint: null }));
    const renderLocalPageText = vi.fn(async () => "Title: Attention Required! | Cloudflare\n\nJust a moment...");
    const { webFetchTool } = createWebTools({ fetchPageOutcome, renderLocalPageText });
    const result = await webFetchTool.execute("id", { url: "https://example.com/bot" }, undefined, undefined, {} as never);
    expect(textOf(result)).toBe(FORBIDDEN);
  });

  it("renders a thin javascript page locally", async () => {
    const fetchPageOutcome = vi.fn(async () => ({ text: "(page returned no readable text)", hint: HINT }));
    const renderLocalPageText = vi.fn(async () => LONG_PAGE);
    const { webFetchTool } = createWebTools({ fetchPageOutcome, renderLocalPageText });
    const result = await webFetchTool.execute("id", { url: "https://example.com/app" }, undefined, undefined, {} as never);
    expect(textOf(result)).toContain("rendered locally with Lightpanda instead");
    expect(textOf(result)).toContain("Rendered locally body text.");
  });

  it("appends the incomplete note when the renderer is missing", async () => {
    const fetchPageOutcome = vi.fn(async () => ({ text: "Title: App", hint: HINT }));
    const renderLocalPageText = vi.fn(async () => null);
    const { webFetchTool } = createWebTools({ fetchPageOutcome, renderLocalPageText });
    const result = await webFetchTool.execute("id", { url: "https://example.com/app" }, undefined, undefined, {} as never);
    expect(textOf(result)).toContain("(JavaScript-rendered page; content may be incomplete)");
  });

  it("appends the incomplete note when the local render is not richer", async () => {
    const fetchPageOutcome = vi.fn(async () => ({ text: "x".repeat(2000), hint: HINT }));
    const renderLocalPageText = vi.fn(async () => "x".repeat(100));
    const { webFetchTool } = createWebTools({ fetchPageOutcome, renderLocalPageText });
    const result = await webFetchTool.execute("id", { url: "https://example.com/app" }, undefined, undefined, {} as never);
    expect(textOf(result)).toContain("(JavaScript-rendered page; content may be incomplete)");
    expect(textOf(result).startsWith("x".repeat(2000))).toBe(true);
  });

  it("does not render when the fetch looks complete", async () => {
    const fetchPageOutcome = vi.fn(async () => ({ text: "Full page text.", hint: null }));
    const renderLocalPageText = vi.fn(async () => LONG_PAGE);
    const { webFetchTool } = createWebTools({ fetchPageOutcome, renderLocalPageText });
    const result = await webFetchTool.execute("id", { url: "https://example.com/" }, undefined, undefined, {} as never);
    expect(renderLocalPageText).not.toHaveBeenCalled();
    expect(textOf(result)).toBe("Full page text.");
  });
});

describe("tool call rendering", () => {
  const plainTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;

  const { webSearchTool, webFetchTool } = createWebTools();

  it("shows the search query", () => {
    expect(callText(webSearchTool.renderCall?.({ query: "unsloth studio" }, plainTheme, {} as never))).toBe(
      'web_search "unsloth studio"',
    );
  });

  it("shows the fetched url", () => {
    expect(callText(webFetchTool.renderCall?.({ url: "https://example.com/" }, plainTheme, {} as never))).toBe(
      "web_fetch https://example.com/",
    );
  });

  it("collapses whitespace in the rendered target", () => {
    expect(callText(webFetchTool.renderCall?.({ url: "https://example.com/a\n  b" }, plainTheme, {} as never))).toBe(
      "web_fetch https://example.com/a b",
    );
  });

  it("styles the tool name and target", () => {
    const theme = {
      fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
      bold: (text: string) => `**${text}**`,
    } as unknown as Theme;
    expect(callText(webSearchTool.renderCall?.({ query: "cats" }, theme, {} as never))).toBe(
      '[toolTitle]**web_search**[/toolTitle] [accent]"cats"[/accent]',
    );
  });

  it("falls back to the bare tool name without arguments", () => {
    expect(callText(webSearchTool.renderCall?.({}, plainTheme, {} as never))).toBe("web_search");
    expect(callText(webFetchTool.renderCall?.({ url: "" }, plainTheme, {} as never))).toBe("web_fetch");
  });

  it("truncates long targets to the render width", () => {
    const long = "q".repeat(200);
    const components = [
      webSearchTool.renderCall?.({ query: long }, plainTheme, {} as never),
      webFetchTool.renderCall?.({ url: `https://example.com/${long}` }, plainTheme, {} as never),
    ];
    for (const component of components) {
      const line = component?.render(40)[0] ?? "";
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
      expect(line).toContain("...");
    }
  });
});
