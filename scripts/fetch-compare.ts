import { fetchPageOutcome, type FetchTransport } from "../web-fetch.ts";
import { renderPageWithLightpanda } from "../lightpanda.ts";

const TIMEOUT_MS = 45_000;
const THIN_CHARS = 1000;
const DEFAULT_TARGETS = [
  "https://example.com/",
  "https://news.ycombinator.com/",
  "https://en.wikipedia.org/wiki/Web_scraping",
  "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
  "https://react.dev/learn",
  "https://nextjs.org/docs",
  "https://supabase.com/docs",
  "https://github.com/unslothai/unsloth",
  "https://www.reddit.com/r/programming/",
  "https://medium.com/@davidbyttow/hello-world",
  "https://www.g2.com/products/asana/reviews",
  "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array",
];

interface Cell {
  ok: boolean;
  detail: string;
  chars: number;
  ms: number;
}

function bytes(count: number): string {
  if (count >= 1024 * 1024) return `${(count / (1024 * 1024)).toFixed(1)}MB`;
  if (count >= 1024) return `${(count / 1024).toFixed(1)}KB`;
  return `${count}B`;
}

function format(cell: Cell | null): string {
  if (cell === null) return "unavailable";
  const head = cell.ok ? `ok ${bytes(cell.chars)}${cell.chars < THIN_CHARS ? " (thin)" : ""}` : cell.detail.slice(0, 28);
  return `${head} · ${Math.round(cell.ms)}ms`;
}

function failedText(text: string): boolean {
  return (
    text.startsWith("Failed to fetch URL:") ||
    text.startsWith("Failed to render URL:") ||
    text.startsWith("Blocked:") ||
    text.startsWith("(page returned no readable text)")
  );
}

async function timed(run: () => Promise<Omit<Cell, "ms">>): Promise<Cell> {
  const start = performance.now();
  try {
    const result = await run();
    return { ...result, ms: performance.now() - start };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      chars: 0,
      ms: performance.now() - start,
    };
  }
}

function textCell(text: string): Omit<Cell, "ms"> {
  const failure = failedText(text);
  return { ok: !failure, detail: failure ? text : "readable", chars: text.length };
}

async function pipelineCell(url: string, transport: FetchTransport): Promise<Cell> {
  return timed(async () => {
    const outcome = await fetchPageOutcome(url, { timeoutMs: TIMEOUT_MS, transport });
    return textCell(outcome.text);
  });
}

async function lightpandaCell(url: string): Promise<Cell> {
  return timed(async () => {
    const text = await renderPageWithLightpanda(url, { timeoutMs: TIMEOUT_MS });
    if (text === null) return { ok: false, detail: "binary unavailable", chars: 0 };
    return textCell(text);
  });
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + " ".repeat(width - value.length);
}

const args = process.argv.slice(2);
const skipLightpanda = args.includes("--no-lightpanda");
const targets = args.filter((arg) => !arg.startsWith("--"));
const list = targets.length ? targets : DEFAULT_TARGETS;
const width = Math.max(...list.map((url) => url.length), 20);
const columnWidth = 26;
const columns = [
  { name: "DIRECT", width: columnWidth },
  { name: "TLS-FIRST", width: columnWidth },
  { name: "LIGHTPANDA", width: columnWidth },
].filter((column) => !(column.name === "LIGHTPANDA" && skipLightpanda));

console.log(`targets: ${list.length} · timeout: ${TIMEOUT_MS}ms`);
console.log(pad("URL", width) + "  " + columns.map((column) => pad(column.name, column.width)).join("  "));

interface Tally {
  ok: number;
  thin: number;
  chars: number;
  ms: number;
}

const tallies = new Map<string, Tally>();
const record = (tier: string, cell: Cell | null): void => {
  if (cell === null) return;
  const tally = tallies.get(tier) ?? { ok: 0, thin: 0, chars: 0, ms: 0 };
  if (cell.ok) {
    tally.ok++;
    tally.chars += cell.chars;
    tally.ms += cell.ms;
    if (cell.chars < THIN_CHARS) tally.thin++;
  }
  tallies.set(tier, tally);
};

for (const url of list) {
  const direct = await pipelineCell(url, "off");
  const tls = await pipelineCell(url, "tls-first");
  const cells: [string, Cell | null][] = [["DIRECT", direct], ["TLS", tls]];
  if (!skipLightpanda) cells.push(["LIGHTPANDA", await lightpandaCell(url)]);
  for (const [tier, cell] of cells) record(tier, cell);
  const rescued = !direct.ok && tls.ok && tls.chars >= THIN_CHARS;
  const rendered = cells.map(([tier, cell]) =>
    pad(format(cell) + (rescued && tier === "TLS" ? " +" : ""), columnWidth),
  );
  console.log(pad(url, width) + "  " + rendered.join("  "));
}

console.log("");
for (const [tier, tally] of tallies) {
  const average = tally.ok ? `${Math.round(tally.chars / tally.ok)} chars avg, ${Math.round(tally.ms / tally.ok)}ms avg` : "no successes";
  console.log(
    `${pad(tier, 12)} ok ${tally.ok}/${list.length} · thin ${tally.thin} · ${average}`,
  );
}
console.log("");
console.log("(+) = direct fetch failed but the tier returned substantial text");
console.log("note: sandbox egress is a datacenter IP; anti-bot results are pessimistic versus residential.");
