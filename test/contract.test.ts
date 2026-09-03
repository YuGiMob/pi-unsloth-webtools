import { describe, expect, it } from "vitest";
import {
  EMPTY_SEARCH_RESULTS,
  formatSearchResults,
  searchFailureMessage,
  webSearch,
} from "../web-search.ts";
import { EmptySweepError, SearchCancelled, SearchTimeoutError } from "../engines.ts";
import { fetchPageText, fetchUrlRaw, truncatePageText } from "../web-fetch.ts";
import { staleNotice } from "../cache.ts";
import { checkUrlAccess } from "../web-access.ts";
import { seamWithResponse } from "./helpers.ts";

describe("search contract", () => {
  it("returns the empty-query message", async () => {
    expect(await webSearch("", {})).toBe("No query provided.");
    expect(await webSearch("   ", {})).toBe("No query provided.");
  });

  it("returns the cancellation message", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await webSearch("cats", { signal: controller.signal })).toBe("Search cancelled.");
    expect(searchFailureMessage(new SearchCancelled())).toBe("Search cancelled.");
  });

  it("pins the empty-result messages", () => {
    expect(EMPTY_SEARCH_RESULTS).toEqual([
      "No results found.",
      "No results found within the website access limits.",
    ]);
  });

  it("maps empty sweeps to the no-results message", () => {
    expect(searchFailureMessage(new EmptySweepError())).toBe("No results found.");
    expect(searchFailureMessage(new Error("No results found upstream"))).toBe("No results found.");
  });

  it("pins timeout messages with and without providers", () => {
    expect(searchFailureMessage(new SearchTimeoutError(["brave", "google"]), 60000)).toBe(
      "Search failed: the search engines (brave, google) did not respond within 60 seconds.",
    );
    expect(searchFailureMessage(new SearchTimeoutError([]), 60000)).toBe(
      "Search failed: the search engines did not respond within 60 seconds.",
    );
  });

  it("prefixes generic failures", () => {
    expect(searchFailureMessage(new Error("boom"))).toBe("Search failed: boom");
  });

  it("ends formatted results with the url hint", () => {
    const out = formatSearchResults([{ title: "T", href: "https://x.com/", body: "S" }]);
    expect(out).toContain("Title: T");
    expect(out).toContain("URL: https://x.com/");
    expect(out).toContain("Snippet: S");
    expect(out).toContain('{"url": "<URL>"}');
  });
});

describe("fetch contract", () => {
  it("pins blocked-url messages", () => {
    expect(checkUrlAccess("", null)[1]).toBe("Blocked: the URL is empty.");
    expect(checkUrlAccess("ftp://x.com", null)[1]).toBe("Blocked: only http/https URLs are allowed.");
    expect(checkUrlAccess("https://user:pass@example.com", null)[1]).toBe(
      "Blocked: URLs with credentials or encoded hostnames are not allowed.",
    );
  });

  it("reports empty pages", () => {
    expect(truncatePageText("", 100)).toBe("(page returned no readable text)");
  });

  it("marks maxChars truncation with the total", () => {
    const out = truncatePageText("x".repeat(300), 100);
    expect(out).toContain("(truncated, 300 chars total)");
  });

  it("keeps the download-cap notice through maxChars truncation", () => {
    const capped = "x".repeat(400) + "\n\n... (page truncated at the download limit)";
    const out = truncatePageText(capped, 100);
    expect(out).toContain("(page truncated at the download limit)");
    expect(out).toContain(`(truncated, ${capped.length} chars total)`);
  });

  it("labels non-text content", async () => {
    const result = await fetchUrlRaw("https://example.com/f.zip", {
      seams: seamWithResponse(Buffer.from("PK\x03\x04data"), "application/zip"),
    });
    expect(result.error).toContain("(non-text content: application/zip");
  });

  it("labels binary magic", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const result = await fetchUrlRaw("https://example.com/i", {
      seams: seamWithResponse(png, "text/plain"),
    });
    expect(result.error).toContain("(binary content,");
  });

  it("prefixes html pages with the document title", async () => {
    const html = Buffer.from("<html><head><title>Example Page</title></head><body><p>Hello</p></body></html>");
    const out = await fetchPageText("https://example.com/", {
      timeoutMs: 5000,
      seams: seamWithResponse(html, "text/html"),
    });
    expect(out).toContain("Title: Example Page");
    expect(out).toContain("Hello");
  });

  it("prefixes github readme api results", async () => {
    const out = await fetchPageText("https://github.com/o/r", {
      rawFetch: async (url) => {
        if (url.includes("api.github.com")) return { error: null, body: "# Hi", contentType: "text/plain" };
        return { error: "Failed to fetch URL: HTTP 404", body: "", contentType: "" };
      },
    });
    expect(out).toContain("README of https://github.com/o/r (fetched via the GitHub README API):");
    expect(out).toContain("# Hi");
  });

  it("prefixes wayback fallbacks with the snapshot date", async () => {
    const out = await fetchPageText("https://example.com/gone", {
      rawFetch: async (url) => {
        if (url.includes("archive.org/wayback/available")) {
          return {
            error: null,
            body: JSON.stringify({
              archived_snapshots: {
                closest: { available: true, url: "https://web.archive.org/web/20200102030405/https://example.com/gone", timestamp: "20200102030405", status: "200" },
              },
            }),
            contentType: "application/json",
          };
        }
        if (url.includes("web.archive.org")) return { error: null, body: "<html><body>old</body></html>", contentType: "text/html" };
        return { error: "Failed to fetch URL: HTTP 404 Not Found", body: "", contentType: "" };
      },
    });
    expect(out).toContain("*Fetched from Wayback Machine snapshot (2020-01-02) for https://example.com/gone:*");
  });

  it("formats stale cache notices with an iso date", () => {
    const notice = staleNotice({
      url: "https://x.com/",
      body: "b",
      contentType: "text/html",
      timestamp: Date.UTC(2024, 0, 15),
    });
    expect(notice).toContain("STALE cache from 2024-01-15");
    expect(notice).toContain("serving cached copy");
  });
});
