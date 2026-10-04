import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { collapseWhitespace, decodeHtmlEntities, feedHtml } from "./html-to-md.ts";
import type { AttrDict } from "./html-to-md.ts";
import { randomUserAgent } from "./user-agents.ts";
import { agentDir } from "./agent-dir.ts";
import { impersonatedRequest, type FetchTransport, type TlsHopOptions, type TlsHopResponse } from "./tls-fetch.ts";
import { checkUrlAccess, isPublicIp, MAX_SIGNAL_TIMEOUT_MS, type WebsitePolicy } from "./web-access.ts";
import { socksProxyForUrl } from "./proxy.ts";
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
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
      url.port = "";
    }
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
    if (input.startsWith("last()", pos)) {
      pos += "last()".length;
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
    if (input.startsWith("./", pos)) {
      pos += 2;
      const name = word();
      const { preds, next } = parsePredicateBlocks(input, pos);
      pos = next;
      return { op: "child", tag: name, preds };
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

function predContainsLast(pred: Pred): boolean {
  switch (pred.op) {
    case "last":
      return true;
    case "or":
    case "and":
      return predContainsLast(pred.a) || predContainsLast(pred.b);
    case "child":
      return pred.preds.some(predContainsLast);
    default:
      return false;
  }
}

function applyStep(step: XStep, nodes: DomNode[]): DomNode[] {
  if (step.preds.some(predContainsLast)) {
    const out: DomNode[] = [];
    const seen = new Set<DomNode>();
    for (const node of nodes) {
      const source = step.axis === "child" ? node.children : descendantsOf(node);
      const list = source.filter((c) => !step.name || c.tag === step.name);
      const total = list.length;
      list.forEach((el, index) => {
        if (seen.has(el)) return;
        if (step.preds.every((p) => matchesPred(p, el, index, total))) {
          seen.add(el);
          out.push(el);
        }
      });
    }
    return out;
  }
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
    if (!result.title && !result.href && !result.body) continue;
    results.push(result);
  }
  return results;
}

export type EngineImpersonation = (options: TlsHopOptions) => Promise<TlsHopResponse | null>;

export interface SearchEngineOptions {
  transport?: FetchTransport;
  policy?: WebsitePolicy | null;
  impersonate?: EngineImpersonation;
  engines?: string[];
  engineWeights?: Record<string, number>;
  maxPerHost?: number;
}

export interface EngineContext extends SearchEngineOptions {
  region: string;
  safesearch: string;
}

export interface Engine {
  name: string;
  provider: string;
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
  ctx?: EngineContext;
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
const MAX_ENGINE_HOPS = 5;
const DEFAULT_ENGINE_TRANSPORT: FetchTransport = "off";

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

interface EngineHopResponse {
  status: number;
  location: string | null;
  body: string | null;
}

type EngineTransportKind = "direct" | "tls";

function engineTransportOrder(transport: FetchTransport, target: URL): EngineTransportKind[] {
  if (transport === "off" || socksProxyForUrl(target) !== null) return ["direct"];
  return transport === "direct-first" ? ["direct", "tls"] : ["tls", "direct"];
}

function engineTargetAllowed(target: string, policy: WebsitePolicy | null): boolean {
  const [allowed, , hostname] = checkUrlAccess(target, policy);
  if (!allowed) return false;
  const isLiteral = hostname.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  return !isLiteral || isPublicIp(hostname);
}

function classifyRequestError(
  err: unknown,
  caller: AbortSignal | undefined,
  hopSignal: AbortSignal,
): Error | null {
  if (caller?.aborted) return new SearchCancelled();
  if (hopSignal.aborted) return new SearchTimeoutError();
  if (err instanceof DOMException && err.name === "TimeoutError") return new SearchTimeoutError();
  if (err instanceof DOMException && err.name === "AbortError") return new SearchTimeoutError();
  if (err instanceof Error && err.message === "timed out") return new SearchTimeoutError();
  if (err instanceof Error && err.message === "cancelled") return new SearchCancelled();
  return null;
}

async function directEngineHop(
  target: URL,
  headers: Record<string, string>,
  method: string,
  body: string | undefined,
  signal: AbortSignal,
): Promise<EngineHopResponse | null> {
  const response = await fetch(target.toString(), { method, headers, body, signal, redirect: "manual" });
  if (response.status === 200) {
    const text = await readBodyCapped(response);
    return text === null ? null : { status: 200, location: null, body: text };
  }
  try {
    await response.body?.cancel();
  } catch {}
  return { status: response.status, location: response.headers.get("location"), body: null };
}

function tlsEngineHop(
  impersonate: EngineImpersonation,
  target: URL,
  headers: Record<string, string>,
  method: string,
  body: string | undefined,
  caller: AbortSignal | undefined,
  timeoutMs: number,
): Promise<EngineHopResponse | null> {
  return impersonate({
    url: target,
    timeoutMs,
    signal: caller,
    maxBytes: MAX_ENGINE_RESPONSE_BYTES,
    maxPdfBytes: MAX_ENGINE_RESPONSE_BYTES,
    method,
    body,
    extraHeaders: headers,
  }).then((response) => {
    if (response === null || response.truncated) return null;
    return {
      status: response.status,
      location: response.headers.location ?? null,
      body: response.status === 200 ? new TextDecoder("utf-8").decode(response.body) : null,
    };
  });
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
  const deadline = Date.now() + timeoutMs;
  const caller = options.signal;
  const transport = options.ctx?.transport ?? DEFAULT_ENGINE_TRANSPORT;
  const policy = options.ctx?.policy ?? null;
  const impersonate = options.ctx?.impersonate ?? (transport === "off" ? null : impersonatedRequest);
  let method = options.method ?? "GET";
  let body = method === "POST" ? options.body : undefined;
  let target = url;
  for (let hop = 0; hop < MAX_ENGINE_HOPS; hop++) {
    if (caller?.aborted) throw new SearchCancelled();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SearchTimeoutError();
    const targetUrl = new URL(target);
    const hopSignal = caller
      ? AbortSignal.any([caller, AbortSignal.timeout(remaining)])
      : AbortSignal.timeout(remaining);
    let response: EngineHopResponse | null = null;
    let failure: unknown = null;
    for (const kind of engineTransportOrder(transport, targetUrl)) {
      try {
        let attempt: EngineHopResponse | null = null;
        if (kind === "tls") {
          if (impersonate !== null) {
            attempt = await tlsEngineHop(impersonate, targetUrl, headers, method, body, caller, remaining);
          }
        } else {
          attempt = await directEngineHop(targetUrl, headers, method, body, hopSignal);
        }
        if (attempt === null) continue;
        if (response === null || (attempt.status < 400 && response.status >= 400)) response = attempt;
        if (attempt.status < 400) break;
      } catch (err) {
        const mapped = classifyRequestError(err, caller, hopSignal);
        if (mapped) throw mapped;
        failure = err;
      }
    }
    if (response === null) {
      if (failure) throw failure;
      return null;
    }
    if (response.status >= 300 && response.status < 400) {
      if (!response.location) return null;
      let next: string;
      try {
        next = new URL(response.location, target).toString();
      } catch {
        return null;
      }
      if (!engineTargetAllowed(next, policy)) return null;
      if (response.status !== 307 && response.status !== 308) {
        method = "GET";
        body = undefined;
      }
      target = next;
      continue;
    }
    if (response.status !== 200) return null;
    return response.body ?? "";
  }
  return null;
}

const DUCKDUCKGO: Engine = {
  name: "duckduckgo",
  provider: "bing",
  async search(query, ctx, timeoutMs, signal) {
    const html = await httpPost(
      "https://html.duckduckgo.com/html/",
      { q: query, b: "", l: ctx.region },
      { headers: { "User-Agent": randomUserAgent() }, timeoutMs, signal, ctx },
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

const YANDEX: Engine = {
  name: "yandex",
  provider: "yandex",
  async search(query, ctx, timeoutMs, signal) {
    const searchid = 1000000 + Math.floor(Math.random() * 9000000);
    const html = await httpGet(
      "https://yandex.com/search/site/",
      { text: query, web: "1", searchid: String(searchid) },
      { timeoutMs, signal, ctx },
    );
    if (!html) return null;
    return extractResults(html, "//li[contains(@class, 'serp-item')]", {
      title: ".//h3//text()",
      href: ".//h3//a/@href",
      body: ".//div[contains(@class, 'text')]//text()",
    });
  },
};

const START_PAGE: Engine = {
  name: "startpage",
  provider: "google",
  async search(query, ctx, timeoutMs, signal) {
    const [country, lang] = ctx.region.toLowerCase().split("-");
    const html = await httpGet(
      "https://www.startpage.com/sp/search",
      { query, qsr: `${lang}_${country.toUpperCase()}` },
      { headers: { Referer: "https://www.startpage.com/" }, timeoutMs, signal, ctx },
    );
    if (!html) return null;
    return extractResults(html, "//div[contains(@class, 'result')][./a]", {
      title: ".//h2//text()",
      href: "./a/@href",
      body: ".//p//text()",
    });
  },
};

export const TEXT_ENGINES: Engine[] = [DUCKDUCKGO, YANDEX, START_PAGE];

export class ResultsAggregator {
  private cache = new Map<string, SearchResult>();
  private scores = new Map<string, number>();

  get size(): number {
    return this.cache.size;
  }

  append(item: SearchResult, weight = 1, rank = 1): void {
    if (typeof item.href !== "string" || !item.href.trim()) return;
    const key = canonicalizeHref(item.href);
    if (!key) return;
    const existing = this.cache.get(key);
    if (!existing || item.body.length > existing.body.length) {
      this.cache.set(key, { ...item, href: key });
    }
    this.scores.set(key, (this.scores.get(key) ?? 0) + weight / (RRF_RANK_CONSTANT + rank));
  }

  extend(items: SearchResult[], weight = 1): void {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      const key = canonicalizeHref(item.href);
      if (!key) return;
      const first = !seen.has(key);
      seen.add(key);
      this.append(item, first ? weight : 0, index + 1);
    });
  }

  ranked(): SearchResult[] {
    return [...this.cache.entries()]
      .filter(([, doc]) => !isWikimediaCategory(doc))
      .map(([key, doc]) => ({ doc, score: this.scores.get(key) ?? 0 }))
      .sort((a, b) => b.score - a.score || a.doc.href.localeCompare(b.doc.href))
      .map((entry) => entry.doc);
  }
}

const RRF_RANK_CONSTANT = 60;
const DEFAULT_MAX_PER_HOST = 0;
const MULTI_PART_SUFFIXES = new Set(["co.uk", "org.uk", "com.au", "co.jp", "co.nz", "com.br", "co.in"]);

export function registrableDomain(url: string): string {
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
  const parts = hostname.split(".");
  if (parts.length < 2) return hostname;
  const lastTwo = parts.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3 ? parts.slice(-3).join(".") : lastTwo;
}

export function capByHost(docs: SearchResult[], limit: number, maxPerHost: number): SearchResult[] {
  if (limit <= 0) return [];
  const perHost = new Map<string, number>();
  const capped: SearchResult[] = [];
  const allowed = maxPerHost > 0 ? maxPerHost : Number.POSITIVE_INFINITY;
  for (const doc of docs) {
    const domain = registrableDomain(doc.href);
    const used = perHost.get(domain) ?? 0;
    if (used >= allowed) continue;
    perHost.set(domain, used + 1);
    capped.push(doc);
    if (capped.length >= limit) break;
  }
  return capped;
}

function isWikimediaCategory(doc: SearchResult): boolean {
  return doc.title.includes("Category:") && doc.title.includes("Wikimedia");
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

function selectedEngines(names: string[] | undefined): Engine[] {
  if (!names?.length) return TEXT_ENGINES;
  const wanted = new Set(names.map((name) => name.trim().toLowerCase()));
  const chosen = TEXT_ENGINES.filter((engine) => wanted.has(engine.name));
  return chosen.length ? chosen : TEXT_ENGINES;
}

function shuffledEngines(engines: Engine[] = TEXT_ENGINES): Engine[] {
  const shuffled = [...engines];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export async function autoTextSearch(
  query: string,
  maxResults: number,
  timeoutMs: number,
  signal?: AbortSignal,
  options: SearchEngineOptions = {},
): Promise<SearchResult[]> {
  const started = Date.now();
  const engines = shuffledEngines(selectedEngines(options.engines));
  const deadline = started + timeoutMs;
  const seenProviders = new Set<string>();
  const aggregator = new ResultsAggregator();
  const engineWeights = options.engineWeights ?? {};
  const maxPerHost = options.maxPerHost ?? DEFAULT_MAX_PER_HOST;
  const enough = () => capByHost(aggregator.ranked(), maxResults, maxPerHost).length >= maxResults;
  const ctx: EngineContext = {
    region: "us-en",
    safesearch: "moderate",
    transport: options.transport ?? DEFAULT_ENGINE_TRANSPORT,
    policy: options.policy ?? null,
    impersonate: options.impersonate,
  };
  const controller = new AbortController();
  let onAbort: (() => void) | undefined;
  if (signal) {
    if (signal.aborted) controller.abort();
    else {
      onAbort = () => controller.abort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  const timedOutProviders = new Set<string>();
  let cancelled = false;
  const uniqueProviders = new Set(engines.map((e) => e.provider)).size;
  const maxWorkers = Math.min(uniqueProviders, Math.max(4, Math.ceil(maxResults / 5) + 1));
  let i = 0;
  const pending = new Set<Promise<void>>();
  const run = async (engine: Engine) => {
    let results: SearchResult[] | null = null;
    for (let attempt = 0; attempt < 2 && results === null; attempt++) {
      if (controller.signal.aborted) {
        if (signal?.aborted) cancelled = true;
        return;
      }
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
      aggregator.extend(results, engineWeights[engine.name] ?? 1);
      seenProviders.add(engine.provider);
      if (enough()) controller.abort();
    }
  };
  while (i < engines.length || pending.size > 0) {
    if (enough() || cancelled) {
      controller.abort();
      break;
    }
    while (i < engines.length && pending.size < maxWorkers) {
      if (enough() || cancelled) {
        controller.abort();
        break;
      }
      const engine = engines[i++];
      if (seenProviders.has(engine.provider)) continue;
      const task = run(engine);
      pending.add(task);
      void task.then(
        () => {
          pending.delete(task);
        },
        () => {
          pending.delete(task);
        },
      );
    }
    if (pending.size === 0) break;
    if (enough() || cancelled) {
      controller.abort();
      break;
    }
    await Promise.race(pending);
  }
  await Promise.allSettled(pending);
  if (onAbort && signal) signal.removeEventListener("abort", onAbort);
  if (cancelled) throw new SearchCancelled();
  const results = capByHost(aggregator.ranked(), maxResults, maxPerHost);
  if (results.length) {
    void recordSweepStats(query, maxResults, started, [...timedOutProviders], results.length);
    return results;
  }
  if (timedOutProviders.size) {
    const sorted = [...timedOutProviders].sort();
    void recordSweepStats(query, maxResults, started, sorted, 0);
    throw new SearchTimeoutError(sorted);
  }
  void recordSweepStats(query, maxResults, started, [], 0);
  throw new EmptySweepError();
}
