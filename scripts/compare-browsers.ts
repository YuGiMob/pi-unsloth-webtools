import { htmlToMarkdown, visibleChars } from "../html-to-md.ts";
import { fetchUrlRaw, resolveAndValidateHost } from "../web-fetch.ts";
import { impersonatedRequest } from "../tls-fetch.ts";
import { renderPageWithLightpanda } from "../lightpanda.ts";

const TIMEOUT_MS = 45_000;
const THIN_CHARS = 1000;
const CHALLENGE_RE = /just a moment|attention required|checking if the site connection is secure/i;
const BLOCK_RE = /just a moment|attention required|you have been blocked|enable javascript and cookies|access denied|please enable cookies/i;
const DEFAULT_TARGETS = [
  "https://example.com/",
  "https://en.wikipedia.org/wiki/Web_scraping",
  "https://react.dev/learn",
  "https://nextjs.org/docs",
  "https://github.com/unslothai/unsloth",
  "https://www.reddit.com/r/programming/",
  "https://medium.com/@davidbyttow/hello-world",
  "https://www.g2.com/products/asana/reviews",
  "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array",
];

interface Cell {
  chars: number;
  ms: number;
  failed: boolean;
  blocked?: boolean;
  detail?: string;
}

interface BrowserPage {
  goto(url: string, options: Record<string, unknown>): Promise<unknown>;
  content(): Promise<string>;
  title(): Promise<string>;
  waitForTimeout(ms: number): Promise<void>;
  url(): string;
}

interface BrowserContext {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

interface BrowserInstance {
  newContext(): Promise<BrowserContext>;
  close(): Promise<void>;
}

type CamoufoxLauncher = (options: Record<string, unknown>) => Promise<BrowserInstance>;

async function loadCamoufox(): Promise<CamoufoxLauncher | null> {
  try {
    const moduleName = "camoufox-js";
    const loaded = (await import(moduleName)) as unknown as { Camoufox: CamoufoxLauncher };
    return loaded.Camoufox;
  } catch {
    return null;
  }
}

function readable(body: string, contentType: string): { chars: number; blocked: boolean } {
  const isHtml =
    contentType.includes("html") || /^\s*<(!doctype|html|head|body)/i.test(body.slice(0, 200));
  const text = isHtml ? htmlToMarkdown(body, true) : body;
  return { chars: visibleChars(text), blocked: BLOCK_RE.test(text) };
}

async function timed(run: () => Promise<Omit<Cell, "ms">>): Promise<Cell> {
  const start = performance.now();
  try {
    return { ...(await run()), ms: performance.now() - start };
  } catch (error) {
    return {
      chars: 0,
      ms: performance.now() - start,
      failed: true,
      detail: String(error instanceof Error ? error.message : error).slice(0, 40),
    };
  }
}

async function directCell(url: string): Promise<Cell> {
  return timed(async () => {
    const result = await fetchUrlRaw(url, { transport: "off", timeoutMs: TIMEOUT_MS });
    if (result.error) return { chars: 0, failed: true, detail: result.error.slice(0, 34) };
    return { ...readable(result.body, result.contentType), failed: false };
  });
}

async function wreqCell(url: string): Promise<Cell> {
  return timed(async () => {
    const parsed = new URL(url);
    const resolved = await resolveAndValidateHost(parsed.hostname, undefined, true);
    if (!resolved.ok) return { chars: 0, failed: true, detail: resolved.reason.slice(0, 34) };
    const result = await impersonatedRequest({
      url: parsed,
      pinnedIp: resolved.ip,
      family: resolved.family,
      timeoutMs: TIMEOUT_MS,
      maxBytes: 4 * 1024 * 1024,
    });
    if (result === null || result.status >= 400) {
      return { chars: 0, failed: true, detail: `HTTP ${result?.status ?? "ERR"}` };
    }
    return { ...readable(result.body.toString("utf-8"), result.headers["content-type"] ?? ""), failed: false };
  });
}

async function lightpandaCell(url: string): Promise<Cell> {
  return timed(async () => {
    const text = await renderPageWithLightpanda(url, { timeoutMs: TIMEOUT_MS });
    if (text === null) return { chars: 0, failed: true, detail: "unavailable" };
    if (text.startsWith("Failed to render URL:") || text.startsWith("Blocked:")) {
      return { chars: 0, failed: true, detail: text.slice(0, 34) };
    }
    return { chars: visibleChars(text), blocked: BLOCK_RE.test(text), failed: false };
  });
}

function camoufoxCellFor(browser: BrowserInstance, budgetMs: number) {
  return (url: string): Promise<Cell> =>
    timed(async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
        let result = readable(await page.content(), "text/html");
        for (let waited = 0; waited < budgetMs; waited += 1000) {
          if (result.chars >= THIN_CHARS && !result.blocked) break;
          const title = await page.title();
          if (result.chars >= THIN_CHARS && !CHALLENGE_RE.test(title)) break;
          await page.waitForTimeout(1000);
          result = readable(await page.content(), "text/html");
        }
        return { ...result, failed: false };
      } finally {
        await context.close();
      }
    });
}

function bytes(count: number): string {
  return count >= 1024 ? `${(count / 1024).toFixed(1)}KB` : `${count}B`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + " ".repeat(width - value.length);
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const secondsArg = args.find((arg) => arg.startsWith("--seconds="));
const challengeBudgetMs = secondsArg ? Number(secondsArg.split("=")[1]) * 1000 : 25_000;
const targets = args.filter((arg) => !arg.startsWith("--"));
const list = targets.length ? targets : DEFAULT_TARGETS;

const columns: { name: string; cell: (url: string) => Promise<Cell> }[] = [
  { name: "DIRECT", cell: directCell },
  { name: "WREQ", cell: wreqCell },
];
if (!flags.has("--no-lightpanda")) columns.push({ name: "LIGHTPANDA", cell: lightpandaCell });
let browser: BrowserInstance | null = null;
if (!flags.has("--no-camoufox")) {
  const camoufox = await loadCamoufox();
  if (camoufox === null) {
    console.log("camoufox-js is not installed; skipping the CAMOUFOX column");
  } else {
    browser = await camoufox({ headless: true, geoip: true, humanize: false });
    columns.push({ name: "CAMOUFOX", cell: camoufoxCellFor(browser, challengeBudgetMs) });
  }
}

const width = Math.max(...list.map((url) => url.length), 20);
const columnWidth = 24;
console.log(
  pad("URL", width) + "  " + columns.map((column) => pad(column.name, columnWidth)).join("  "),
);

const tally = new Map<string, number>();
for (const url of list) {
  const results: Cell[] = [];
  for (const column of columns) results.push(await column.cell(url));
  const bestIndex = results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => !result.failed && result.chars >= THIN_CHARS && !result.blocked)
    .sort((a, b) => b.result.chars - a.result.chars)[0]?.index;
  if (bestIndex !== undefined) {
    const name = columns[bestIndex].name;
    tally.set(name, (tally.get(name) ?? 0) + 1);
  }
  const rendered = results.map((result, index) => {
    const value = result.failed
      ? (result.detail ?? "failed")
      : `${result.blocked ? "BLOCK " : ""}${bytes(result.chars)}`;
    return pad(`${value} · ${Math.round(result.ms)}ms${index === bestIndex ? " *" : ""}`, columnWidth);
  });
  console.log(pad(url, width) + "  " + rendered.join("  "));
}

await browser?.close();
console.log("");
console.log(
  `best readable text per target (>= ${THIN_CHARS} chars, challenge pages excluded):`,
  [...tally.entries()].map(([name, count]) => `${name} ${count}`).join(" · ") || "none",
);
console.log(
  "camoufox requires a separate install: npm i camoufox-js playwright-core && npx camoufox-js fetch" +
    (process.platform === "linux" ? " (plus GTK3 system libraries)" : ""),
);
