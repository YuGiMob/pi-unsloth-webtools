import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG_DIR_NAME = "pi-unsloth-webtools";
const TEMP_PREFIX = ".tmp-";
const CONFIG_LOCK_DELAY_MS = 25;
const CONFIG_LOCK_STALE_MS = 5000;
const CONFIG_LOCK_RETRIES = Math.ceil(CONFIG_LOCK_STALE_MS / CONFIG_LOCK_DELAY_MS) * 2;

export interface Config {
  webRenderEnabled: boolean;
}

const DEFAULT_CONFIG: Config = {
  webRenderEnabled: true,
};

function homeBase(): string {
  const envHome = process.env.HOME;
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function configBase(): string {
  if (process.platform !== "win32") {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg && xdg.length > 0) return xdg;
  }
  return join(homeBase(), ".config");
}

export function configDir(): string {
  return join(configBase(), CONFIG_DIR_NAME);
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function parseConfig(content: string): Config {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed) || (parsed.webRenderEnabled !== undefined && typeof parsed.webRenderEnabled !== "boolean")) {
    throw new Error("config.json must be an object with a boolean webRenderEnabled field");
  }
  return {
    webRenderEnabled:
      typeof parsed.webRenderEnabled === "boolean" ? parsed.webRenderEnabled : DEFAULT_CONFIG.webRenderEnabled,
  };
}

async function loadConfigFile(): Promise<{ config: Config; corrupted: boolean }> {
  let content: string;
  try {
    content = await readFile(configPath(), "utf-8");
  } catch (error: unknown) {
    if (errCode(error) === "ENOENT") return { config: { ...DEFAULT_CONFIG }, corrupted: false };
    console.error("Config file unreadable, using defaults:", error);
    return { config: { ...DEFAULT_CONFIG }, corrupted: false };
  }
  try {
    return { config: parseConfig(content), corrupted: false };
  } catch (error: unknown) {
    try {
      const badPath = configPath();
      await rename(badPath, `${badPath}.corrupt-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`);
    } catch {}
    console.error("Config file corrupted, quarantined, using defaults:", error);
    return { config: { ...DEFAULT_CONFIG }, corrupted: true };
  }
}

export async function readConfig(): Promise<Config> {
  return (await loadConfigFile()).config;
}

export async function readConfigWithStatus(): Promise<{ config: Config; corrupted: boolean }> {
  return loadConfigFile();
}

async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {}
}

export async function writeConfig(config: Config): Promise<void> {
  const path = configPath();
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tempPath = join(dir, `${TEMP_PREFIX}${randomUUID()}`);
  const content = JSON.stringify(config, null, 2);
  await writeFile(tempPath, content, { mode: 0o600 });
  try {
    await rename(tempPath, path);
    await syncDir(dir);
  } catch (error: unknown) {
    if (process.platform === "win32" && errCode(error) === "EPERM") {
      try {
        await writeFile(path, content, "utf-8");
        return;
      } finally {
        try {
          await rm(tempPath, { force: true });
        } catch {}
      }
    }
    try {
      await rm(tempPath, { force: true });
    } catch {}
    throw error;
  }
}

interface ConfigLock {
  path: string;
  dev: number;
  ino: number;
}

async function acquireConfigLock(lockPath: string): Promise<ConfigLock> {
  try {
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  } catch {}
  for (let attempt = 0; attempt < CONFIG_LOCK_RETRIES; attempt++) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error: unknown) {
      if (errCode(error) === "ENOENT") {
        try {
          await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
        } catch {}
        continue;
      }
      if (errCode(error) !== "EEXIST") throw error;
      try {
        const lockStats = await stat(lockPath);
        if (Date.now() - lockStats.mtimeMs > CONFIG_LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {}
      await new Promise<void>((resolve) => setTimeout(resolve, CONFIG_LOCK_DELAY_MS));
      continue;
    }
    try {
      const lockStats = await stat(lockPath);
      return { path: lockPath, dev: lockStats.dev, ino: lockStats.ino };
    } catch (error: unknown) {
      if (errCode(error) !== "ENOENT") {
        try {
          await rm(lockPath, { recursive: true, force: true });
        } catch {}
      }
      continue;
    }
  }
  throw new Error(`[E_ACCESS] Could not acquire config lock: ${lockPath}`);
}

async function releaseConfigLock(lock: ConfigLock): Promise<void> {
  try {
    const lockStats = await stat(lock.path);
    if (lockStats.dev !== lock.dev || lockStats.ino !== lock.ino) return;
  } catch {
    return;
  }
  try {
    await rm(lock.path, { recursive: true, force: true });
  } catch {}
}

export async function updateConfig(mut: (config: Config) => void): Promise<Config> {
  const path = configPath();
  const lock = await acquireConfigLock(`${path}.lock`);
  try {
    const config = await readConfig();
    mut(config);
    await writeConfig(config);
    return config;
  } finally {
    await releaseConfigLock(lock);
  }
}

export async function toggleWebRender(): Promise<boolean> {
  const config = await updateConfig((current) => {
    current.webRenderEnabled = !(current.webRenderEnabled === true);
  });
  return config.webRenderEnabled === true;
}
