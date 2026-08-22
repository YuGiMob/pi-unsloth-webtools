import { describe, expect, it } from "vitest";
import { fetchPageText, fetchUrlRaw, extractPdfText } from "../web-fetch.ts";
import { ddgSearch } from "../web-search.ts";

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
    const results = await ddgSearch("unsloth studio");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title.length).toBeGreaterThan(0);
    expect(results[0].href).toMatch(/^https?:\/\//);
  }, 60000);

  it("rejects non-public resolution targets", async () => {
    const result = await fetchUrlRaw("http://localhost/", { timeoutMs: 10000 });
    expect(result.error).toContain("Blocked");
  });

  it("extracts text from a real pdf", async () => {
    const result = await fetchUrlRaw("https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", { timeoutMs: 30000 });
    expect(result.error).toBeNull();
    expect(result.body).toContain("PDF");
  }, 60000);
});
