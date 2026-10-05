import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text } from "@earendil-works/pi-tui";
import type { Component, SettingItem, SettingsListTheme } from "@earendil-works/pi-tui";
import { agentDir } from "./agent-dir.ts";
import { DEFAULT_ENGINE_NAMES, TEXT_ENGINES } from "./engines.ts";
import { loadSearchSettings } from "./settings.ts";

const ENGINE_LABELS: Record<string, string> = {
  duckduckgo: "DuckDuckGo",
  startpage: "Startpage",
  yandex: "Yandex",
  brave: "Brave",
  yahoo: "Yahoo",
};

const ENGINE_HINTS: Record<string, string> = {
  duckduckgo: "On by default. DuckDuckGo's HTML results endpoint.",
  startpage: "On by default. Google-backed index served through Startpage.",
  yandex: "Opt-in. Yandex results are only searched while this stays on.",
  brave: "Opt-in render-only. Brave's own index; swept only through the local Lightpanda renderer.",
  yahoo: "Opt-in render-only. Yahoo results; swept only through the local Lightpanda renderer.",
};

const ENGINE_SETTING_PATHS = [
  ["unslothWebTools", "engines"],
  ["webSearch", "engines"],
] as const;

const LIGHTPANDA_FALLBACK_SETTING_PATHS = [
  ["unslothWebTools", "lightpandaFallback"],
  ["webSearch", "lightpandaFallback"],
] as const;

export interface SearchConfig {
  engines: string[];
  lightpandaFallback: boolean;
  file: string;
}

export interface SearchConfigDraft {
  engines: Set<string>;
  lightpandaFallback: boolean;
}

const RENDER_ONLY_ENGINES = new Set(
  TEXT_ENGINES.filter((engine) => engine.renderOnly === true).map((engine) => engine.name),
);

export function toggleSearchConfig(draft: SearchConfigDraft, id: string, value: string): boolean {
  if (id === "reset") {
    draft.engines = new Set(DEFAULT_ENGINE_NAMES);
    draft.lightpandaFallback = false;
    return true;
  }
  if (id === "lightpandaFallback") {
    draft.lightpandaFallback = value === "on";
    if (!draft.lightpandaFallback) {
      for (const name of RENDER_ONLY_ENGINES) draft.engines.delete(name);
      if (draft.engines.size === 0) draft.engines = new Set(DEFAULT_ENGINE_NAMES);
    }
    return true;
  }
  if (value === "on") {
    draft.engines.add(id);
    if (RENDER_ONLY_ENGINES.has(id)) draft.lightpandaFallback = true;
    return true;
  }
  if (draft.engines.size === 1 && draft.engines.has(id)) return false;
  draft.engines.delete(id);
  return true;
}

function knownEngineNames(): Set<string> {
  return new Set(TEXT_ENGINES.map((engine) => engine.name));
}

export async function readSearchConfig(cwd?: string): Promise<SearchConfig> {
  const { engines, lightpandaFallback, sourceFile } = await loadSearchSettings(cwd);
  const known = knownEngineNames();
  const listed = (engines ?? [])
    .map((name) => name.trim().toLowerCase())
    .filter((name) => known.has(name));
  const fallback = lightpandaFallback === true;
  let names = listed.length ? [...new Set(listed)] : [...DEFAULT_ENGINE_NAMES];
  if (!fallback) names = names.filter((name) => !RENDER_ONLY_ENGINES.has(name));
  if (!names.length) names = [...DEFAULT_ENGINE_NAMES];
  if (sourceFile) return { engines: names, lightpandaFallback: fallback, file: sourceFile };
  const base = agentDir();
  if (!base) throw new Error("could not resolve the pi agent directory");
  return { engines: names, lightpandaFallback: fallback, file: join(base, "settings.json") };
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

function setSettingValue(
  data: Record<string, unknown>,
  paths: readonly (readonly [string, string])[],
  value: unknown,
): void {
  let updated = false;
  for (const [section, key] of paths) {
    const sectionValue = data[section];
    if (isRecord(sectionValue) && key in sectionValue) {
      sectionValue[key] = value;
      updated = true;
    }
  }
  if (updated) return;
  const [section, key] = paths[paths.length - 1];
  const sectionValue = data[section];
  if (isRecord(sectionValue)) sectionValue[key] = value;
  else data[section] = { [key]: value };
}

export async function saveSearchConfig(
  file: string,
  config: { engines: string[]; lightpandaFallback: boolean },
): Promise<void> {
  const data = await readSettingsObject(file);
  setSettingValue(data, ENGINE_SETTING_PATHS, config.engines);
  setSettingValue(data, LIGHTPANDA_FALLBACK_SETTING_PATHS, config.lightpandaFallback);
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

export async function openSearchConfig(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/search-config requires interactive mode", "error");
    return;
  }
  let config: SearchConfig;
  try {
    config = await readSearchConfig(ctx.cwd);
  } catch (error) {
    ctx.ui.notify(`Search config: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const draft: SearchConfigDraft = {
        engines: new Set(config.engines),
        lightpandaFallback: config.lightpandaFallback,
      };
      let list: SettingsList;
      const status = new Text("", 1, 0);
      const persist = () => {
        void saveSearchConfig(config.file, { engines: [...draft.engines], lightpandaFallback: draft.lightpandaFallback })
          .then(
            () => status.setText(theme.fg("dim", `Saved to ${config.file}`)),
            (error: unknown) =>
              status.setText(theme.fg("error", `Save failed: ${error instanceof Error ? error.message : String(error)}`)),
          )
          .finally(() => tui.requestRender());
      };
      const items: SettingItem[] = [
        ...engineOrder().map((name) => ({
          id: name,
          label: ENGINE_LABELS[name] ?? name,
          currentValue: draft.engines.has(name) ? "on" : "off",
          values: ["on", "off"],
          description: ENGINE_HINTS[name] ?? "",
        })),
        {
          id: "lightpandaFallback",
          label: "Lightpanda fallback",
          currentValue: draft.lightpandaFallback ? "on" : "off",
          values: ["on", "off"],
          description:
            "Render an engine page locally with Lightpanda when the network transports return no results; required by Brave and Yahoo.",
        },
        {
          id: "reset",
          label: "Reset",
          currentValue: "defaults",
          values: ["defaults"],
          description: `Enable ${DEFAULT_ENGINE_NAMES.join(" and ")}; Lightpanda fallback off.`,
        },
      ];
      const syncRows = () => {
        for (const item of items) {
          if (item.id === "reset") continue;
          if (item.id === "lightpandaFallback") list.updateValue(item.id, draft.lightpandaFallback ? "on" : "off");
          else list.updateValue(item.id, draft.engines.has(item.id) ? "on" : "off");
        }
      };
      const onChange = (id: string, value: string) => {
        if (!toggleSearchConfig(draft, id, value)) {
          list.updateValue(id, "on");
          tui.requestRender();
          return;
        }
        syncRows();
        persist();
      };
      list = new SettingsList(items, items.length, settingsTheme(theme), onChange, () => done());
      const container = new Container();
      container.addChild(rule(theme));
      container.addChild(new Text(theme.fg("accent", theme.bold("Search config")), 1, 0));
      container.addChild(
        new Text(theme.fg("dim", "Applies to the web_search sweep; at least one engine stays on."), 1, 0),
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
