import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync as read } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { htmlToMarkdown, visibleChars } from "../html-to-md.ts";

const STACK_DEFAULT =
  "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array";
const PLAIN_DEFAULT = [
  "https://example.com/",
  "https://en.wikipedia.org/wiki/Web_scraping",
  "https://react.dev/learn",
  "https://nextjs.org/docs",
];

interface PageLike {
  goto(url: string, options: Record<string, unknown>): Promise<{ status(): number } | null>;
  content(): Promise<string>;
  title(): Promise<string>;
  evaluate<T>(fn: () => T): Promise<T>;
  close(): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
}

interface ContextLike {
  newPage(): Promise<PageLike>;
  cookies(url?: string): Promise<{ name: string; expires: number }[]>;
  close(): Promise<void>;
}

interface InstanceLike {
  newContext?(): Promise<ContextLike>;
  newPage(): Promise<PageLike>;
  cookies?(url?: string): Promise<{ name: string; expires: number }[]>;
  close(): Promise<void>;
}

interface CookieLike {
  name: string;
  expires: number;
}

type Launcher = (options: Record<string, unknown>) => Promise<InstanceLike>;

async function load(name: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(name)) as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

function camoufoxPids(): string[] {
  try {
    const out = execSync("ps -eo pid,args | grep -i camoufox | grep -v grep", { encoding: "utf8" });
    return out.trim().split("\n").filter(Boolean).map((line) => line.trim().split(/\s+/)[0]);
  } catch {
    return [];
  }
}

function rssMb(): number {
  let kb = 0;
  for (const pid of camoufoxPids()) {
    try {
      kb += (Number(read(`/proc/${pid}/statm`, "utf8").split(" ")[1]) * 4096) / 1024;
    } catch {}
  }
  return Math.round(kb / 1024);
}

function jiffies(): number {
  let total = 0;
  for (const pid of camoufoxPids()) {
    try {
      const stat = read(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      total += Number(fields[11]) + Number(fields[12]);
    } catch {}
  }
  return total;
}

async function idleCpu(seconds: number): Promise<number> {
  const before = jiffies();
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  return Math.round((jiffies() - before) / seconds / 100);
}

async function openPage(instance: InstanceLike): Promise<PageLike> {
  if (instance.newContext) return (await instance.newContext()).newPage();
  return instance.newPage();
}

async function cookiesFor(instance: InstanceLike, url: string): Promise<CookieLike[]> {
  return instance.cookies ? instance.cookies(url) : [];
}

async function visit(open: () => Promise<PageLike>, label: string, url: string, budgetMs: number): Promise<void> {
  const start = Date.now();
  let page: PageLike | null = null;
  try {
    page = await open();
    const opened = Date.now() - start;
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const dom = Date.now() - start;
    let markdown = htmlToMarkdown(await page.content(), true);
    for (let waited = 0; waited < budgetMs && visibleChars(markdown) < 1000; waited += 1000) {
      await page.waitForTimeout(1000);
      markdown = htmlToMarkdown(await page.content(), true);
    }
    console.log(
      `  ${label.padEnd(30)} ${String(Date.now() - start).padStart(6)}ms (page ${String(opened).padStart(4)} + dom ${String(dom - opened).padStart(5)})  ${String(visibleChars(markdown)).padStart(7)} chars  status=${response?.status()}  ${JSON.stringify((await page.title()).slice(0, 26))}`,
    );
  } catch (error) {
    console.log(`  ${label.padEnd(30)} FAILED after ${Date.now() - start}ms: ${String(error instanceof Error ? error.message : error).slice(0, 50)}`);
  } finally {
    await page?.close().catch(() => {});
  }
}

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const value = (name: string, fallback: number): number => {
  const found = args.find((arg) => arg.startsWith(`${name}=`));
  return found ? Number(found.split("=")[1]) : fallback;
};
const targets = args.filter((arg) => !arg.startsWith("--"));
const plain = targets.filter((url) => !url.includes("stackoverflow"));
const walled = targets.find((url) => url.includes("stackoverflow")) ?? STACK_DEFAULT;
const list = plain.length ? plain : PLAIN_DEFAULT;
const wallBudget = value("--seconds", 45) * 1000;
const idleSeconds = value("--idle", 6);

const camoufoxModule = await load("camoufox-js");
if (!camoufoxModule) {
  console.log("install camoufox-js first: npm i camoufox-js playwright-core && npx camoufox-js fetch");
  process.exit(1);
}
const Camoufox = camoufoxModule.Camoufox as Launcher;
const profile = mkdtempSync(join(tmpdir(), "camoufox-warmup-"));
const pinned = value("--pin", 1) === 1;
let fingerprint: Record<string, unknown> | undefined;
if (pinned) {
  const generatorModule = await load("fingerprint-generator");
  if (generatorModule) {
    const Generator = generatorModule.FingerprintGenerator as new () => {
      getFingerprint(options: Record<string, unknown>): { fingerprint: Record<string, unknown> };
    };
    fingerprint = new Generator().getFingerprint({
      browsers: [{ name: "firefox" }],
      devices: ["desktop"],
      operatingSystems: ["windows"],
    }).fingerprint;
  }
}

const options: Record<string, unknown> = {
  headless: flag("--virtual") ? "virtual" : true,
  geoip: true,
  humanize: false,
  user_data_dir: profile,
};
if (fingerprint) {
  options.fingerprint = fingerprint;
  options.iKnowWhatImDoing = true;
}

console.log(`profile: ${profile}`);
console.log(`pinned identity: ${fingerprint ? String((fingerprint.navigator as { userAgent: string }).userAgent) : "no (Camoufox rotates per launch)"}\n`);

console.log("== cold launch ==");
let start = Date.now();
let instance = await Camoufox(options);
console.log(`  launch ${Date.now() - start}ms  rss=${rssMb()}MB  procs=${camoufoxPids().length}  idle cpu=${await idleCpu(idleSeconds)}% of one core`);
console.log(`  profile files: ${existsSync(profile) ? readdirSync(profile).length : 0} entries`);

console.log("\n== warm fetches (browser already running) ==");
for (const url of list) await visit(() => openPage(instance), url.replace("https://", "").slice(0, 30), url, 6000);
console.log(`  rss while warm: ${rssMb()}MB  procs=${camoufoxPids().length}`);

console.log("\n== cloudflare wall (first solve) ==");
await visit(() => openPage(instance), "walled page (cold)", walled, wallBudget);
const earned = await cookiesFor(instance, walled);
console.log(`  cookies: ${earned.map((c) => c.name).join(", ") || "none"}`);
await instance.close();
console.log(`  closed, rss=${rssMb()}MB`);
await new Promise((resolve) => setTimeout(resolve, 1500));

console.log("\n== restart with the same profile (is the clearance reusable?) ==");
start = Date.now();
instance = await Camoufox(options);
console.log(`  relaunch ${Date.now() - start}ms  rss=${rssMb()}MB`);
const restored = await cookiesFor(instance, walled);
console.log(`  cookies restored: ${restored.map((c) => c.name).join(", ") || "none"}`);
if (fingerprint) {
  const page = await openPage(instance);
  const live = await page.evaluate(() => navigator.userAgent);
  await page.close();
  const expected = String((fingerprint.navigator as { userAgent: string }).userAgent);
  console.log(`  identity stable: ${live === expected ? "yes" : `NO (live ${live})`}`);
}
await visit(() => openPage(instance), "walled page (warm)", walled, wallBudget);
await visit(() => openPage(instance), "walled page (warm again)", walled, wallBudget);
await instance.close();
console.log(`  closed, rss=${rssMb()}MB`);
console.log("\nflags: --virtual, --pin=0, --seconds=N (challenge budget), --idle=N (cpu sample)");
