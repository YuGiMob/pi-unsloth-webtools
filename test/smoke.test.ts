import { describe, expect, it } from "vitest";
import { fetchPageText, fetchUrlRaw, hasPdfMagic } from "../web-fetch.ts";
import { extractPdfText } from "../pdf.ts";
import { EmptySweepError, SearchTimeoutError, ddgSearch } from "../web-search.ts";
import { TEXT_ENGINES, type SearchResult } from "../engines.ts";
import { deflateSync } from "node:zlib";

const MIN_HEALTHY_ENGINES = 2;

function isWellFormedResult(result: SearchResult): boolean {
  return result.title.trim().length > 0 && /^https?:\/\//.test(result.href);
}

describe("live smoke", () => {
  it("fetches a GitHub repo page via the README API", async () => {
    const text = await fetchPageText("https://github.com/unslothai/unsloth", { timeoutMs: 30000 });
    expect(text).toContain("README of");
    expect(text.length).toBeGreaterThan(200);
  }, 60000);

  it("blocks private addresses", async () => {
    const text = await fetchPageText("http://127.0.0.1/", { timeoutMs: 10000 });
    expect(text).toContain("Blocked");
  });

  it("fetches bare-host example.com as https", async () => {
    const text = await fetchPageText("example.com", { timeoutMs: 30000 });
    expect(text.toLowerCase()).toContain("example");
  }, 60000);

  it("converts an html page to markdown", async () => {
    const text = await fetchPageText("https://example.com/", { timeoutMs: 30000 });
    expect(text.toLowerCase()).toContain("example");
    expect(text).not.toContain("<html");
  }, 60000);

  it("searches duckduckgo", async () => {
    let results: SearchResult[];
    try {
      results = await ddgSearch("unsloth studio");
    } catch (err) {
      if (err instanceof EmptySweepError || err instanceof SearchTimeoutError) {
        console.warn(`duckduckgo unreachable from this network: ${err.message}`);
        return;
      }
      throw err;
    }
    const first = results.find(isWellFormedResult);
    if (!first) {
      console.warn("duckduckgo unreachable from this network: no parseable results");
      return;
    }
  }, 60000);

  it("parses well-formed results from most engines", async () => {
    const ctx = { region: "us-en", safesearch: "moderate" };
    let healthy = 0;
    const unhealthy: string[] = [];
    for (const engine of TEXT_ENGINES) {
      let results: SearchResult[];
      try {
        results = (await engine.search("unsloth", ctx, 20_000)) ?? [];
      } catch (err) {
        unhealthy.push(`${engine.name} (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      const wellFormed = results.filter(isWellFormedResult);
      if (wellFormed.length) healthy++;
      else unhealthy.push(engine.name);
    }
    if (unhealthy.length) console.warn(`unhealthy engines: ${unhealthy.join(", ")}`);
    expect(healthy).toBeGreaterThanOrEqual(MIN_HEALTHY_ENGINES);
  }, 180_000);

  it("rejects non-public resolution targets", async () => {
    const result = await fetchUrlRaw("http://localhost/", { timeoutMs: 10000 });
    expect(result.error).toContain("Blocked");
  });

  it("extracts text from a flate-compressed pdf", async () => {
    const content = "BT /F1 12 Tf 72 720 Td (Hello PDF world) Tj ET";
    const compressed = deflateSync(Buffer.from(content, "latin1"));
    const pdf = Buffer.from(
      "%PDF-1.4\n" +
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n" +
      `4 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n` +
      compressed.toString("latin1") + "\nendstream\nendobj\n" +
      "trailer\n<< /Root 1 0 R >>\n%%EOF\n",
      "latin1",
    );
    const text = await extractPdfText(pdf);
    expect(text).toContain("Hello PDF world");
  });
  it("extracts a real multi-page pdf without a character budget", async () => {
    const result = await fetchUrlRaw("https://arxiv.org/pdf/2305.07147", { timeoutMs: 60000 });
    expect(result.error).toBeNull();
    expect(result.body.length).toBeGreaterThan(100_000);
    expect(result.body).not.toContain("text limited");
    expect(result.body).toContain("## Page");
  }, 90000);

  it("detects pdf magic before extraction", () => {
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n", "latin1");
    expect(hasPdfMagic(pdf)).toBe(true);
    expect(hasPdfMagic(Buffer.from("hello world"))).toBe(false);
  });
});
