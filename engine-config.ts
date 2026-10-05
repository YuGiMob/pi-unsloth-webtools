import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text } from "@earendil-works/pi-tui";
import type { Component, SettingItem, SettingsListTheme } from "@earendil-works/pi-tui";
import { agentDir } from "./agent-dir.ts";
import { DEFAULT_ENGINE_NAMES, TEXT_ENGINES } from "./engines.ts";
import { loadEngineSettings } from "./settings.ts";

const ENGINE_LABELS: Record<string, string> = {
  duckduckgo: "DuckDuckGo",
  startpage: "Startpage",
  yandex: "Yandex",
};

const ENGINE_HINTS: Record<string, string> = {
  duckduckgo: "On by default. DuckDuckGo's HTML results endpoint.",
  startpage: "On by default. Google-backed index served through Startpage.",
  yandex: "Opt-in. Yandex results are only searched while this stays on.",
};

export interface EngineSelection {
  names: string[];
  file: string;
}

function knownEngineNames(): Set<string> {
  return new Set(TEXT_ENGINES.map((engine) => engine.name));
}

export async function readEngineSelection(cwd?: string): Promise<EngineSelection> {
  const { engines, sourceFile } = await loadEngineSettings(cwd);
  const known = knownEngineNames();
  const listed = (engines ?? [])
    .map((name) => name.trim().toLowerCase())
    .filter((name) => known.has(name));
  const names = listed.length ? [...new Set(listed)] : [...DEFAULT_ENGINE_NAMES];
  if (sourceFile) return { names, file: sourceFile };
  const base = agentDir();
  if (!base) throw new Error("could not resolve the pi agent directory");
  return { names, file: join(base, "settings.json") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSettingsObject(file: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const data = JSON.parse(raw) as unknown;
  if (!isRecord(data)) throw new Error(`${file} is not a JSON object`);
  return data;
}

async function writeSettingsObject(file: string, data: Record<string, unknown>): Promise<void> {
  const temporary = `${file}.tmp.${process.pid}`;
  let mode: number | undefined;
  try {
    mode = (await stat(file)).mode & 0o777;
  } catch {}
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, mode === undefined ? {} : { mode });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function saveEngineSelection(file: string, names: string[]): Promise<void> {
  const data = await readSettingsObject(file);
  let updated = false;
  for (const [section, key] of [
    ["unslothWebTools", "engines"],
    ["webSearch", "engines"],
  ] as const) {
    const value = data[section];
    if (isRecord(value) && key in value) {
      value[key] = names;
      updated = true;
    }
  }
  if (!updated) {
    const webSearch = data["webSearch"];
    if (isRecord(webSearch)) webSearch["engines"] = names;
    else data["webSearch"] = { engines: names };
  }
  await writeSettingsObject(file, data);
}

function engineOrder(): string[] {
  const preferred = new Set<string>(DEFAULT_ENGINE_NAMES);
  return [
    ...DEFAULT_ENGINE_NAMES,
    ...TEXT_ENGINES.map((engine) => engine.name).filter((name) => !preferred.has(name)),
  ];
}

function settingsTheme(theme: Theme): SettingsListTheme {
  return {
    label: (text, selected) => (selected ? theme.fg("accent", text) : text),
    value: (text) => {
      if (text === "on") return theme.fg("success", text);
      if (text === "off") return theme.fg("dim", text);
      return theme.fg("accent", text);
    },
    description: (text) => theme.fg("muted", text),
    cursor: theme.fg("accent", "> "),
    hint: (text) => theme.fg("dim", text),
  };
}

function rule(theme: Theme): Component {
  return {
    render: (width: number) => [theme.fg("border", "─".repeat(Math.max(1, width)))],
    invalidate: () => {},
  };
}

export async function openEngineConfig(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/search-engines requires interactive mode", "error");
    return;
  }
  let selection: EngineSelection;
  try {
    selection = await readEngineSelection(ctx.cwd);
  } catch (error) {
    ctx.ui.notify(`Search engines: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      let enabled = new Set(selection.names);
      let list: SettingsList;
      const status = new Text("", 1, 0);
      const persist = (names: string[]) => {
        void saveEngineSelection(selection.file, names)
          .then(
            () => status.setText(theme.fg("dim", `Saved to ${selection.file}`)),
            (error: unknown) =>
              status.setText(theme.fg("error", `Save failed: ${error instanceof Error ? error.message : String(error)}`)),
          )
          .finally(() => tui.requestRender());
      };
      const items: SettingItem[] = [
        ...engineOrder().map((name) => ({
          id: name,
          label: ENGINE_LABELS[name] ?? name,
          currentValue: enabled.has(name) ? "on" : "off",
          values: ["on", "off"],
          description: ENGINE_HINTS[name] ?? "",
        })),
        {
          id: "reset",
          label: "Reset",
          currentValue: "defaults",
          values: ["defaults"],
          description: `Enable ${DEFAULT_ENGINE_NAMES.join(" and ")}; Yandex stays off.`,
        },
      ];
      const onChange = (id: string, value: string) => {
        if (id === "reset") {
          enabled = new Set(DEFAULT_ENGINE_NAMES);
          for (const item of items) {
            if (item.id !== "reset") list.updateValue(item.id, enabled.has(item.id) ? "on" : "off");
          }
          persist([...enabled]);
          return;
        }
        const next = new Set(enabled);
        if (value === "on") next.add(id);
        else next.delete(id);
        if (!next.size) {
          list.updateValue(id, "on");
          tui.requestRender();
          return;
        }
        enabled = next;
        persist([...enabled]);
      };
      list = new SettingsList(items, items.length, settingsTheme(theme), onChange, () => done());
      const container = new Container();
      container.addChild(rule(theme));
      container.addChild(new Text(theme.fg("accent", theme.bold("Search engines")), 1, 0));
      container.addChild(
        new Text(theme.fg("dim", "The web_search sweep queries every engine marked on; at least one stays on."), 1, 0),
      );
      container.addChild(list);
      container.addChild(status);
      container.addChild(rule(theme));
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 56, maxHeight: "80%" } },
  );
}
