import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSearchConfig, readSearchConfig, saveSearchConfig } from "../search-config.ts";
import { DEFAULT_ENGINE_NAMES } from "../engines.ts";

let root: string;
const initialAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-unsloth-search-config-"));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
});

afterEach(async () => {
  if (initialAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = initialAgentDir;
  await rm(root, { recursive: true, force: true });
});

describe("search config reads", () => {
  it("defaults to duckduckgo and startpage with yandex and the renderer opt-in", async () => {
    const config = await readSearchConfig();
    expect(config.engines).toEqual([...DEFAULT_ENGINE_NAMES]);
    expect(config.engines).not.toContain("yandex");
    expect(config.lightpandaFallback).toBe(false);
    expect(config.file).toBe(join(root, "agent", "settings.json"));
  });

  it("reads explicit values and reports the file that set them", async () => {
    const project = join(root, "project");
    const projectFile = join(project, ".pi", "settings.json");
    await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(
      projectFile,
      JSON.stringify({ webSearch: { engines: ["yandex", "startpage"], lightpandaFallback: true } }),
    );
    const config = await readSearchConfig(project);
    expect(config.engines).toEqual(["yandex", "startpage"]);
    expect(config.lightpandaFallback).toBe(true);
    expect(config.file).toBe(projectFile);
  });

  it("ignores unknown names and keeps the default sweep", async () => {
    const file = join(root, "agent", "settings.json");
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(file, JSON.stringify({ webSearch: { engines: ["nope"] } }));
    const config = await readSearchConfig();
    expect(config.engines).toEqual([...DEFAULT_ENGINE_NAMES]);
    expect(config.file).toBe(file);
  });
});

describe("search config writes", () => {
  it("creates webSearch.engines and webSearch.lightpandaFallback in the global settings file", async () => {
    const config = await readSearchConfig();
    await saveSearchConfig(config.file, { engines: ["duckduckgo", "startpage", "yandex"], lightpandaFallback: true });
    const saved = JSON.parse(await readFile(config.file, "utf-8"));
    expect(saved).toEqual({
      webSearch: { engines: ["duckduckgo", "startpage", "yandex"], lightpandaFallback: true },
    });
    const reread = await readSearchConfig();
    expect(reread.engines).toEqual(["duckduckgo", "startpage", "yandex"]);
    expect(reread.lightpandaFallback).toBe(true);
  });

  it("preserves other settings and updates an existing engines list", async () => {
    const file = join(root, "agent", "settings.json");
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ theme: "dark", unslothWebTools: { maxResults: 9, engines: ["duckduckgo"] } }),
    );
    await saveSearchConfig(file, { engines: ["startpage"], lightpandaFallback: true });
    expect(JSON.parse(await readFile(file, "utf-8"))).toEqual({
      theme: "dark",
      unslothWebTools: { maxResults: 9, engines: ["startpage"] },
      webSearch: { lightpandaFallback: true },
    });
  });

  it("writes to the project file when it overrides search settings", async () => {
    const project = join(root, "project");
    const projectFile = join(project, ".pi", "settings.json");
    await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(projectFile, JSON.stringify({ webSearch: { lightpandaFallback: true } }));
    const config = await readSearchConfig(project);
    await saveSearchConfig(config.file, { engines: ["duckduckgo", "startpage"], lightpandaFallback: false });
    expect(JSON.parse(await readFile(projectFile, "utf-8"))).toEqual({
      webSearch: { lightpandaFallback: false, engines: ["duckduckgo", "startpage"] },
    });
  });

  it("refuses to overwrite a settings file that is not valid JSON", async () => {
    const file = join(root, "agent", "settings.json");
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(file, "not json");
    await expect(saveSearchConfig(file, { engines: ["duckduckgo"], lightpandaFallback: false })).rejects.toThrow();
    expect(await readFile(file, "utf-8")).toBe("not json");
  });
});

describe("search config command", () => {
  it("requires interactive mode", async () => {
    const notify = vi.fn();
    await openSearchConfig({ mode: "json", cwd: root, ui: { notify } } as never);
    expect(notify).toHaveBeenCalledWith("/search-config requires interactive mode", "error");
  });

  it("renders the engines and the renderer toggle", async () => {
    let rendered = "";
    const custom = async (
      factory: (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (result: unknown) => void,
      ) => unknown,
    ) => {
      const component = factory(
        { requestRender: () => {} },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        {},
        () => {},
      ) as { render(width: number): string[] };
      rendered = component.render(80).join("\n");
    };
    await openSearchConfig({ mode: "tui", cwd: root, ui: { custom, notify: () => {} } } as never);
    expect(rendered).toMatch(/DuckDuckGo\s+on/);
    expect(rendered).toMatch(/Startpage\s+on/);
    expect(rendered).toMatch(/Yandex\s+off/);
    expect(rendered).toMatch(/Lightpanda fallback\s+off/);
  });
});
