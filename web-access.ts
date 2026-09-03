import { domainToASCII } from "node:url";

const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_DOMAINS_PER_LIST = 100;
const MAX_CACHEABLE_DOMAIN_LEN = 253;
const SITE_FILTER_LIMIT = 8;
const DOTTED_HOST_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const PORT_RE = /^[0-9]{1,5}$/;
export const MAX_SIGNAL_TIMEOUT_MS = 2 ** 31 - 1;

function throwInvalidDomain(value: unknown): never {
  throw new Error(`Invalid website domain: ${String(value)}`);
}

const INVALID_HOST_REASON = "Blocked: the URL has an invalid hostname or port.";
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
    throwInvalidDomain(value);
  }
  const startsBracket = domain.startsWith("[");
  const endsBracket = domain.endsWith("]");
  if (startsBracket !== endsBracket) {
    throwInvalidDomain(value);
  }
  const stripped = (startsBracket ? domain.slice(1, -1) : domain).replace(/\.+$/, "");
  if (/^[0-9a-fA-F:.]+$/.test(stripped) && stripped.includes(":")) {
    try {
      return compressIpv6(stripped);
    } catch {
      throwInvalidDomain(value);
    }
  }
  if (stripped.includes(":")) {
    throw new Error("Website limits must contain domains without schemes or ports");
  }
  const numericParts = stripped.split(".");
  const canonicalIpv4 =
    numericParts.length === 4 &&
    numericParts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/.test(part)) &&
    numericParts.every((part) => Number(part) <= 255);
  if (canonicalIpv4) return stripped;
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
    throwInvalidDomain(value);
  }
  if (
    asciiDomain.length > 253 ||
    !asciiDomain.split(".").every((label) => DOMAIN_LABEL_RE.test(label))
  ) {
    throwInvalidDomain(value);
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
  const normalized = groups.map((g) => (/^0+$/.test(g) ? "0" : g.replace(/^0+(?=[0-9a-f])/, "")));
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= normalized.length; i++) {
    if (i < normalized.length && normalized[i] === "0") {
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
  if (bestLen < 2) return normalized.join(":");
  const head = normalized.slice(0, bestStart);
  const tail = normalized.slice(bestStart + bestLen);
  return `${head.join(":")}::${tail.join(":")}`;
}

const PCP_ANYCAST = new Set(["2001:1::1", "2001:1::2"]);

function isPcpAnycast(lower: string): boolean {
  try {
    return PCP_ANYCAST.has(compressIpv6(lower));
  } catch {
    return false;
  }
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
    const rawDomains = raw[key] ?? [];
    if (!Array.isArray(rawDomains)) throw new Error(`${key} must be a list`);
    if (rawDomains.length > MAX_DOMAINS_PER_LIST) {
      throw new Error(`${key} supports at most ${MAX_DOMAINS_PER_LIST} domains`);
    }
    normalized[key] = normalizeDomainList(rawDomains, key);
  }
  return normalized;
}

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function normalizeDomainList(domains: unknown[], listName: string): string[] {
  const out: string[] = [];
  for (const rawDomain of domains) {
    if (typeof rawDomain !== "string" || rawDomain.length > MAX_CACHEABLE_DOMAIN_LEN) {
      throw new Error(`${listName} must contain only strings`);
    }
    const domain = normalizeDomain(rawDomain);
    if (!out.includes(domain)) out.push(domain);
  }
  return out;
}

function policyAllows(host: string, policy: WebsitePolicy | null): boolean {
  let normalized: WebsitePolicy;
  try {
    normalized = normalizeWebsitePolicy(policy);
  } catch {
    return false;
  }
  if (normalized.blockedDomains.some((domain) => matchesDomain(host, domain))) return false;
  const allowed = normalized.allowedDomains;
  return allowed.length === 0 || allowed.some((domain) => matchesDomain(host, domain));
}

export function hostnameAllowed(hostname: string, policy: WebsitePolicy | null): boolean {
  try {
    return policyAllows(normalizeDomain(hostname), policy);
  } catch {
    return false;
  }
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
    return [false, INVALID_HOST_REASON, ""];
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return [false, "Blocked: only http/https URLs are allowed.", ""];
  }
  if (parsed.username || parsed.password || parsed.hostname.includes("%")) {
    return [false, "Blocked: URLs with credentials or encoded hostnames are not allowed.", ""];
  }
  if (!parsed.hostname) {
    return [false, INVALID_HOST_REASON, ""];
  }
  if (parsed.port && !(PORT_RE.test(parsed.port) && Number(parsed.port) >= 1 && Number(parsed.port) <= 65535)) {
    return [false, INVALID_HOST_REASON, ""];
  }
  let hostname: string;
  try {
    hostname = normalizeDomain(parsed.hostname);
  } catch {
    return [false, INVALID_HOST_REASON, ""];
  }
  if (!policyAllows(hostname, policy)) {
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

function parseGithubRepo(url: string): { owner: string; repo: string; rest: string[] } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = (parsed.hostname ?? "").toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;
  const parts = parsed.pathname.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repoRaw = parts[1];
  if (GITHUB_NON_OWNER_SEGMENTS.has(owner.toLowerCase())) return null;
  const repo = repoRaw.endsWith(".git") ? repoRaw.slice(0, -4) : repoRaw;
  if (!GITHUB_NAME_RE.test(owner) || !GITHUB_NAME_RE.test(repo)) return null;
  return { owner, repo, rest: parts.slice(2) };
}
function githubRepoRoot(url: string): { owner: string; repo: string; rest: string[] } | null {
  const parsed = parseGithubRepo(url);
  if (!parsed || parsed.rest.length !== 0) return null;
  return parsed;
}

export function githubRepoReadmeApiUrl(url: string): string | null {
  const parsed = githubRepoRoot(url);
  if (!parsed) return null;
  return `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/readme`;
}

export function githubRepoRawReadmeUrl(url: string): string | null {
  const parsed = githubRepoRoot(url);
  if (!parsed) return null;
  return `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/HEAD/README.md`;
}
export function githubRawContentUrl(url: string): string | null {
  const parsed = parseGithubRepo(url);
  if (!parsed || parsed.rest.length < 2) return null;
  const [kind, ref] = parsed.rest;
  if (kind !== "blob" && kind !== "raw") return null;
  if (!ref) return null;
  const filePath = parsed.rest.slice(2).join("/");
  if (!filePath) return null;
  return `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${ref}/${filePath}`;
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
    if (o[0] === 192 && o[1] === 88 && o[2] === 99) return false;
    if (o[0] === 192 && o[1] === 168) return false;
    if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return false;
    if (o[0] === 198 && o[1] === 51 && o[2] === 100) return false;
    if (o[0] === 203 && o[1] === 0 && o[2] === 113) return false;
    if (o[0] >= 224) return false;
    return true;
  }
  let canonical: string;
  try {
    canonical = compressIpv6(ip);
  } catch {
    return false;
  }
  if (canonical === "::1" || canonical.startsWith("::")) return false;
  if (canonical.startsWith("fc") || canonical.startsWith("fd")) return false;
  if (/^fe[89a-f][0-9a-f]:/.test(canonical)) return false;
  if (canonical.startsWith("ff")) return false;
  if (canonical.startsWith("2001:db8")) return false;
  if (canonical.startsWith("64:ff9b:")) return false;
  if (canonical.startsWith("2001:10:")) return false;
  if (canonical.startsWith("2002:")) return false;
  if (canonical.startsWith("2001:0:") || canonical.startsWith("2001::")) return false;
  if (canonical.startsWith("2001:2:")) return false;
  if (isPcpAnycast(canonical)) return false;
  return true;
}
