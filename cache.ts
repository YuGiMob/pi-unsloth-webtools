import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentDir } from "./agent-dir.ts";
import { canonicalizeHref } from "./engines.ts";

const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 128;
const MAX_BYTES = 128 * 1024 * 1024;
const STALE_MAX_AGE_MS = 24 * CACHE_TTL_MS;

function cacheDir(): string {
  const env = process.env.PI_UNSLOTH_CACHE_DIR?.trim();
  if (env) return env;
  const base = agentDir();
  if (base) return join(base, "pi-unsloth-cache");
  return join(tmpdir(), "pi-unsloth-cache");
}

function cacheKey(url: string): string {
  const canon = canonicalizeHref(url) || url;
  return createHash("sha256").update(canon).digest("hex");
}

function cachePath(key: string): string {
  return join(cacheDir(), `${key}.json`);
}

async function secureChmod(path: string, mode: number): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(path, mode);
  } catch {}
}

async function unlinkSafe(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(): Promise<void> {
  const dir = cacheDir();
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await secureChmod(dir, 0o700);
  } catch {}
}

export interface CacheEntry {
  url: string;
  body: string;
  contentType: string;
  timestamp: number;
}

export async function getCached(url: string): Promise<CacheEntry | null> {
  const key = cacheKey(url);
  const path = cachePath(key);
  try {
    const raw = await readFile(path, "utf8");
    const entry = JSON.parse(raw) as CacheEntry;
    if (!entry || typeof entry.body !== "string" || typeof entry.contentType !== "string" || typeof entry.timestamp !== "number") return null;
    if (!Number.isFinite(entry.timestamp)) return null;
    return entry;
  } catch {
    return null;
  }
}

export async function setCached(url: string, body: string, contentType: string): Promise<void> {
  await ensureDir();
  const key = cacheKey(url);
  const path = cachePath(key);
  const entry: CacheEntry = { url: canonicalizeHref(url) || url, body, contentType, timestamp: Date.now() };
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmpPath, JSON.stringify(entry), { mode: 0o600 });
    await secureChmod(tmpPath, 0o600);
    await rename(tmpPath, path);
    await secureChmod(path, 0o600);
  } catch {
    await unlinkSafe(tmpPath);
    return;
  }
  await prune();
}

async function prune(): Promise<void> {
  const dir = cacheDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return;
  }
  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  if (!jsonFiles.length) return;
  const now = Date.now();
  const entries: { file: string; size: number; timestamp: number }[] = [];
  let total = 0;
  for (const file of jsonFiles) {
    const full = join(dir, file);
    try {
      const s = await stat(full);
      let timestamp = s.mtimeMs;
      try {
        const raw = await readFile(full, "utf8");
        const entry = JSON.parse(raw) as CacheEntry;
        if (entry && typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) timestamp = entry.timestamp;
      } catch {}
      if (now - timestamp >= STALE_MAX_AGE_MS) {
        await unlinkSafe(full);
        continue;
      }
      entries.push({ file: full, size: s.size, timestamp });
      total += s.size;
    } catch {}
  }
  const expired = entries.filter((e) => now - e.timestamp >= CACHE_TTL_MS).sort((a, b) => a.timestamp - b.timestamp);
  for (const e of expired) {
    if (entries.length <= MAX_ENTRIES && total <= MAX_BYTES) break;
    if (await unlinkSafe(e.file)) {
      total -= e.size;
      const idx = entries.indexOf(e);
      if (idx !== -1) entries.splice(idx, 1);
    }
  }
  if (entries.length <= MAX_ENTRIES && total <= MAX_BYTES) return;
  entries.sort((a, b) => a.timestamp - b.timestamp);
  let idx = 0;
  while (idx < entries.length && (entries.length > MAX_ENTRIES || total > MAX_BYTES)) {
    const e = entries[idx];
    if (await unlinkSafe(e.file)) {
      total -= e.size;
      entries.splice(idx, 1);
    } else {
      idx++;
    }
  }
}

export function isFresh(entry: CacheEntry, now = Date.now()): boolean {
  return now - entry.timestamp < CACHE_TTL_MS;
}

export function staleNotice(entry: CacheEntry): string {
  const date = new Date(entry.timestamp).toISOString().slice(0, 10);
  return `\n\n*STALE cache from ${date} — network fetch failed, serving cached copy*`;
}
