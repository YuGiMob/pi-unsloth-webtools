import { execSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDefaultResultOrder } from "node:dns";
import { htmlToMarkdown, visibleChars } from "../html-to-md.ts";

setDefaultResultOrder("ipv4first");

const SANNY = "https://bot.sannysoft.com/";
const WALL =
  "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array";
const PLAIN = "https://en.wikipedia.org/wiki/Web_scraping";
const CHALLENGE_RE = /just a moment|attention required|checking if the site connection is secure/i;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (html: string) => htmlToMarkdown(html, true);

interface Session {
  visit(url: string, budgetMs: number): Promise<string>;
  close(): Promise<void>;
}

interface Row {
  name: string;
  needle: string;
  open: () => Promise<Session>;
}

async function loadModule(specifier: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(specifier)) as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

function rssOf(needle: string): string {
  try {
    const out = execSync(`ps -eo rss,args | grep -F "${needle}" | grep -v grep`, { encoding: "utf8" });
    const kb = out.trim().split("\n").filter(Boolean).reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[0] ?? 0), 0);
    return `${Math.round(kb / 1024)}MB`;
  } catch {
    return "-";
  }
}

function detectionRows(text: string): string {
  const wanted = ["WebDriver (New)", "WebDriver Advanced", "Chrome (New)", "User Agent (Old)"];
  const found: string[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (wanted.some((w) => line.includes(w))) found.push(line.replace(/\s+/g, " ").slice(0, 70));
    if (found.length >= 4) break;
  }
  return found.join(" | ") || "(no rows matched)";
}

async function runRow(row: Row, attempts: number, budgetMs: number): Promise<void> {
  let session: Session | null = null;
  const start = Date.now();
  try {
    session = await row.open();
    const launchMs = Date.now() - start;
    const detection = detectionRows(textOf(await session.visit(SANNY, 4000)));
    const plain = `${visibleChars(textOf(await session.visit(PLAIN, 6000)))} chars`;
    const outcomes: string[] = [];
    for (let i = 0; i < attempts; i++) {
      const wallStart = Date.now();
      try {
        const html = await session.visit(WALL, budgetMs);
        const chars = visibleChars(textOf(html));
        const challenged = CHALLENGE_RE.test(html.slice(0, 800));
        outcomes.push(`${chars}ch/${((Date.now() - wallStart) / 1000).toFixed(1)}s${challenged ? " BLOCKED" : ""}`);
      } catch (error) {
        outcomes.push(`ERR ${String(error instanceof Error ? error.message : error).slice(0, 28)}`);
      }
    }
    console.log(
      `${row.name.padEnd(20)} launch=${String(launchMs).padStart(5)}ms rss=${rssOf(row.needle).padStart(6)} plain=${plain.padEnd(11)} wall: ${outcomes.join("  ")}`,
    );
    console.log(`  detection: ${detection}`);
  } catch (error) {
    console.log(`${row.name.padEnd(20)} FAILED: ${String(error instanceof Error ? error.message : error).slice(0, 90)}`);
  } finally {
    await session?.close().catch(() => {});
  }
}

function rawCdpRow(port: number): Row {
  return {
    name: "raw-cdp-system",
    needle: "user-data-dir=/tmp/cdp-",
    open: async () => {
      const profile = mkdtempSync(join(tmpdir(), "cdp-"));
      const binary = process.env.PI_CHROMIUM_BIN ?? "chromium";
      const child = spawn(
        binary,
        ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`],
        { stdio: "ignore" },
      );
      let version: { webSocketDebuggerUrl: string } | null = null;
      for (let i = 0; i < 60 && !version; i++) {
        try {
          version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
        } catch {
          await wait(250);
        }
      }
      if (!version) throw new Error(`no devtools endpoint (is ${binary} installed? set PI_CHROMIUM_BIN)`);
      const ws = new WebSocket(version.webSocketDebuggerUrl);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
      });
      let nextId = 0;
      const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as { id?: number; error?: { message: string }; result?: unknown };
        if (message.id && pending.has(message.id)) {
          const handlers = pending.get(message.id)!;
          pending.delete(message.id);
          if (message.error) handlers.reject(new Error(message.error.message));
          else handlers.resolve(message.result as never);
        }
      });
      const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<never> =>
        new Promise((resolve, reject) => {
          const id = ++nextId;
          pending.set(id, { resolve: resolve as (value: never) => void, reject });
          ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      const created = (await send("Target.createTarget", { url: "about:blank" })) as unknown as { targetId: string };
      const attached = (await send("Target.attachToTarget", { targetId: created.targetId, flatten: true })) as unknown as { sessionId: string };
      const sessionId = attached.sessionId;
      const read = async (): Promise<string> => {
        const result = (await send(
          "Runtime.evaluate",
          { expression: "document.documentElement ? document.documentElement.outerHTML : ''", returnByValue: true },
          sessionId,
        )) as unknown as { result?: { value?: string } };
        return String(result.result?.value ?? "");
      };
      return {
        async visit(url: string, budgetMs: number) {
          await send("Page.navigate", { url }, sessionId);
          const start = Date.now();
          let html = await read();
          while (Date.now() - start < budgetMs && (visibleChars(textOf(html)) < 1000 || CHALLENGE_RE.test(html.slice(0, 800)))) {
            await wait(1000);
            html = await read();
          }
          return html;
        },
        async close() {
          ws.close();
          child.kill("SIGKILL");
          await wait(300);
        },
      };
    },
  };
}

function playwrightRow(moduleName: string, channel?: string): Row {
  return {
    name: channel ? "playwright-chromium" : "playwright-shell",
    needle: "ms-playwright",
    open: async () => {
      const module = await loadModule(moduleName);
      if (!module) throw new Error(`install it first: npm i ${moduleName}`);
      const chromium = module.chromium as {
        launch(options: Record<string, unknown>): Promise<{
          newContext(): Promise<{ newPage(): Promise<{ goto(url: string, options: Record<string, unknown>): Promise<unknown>; content(): Promise<string>; close(): Promise<void> }>; close(): Promise<void> }>;
          close(): Promise<void>;
        }>;
      };
      const browser = await chromium.launch({
        headless: true,
        chromiumSandbox: false,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
        ...(channel ? { channel } : {}),
      });
      const context = await browser.newContext();
      const page = await context.newPage();
      return {
        async visit(url: string, budgetMs: number) {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          const start = Date.now();
          let html = await page.content();
          while (Date.now() - start < budgetMs && (visibleChars(textOf(html)) < 1000 || CHALLENGE_RE.test(html.slice(0, 800)))) {
            await wait(1000);
            html = await page.content();
          }
          return html;
        },
        async close() {
          await context.close().catch(() => {});
          await browser.close().catch(() => {});
        },
      };
    },
  };
}

function camoufoxRow(): Row {
  return {
    name: "camoufox",
    needle: "camoufox",
    open: async () => {
      const module = await loadModule("camoufox-js");
      if (!module) throw new Error("install it first: npm i camoufox-js playwright-core && npx camoufox-js fetch");
      const launch = module.Camoufox as (options: Record<string, unknown>) => Promise<{
        newContext(): Promise<{ newPage(): Promise<{ goto(url: string, options: Record<string, unknown>): Promise<unknown>; content(): Promise<string>; close(): Promise<void> }>; close(): Promise<void> }>;
        close(): Promise<void>;
      }>;
      const browser = await launch({ headless: true, geoip: true, humanize: false });
      const context = await browser.newContext();
      const page = await context.newPage();
      return {
        async visit(url: string, budgetMs: number) {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          const start = Date.now();
          let html = await page.content();
          while (Date.now() - start < budgetMs && (visibleChars(textOf(html)) < 1000 || CHALLENGE_RE.test(html.slice(0, 800)))) {
            await wait(1000);
            html = await page.content();
          }
          return html;
        },
        async close() {
          await context.close().catch(() => {});
          await browser.close().catch(() => {});
        },
      };
    },
  };
}

const args = process.argv.slice(2);
const numberFlag = (name: string, fallback: number): number => {
  const found = args.find((arg) => arg.startsWith(`${name}=`));
  return found ? Number(found.split("=")[1]) : fallback;
};
const attempts = numberFlag("--attempts", 2);
const budgetMs = numberFlag("--seconds", 25) * 1000;
const targets = args.filter((arg) => !arg.startsWith("--"));
const rows: Row[] = [];
if (targets.length) {
  for (const target of targets) {
    if (target === "raw-cdp") rows.push(rawCdpRow(9333));
    else if (target === "camoufox") rows.push(camoufoxRow());
    else rows.push(playwrightRow(target === "patchright" ? "patchright" : "playwright", target === "playwright" ? "chromium" : undefined));
  }
} else {
  rows.push(rawCdpRow(9333), playwrightRow("playwright", "chromium"), playwrightRow("patchright"), camoufoxRow());
}

console.log(`${attempts} walled attempts x ${budgetMs / 1000}s; detection from bot.sannysoft.com; BLOCKED = challenge page still showing\n`);
for (const row of rows) await runRow(row, attempts, budgetMs);
console.log("\nrows: raw-cdp | playwright | patchright | camoufox (pass names to run a subset)");
