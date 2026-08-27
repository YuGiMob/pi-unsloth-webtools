import { randomBytes } from "node:crypto";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { collapseWhitespace, decodeHtmlEntities, feedHtml } from "./html-to-md.ts";
import type { AttrDict } from "./html-to-md.ts";
import { randomUserAgent } from "./user-agents.ts";
import { agentDir } from "./agent-dir.ts";
import { MAX_SIGNAL_TIMEOUT_MS } from "./web-access.ts";
export class EmptySweepError extends Error {
  constructor() {
    super("No results found");
  }
}

export class SearchTimeoutError extends Error {
  providers: string[];
  constructor(providers: string[] = []) {
    super("timed out");
    this.providers = providers;
  }
}

export class SearchCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}


export interface SearchResult {
  title: string;
  href: string;
  body: string;
}

const STRIP_TAGS_RE = /<.*?>/g;

export function normalizeText(raw: string): string {
  if (!raw) return "";
  let text = raw.replace(STRIP_TAGS_RE, "");
  text = decodeHtmlEntities(text);
  text = text.normalize("NFC");
  text = text.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}]/gu, "");
  return collapseWhitespace(text);
}

export function normalizeUrl(url: string): string {
  if (!url) return "";
  try {
    return decodeURIComponent(url).replace(/ /g, "+");
  } catch {
    return url.replace(/ /g, "+");
  }
}

const TRACKING_PARAM_NAMES = new Set([
  "_hsenc",
  "_hsmi",
  "dclid",
  "fbclid",
  "gbraid",
  "gclid",
  "gclsrc",
  "igshid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "srsltid",
  "twclid",
  "wbraid",
  "yclid",
]);

export function canonicalizeHref(href: string): string {
  if (!href) return "";
  try {
    const url = new URL(href);
    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith("utm_") || TRACKING_PARAM_NAMES.has(lower)) {
        url.searchParams.delete(key);
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return href;
  }
}

export interface DomNode {
  tag: string;
  attrs: Record<string, string>;
  children: DomNode[];
  textNodes: string[];
}

export function buildDom(html: string): DomNode {
  const root: DomNode = { tag: "#root", attrs: {}, children: [], textNodes: [] };
  const stack: DomNode[] = [root];
  const pushText = (text: string) => {
    for (const el of stack) el.textNodes.push(text);
  };
  feedHtml(html, {
    handleStartTag(name: string, attrs: AttrDict) {
      const el: DomNode = {
        tag: name,
        attrs: Object.fromEntries(
          Object.entries(attrs).map(([key, value]) => [key, value ?? ""]),
        ),
        children: [],
        textNodes: [],
      };
      stack[stack.length - 1].children.push(el);
      stack.push(el);
    },
    handleStartEndTag() {},
    handleEndTag(name: string) {
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tag === name) {
          stack.length = i;
          return;
        }
      }
    },
    handleData(text: string) {
      pushText(text);
    },
    handleEntityRef(name: string) {
      pushText(decodeHtmlEntities(`&${name};`));
    },
    handleCharRef(name: string) {
      pushText(decodeHtmlEntities(`&#${name};`));
    },
  });
  return root;
}

type Pred =
  | { op: "or"; a: Pred; b: Pred }
  | { op: "and"; a: Pred; b: Pred }
  | { op: "last" }
  | { op: "class-contains"; value: string }
  | { op: "attr-eq"; name: string; value: string }
  | { op: "has-attr"; name: string }
  | { op: "desc"; tag: string }
  | { op: "child"; tag: string; preds: Pred[] };

interface XStep {
  axis: "descendant" | "child";
  name?: string;
  preds: Pred[];
  terminal?: "text" | string;
}
function parsePredicateBlocks(input: string, start: number): { preds: Pred[]; next: number } {
  const preds: Pred[] = [];
  let pos = start;
  while (pos < input.length && input[pos] === "[") {
    const innerStart = pos + 1;
    let depth = 1;
    let quote: string | null = null;
    let j = innerStart;
    while (j < input.length && depth) {
      const c = input[j];
      if (quote !== null) {
        if (c === quote) quote = null;
      } else if (c === "'" || c === '"') {
        quote = c;
      } else if (c === "[") {
        depth++;
      } else if (c === "]") {
        depth--;
      }
      j++;
    }
    preds.push(parsePredExpr(input.slice(innerStart, j - 1)));
    pos = j;
  }
  return { preds, next: pos };
}

function parsePredExpr(input: string): Pred {
  let pos = 0;
  const ws = () => {
    while (pos < input.length && /\s/.test(input[pos])) pos++;
  };
  const word = () => {
    ws();
    const m = /^[A-Za-z][A-Za-z0-9_-]*/.exec(input.slice(pos));
    if (!m) throw new Error(`bad predicate: ${input}`);
    pos += m[0].length;
    return m[0];
  };
  const quoted = () => {
    ws();
    const quote = input[pos];
    if (quote !== "'" && quote !== '"') throw new Error(`bad predicate quote: ${input}`);
    pos++;
    const end = input.indexOf(quote, pos);
    if (end === -1) throw new Error(`bad predicate quote: ${input}`);
    const value = input.slice(pos, end);
    pos = end + 1;
    return value;
  };
  const atom = (): Pred => {
    ws();
    if (input[pos] === "(") {
      pos++;
      const inner = parseOr();
      ws();
      if (input[pos] !== ")") throw new Error(`bad predicate paren: ${input}`);
      pos++;
      return inner;
    }
    if (input.startsWith("position()=last()", pos)) {
      pos += "position()=last()".length;
      return { op: "last" };
    }
    if (input.startsWith("contains(@class,", pos)) {
      pos += "contains(@class,".length;
      const value = quoted();
      ws();
      if (input[pos] !== ")") throw new Error(`bad predicate contains: ${input}`);
      pos++;
      return { op: "class-contains", value };
    }
    if (input[pos] === "@") {
      pos++;
      const name = word();
      ws();
      if (input[pos] === "=") {
        pos++;
        const value = quoted();
        return { op: "attr-eq", name, value };
      }
      return { op: "has-attr", name };
    }
    if (input.startsWith(".//", pos)) {
      pos += 3;
      const name = word();
      return { op: "desc", tag: name };
    }
    const name = word();
    const { preds, next } = parsePredicateBlocks(input, pos);
    pos = next;
    return { op: "child", tag: name, preds };
  };
  const parseAnd = (): Pred => {
    let left = atom();
    while (true) {
      ws();
      if (input.startsWith("and", pos) && !/[A-Za-z0-9_]/.test(input[pos + 3] ?? "")) {
        pos += 3;
        left = { op: "and", a: left, b: atom() };
      } else {
        return left;
      }
    }
  };
  const parseOr = (): Pred => {
    let left = parseAnd();
    while (true) {
      ws();
      if (input.startsWith("or", pos) && !/[A-Za-z0-9_]/.test(input[pos + 2] ?? "")) {
        pos += 2;
        left = { op: "or", a: left, b: parseAnd() };
      } else {
        return left;
      }
    }
  };
  return parseOr();
}

function parsePath(expr: string): XStep[] {
  const steps: XStep[] = [];
  let i = 0;
  let axis: "child" | "descendant" = "child";
  if (expr.startsWith("//")) {
    axis = "descendant";
    i = 2;
  } else if (expr.startsWith("./")) {
    i = 2;
    if (expr[i] === "/") {
      axis = "descendant";
      i++;
    }
  }
  while (i < expr.length) {
    if (expr[i] === "/") {
      if (expr[i + 1] === "/") {
        axis = "descendant";
        i += 2;
      } else {
        axis = "child";
        i++;
      }
      continue;
    }
    if (expr[i] === ".") {
      i++;
      continue;
    }
    if (expr[i] === "@") {
      i++;
      const m = /^[A-Za-z0-9_-]+/.exec(expr.slice(i));
      steps.push({ axis, preds: [], terminal: m ? m[0] : "" });
      i += m ? m[0].length : 0;
      continue;
    }
    if (expr.startsWith("text()", i)) {
      steps.push({ axis, preds: [], terminal: "text" });
      i += 6;
      continue;
    }
    const m = /^[A-Za-z][A-Za-z0-9_-]*/.exec(expr.slice(i));
    if (!m) break;
    const name = m[0];
    i += m[0].length;
    const { preds, next } = parsePredicateBlocks(expr, i);
    i = next;
    steps.push({ axis, name, preds });
  }
  return steps;
}

function descendantsOf(el: DomNode): DomNode[] {
  const out: DomNode[] = [];
  const walk = (node: DomNode) => {
    for (const child of node.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(el);
  return out;
}

function matchesPred(pred: Pred, el: DomNode, index: number, total: number): boolean {
  switch (pred.op) {
    case "or":
      return matchesPred(pred.a, el, index, total) || matchesPred(pred.b, el, index, total);
    case "and":
      return matchesPred(pred.a, el, index, total) && matchesPred(pred.b, el, index, total);
    case "last":
      return index === total - 1;
    case "class-contains":
      return (el.attrs["class"] ?? "").includes(pred.value);
    case "attr-eq":
      return el.attrs[pred.name] === pred.value;
    case "has-attr":
      return pred.name in el.attrs;
    case "desc":
      return el.tag === pred.tag || descendantsOf(el).some((d) => d.tag === pred.tag);
    case "child":
      return el.children.some(
        (c) => c.tag === pred.tag && pred.preds.every((p) => matchesPred(p, c, 0, 1)),
      );
  }
}

function applyStep(step: XStep, nodes: DomNode[]): DomNode[] {
  const candidates: DomNode[] = [];
  for (const node of nodes) {
    const list = step.axis === "child" ? node.children : descendantsOf(node);
    for (const c of list) {
      if (step.name && c.tag !== step.name) continue;
      candidates.push(c);
    }
  }
  const deduped: DomNode[] = [];
  const seen = new Set<DomNode>();
  for (const c of candidates) {
    if (!seen.has(c)) {
      seen.add(c);
      deduped.push(c);
    }
  }
  const total = deduped.length;
  return deduped.filter((el, index) => step.preds.every((p) => matchesPred(p, el, index, total)));
}

export function xpathText(expr: string, node: DomNode): string[] {
  const steps = parsePath(expr);
  let nodes: DomNode[] = [node];
  for (const step of steps) {
    if (step.terminal === "text") {
      const out: string[] = [];
      for (const n of nodes) out.push(...n.textNodes);
      return out;
    }
    if (step.terminal !== undefined) {
      return nodes.map((n) => n.attrs[step.terminal as string] ?? "");
    }
    nodes = applyStep(step, nodes);
  }
  return [];
}

export function xpathNodes(expr: string, root: DomNode): DomNode[] {
  const steps = parsePath(expr);
  let nodes: DomNode[] = [root];
  for (const step of steps) {
    if (step.terminal) break;
    nodes = applyStep(step, nodes);
  }
  return nodes;
}

export function extractResults(
  html: string,
  itemsXpath: string,
  elementsXpath: { title: string; href: string; body: string },
): SearchResult[] {
  const root = buildDom(html);
  const items = xpathNodes(itemsXpath, root);
  const results: SearchResult[] = [];
  for (const item of items) {
    const result: SearchResult = { title: "", href: "", body: "" };
    const entries = [
      ["title", elementsXpath.title],
      ["href", elementsXpath.href],
      ["body", elementsXpath.body],
    ] as const;
    for (const [key, value] of entries) {
      const data = collapseWhitespace(xpathText(value, item).join(""));
      if (!data) continue;
      result[key] = key === "href" ? normalizeUrl(data) : normalizeText(data);
    }
    results.push(result);
  }
  return results;
}

function googleUserAgent(): string {
  const devices: [string, string, number, number][] = [
    ["5.0", "SM-G900P Build/LRX21T", 39, 60],
    ["6.0", "Nexus 5 Build/MRA58N", 39, 60],
    ["8.0", "Pixel 2 Build/OPD3.170816.012", 39, 60],
  ];
  const [androidVer, device, chromeMin, chromeMax] = devices[Math.floor(Math.random() * devices.length)];
  const chromeMajor = chromeMin + Math.floor(Math.random() * (chromeMax - chromeMin + 1));
  const chromeBuild = 1000 + Math.floor(Math.random() * 9000);
  const chromePatch = 1000 + Math.floor(Math.random() * 1000);
  return (
    `Mozilla/5.0 (Linux; Android ${androidVer}; ${device}) ` +
    `AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${chromeMajor}.0.${chromeBuild}.${chromePatch} Mobile Safari/537.36` +
    "NSTNWV"
  );
}

function tokenUrlSafe(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

function unquotePlus(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, "%20"));
  } catch {
    return value.replace(/\+/g, " ");
  }
}

function yahooExtractUrl(raw: string): string {
  const afterRu = raw.split("/RU=", 2)[1] ?? "";
  const t = afterRu.split("/RK=", 1)[0].split("/RS=", 1)[0];
  return unquotePlus(t);
}

interface EngineContext {
  region: string;
  safesearch: string;
}

export interface Engine {
  name: string;
  provider: string;
  priority?: number;
  search(
    query: string,
    ctx: EngineContext,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[] | null>;
}

interface HttpRequestOptions {
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface HttpOptions extends HttpRequestOptions {
  method?: string;
  body?: string;
}

async function httpGet(
  url: string,
  params: Record<string, string>,
  options: HttpRequestOptions,
): Promise<string | null> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return httpFetch(target.toString(), options);
}

async function httpPost(
  url: string,
  data: Record<string, string>,
  options: HttpRequestOptions,
): Promise<string | null> {
  return httpFetch(url, { ...options, method: "POST", body: new URLSearchParams(data).toString() });
}

const MAX_ENGINE_RESPONSE_BYTES = 5 * 1024 * 1024;
const ENGINE_RETRY_BACKOFF_MS = 250;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readBodyCapped(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_ENGINE_RESPONSE_BYTES) return null;
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_ENGINE_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

function mapFetchError(err: unknown): never {
  if (err instanceof DOMException && err.name === "TimeoutError") throw new SearchTimeoutError();
  if (err instanceof DOMException && err.name === "AbortError") throw new SearchCancelled();
  throw err;
}

async function httpFetch(
  url: string,
  options: HttpOptions,
): Promise<string | null> {
  const headers: Record<string, string> = {
    "User-Agent": options.headers?.["User-Agent"] ?? randomUserAgent(),
    Accept: "*/*",
    ...options.headers,
  };
  if (options.method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  const cookie = options.cookies
    ? Object.entries(options.cookies)
        .map(([key, value]) => `${key}=${value}`)
        .join("; ")
    : null;
  if (cookie) headers["Cookie"] = cookie;
  const timeoutMs = Math.min(MAX_SIGNAL_TIMEOUT_MS, Math.max(1, options.timeoutMs));
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (options.signal) signals.push(options.signal);
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.method === "POST" ? options.body : undefined,
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    throw mapFetchError(err);
  }
  if (response.status !== 200) {
    try {
      await response.body?.cancel();
    } catch {
      return null;
    }
    return null;
  }
  try {
    return await readBodyCapped(response);
  } catch (err) {
    throw mapFetchError(err);
  }
}

const DUCKDUCKGO: Engine = {
  name: "duckduckgo",
  provider: "bing",
  async search(query, ctx, timeoutMs, signal) {
    const html = await httpPost(
      "https://html.duckduckgo.com/html/",
      { q: query, b: "", l: ctx.region },
      { headers: { "User-Agent": randomUserAgent() }, timeoutMs, signal },
    );
    if (!html) return null;
    const results = extractResults(html, "//div[contains(@class, 'body')]", {
      title: ".//h2//text()",
      href: "./a/@href",
      body: "./a//text()",
    });
    return results.filter((r) => !r.href.startsWith("https://duckduckgo.com/y.js?"));
  },
};

const BRAVE: Engine = {
  name: "brave",
  provider: "brave",
  async search(query, ctx, timeoutMs, signal) {
    const country = ctx.region.toLowerCase().split("-")[0];
    const cookies: Record<string, string> = { [country]: country, useLocation: "0" };
    if (ctx.safesearch !== "moderate") {
      cookies["safesearch"] = ctx.safesearch === "on" ? "strict" : "off";
    }
    const html = await httpGet(
      "https://search.brave.com/search",
      { q: query, source: "web" },
      { cookies, timeoutMs, signal },
    );
    if (!html) return null;
    return extractResults(html, "//div[@data-type='web']", {
      title:
        ".//div[(contains(@class,'title') or contains(@class,'sitename-container')) and position()=last()]//text()",
      href: ".//a[div[contains(@class, 'title')]]/@href",
      body: ".//div[contains(@class, 'snippet')]//div[contains(@class, 'content')]//text()",
    });
  },
};

const GOOGLE: Engine = {
  name: "google",
  provider: "google",
  async search(query, ctx, timeoutMs, signal) {
    const [country, lang] = ctx.region.split("-");
    const safesearchBase: Record<string, string> = { on: "2", moderate: "1", off: "0" };
    const html = await httpGet(
      "https://www.google.com/search",
      {
        q: query,
        filter: safesearchBase[ctx.safesearch.toLowerCase()] ?? "1",
        start: "0",
        hl: `${lang}-${country.toUpperCase()}`,
        lr: `lang_${lang}`,
        cr: `country${country.toUpperCase()}`,
      },
      {
        headers: { "User-Agent": googleUserAgent() },
        cookies: { CONSENT: "YES+" },
        timeoutMs,
        signal,
      },
    );
    if (!html) return null;
    const results = extractResults(html, "//div[@data-hveid][.//h3]", {
      title: ".//h3//text()",
      href: ".//a[.//h3]/@href",
      body: "./div/div[last()]//text()",
    });
    return results
      .map((r) => {
        if (r.href.startsWith("/url?q=")) {
          r.href = r.href.split("?q=")[1].split("&")[0];
        }
        return r;
      })
      .filter((r) => r.title && r.href.startsWith("http"));
  },
};

const MOJEEK: Engine = {
  name: "mojeek",
  provider: "mojeek",
  async search(query, ctx, timeoutMs, signal) {
    const [country, lang] = ctx.region.toLowerCase().split("-");
    const params: Record<string, string> = { q: query };
    if (ctx.safesearch === "on") params["safe"] = "1";
    const html = await httpGet(
      "https://www.mojeek.com/search",
      params,
      { cookies: { arc: country, lb: lang }, timeoutMs, signal },
    );
    if (!html) return null;
    return extractResults(html, "//ul[contains(@class, 'results')]/li", {
      title: ".//h2//text()",
      href: ".//h2/a/@href",
      body: ".//p[@class='s']//text()",
    });
  },
};

const YAHOO: Engine = {
  name: "yahoo",
  provider: "bing",
  async search(query, _ctx, timeoutMs, signal) {
    const ylt = tokenUrlSafe(18);
    const ylu = tokenUrlSafe(35);
    const html = await httpGet(
      `https://search.yahoo.com/search;_ylt=${ylt};_ylu=${ylu}`,
      { p: query },
      { timeoutMs, signal },
    );
    if (!html) return null;
    const results = extractResults(html, "//div[contains(@class, 'relsrch')]", {
      title: ".//div[contains(@class, 'Title')]//h3//text()",
      href: ".//div[contains(@class, 'Title')]//a/@href",
      body: ".//div[contains(@class, 'Text')]//text()",
    });
    return results
      .filter((r) => !r.href.startsWith("https://www.bing.com/aclick?"))
      .map((r) => {
        if (r.href.includes("/RU=")) r.href = yahooExtractUrl(r.href);
        return r;
      });
  },
};

const YANDEX: Engine = {
  name: "yandex",
  provider: "yandex",
  async search(query, _ctx, timeoutMs, signal) {
    const searchid = 1000000 + Math.floor(Math.random() * 9000000);
    const html = await httpGet(
      "https://yandex.com/search/site/",
      { text: query, web: "1", searchid: String(searchid) },
      { timeoutMs, signal },
    );
    if (!html) return null;
    return extractResults(html, "//li[contains(@class, 'serp-item')]", {
      title: ".//h3//text()",
      href: ".//h3//a/@href",
      body: ".//div[contains(@class, 'text')]//text()",
    });
  },
};

const WIKIPEDIA: Engine = {
  name: "wikipedia",
  provider: "wikipedia",
  priority: 2,
  async search(query, ctx, timeoutMs, signal) {
    const started = Date.now();
    const lang = ctx.region.toLowerCase().split("-")[1] ?? "en";
    const encoded = encodeURIComponent(query);
    const opensearchUrl =
      `https://${lang}.wikipedia.org/w/api.php?action=opensearch&profile=fuzzy&limit=1&search=${encoded}`;
    const opensearch = await httpGet(opensearchUrl, {}, { timeoutMs, signal });
    if (!opensearch) return null;
    let data: unknown;
    try {
      data = JSON.parse(opensearch);
    } catch {
      return null;
    }
    const payload = data as [string, string[], string[], string[]];
    if (!payload[1] || !payload[1].length) return [];
    const title = payload[1][0];
    const href = payload[3][0];
    let body = "";
    const extractUrl =
      `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&prop=extracts` +
      `&titles=${encodeURIComponent(title)}&explaintext=0&exintro=0&redirects=1`;
    const extract = await httpGet(extractUrl, {}, { timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)), signal });
    if (extract) {
      try {
        const pageData = JSON.parse(extract) as {
          query: { pages: Record<string, { extract?: string }> };
        };
        const pages = Object.values(pageData.query.pages);
        if (pages.length) body = pages[0].extract ?? "";
      } catch {
        body = "";
      }
    }
    if (body.includes("may refer to:")) return [];
    return [{ title: normalizeText(title), href: normalizeUrl(href), body: normalizeText(body) }];
  },
};

export const TEXT_ENGINES: Engine[] = [DUCKDUCKGO, BRAVE, GOOGLE, MOJEEK, YAHOO, YANDEX, WIKIPEDIA];

export class ResultsAggregator {
  private cache = new Map<string, SearchResult>();
  private counter = new Map<string, number>();

  get size(): number {
    return this.cache.size;
  }

  append(item: SearchResult): void {
    const key = canonicalizeHref(item.href);
    const existing = this.cache.get(key);
    if (!existing || item.body.length > existing.body.length) {
      this.cache.set(key, { ...item, href: key });
    }
    this.counter.set(key, (this.counter.get(key) ?? 0) + 1);
  }

  extend(items: SearchResult[]): void {
    for (const item of items) this.append(item);
  }

  extractDicts(): SearchResult[] {
    return [...this.counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key]) => this.cache.get(key)!);
  }
}

function extractTokens(query: string): Set<string> {
  return new Set(query.toLowerCase().split(/\W+/u).filter((t) => t.length >= 3));
}

function hasAnyToken(text: string, tokens: Set<string>): boolean {
  const lower = text.toLowerCase();
  for (const token of tokens) {
    if (lower.includes(token)) return true;
  }
  return false;
}

export function rankResults(docs: SearchResult[], query: string): SearchResult[] {
  const tokens = extractTokens(query);
  const wiki: SearchResult[] = [];
  const both: SearchResult[] = [];
  const titleOnly: SearchResult[] = [];
  const bodyOnly: SearchResult[] = [];
  const neither: SearchResult[] = [];
  for (const doc of docs) {
    if (doc.title.includes("Category:") && doc.title.includes("Wikimedia")) continue;
    if (doc.href.includes("wikipedia.org")) {
      wiki.push(doc);
      continue;
    }
    const hitTitle = hasAnyToken(doc.title, tokens);
    const hitBody = hasAnyToken(doc.body, tokens);
    if (hitTitle && hitBody) both.push(doc);
    else if (hitTitle) titleOnly.push(doc);
    else if (hitBody) bodyOnly.push(doc);
    else neither.push(doc);
  }
  return [...wiki, ...both, ...titleOnly, ...bodyOnly, ...neither];
}
async function recordSweepStats(query: string, maxResults: number, started: number, timedOutProviders: string[], resultCount: number): Promise<void> {
  const flag = process.env.PI_UNSLOTH_WEBTOOLS_STATS?.trim();
  if (!flag) return;
  const lower = flag.toLowerCase();
  if (lower === "0" || lower === "false" || lower === "no" || lower === "off") return;
  const base = agentDir();
  if (!base) return;
  const isDefaultFlag = lower === "1" || lower === "true" || lower === "yes" || lower === "on";
  const statsPath = isDefaultFlag ? join(base, "pi-unsloth-webtools-stats.jsonl") : isAbsolute(flag) ? flag : join(base, flag);
  try {
    const dir = dirname(statsPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      try {
        await chmod(dir, 0o700);
      } catch {}
    }
    const sortedProviders = [...timedOutProviders].sort();
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      query,
      maxResults,
      durationMs: Date.now() - started,
      timedOutProviders: sortedProviders,
      resultCount,
    });
    await appendFile(statsPath, entry + "\n", { mode: 0o600 });
    if (process.platform !== "win32") {
      try {
        await chmod(statsPath, 0o600);
      } catch {}
    }
  } catch {}
}

function shuffledEngines(): Engine[] {
  const shuffled = [...TEXT_ENGINES];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const wikipedia = shuffled.find((e) => e.priority === 2);
  const rest = shuffled.filter((e) => e.priority !== 2);
  return wikipedia ? [wikipedia, ...rest] : shuffled;
}

export async function autoTextSearch(
  query: string,
  maxResults: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const started = Date.now();
  const engines = shuffledEngines();
  const deadline = started + timeoutMs;
  const seenProviders = new Set<string>();
  const aggregator = new ResultsAggregator();
  const ctx: EngineContext = { region: "us-en", safesearch: "moderate" };
  const controller = new AbortController();
  const timedOutProviders = new Set<string>();
  let cancelled = false;
  const uniqueProviders = new Set(engines.map((e) => e.provider)).size;
  const maxWorkers = Math.min(uniqueProviders, Math.ceil(maxResults / 10) + 1);
  let i = 0;
  let pending: Promise<void>[] = [];
  const run = async (engine: Engine) => {
    let results: SearchResult[] | null = null;
    for (let attempt = 0; attempt < 2 && results === null; attempt++) {
      if (controller.signal.aborted) return;
      const budgetLeft = deadline - Date.now();
      if (budgetLeft <= 0) return;
      if (attempt > 0 && budgetLeft < ENGINE_RETRY_BACKOFF_MS) return;
      const remaining = Math.max(1, budgetLeft);
      const engineSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      try {
        results = await engine.search(query, ctx, remaining, engineSignal);
      } catch (e) {
        if (e instanceof SearchCancelled) {
          if (controller.signal.aborted && !signal?.aborted) return;
          cancelled = true;
          return;
        }
        if (e instanceof SearchTimeoutError) {
          timedOutProviders.add(engine.name);
          return;
        }
      }
      if (results === null && attempt === 0) {
        const backoff = Math.min(ENGINE_RETRY_BACKOFF_MS, Math.max(0, deadline - Date.now()));
        if (backoff > 0) await sleep(backoff);
        if (signal?.aborted) {
          cancelled = true;
          return;
        }
        if (controller.signal.aborted) return;
      }
    }
    if (results && results.length) {
      aggregator.extend(results);
      seenProviders.add(engine.provider);
      if (aggregator.size >= maxResults) controller.abort();
    }
  };
  while (i < engines.length) {
    if (aggregator.size >= maxResults || cancelled) {
      controller.abort();
      break;
    }
    const engine = engines[i++];
    if (seenProviders.has(engine.provider)) continue;
    pending.push(run(engine));
    if (pending.length >= maxWorkers) {
      await Promise.allSettled(pending);
      pending = [];
    }
  }
  await Promise.allSettled(pending);
  if (cancelled) throw new SearchCancelled();
  const results = rankResults(aggregator.extractDicts(), query);
  if (results.length) {
    void recordSweepStats(query, maxResults, started, [...timedOutProviders].sort(), results.length);
    return results.slice(0, maxResults);
  }
  if (timedOutProviders.size) {
    const sorted = [...timedOutProviders].sort();
    void recordSweepStats(query, maxResults, started, sorted, 0);
    throw new SearchTimeoutError(sorted);
  }
  void recordSweepStats(query, maxResults, started, [], 0);
  throw new EmptySweepError();
}
