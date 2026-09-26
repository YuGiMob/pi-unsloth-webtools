import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerExtension, { createWebTools } from "../index.ts";
import type { FetchPageOptions, RenderHint } from "../web-fetch.ts";
import type { WebSearchOptions } from "../web-search.ts";
import { readConfig, writeConfig } from "../config.ts";
import { testTheme, waitFor, withTempConfig } from "./config-helpers.ts";

function firstText(update: { content: { type: string; text?: string }[] }): string {
  return update.content[0]?.text ?? "";
}

function callText(component: { render(width: number): string[] } | undefined): string {
  return component?.render(80).join("\n") ?? "";
}

interface Harness {
  handlers: Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>;
  commands: Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<unknown> }>;
  tools: string[];
  active: () => string[];
}

function makeHarness(initialActive: string[]): Harness {
  let active = [...initialActive];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const commands = new Map<
    string,
    { description?: string; handler: (args: string, ctx: unknown) => Promise<unknown> }
  >();
  const tools: string[] = [];
  const pi = {
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerCommand: (
      name: string,
      options: { description?: string; handler: (args: string, ctx: unknown) => Promise<unknown> }
    ) => {
      commands.set(name, options);
    },
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = names;
    },
  } as unknown as ExtensionAPI;
  registerExtension(pi);
  return { handlers, commands, tools, active: () => active };
}

describe("extension registration", () => {
  it("registers the web tools and the webtools-config command", () => {
    const harness = makeHarness(["read", "web_fetch"]);
    expect(harness.tools).toEqual(["web_search", "web_fetch"]);
    expect([...harness.commands.keys()]).toEqual(["webtools-config"]);
    expect(harness.commands.get("webtools-config")?.description).toContain("JavaScript");
  });
});

describe("web render config", () => {
  it("warns about a corrupt config on session start without touching tools", async () => {
    await withTempConfig(async (dir) => {
      await mkdir(join(dir, ".config", "pi-unsloth-webtools"), { recursive: true });
      await writeFile(join(dir, ".config", "pi-unsloth-webtools", "config.json"), JSON.stringify([1, 2]));
      const harness = makeHarness(["read", "web_search", "web_fetch"]);
      const notices: { message: string; level: string }[] = [];
      await harness.handlers.get("session_start")?.(
        {},
        { hasUI: true, ui: { notify: (message: string, level: string) => notices.push({ message, level }) } },
      );
      expect(harness.active()).toEqual(["read", "web_search", "web_fetch"]);
      expect(notices[0]?.level).toBe("warning");
    });
  });

  it("keeps tools active on session start when rendering is disabled", async () => {
    await withTempConfig(async () => {
      await writeConfig({ webRenderEnabled: false });
      const harness = makeHarness(["read", "web_search", "web_fetch"]);
      await harness.handlers.get("session_start")?.({}, { hasUI: false });
      expect(harness.active()).toEqual(["read", "web_search", "web_fetch"]);
    });
  });

  it("toggles rendering through the config command", async () => {
    await withTempConfig(async () => {
      const harness = makeHarness(["read", "web_search", "web_fetch"]);
      let overlay: { handleInput(data: string): void } | undefined;
      const ctx = {
        hasUI: true,
        ui: {
          notify: () => {},
          custom: async (
            factory: (tui: unknown, theme: Theme, keybindings: unknown, done: () => void) => Promise<unknown>
          ) => {
            overlay = (await factory({ requestRender: () => {} }, testTheme(), undefined, () => {})) as {
              handleInput(data: string): void;
            };
          },
        },
      };
      await harness.commands.get("webtools-config")?.handler("", ctx);
      expect(overlay).toBeDefined();
      overlay?.handleInput(" ");
      await waitFor(async () => (await readConfig()).webRenderEnabled === false);
      overlay?.handleInput(" ");
      await waitFor(async () => (await readConfig()).webRenderEnabled === true);
    });
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

  it("passes the local access settings to the fetch", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-unsloth-idx-"));
    const previousEnv = process.env.PI_CODING_AGENT_DIR;
    try {
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, "settings.json"),
        JSON.stringify({ webFetch: { allowPrivateAddresses: false, allowLocalFiles: false } }),
      );
      process.env.PI_CODING_AGENT_DIR = root;
      const fetchPageText = vi.fn(
        async (_url: string, _options?: FetchPageOptions) => "body",
      );
      const { webFetchTool } = createWebTools({ fetchPageText });
      await webFetchTool.execute(
        "id",
        { url: "https://example.com/" },
        undefined,
        undefined,
        {} as never,
      );
      expect(fetchPageText).toHaveBeenCalledWith(
        "https://example.com/",
        expect.objectContaining({ allowPrivateAddresses: false, allowLocalFiles: false }),
      );
    } finally {
      if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousEnv;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("http 403 fallback", () => {
  const FORBIDDEN = "Failed to fetch URL: HTTP 403 Forbidden";

  function textOf(result: unknown): string {
    const content = (result as { content?: { text?: string }[] } | undefined)?.content;
    return content?.[0]?.text ?? "";
  }

  it("falls back through the Jina Reader when web_fetch is refused with 403", async () => {
    const fetchPageText = vi.fn(async () => FORBIDDEN);
    const renderPageText = vi.fn(async () => "Title: Blocked\n\nRendered body text.");
    const { webFetchTool } = createWebTools({ fetchPageText, renderPageText, webRenderEnabled: async () => true });
    const result = await webFetchTool.execute("id", { url: "https://example.com/bot" }, undefined, undefined, {} as never);
    expect(renderPageText).toHaveBeenCalledWith("https://example.com/bot", expect.objectContaining({ timeoutMs: expect.any(Number) }));
    const text = textOf(result);
    expect(text).toContain("rendered via the Jina Reader instead");
    expect(text).toContain("Rendered body text.");
  });

  it("keeps the 403 when rendering is disabled", async () => {
    const fetchPageText = vi.fn(async () => FORBIDDEN);
    const renderPageText = vi.fn(async () => "Rendered body text.");
    const { webFetchTool } = createWebTools({ fetchPageText, renderPageText, webRenderEnabled: async () => false });
    const result = await webFetchTool.execute("id", { url: "https://example.com/bot" }, undefined, undefined, {} as never);
    expect(textOf(result)).toBe(FORBIDDEN);
    expect(renderPageText).not.toHaveBeenCalled();
  });

  it("honors the stored webRenderEnabled setting by default", async () => {
    await withTempConfig(async () => {
      await writeConfig({ webRenderEnabled: false });
      const fetchPageText = vi.fn(async () => FORBIDDEN);
      const renderPageText = vi.fn(async () => "Rendered body text.");
      const { webFetchTool } = createWebTools({ fetchPageText, renderPageText });
      const result = await webFetchTool.execute("id", { url: "https://example.com/bot" }, undefined, undefined, {} as never);
      expect(textOf(result)).toBe(FORBIDDEN);
      expect(renderPageText).not.toHaveBeenCalled();
    });
  });

  it("keeps the 403 when the render also fails", async () => {
    const fetchPageText = vi.fn(async () => FORBIDDEN);
    const renderPageText = vi.fn(async () => "Failed to render URL: 429 Too Many Requests");
    const { webFetchTool } = createWebTools({ fetchPageText, renderPageText, webRenderEnabled: async () => true });
    const result = await webFetchTool.execute("id", { url: "https://example.com/bot" }, undefined, undefined, {} as never);
    expect(textOf(result)).toBe(FORBIDDEN);
  });

  it("keeps the 403 when the render target cannot be resolved", async () => {
    const fetchPageText = vi.fn(async () => FORBIDDEN);
    const renderPageText = vi.fn(async () => "Failed to render URL: Failed to resolve host: getaddrinfo ENOTFOUND example.com");
    const { webFetchTool } = createWebTools({ fetchPageText, renderPageText, webRenderEnabled: async () => true });
    const result = await webFetchTool.execute("id", { url: "https://example.com/bot" }, undefined, undefined, {} as never);
    expect(textOf(result)).toBe(FORBIDDEN);
  });

  it("does not render for other fetch failures", async () => {
    const fetchPageText = vi.fn(async () => "Failed to fetch URL: HTTP 404 Not Found");
    const renderPageText = vi.fn(async () => "Rendered body text.");
    const { webFetchTool } = createWebTools({ fetchPageText, renderPageText, webRenderEnabled: async () => true });
    const result = await webFetchTool.execute("id", { url: "https://example.com/gone" }, undefined, undefined, {} as never);
    expect(textOf(result)).toBe("Failed to fetch URL: HTTP 404 Not Found");
    expect(renderPageText).not.toHaveBeenCalled();
  });
});

describe("javascript render fallback", () => {
  const HINT: RenderHint = { reason: "js-shell", evidence: ["spa-markers"] };

  function textOf(result: unknown): string {
    const content = (result as { content?: { text?: string }[] } | undefined)?.content;
    return content?.[0]?.text ?? "";
  }

  it("renders a thin javascript page automatically", async () => {
    const fetchPageOutcome = vi.fn(async () => ({ text: "(page returned no readable text)", hint: HINT }));
    const renderPageText = vi.fn(async () => "Title: App\n\n" + "Rendered body text. ".repeat(20));
    const { webFetchTool } = createWebTools({ fetchPageOutcome, renderPageText, webRenderEnabled: async () => true });
    const result = await webFetchTool.execute("id", { url: "https://example.com/app" }, undefined, undefined, {} as never);
    expect(renderPageText).toHaveBeenCalledWith("https://example.com/app", expect.objectContaining({ timeoutMs: expect.any(Number) }));
    expect(textOf(result)).toContain("rendered via the Jina Reader instead");
    expect(textOf(result)).toContain("Rendered body text.");
  });

  it("appends the incomplete note when rendering is disabled", async () => {
    const fetchPageOutcome = vi.fn(async () => ({ text: "Title: App", hint: HINT }));
    const renderPageText = vi.fn(async () => "Rendered body text.");
    const { webFetchTool } = createWebTools({ fetchPageOutcome, renderPageText, webRenderEnabled: async () => false });
    const result = await webFetchTool.execute("id", { url: "https://example.com/app" }, undefined, undefined, {} as never);
    expect(renderPageText).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("(JavaScript-rendered page; content may be incomplete)");
  });

  it("keeps the fetched text when rendering is not richer", async () => {
    const fetchPageOutcome = vi.fn(async () => ({ text: "x".repeat(200), hint: HINT }));
    const renderPageText = vi.fn(async () => "x".repeat(100));
    const { webFetchTool } = createWebTools({ fetchPageOutcome, renderPageText, webRenderEnabled: async () => true });
    const result = await webFetchTool.execute("id", { url: "https://example.com/app" }, undefined, undefined, {} as never);
    expect(textOf(result)).toContain("(JavaScript-rendered page; content may be incomplete)");
    expect(textOf(result).startsWith("x".repeat(200))).toBe(true);
  });

  it("does not render when the fetch looks complete", async () => {
    const fetchPageOutcome = vi.fn(async () => ({ text: "Full page text.", hint: null }));
    const renderPageText = vi.fn(async () => "Rendered body text.");
    const { webFetchTool } = createWebTools({ fetchPageOutcome, renderPageText, webRenderEnabled: async () => true });
    const result = await webFetchTool.execute("id", { url: "https://example.com/" }, undefined, undefined, {} as never);
    expect(renderPageText).not.toHaveBeenCalled();
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
