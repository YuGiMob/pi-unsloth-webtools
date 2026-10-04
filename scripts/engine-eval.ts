import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ResultsAggregator, TEXT_ENGINES, capByHost, canonicalizeHref, registrableDomain, type SearchResult } from "../engines.ts";

interface GoldenQuery {
  query: string;
  expectedDomains: string[];
}

const GOLDEN_QUERIES: GoldenQuery[] = [
  { query: "unsloth studio", expectedDomains: ["unsloth.ai", "github.com"] },
  { query: "pgvector hnsw index tuning", expectedDomains: ["github.com", "postgresql.org", "tembo.io", "timescale.com"] },
  { query: "python 3.14 release notes", expectedDomains: ["python.org"] },
  { query: "attention is all you need paper", expectedDomains: ["arxiv.org", "neurips.cc"] },
  { query: "postgres could not serialize access due to concurrent update", expectedDomains: ["postgresql.org"] },
  { query: "linux io_uring explained", expectedDomains: ["kernel.dk", "kernel.org", "lwn.net", "man7.org"] },
  { query: "react server components explained", expectedDomains: ["react.dev", "github.com", "nextjs.org"] },
  { query: "sqlite wal mode concurrency", expectedDomains: ["sqlite.org", "github.com"] },
];

const WEIGHT_VECTORS: { name: string; weights: Record<string, number> }[] = [
  { name: "uniform", weights: { duckduckgo: 1, yandex: 1, startpage: 1 } },
  { name: "startpage-heavy", weights: { startpage: 2, duckduckgo: 1.5, yandex: 0.75 } },
  { name: "duckduckgo-heavy", weights: { duckduckgo: 2, startpage: 1.5, yandex: 0.75 } },
  { name: "yandex-heavy", weights: { yandex: 2, startpage: 1.5, duckduckgo: 1.5 } },
];

const PER_HOST_CHOICES = [1, 2, 3, 4, 5];

const args = process.argv.slice(2);
const numberFlag = (name: string, fallback: number): number => {
  const found = args.find((arg) => arg.startsWith(`${name}=`));
  const value = found ? Number(found.split("=")[1]) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
const stringFlag = (name: string): string => args.find((arg) => arg.startsWith(`${name}=`))?.split("=")[1] ?? "";
const DELAY_MS = numberFlag("--delay", 3000);
const TIMEOUT_MS = numberFlag("--timeout", 20_000);
const MAX_RESULTS = numberFlag("--max", 5);
const TRANSPORT = (stringFlag("--transport") || "tls-first") as "tls-first" | "direct-first" | "off";
const CACHE_PATH = stringFlag("--cache");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pad = (value: string | number, width: number) => String(value).padEnd(width);
const padStart = (value: string | number, width: number) => String(value).padStart(width);

function matchesExpected(href: string, expectedDomains: string[]): boolean {
  const domain = registrableDomain(href);
  return expectedDomains.some((expected) => domain === expected || domain.endsWith(`.${expected}`));
}

function precision(results: SearchResult[], golden: GoldenQuery): number {
  const top = results.slice(0, MAX_RESULTS);
  if (!top.length) return 0;
  return top.filter((result) => matchesExpected(result.href, golden.expectedDomains)).length / top.length;
}

interface EngineRun {
  results: SearchResult[];
  ms: number;
  error: string;
}

const engineNames = TEXT_ENGINES.map((engine) => engine.name);
const goldenByQuery = new Map(GOLDEN_QUERIES.map((golden) => [golden.query, golden]));
const ctx = { region: "us-en", safesearch: "moderate", transport: TRANSPORT };

async function runEngine(engineName: string, query: string): Promise<EngineRun> {
  const engine = TEXT_ENGINES.find((candidate) => candidate.name === engineName);
  if (!engine) return { results: [], ms: 0, error: "unknown engine" };
  const started = Date.now();
  try {
    const results = (await engine.search(query, ctx, TIMEOUT_MS)) ?? [];
    return { results, ms: Date.now() - started, error: "" };
  } catch (error) {
    return { results: [], ms: Date.now() - started, error: String((error as Error)?.message ?? error).slice(0, 40) };
  }
}

function fuse(perEngine: Map<string, EngineRun>, weights: Record<string, number>, maxPerHost: number): SearchResult[] {
  const aggregator = new ResultsAggregator();
  for (const [engineName, run] of perEngine) aggregator.extend(run.results, weights[engineName] ?? 1);
  return capByHost(aggregator.ranked(), MAX_RESULTS, maxPerHost);
}

function loadCache(path: string): Map<string, Map<string, EngineRun>> | null {
  if (!path || !existsSync(path)) return null;
  try {
    const rows = JSON.parse(readFileSync(path, "utf8")) as { query: string; engine: string; run: EngineRun }[];
    const loaded = new Map<string, Map<string, EngineRun>>();
    for (const row of rows) {
      if (!loaded.has(row.query)) loaded.set(row.query, new Map());
      loaded.get(row.query)!.set(row.engine, row.run);
    }
    return loaded;
  } catch {
    return null;
  }
}

function saveCache(path: string, collected: Map<string, Map<string, EngineRun>>): void {
  const rows = [...collected].flatMap(([query, perEngine]) => [...perEngine].map(([engine, run]) => ({ query, engine, run })));
  writeFileSync(path, JSON.stringify(rows));
}

console.log(`transport=${TRANSPORT} timeout=${TIMEOUT_MS}ms delay=${DELAY_MS}ms queries=${GOLDEN_QUERIES.length} engines=${engineNames.join(", ")}`);
console.log("labels are hand-set for developer queries; treat single-run numbers as directional\n");

let runs = loadCache(CACHE_PATH);
if (runs) {
  console.log(`loaded ${[...runs.values()].reduce((sum, perEngine) => sum + perEngine.size, 0)} cached engine runs from ${CACHE_PATH}\n`);
} else {
  runs = new Map();
  for (const golden of GOLDEN_QUERIES) {
    const perEngine = new Map<string, EngineRun>();
    for (const engineName of engineNames) {
      if (DELAY_MS) await sleep(DELAY_MS);
      const run = await runEngine(engineName, golden.query);
      perEngine.set(engineName, run);
      process.stdout.write(`${pad(engineName, 12)} ${pad(`"${golden.query}"`, 58)} ${padStart(run.results.length, 2)} results ${padStart(run.ms, 5)}ms ${run.error}\n`);
    }
    runs.set(golden.query, perEngine);
  }
  if (CACHE_PATH) saveCache(CACHE_PATH, runs);
}

console.log(`\n=== per-engine (own ranking, top ${MAX_RESULTS} vs expected domains) ===`);
console.log(`${pad("engine", 12)} ${padStart("results", 7)} ${padStart("median ms", 9)} ${padStart("p@" + MAX_RESULTS, 5)} ${padStart("failures", 8)}`);
for (const engineName of engineNames) {
  const all = [...runs.values()].map((perEngine) => perEngine.get(engineName) ?? { results: [], ms: 0, error: "missing" });
  const times = all.map((run) => run.ms).sort((a, b) => a - b);
  const meanPrecision = [...runs].reduce((sum, [queryText, perEngine]) => sum + precision(perEngine.get(engineName)?.results ?? [], goldenByQuery.get(queryText)!), 0) / runs.size;
  const failures = all.filter((run) => run.error || run.results.length === 0).length;
  console.log(`${pad(engineName, 12)} ${padStart(all.reduce((sum, run) => sum + run.results.length, 0), 7)} ${padStart(times[Math.floor(times.length / 2)] ?? 0, 9)} ${padStart(meanPrecision.toFixed(2), 5)} ${padStart(failures, 8)}`);
}

console.log("\n=== pairwise URL overlap (mean Jaccard) ===");
console.log(`${pad("", 12)} ${engineNames.map((name) => padStart(name, 12)).join(" ")}`);
for (const left of engineNames) {
  const row = engineNames.map((right) => {
    if (left === right) return padStart("-", 12);
    let sum = 0;
    for (const perEngine of runs.values()) {
      const a = new Set((perEngine.get(left)?.results ?? []).map((result) => canonicalizeHref(result.href) || result.href));
      const b = new Set((perEngine.get(right)?.results ?? []).map((result) => canonicalizeHref(result.href) || result.href));
      const union = new Set([...a, ...b]);
      const shared = [...a].filter((href) => b.has(href)).length;
      sum += union.size ? shared / union.size : 0;
    }
    return padStart((sum / runs.size).toFixed(2), 12);
  });
  console.log(`${pad(left, 12)} ${row.join(" ")}`);
}

console.log("\n=== unique contribution (URLs no other engine returned) ===");
for (const engineName of engineNames) {
  let unique = 0;
  let total = 0;
  let uniqueExpected = 0;
  for (const [queryText, perEngine] of runs) {
    const golden = goldenByQuery.get(queryText)!;
    const others = new Set(
      engineNames
        .filter((name) => name !== engineName)
        .flatMap((name) => (perEngine.get(name)?.results ?? []).map((result) => canonicalizeHref(result.href) || result.href)),
    );
    for (const result of perEngine.get(engineName)?.results ?? []) {
      total++;
      if (!others.has(canonicalizeHref(result.href) || result.href)) {
        unique++;
        if (matchesExpected(result.href, golden.expectedDomains)) uniqueExpected++;
      }
    }
  }
  console.log(`${pad(engineName, 12)} ${padStart(unique, 3)}/${padStart(total, 3)} unique   ${padStart(uniqueExpected, 3)} of them expected-domain hits`);
}

console.log(`\n=== fusion simulation through the shipped ranking (top ${MAX_RESULTS}) ===`);
console.log(`${pad("weights", 20)} ${pad("perHost", 8)} ${padStart("mean p@" + MAX_RESULTS, 9)} ${padStart("domains", 7)}  engine mix`);
for (const vector of WEIGHT_VECTORS) {
  for (const maxPerHost of PER_HOST_CHOICES) {
    let precisionSum = 0;
    let domainSum = 0;
    const mix = new Map<string, number>(engineNames.map((name) => [name, 0]));
    for (const [queryText, perEngine] of runs) {
      const golden = goldenByQuery.get(queryText)!;
      const fused = fuse(perEngine, vector.weights, maxPerHost);
      precisionSum += precision(fused, golden);
      domainSum += new Set(fused.map((result) => registrableDomain(result.href))).size;
      for (const result of fused) {
        const owner = engineNames.find((name) =>
          (perEngine.get(name)?.results ?? []).some((candidate) => (canonicalizeHref(candidate.href) || candidate.href) === result.href),
        );
        if (owner) mix.set(owner, (mix.get(owner) ?? 0) + 1);
      }
    }
    const mixText = engineNames.map((name) => `${name.slice(0, 5)}:${mix.get(name)}`).join(" ");
    console.log(`${pad(vector.name, 20)} ${pad(maxPerHost, 8)} ${padStart((precisionSum / runs.size).toFixed(2), 9)} ${padStart((domainSum / runs.size).toFixed(1), 7)}  ${mixText}`);
  }
}
