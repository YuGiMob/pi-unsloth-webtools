import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerExtension, { createWebTools } from "../index.ts";
import type { FetchPageOptions } from "../web-fetch.ts";
import type { WebSearchOptions } from "../web-search.ts";

function firstText(update: { content: { type: string; text?: string }[] }): string {
  return update.content[0]?.text ?? "";
}

describe("extension registration", () => {
  it("registers the web_search and web_fetch tools", () => {
    const registered: { name: string }[] = [];
    const pi = {
      registerTool: (tool: { name: string }) => registered.push(tool),
    } as unknown as ExtensionAPI;
    registerExtension(pi);
    expect(registered.map((tool) => tool.name)).toEqual(["web_search", "web_fetch"]);
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
        JSON.stringify({ webFetch: { allowPrivateAddresses: true, allowLocalFiles: true } }),
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
        expect.objectContaining({ allowPrivateAddresses: true, allowLocalFiles: true }),
      );
    } finally {
      if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousEnv;
      await rm(root, { recursive: true, force: true });
    }
  });
});
