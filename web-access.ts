import { domainToASCII } from "node:url";

const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_DOMAINS_PER_LIST = 100;
const MAX_CACHEABLE_DOMAIN_LEN = 253;
const SITE_FILTER_LIMIT = 8;
const DOTTED_HOST_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const PORT_RE = /^[0-9]{1,5}$/;

export interface WebsitePolicy {
  allowedDomains: string[];
  blockedDomains: string[];
}

export function normalizeDomain(value: unknown): string {
  const domain = String(value ?? "").trim().toLowerCase();
  if (!domain) throw new Error("Website domains cannot be empty");
  if (
    [...domain].some((char) => char.charCodeAt(0) < 32) ||
    ["\\", "/", "@", "?", "#"].some((char) => domain.includes(char))
  ) {
    throw new Error(`Invalid website domain: ${String(value)}`);
  }
  const bracketed = domain.startsWith("[") && domain.endsWith("]");
  if (domain.startsWith("[") !== domain.endsWith("]")) {
    throw new Error(`Invalid website domain: ${String(value)}`);
  }
  const stripped = (bracketed ? domain.slice(1, -1) : domain).replace(/\.+$/, "");
  if (/^[0-9a-fA-F:.]+$/.test(stripped) && stripped.includes(":")) {
    try {
      return compressIpv6(stripped);
    } catch {
      throw new Error(`Invalid website domain: ${String(value)}`);
    }
  }
  if (stripped.includes(":")) {
    throw new Error("Website limits must contain domains without schemes or ports");
  }
  const numericParts = stripped.split(".");
  if (
    numericParts.length <= 4 &&
    numericParts.every((part) => /^(?:0x[0-9a-f]+|[0-9]+)$/.test(part))
  ) {
    throw new Error("Non-canonical numeric IP hostnames are not allowed");
  }
  let asciiDomain: string;
  try {
    asciiDomain = domainToASCII(stripped).toLowerCase();
  } catch {
    throw new Error(`Invalid website domain: ${String(value)}`);
  }
  if (
    asciiDomain.length > 253 ||
    !asciiDomain.split(".").every((label) => DOMAIN_LABEL_RE.test(label))
  ) {
    throw new Error(`Invalid website domain: ${String(value)}`);
  }
  return asciiDomain;
}

function compressIpv6(ip: string): string {
  const segments = ip.toLowerCase().split("::");
  if (segments.length > 2) throw new Error("invalid ipv6");
  const left = segments[0] ? segments[0].split(":") : [];
  const right = segments.length === 2 && segments[1] ? segments[1].split(":") : [];
  for (const group of [...left, ...right]) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) throw new Error("invalid ipv6");
  }
  if (segments.length === 2) {
    const fill = 8 - left.length - right.length;
    if (fill < 1) throw new Error("invalid ipv6");
    const full = [...left, ...Array(fill).fill("0"), ...right];
    return compressGroups(full);
  }
  if (left.length !== 8) throw new Error("invalid ipv6");
  return compressGroups(left);
}

function compressGroups(groups: string[]): string {
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === "0") {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      const runLen = i - runStart;
      if (runLen > bestLen) {
        bestStart = runStart;
        bestLen = runLen;
      }
      runStart = -1;
    }
  }
  if (bestLen < 2) return groups.map((g) => g.replace(/^0+(?=[0-9a-f])/, "")).join(":");
  const head = groups.slice(0, bestStart).map((g) => g.replace(/^0+(?=[0-9a-f])/, ""));
  const tail = groups.slice(bestStart + bestLen).map((g) => g.replace(/^0+(?=[0-9a-f])/, ""));
  return [...head, "", ...tail].join(":");
}

export function normalizeWebsitePolicy(value: unknown): WebsitePolicy {
  if (value === null || value === undefined) {
    return { allowedDomains: [], blockedDomains: [] };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("websitePolicy must be an object");
  }
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter(
    (key) => key !== "allowedDomains" && key !== "blockedDomains",
  );
  if (unknown.length) {
    throw new Error(`Unsupported websitePolicy fields: ${unknown.sort().join(", ")}`);
  }
  const normalized: WebsitePolicy = { allowedDomains: [], blockedDomains: [] };
  for (const key of ["allowedDomains", "blockedDomains"] as const) {
    const rawDomains = raw[key];
    if (!Array.isArray(rawDomains)) throw new Error(`${key} must be a list`);
    if (rawDomains.length > MAX_DOMAINS_PER_LIST) {
      throw new Error(`${key} supports at most ${MAX_DOMAINS_PER_LIST} domains`);
    }
    const domains: string[] = [];
    for (const rawDomain of rawDomains) {
      if (typeof rawDomain !== "string" || rawDomain.length > MAX_CACHEABLE_DOMAIN_LEN) {
        throw new Error(`${key} must contain only strings`);
      }
      const domain = normalizeDomain(rawDomain);
      if (!domains.includes(domain)) domains.push(domain);
    }
    normalized[key] = domains;
  }
  return normalized;
}

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function hostnameAllowed(hostname: string, policy: WebsitePolicy | null): boolean {
  let host: string;
  let normalized: WebsitePolicy;
  try {
    host = normalizeDomain(hostname);
    normalized = normalizePolicyMaybe(policy);
  } catch {
    return false;
  }
  if (normalized.blockedDomains.some((domain) => matchesDomain(host, domain))) return false;
  const allowed = normalized.allowedDomains;
  return allowed.length === 0 || allowed.some((domain) => matchesDomain(host, domain));
}

function normalizePolicyObject(policy: WebsitePolicy): WebsitePolicy {
  const normalized: WebsitePolicy = { allowedDomains: [], blockedDomains: [] };
  for (const key of ["allowedDomains", "blockedDomains"] as const) {
    const domains: string[] = [];
    for (const rawDomain of policy[key]) {
      const domain = normalizeDomain(rawDomain);
      if (!domains.includes(domain)) domains.push(domain);
    }
    normalized[key] = domains;
  }
  return normalized;
}

function normalizePolicyMaybe(policy: WebsitePolicy | null | undefined): WebsitePolicy {
  if (!policy) return { allowedDomains: [], blockedDomains: [] };
  return normalizePolicyObject(policy);
}

export function checkUrlAccess(
  url: string,
  policy: WebsitePolicy | null,
): [boolean, string, string] {
  if (typeof url !== "string" || !url.trim()) {
    return [false, "Blocked: the URL is empty.", ""];
  }
  const candidate = url.trim();
  if (
    Array.from(candidate).some((char) => /\s/.test(char) || char.charCodeAt(0) < 32) ||
    candidate.includes("\\")
  ) {
    return [false, "Blocked: the URL contains invalid characters.", ""];
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return [false, "Blocked: the URL has an invalid hostname or port.", ""];
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return [false, "Blocked: only http/https URLs are allowed.", ""];
  }
  if (parsed.username || parsed.password || parsed.hostname.includes("%")) {
    return [false, "Blocked: URLs with credentials or encoded hostnames are not allowed.", ""];
  }
  if (!parsed.hostname) {
    return [false, "Blocked: the URL has an invalid hostname or port.", ""];
  }
  try {
    if (parsed.port && !(PORT_RE.test(parsed.port) && Number(parsed.port) >= 1 && Number(parsed.port) <= 65535)) {
      return [false, "Blocked: the URL has an invalid hostname or port.", ""];
    }
  } catch {
    return [false, "Blocked: the URL has an invalid hostname or port.", ""];
  }
  let hostname: string;
  try {
    hostname = normalizeDomain(parsed.hostname);
  } catch {
    return [false, "Blocked: the URL has an invalid hostname or port.", ""];
  }
  if (!hostnameAllowed(hostname, policy)) {
    return [false, `Blocked: the website access policy disallows ${hostname}.`, hostname];
  }
  return [true, "", hostname];
}

export function websitePolicyPrompt(policy: WebsitePolicy | null): string {
  const normalized = normalizeWebsitePolicy(policy);
  const allowed = normalized.allowedDomains;
  const blocked = normalized.blockedDomains;
  if (!allowed.length && !blocked.length) return "";
  const lines = ["Website access limits are enforced by the application."];
  if (allowed.length) {
    lines.push(
      "Only search or fetch these domains and their subdomains: " +
        allowed.join(", ") +
        ". Do not propose, cite, or attempt any other website.",
    );
  }
  if (blocked.length) {
    lines.push(
      "Never search or fetch these domains or their subdomains: " + blocked.join(", ") + ".",
    );
  }
  lines.push("Blocked search results are unavailable; do not try to work around these limits.");
  return lines.join("\n");
}

export function scopeSearchQuery(query: string, policy: WebsitePolicy | null): string {
  const allowed = normalizeWebsitePolicy(policy).allowedDomains;
  if (!allowed.length) return query;
  let window = allowed;
  if (allowed.length > SITE_FILTER_LIMIT) {
    let hash = 0;
    for (const char of query) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    const offset = hash % allowed.length;
    window = [...allowed, ...allowed].slice(offset, offset + SITE_FILTER_LIMIT);
  }
  const siteFilter = window.map((domain) => `site:${domain}`).join(" OR ");
  return `${query} (${siteFilter})`;
}

export function normalizeUrlScheme(url: string): string {
  url = url.trim();
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url);
  if (schemeMatch) {
    const scheme = schemeMatch[1];
    const afterScheme = url.slice(schemeMatch[0].length);
    const hasNetloc = afterScheme.startsWith("//");
    if (hasNetloc || !DOTTED_HOST_RE.test(scheme)) return url;
    return rewriteBareHost(url, url.split(/[/?#]/, 1)[0]);
  }
  if (url.startsWith("//")) {
    const rest = url.slice(2);
    return rewriteBareHost("//" + rest, rest.split(/[/?#]/, 1)[0]);
  }
  if (url.startsWith("/")) return url;
  return rewriteBareHost(url, url.split(/[/?#]/, 1)[0]);
}

function rewriteBareHost(url: string, authority: string): string {
  const host = authority.split(":", 1)[0];
  if (!DOTTED_HOST_RE.test(host)) return url;
  const colon = authority.indexOf(":");
  const port = colon === -1 ? "" : authority.slice(colon + 1);
  if (port && !(PORT_RE.test(port) && Number(port) >= 1 && Number(port) <= 65535)) return url;
  return "https://" + url.replace(/^\/\//, "");
}

const GITHUB_NON_OWNER_SEGMENTS = new Set([
  "about",
  "apps",
  "codespaces",
  "collections",
  "contact",
  "customer-stories",
  "dashboard",
  "discussions",
  "enterprise",
  "explore",
  "features",
  "issues",
  "join",
  "login",
  "marketplace",
  "new",
  "notifications",
  "organizations",
  "orgs",
  "pricing",
  "pulls",
  "search",
  "security",
  "settings",
  "signup",
  "site",
  "sponsors",
  "team",
  "topics",
  "trending",
]);

const GITHUB_NAME_RE = /^[A-Za-z0-9_.\-]{1,100}$/;

export function githubRepoReadmeApiUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = (parsed.hostname ?? "").toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;
  const parts = parsed.pathname.split("/").filter((part) => part.length > 0);
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (GITHUB_NON_OWNER_SEGMENTS.has(owner.toLowerCase())) return null;
  const cleanRepo = repo.endsWith(".git") ? repo.slice(0, -4) : repo;
  if (!GITHUB_NAME_RE.test(owner) || !GITHUB_NAME_RE.test(cleanRepo)) return null;
  return `https://api.github.com/repos/${owner}/${cleanRepo}/readme`;
}

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets;
}

export function isPublicIp(ip: string): boolean {
  if (ip.includes(".")) {
    const o = ipv4Octets(ip);
    if (!o) return false;
    if (o[0] === 0) return false;
    if (o[0] === 10) return false;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return false;
    if (o[0] === 127) return false;
    if (o[0] === 169 && o[1] === 254) return false;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false;
    if (o[0] === 192 && o[1] === 0 && o[2] === 0) return false;
    if (o[0] === 192 && o[1] === 0 && o[2] === 2) return false;
    if (o[0] === 192 && o[1] === 168) return false;
    if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return false;
    if (o[0] === 198 && o[1] === 51 && o[2] === 100) return false;
    if (o[0] === 203 && o[1] === 0 && o[2] === 113) return false;
    if (o[0] >= 224) return false;
    return true;
  }
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return false;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return false;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return false;
  if (lower.startsWith("ff")) return false;
  if (lower.startsWith("2001:db8")) return false;
  if (lower.startsWith("64:ff9b:")) return false;
  if (lower.startsWith("2001:10:")) return false;
  if (lower.startsWith("2002:")) return false;
  if (lower.startsWith("2001:0:") || lower.startsWith("2001::")) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPublicIp(mapped[1]);
  if (lower.startsWith("::ffff:")) return false;
  return true;
}
