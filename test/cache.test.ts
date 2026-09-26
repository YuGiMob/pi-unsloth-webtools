import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCached, isFresh, setCached, type CacheEntry } from "../cache.ts";

const CACHE_TTL_MS = 60 * 60 * 1000;
const STALE_MAX_AGE_MS = 24 * CACHE_TTL_MS;
const MAX_ENTRIES = 128;

let dir: string;
const initialCacheDir = process.env.PI_UNSLOTH_CACHE_DIR;
const initialAgentDir = process.env.PI_CODING_AGENT_DIR;

async function jsonNames(target: string): Promise<string[]> {
  return (await readdir(target)).filter((name) => name.endsWith(".json"));
}

async function writeEntry(name: string, timestamp: number): Promise<void> {
  await writeFile(
    join(dir, name),
    JSON.stringify({ url: `https://example.com/${name}`, body: "b", contentType: "text/plain", timestamp }),
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-unsloth-cache-"));
  process.env.PI_UNSLOTH_CACHE_DIR = dir;
});

afterEach(async () => {
  if (initialCacheDir === undefined) delete process.env.PI_UNSLOTH_CACHE_DIR;
  else process.env.PI_UNSLOTH_CACHE_DIR = initialCacheDir;
  if (initialAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = initialAgentDir;
  await rm(dir, { recursive: true, force: true });
});

describe("cache storage", () => {
  it("stores and returns entries keyed by canonicalized urls", async () => {
    await setCached("https://example.com/page?utm_source=rss#section", "cached body", "text/html");
    const entry = await getCached("https://example.com/page");
    expect(entry).toMatchObject({ url: "https://example.com/page", body: "cached body", contentType: "text/html" });
    expect(typeof entry?.timestamp).toBe("number");
    expect(await jsonNames(dir)).toHaveLength(1);
  });

  it("leaves no temp files after a successful write", async () => {
    await setCached("https://example.com/page", "body", "text/plain");
    expect((await readdir(dir)).some((name) => name.includes(".tmp."))).toBe(false);
  });

  it("returns null for unknown urls", async () => {
    expect(await getCached("https://example.com/missing")).toBeNull();
  });

  it("ignores unreadable and malformed entries", async () => {
    await setCached("https://example.com/page", "body", "text/plain");
    const [name] = await jsonNames(dir);
    const path = join(dir, name);
    await writeFile(path, "not json");
    expect(await getCached("https://example.com/page")).toBeNull();
    await writeFile(path, JSON.stringify({ url: "https://example.com/page", body: 5, contentType: "text/plain", timestamp: 1 }));
    expect(await getCached("https://example.com/page")).toBeNull();
    await writeFile(path, '{"url":"https://example.com/page","body":"b","contentType":"text/plain","timestamp":1e999}');
    expect(await getCached("https://example.com/page")).toBeNull();
  });

  it("does not throw when the cache path is not a directory", async () => {
    const filePath = join(dir, "occupied");
    await writeFile(filePath, "not a directory");
    process.env.PI_UNSLOTH_CACHE_DIR = filePath;
    await expect(setCached("https://example.com/", "body", "text/plain")).resolves.toBeUndefined();
    expect(await getCached("https://example.com/")).toBeNull();
  });

  it("leaves no temp files when the final rename fails", async () => {
    await setCached("https://example.com/page", "body", "text/plain");
    const [name] = await jsonNames(dir);
    const target = join(dir, name);
    await rm(target);
    await mkdir(target);
    await setCached("https://example.com/page", "body again", "text/plain");
    expect((await readdir(dir)).some((entry) => entry.includes(".tmp."))).toBe(false);
    expect(await getCached("https://example.com/page")).toBeNull();
  });

  it.skipIf(process.platform === "win32")("creates a private cache directory and files", async () => {
    const nested = join(dir, "nested", "cache");
    process.env.PI_UNSLOTH_CACHE_DIR = nested;
    await setCached("https://example.com/", "body", "text/plain");
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
    const [name] = await jsonNames(nested);
    expect((await stat(join(nested, name))).mode & 0o777).toBe(0o600);
  });

  it("falls back to the agent directory when no override is set", async () => {
    const agent = join(dir, "agent");
    await mkdir(agent);
    delete process.env.PI_UNSLOTH_CACHE_DIR;
    process.env.PI_CODING_AGENT_DIR = agent;
    await setCached("https://example.com/", "body", "text/plain");
    expect(await jsonNames(join(agent, "pi-unsloth-cache"))).toHaveLength(1);
  });
});

describe("cache freshness", () => {
  it("treats entries within the ttl as fresh", () => {
    const entry: CacheEntry = { url: "https://example.com/", body: "b", contentType: "text/plain", timestamp: 1_000 };
    expect(isFresh(entry, 1_000 + CACHE_TTL_MS - 1)).toBe(true);
    expect(isFresh(entry, 1_000 + CACHE_TTL_MS)).toBe(false);
    expect(isFresh(entry, 1_000 + CACHE_TTL_MS + 1)).toBe(false);
  });
});

describe("cache pruning", () => {
  it("deletes entries past the stale retention window", async () => {
    await writeEntry("stale.json", Date.now() - STALE_MAX_AGE_MS - 1);
    await setCached("https://example.com/new", "fresh", "text/plain");
    expect(await jsonNames(dir)).toHaveLength(1);
    expect(await getCached("https://example.com/new")).not.toBeNull();
  });

  it("prunes the oldest entries past the count cap", async () => {
    const base = Date.now() - 10 * 60 * 1000;
    for (let i = 0; i < MAX_ENTRIES + 12; i++) {
      await writeEntry(`old-${String(i).padStart(3, "0")}.json`, base + i);
    }
    await setCached("https://example.com/newest", "b", "text/plain");
    const names = await jsonNames(dir);
    expect(names).toHaveLength(MAX_ENTRIES);
    expect(names).not.toContain("old-000.json");
    expect(names).toContain(`old-${String(MAX_ENTRIES + 11).padStart(3, "0")}.json`);
  });

  it("cleans stale temp files and keeps fresh ones", async () => {
    const staleTmp = join(dir, "leftover.json.tmp.42");
    const freshTmp = join(dir, "active.json.tmp.43");
    await writeFile(staleTmp, "partial");
    await writeFile(freshTmp, "partial");
    const old = new Date(Date.now() - CACHE_TTL_MS - 60_000);
    await utimes(staleTmp, old, old);
    await setCached("https://example.com/", "body", "text/plain");
    const names = await readdir(dir);
    expect(names).not.toContain("leftover.json.tmp.42");
    expect(names).toContain("active.json.tmp.43");
  });
});
