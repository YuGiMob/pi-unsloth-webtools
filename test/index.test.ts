import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerExtension, { createWebTools } from "../index.ts";
import type { FetchPageOptions } from "../web-fetch.ts";
import type { WebSearchOptions } from "../web-search.ts";
import type { RenderPageOptions } from "../web-render.ts";
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
    const harness = makeHarness(["read", "web_render"]);
    expect(harness.tools).toEqual(["web_search", "web_fetch", "web_render"]);
    expect([...harness.commands.keys()]).toEqual(["webtools-config"]);
    expect(harness.commands.get("webtools-config")?.description).toContain("web_render");
  });
});

describe("web render config", () => {
  it("deactivates web_render on session start when disabled", async () => {
    await withTempConfig(async () => {
      await writeConfig({ webRenderEnabled: false });
      const harness = makeHarness(["read", "web_search", "web_fetch", "web_render"]);
      await harness.handlers.get("session_start")?.({}, { hasUI: false });
      expect(harness.active()).toEqual(["read", "web_search", "web_fetch"]);
    });
  });

  it("keeps web_render active on session start when enabled", async () => {
    await withTempConfig(async () => {
      const harness = makeHarness(["read", "web_search", "web_fetch", "web_render"]);
      await harness.handlers.get("session_start")?.({}, { hasUI: false });
      expect(harness.active()).toEqual(["read", "web_search", "web_fetch", "web_render"]);
    });
  });

  it("toggles web_render through the config command", async () => {
    await withTempConfig(async () => {
      const harness = makeHarness(["read", "web_search", "web_fetch", "web_render"]);
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
      await waitFor(async () => (await readConfig()).webRenderEnabled === false && !harness.active().includes("web_render"));
      expect(harness.active()).not.toContain("web_render");
      overlay?.handleInput(" ");
      await waitFor(async () => (await readConfig()).webRenderEnabled === true && harness.active().includes("web_render"));
      expect(harness.active()).toContain("web_render");
    });
  });
});

describe("web_search tool", () => {
  it("fetches the url in url mode with maxChars and timeoutMs", async () => {
    const fetchPageText = vi.fn(
      async (_url: string, _options?: FetchPageOptions) => "page text",
    );
    const { webSearchTool } = createWebTools({ fetchPageText });
    const updates: string[] = [];
    const result = await webSearchTool.execute(
      "id",
      { url: " https://example.com/doc ", maxChars: 100, timeoutMs: 5000 },
      undefined,
      (update) => updates.push(firstText(update)),
      {} as never,
    );
    expect(fetchPageText).toHaveBeenCalledWith(
      "https://example.com/doc",
      expect.objectContaining({ maxChars: 100, timeoutMs: 5000 }),
    );
    expect(result.content[0]).toMatchObject({ type: "text", text: "page text" });
    expect(updates).toEqual(["Fetching https://example.com/doc..."]);
  });

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

  it("drops non-positive option values and keeps the default timeout", async () => {
    const fetchPageText = vi.fn(
      async (_url: string, _options?: FetchPageOptions) => "page text",
    );
    const { webSearchTool } = createWebTools({ fetchPageText });
    await webSearchTool.execute(
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

describe("web_render tool", () => {
  it("renders the url with maxChars and timeoutMs and reports progress", async () => {
    const renderPageText = vi.fn(async (_url: string, _options?: RenderPageOptions) => "rendered");
    const { webRenderTool } = createWebTools({ renderPageText });
    const updates: string[] = [];
    const result = await webRenderTool.execute(
      "id",
      { url: "https://example.com/", maxChars: 50, timeoutMs: 3000 },
      undefined,
      (update) => updates.push(firstText(update)),
      {} as never,
    );
    expect(renderPageText).toHaveBeenCalledWith(
      "https://example.com/",
      expect.objectContaining({ maxChars: 50, timeoutMs: 3000 }),
    );
    expect(result.content[0]).toMatchObject({ type: "text", text: "rendered" });
    expect(updates).toEqual(["Rendering https://example.com/..."]);
  });

  it("reads the jina api key from settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-unsloth-render-"));
    const previousEnv = process.env.PI_CODING_AGENT_DIR;
    try {
      await writeFile(join(root, "settings.json"), JSON.stringify({ unslothWebTools: { jinaApiKey: "secret" } }));
      process.env.PI_CODING_AGENT_DIR = root;
      const renderPageText = vi.fn(async (_url: string, _options?: RenderPageOptions) => "rendered");
      const { webRenderTool } = createWebTools({ renderPageText });
      await webRenderTool.execute("id", { url: "https://example.com/" }, undefined, undefined, {} as never);
      expect(renderPageText).toHaveBeenCalledWith(
        "https://example.com/",
        expect.objectContaining({ apiKey: "secret" }),
      );
    } finally {
      if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousEnv;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("tool call rendering", () => {
  const plainTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;

  const { webSearchTool, webFetchTool, webRenderTool } = createWebTools();

  it("shows the search query", () => {
    expect(callText(webSearchTool.renderCall?.({ query: "unsloth studio" }, plainTheme, {} as never))).toBe(
      'web_search "unsloth studio"',
    );
  });

  it("shows the target url in web_search url mode", () => {
    expect(callText(webSearchTool.renderCall?.({ url: "https://example.com/doc" }, plainTheme, {} as never))).toBe(
      "web_search https://example.com/doc",
    );
  });

  it("shows the fetched url", () => {
    expect(callText(webFetchTool.renderCall?.({ url: "https://example.com/" }, plainTheme, {} as never))).toBe(
      "web_fetch https://example.com/",
    );
  });

  it("shows the rendered url", () => {
    expect(callText(webRenderTool.renderCall?.({ url: "https://example.com/" }, plainTheme, {} as never))).toBe(
      "web_render https://example.com/",
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
      webSearchTool.renderCall?.({ url: `https://example.com/${long}` }, plainTheme, {} as never),
      webFetchTool.renderCall?.({ url: `https://example.com/${long}` }, plainTheme, {} as never),
      webRenderTool.renderCall?.({ url: `https://example.com/${long}` }, plainTheme, {} as never),
    ];
    for (const component of components) {
      const line = component?.render(40)[0] ?? "";
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
      expect(line).toContain("...");
    }
  });
});
