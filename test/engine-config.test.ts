import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openEngineConfig, readEngineSelection, saveEngineSelection } from "../engine-config.ts";
import { DEFAULT_ENGINE_NAMES } from "../engines.ts";

let root: string;
const initialAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-unsloth-engine-config-"));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
});

afterEach(async () => {
  if (initialAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = initialAgentDir;
  await rm(root, { recursive: true, force: true });
});

describe("engine selection", () => {
  it("defaults to duckduckgo and startpage with yandex opt-in", async () => {
    const selection = await readEngineSelection();
    expect(selection.names).toEqual([...DEFAULT_ENGINE_NAMES]);
    expect(selection.names).not.toContain("yandex");
    expect(selection.file).toBe(join(root, "agent", "settings.json"));
  });

  it("reads an explicit list and reports the file that set it", async () => {
    const project = join(root, "project");
    const projectFile = join(project, ".pi", "settings.json");
    await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(projectFile, JSON.stringify({ webSearch: { engines: ["yandex", "startpage"] } }));
    const selection = await readEngineSelection(project);
    expect(selection.names).toEqual(["yandex", "startpage"]);
    expect(selection.file).toBe(projectFile);
  });

  it("ignores unknown names and keeps the default sweep", async () => {
    const file = join(root, "agent", "settings.json");
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(file, JSON.stringify({ webSearch: { engines: ["nope"] } }));
    const selection = await readEngineSelection();
    expect(selection.names).toEqual([...DEFAULT_ENGINE_NAMES]);
    expect(selection.file).toBe(file);
  });
});

describe("engine settings writes", () => {
  it("creates webSearch.engines in the global settings file", async () => {
    const selection = await readEngineSelection();
    await saveEngineSelection(selection.file, ["duckduckgo", "startpage", "yandex"]);
    const saved = JSON.parse(await readFile(selection.file, "utf-8"));
    expect(saved).toEqual({ webSearch: { engines: ["duckduckgo", "startpage", "yandex"] } });
    expect((await readEngineSelection()).names).toEqual(["duckduckgo", "startpage", "yandex"]);
  });

  it("preserves other settings and updates an existing list", async () => {
    const file = join(root, "agent", "settings.json");
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ theme: "dark", unslothWebTools: { maxResults: 9, engines: ["duckduckgo"] } }),
    );
    await saveEngineSelection(file, ["startpage"]);
    expect(JSON.parse(await readFile(file, "utf-8"))).toEqual({
      theme: "dark",
      unslothWebTools: { maxResults: 9, engines: ["startpage"] },
    });
  });

  it("writes to the project file when it overrides the list", async () => {
    const project = join(root, "project");
    const projectFile = join(project, ".pi", "settings.json");
    await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(projectFile, JSON.stringify({ webSearch: { engines: ["yandex"] } }));
    const selection = await readEngineSelection(project);
    await saveEngineSelection(selection.file, ["duckduckgo", "startpage"]);
    expect(JSON.parse(await readFile(projectFile, "utf-8"))).toEqual({
      webSearch: { engines: ["duckduckgo", "startpage"] },
    });
  });

  it("refuses to overwrite a settings file that is not valid JSON", async () => {
    const file = join(root, "agent", "settings.json");
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(file, "not json");
    await expect(saveEngineSelection(file, ["duckduckgo"])).rejects.toThrow();
    expect(await readFile(file, "utf-8")).toBe("not json");
  });
});

describe("search engines command", () => {
  it("requires interactive mode", async () => {
    const notify = vi.fn();
    await openEngineConfig({ mode: "json", cwd: root, ui: { notify } } as never);
    expect(notify).toHaveBeenCalledWith("/search-engines requires interactive mode", "error");
  });

  it("renders the engine list with yandex off by default", async () => {
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
    await openEngineConfig({ mode: "tui", cwd: root, ui: { custom, notify: () => {} } } as never);
    expect(rendered).toMatch(/DuckDuckGo\s+on/);
    expect(rendered).toMatch(/Startpage\s+on/);
    expect(rendered).toMatch(/Yandex\s+off/);
  });
});
