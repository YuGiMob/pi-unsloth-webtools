import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EmptySweepError,
  ResultsAggregator,
  SearchCancelled,
  SearchTimeoutError,
  autoTextSearch,
  extractResults,
  normalizeText,
  normalizeUrl,
  rankResults,
  xpathNodes,
  xpathText,
} from "../engines.ts";
import { buildDom } from "../engines.ts";
import type { DomNode } from "../engines.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizers", () => {
  it("strips tags, unescapes entities, normalizes unicode, removes control chars, collapses whitespace", () => {
    expect(normalizeText("  <b>Hello</b>   &amp;   world  ")).toBe("Hello & world");
    expect(normalizeText("<a href='x'>A</a><span>B</span>")).toBe("AB");
    expect(normalizeText("caf\u00e9 \u0063\u0061\u0066\u0065\u0301")).toBe("café café");
    expect(normalizeText("line\u200bbreak")).toBe("linebreak");
    expect(normalizeText("a\u0000b\u001fc")).toBe("abc");
    expect(normalizeText("&notit; x")).toBe("¬it; x");
    expect(normalizeText("&alpha; &aleph;")).toBe("α ℵ");
  });

  it("unquotes urls and replaces spaces with plus", () => {
    expect(normalizeUrl("https://example.com/a%20b?q=1")).toBe("https://example.com/a+b?q=1");
    expect(normalizeUrl("https://example.com/x y")).toBe("https://example.com/x+y");
    expect(normalizeUrl("")).toBe("");
  });
});

describe("xpath subset", () => {
  it("extracts text and attributes from a nested structure", () => {
    const dom = buildDom(
      '<div class="result"><div class="body"><h2><a href="/t">Title &amp; more</a></h2><a class="snippet" href="/s">Some snippet</a></div></div>',
    );
    const items = xpathNodes("//div[contains(@class, 'body')]", dom);
    expect(items.length).toBe(1);
    expect(xpathText(".//h2//text()", items[0]).join("")).toBe("Title & more");
    expect(xpathText("./a/@href", items[0])).toEqual(["/s"]);
    expect(xpathText(".//a//text()", items[0]).join("")).toBe("Title & moreSome snippet");
  });

  it("supports or/and predicates with position", () => {
    const dom = buildDom(
      '<div class="a"><span class="title">1</span><span class="sitename-container">2</span></div><div class="b"><span class="x">3</span></div>',
    );
    const expr =
      "//div[(contains(@class,'a') or contains(@class,'b')) and position()=last()]";
    const nodes = xpathNodes(expr, dom);
    expect(nodes.length).toBe(1);
    expect(xpathText(".//text()", nodes[0]).join("")).toBe("3");
  });

  it("supports child predicates and descendant tests", () => {
    const dom = buildDom(
      '<div data-type="web"><a><div class="title">Brave title</div></a></div><div data-type="web"><a><span>no title div</span></a></div>',
    );
    const items = xpathNodes("//div[@data-type='web']", dom);
    expect(items.length).toBe(2);
    const hrefs = xpathText(".//a[div[contains(@class, 'title')]]/@href", items[0]);
    expect(hrefs).toEqual([""]);
  });
});

describe("extractResults", () => {
  it("extracts duckduckgo-style results", () => {
    const html = `
      <div class="result results_links">
        <div class="links_main links_deep result__body">
          <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.com/page?utm=1&amp;b=2">Example <b>Page</b></a></h2>
          <div class="result__extras"><a class="result__url" href="https://example.com/page">example.com</a></div>
          <a class="result__snippet" href="https://example.com/page">First snippet text here.</a>
        </div>
      </div>
      <div class="result">
        <div class="result__body">
          <h2><a href="https://duckduckgo.com/y.js?ad=1">Ad result</a></h2>
          <a class="result__snippet" href="https://duckduckgo.com/y.js?ad=1">ad</a>
        </div>
      </div>
    `;
    const results = extractResults(html, "//div[contains(@class, 'body')]", {
      title: ".//h2//text()",
      href: "./a/@href",
      body: "./a//text()",
    });
    expect(results.length).toBe(2);
    expect(results[0].title).toBe("Example Page");
    expect(results[0].href).toBe("https://example.com/page");
    expect(results[0].body).toBe("First snippet text here.");
  });
});

describe("ResultsAggregator", () => {
  it("dedupes by href, keeps the longer body, sorts by frequency", () => {
    const aggregator = new ResultsAggregator();
    aggregator.extend([
      { title: "A", href: "https://x.com/1", body: "short" },
      { title: "B", href: "https://x.com/2", body: "body b" },
      { title: "A2", href: "https://x.com/1", body: "a much longer body" },
      { title: "B", href: "https://x.com/2", body: "body b" },
      { title: "B", href: "https://x.com/2", body: "body b" },
    ]);
    const out = aggregator.extractDicts();
    expect(out.length).toBe(2);
    expect(out[0].href).toBe("https://x.com/2");
    expect(out[0].body).toBe("body b");
    expect(out[1].title).toBe("A2");
    expect(out[1].body).toBe("a much longer body");
  });
});

describe("rankResults", () => {
  it("puts wikipedia first, then token buckets", () => {
    const docs = [
      { title: "unrelated thing", href: "https://x.com/4", body: "nothing here at all" },
      { title: "cats article", href: "https://x.com/1", body: "about cats" },
      { title: "cats", href: "https://en.wikipedia.org/wiki/Cat", body: "the cat" },
      { title: "cats only title", href: "https://x.com/2", body: "other" },
      { title: "Category:Wikimedia cats", href: "https://x.com/5", body: "skip me" },
    ];
    const out = rankResults(docs, "cats");
    expect(out.map((d) => d.href)).toEqual([
      "https://en.wikipedia.org/wiki/Cat",
      "https://x.com/1",
      "https://x.com/2",
      "https://x.com/4",
    ]);
  });

  it("uses tokens of at least three characters", () => {
    const docs = [
      { title: "ab cd", href: "https://x.com/1", body: "ef gh" },
      { title: "xyz", href: "https://x.com/2", body: "abc" },
    ];
    const out = rankResults(docs, "ab xyz");
    expect(out.map((d) => d.href)).toEqual(["https://x.com/2", "https://x.com/1"]);
  });
});

describe("wikipedia engine", () => {
  it("returns the opensearch hit with an extract body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("opensearch")) {
          return new Response(
            JSON.stringify(["cat", ["Cat"], ["feline"], ["https://en.wikipedia.org/wiki/Cat"]]),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            query: { pages: { "1": { extract: "<p>The <b>cat</b> is a small mammal.</p>" } } },
          }),
          { status: 200 },
        );
      }),
    );
    const results = await autoTextSearch("cat", 5, 10_000);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].href).toBe("https://en.wikipedia.org/wiki/Cat");
    expect(results[0].body).toContain("cat is a small mammal");
  });

  it("drops disambiguation hits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("opensearch")) {
          return new Response(
            JSON.stringify(["cat", ["Cat"], [], ["https://en.wikipedia.org/wiki/Cat"]]),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ query: { pages: { "1": { extract: "Cat may refer to: ..." } } } }),
          { status: 200 },
        );
      }),
    );
    await expect(autoTextSearch("cat", 5, 10_000)).rejects.toThrow(EmptySweepError);
  });

  it("reports a timeout when every engine times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }),
    );
    await expect(autoTextSearch("cat", 5, 10_000)).rejects.toThrow(SearchTimeoutError);
  });

  it("reports a timeout when the first engine times out amid later failures", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) throw new DOMException("The operation timed out.", "TimeoutError");
        throw new TypeError("fetch failed");
      }),
    );
    await expect(autoTextSearch("cat", 5, 10_000)).rejects.toThrow(SearchTimeoutError);
  });

  it("reports a timeout when a later engine times out after generic failures", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 2) throw new DOMException("The operation timed out.", "TimeoutError");
        throw new TypeError("fetch failed");
      }),
    );
    await expect(autoTextSearch("cat", 5, 10_000)).rejects.toThrow(SearchTimeoutError);
  });

  it("returns no results when every engine fails without timing out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(autoTextSearch("cat", 5, 10_000)).rejects.toThrow(EmptySweepError);
  });

  it("propagates cancellation when the signal aborts mid-sweep", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }),
    );
    await expect(autoTextSearch("cat", 5, 10_000, controller.signal)).rejects.toThrow(SearchCancelled);
  });

  it("ignores oversized engine responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(6 * 1024 * 1024), { status: 200 })),
    );
    await expect(autoTextSearch("cat", 5, 10_000)).rejects.toThrow(EmptySweepError);
  });

  it("accepts a bodyless response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    await expect(autoTextSearch("cat", 5, 10_000)).rejects.toThrow(EmptySweepError);
  });
});
