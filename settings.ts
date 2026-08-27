import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentDir } from "./agent-dir.ts";

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(file, "utf-8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
    return undefined;
  } catch {
    return undefined;
  }
}

function toNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.floor(value);
}

function pickNumber(data: Record<string, unknown>, paths: string[][]): number | undefined {
  for (const path of paths) {
    let cur: unknown = data;
    for (const key of path) {
      if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = (cur as Record<string, unknown>)[key];
      else {
        cur = undefined;
        break;
      }
    }
    const n = toNumber(cur);
    if (n !== undefined) return n;
  }
  return undefined;
}

const MAX_RESULTS = 5;

const MAX_RESULTS_PATHS: string[][] = [
  ["unslothWebTools", "maxResults"],
  ["webSearch", "maxResults"],
  ["smartWebSearch", "resultsPerQuery"],
];

const FETCH_MAX_CHARS_PATHS: string[][] = [
  ["unslothWebTools", "maxChars"],
  ["webFetch", "maxChars"],
  ["smartFetchDefaultMaxChars"],
];

const FETCH_TIMEOUT_PATHS: string[][] = [
  ["unslothWebTools", "timeoutMs"],
  ["webFetch", "timeoutMs"],
  ["smartFetchDefaultTimeoutMs"],
];

function clampMaxResults(value: number): number {
  return Math.min(20, Math.max(1, value));
}

function settingsFiles(cwd?: string): string[] {
  const base = agentDir();
  const globalFile = base ? join(base, "settings.json") : "";
  const files = globalFile ? [globalFile] : [];
  if (cwd) files.push(join(cwd, ".pi", "settings.json"));
  return files;
}

async function settingsEntries(cwd?: string): Promise<Record<string, unknown>[]> {
  const entries: Record<string, unknown>[] = [];
  for (const file of settingsFiles(cwd)) {
    const data = await readJson(file);
    if (data) entries.push(data);
  }
  return entries;
}

export async function loadDefaultMaxResults(cwd?: string): Promise<number> {
  let result = MAX_RESULTS;
  for (const data of await settingsEntries(cwd)) {
    const candidate = pickNumber(data, MAX_RESULTS_PATHS);
    if (candidate !== undefined) result = clampMaxResults(candidate);
  }
  return result;
}

async function loadFetchSetting(cwd: string | undefined, paths: string[][], valid: (n: number) => boolean): Promise<number | undefined> {
  let result: number | undefined;
  for (const data of await settingsEntries(cwd)) {
    const candidate = pickNumber(data, paths);
    if (candidate !== undefined && valid(candidate)) result = candidate;
  }
  return result;
}

export async function loadDefaultFetchMaxChars(cwd?: string): Promise<number | undefined> {
  return loadFetchSetting(cwd, FETCH_MAX_CHARS_PATHS, (n) => n > 0);
}

export async function loadDefaultFetchTimeoutMs(cwd?: string): Promise<number | undefined> {
  return loadFetchSetting(cwd, FETCH_TIMEOUT_PATHS, (n) => n >= 1000);
}

export async function loadDefaultFetchSettings(cwd?: string): Promise<{ maxChars?: number; timeoutMs?: number }> {
  let maxChars: number | undefined;
  let timeoutMs: number | undefined;
  for (const data of await settingsEntries(cwd)) {
    const c = pickNumber(data, FETCH_MAX_CHARS_PATHS);
    if (c !== undefined && c > 0) maxChars = c;
    const t = pickNumber(data, FETCH_TIMEOUT_PATHS);
    if (t !== undefined && t >= 1000) timeoutMs = t;
  }
  return { maxChars, timeoutMs };
}
