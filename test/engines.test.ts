import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EmptySweepError,
  ResultsAggregator,
  SearchCancelled,
  SearchTimeoutError,
  TEXT_ENGINES,
  autoTextSearch,
  canonicalizeHref,
  capByHost,
  extractResults,
  normalizeText,
  normalizeUrl,
  registrableDomain,
  xpathNodes,
  xpathText,
} from "../engines.ts";
import { buildDom } from "../engines.ts";

function ddgResultsHtml(count: number): string {
  return Array.from(
    { length: count },
    (_, i) =>
      `<div class="result"><div class="body"><h2><a href="https://example-${i}.com/${i}">Result ${i}</a></h2><a href="https://example-${i}.com/${i}">Snippet ${i}.</a></div></div>`
  ).join("");
}

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

describe("canonicalizeHref", () => {
  it("strips tracking parameters and fragments", () => {
    expect(canonicalizeHref("https://x.com/a?utm_source=rss&utm_medium=feed&b=7")).toBe("https://x.com/a?b=7");
    expect(canonicalizeHref("https://x.com/a?fbclid=abc&gclid=def&q=1")).toBe("https://x.com/a?q=1");
    expect(canonicalizeHref("https://x.com/a?srsltid=abc&msclkid=def&gbraid=ghi&wbraid=jkl&yclid=mno&gclsrc=aw.ds&page=2")).toBe("https://x.com/a?page=2");
    expect(canonicalizeHref("https://x.com/a#section")).toBe("https://x.com/a");
  });

  it("strips default ports", () => {
    expect(canonicalizeHref("https://x.com:443/a")).toBe("https://x.com/a");
    expect(canonicalizeHref("http://x.com:80/a")).toBe("http://x.com/a");
    expect(canonicalizeHref("https://x.com:8443/a")).toBe("https://x.com:8443/a");
  });

  it("keeps non-tracking parameters and paths", () => {
    expect(canonicalizeHref("https://x.com/a?page=2&sort=asc")).toBe("https://x.com/a?page=2&sort=asc");
    expect(canonicalizeHref("https://x.com/a/b?q=1")).toBe("https://x.com/a/b?q=1");
  });

  it("returns unparsable input unchanged", () => {
    expect(canonicalizeHref("not a url")).toBe("not a url");
    expect(canonicalizeHref("")).toBe("");
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

  it("supports direct-child predicates", () => {
    const dom = buildDom(
      '<div class="result"><a href="/one"><h2>One</h2></a><p>First</p></div><div class="result"><p>No link</p></div>',
    );
    const items = xpathNodes("//div[contains(@class, 'result')][./a]", dom);
    expect(items.length).toBe(1);
    expect(xpathText("./a/@href", items[0])).toEqual(["/one"]);
    expect(xpathText(".//h2//text()", items[0]).join("")).toBe("One");
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
  it("dedupes by href and keeps the longer body", () => {
    const aggregator = new ResultsAggregator();
    aggregator.extend([
      { title: "A", href: "https://x.com/1", body: "short" },
      { title: "B", href: "https://x.com/2", body: "body b" },
      { title: "A2", href: "https://x.com/1", body: "a much longer body" },
      { title: "B", href: "https://x.com/2", body: "body b" },
      { title: "B", href: "https://x.com/2", body: "body b" },
    ]);
    const out = aggregator.ranked();
    expect(out.length).toBe(2);
    expect(aggregator.size).toBe(2);
    expect(out[0].href).toBe("https://x.com/1");
    expect(out[0].title).toBe("A2");
    expect(out[0].body).toBe("a much longer body");
  });

  it("merges duplicates that differ only by tracking parameters", () => {
    const aggregator = new ResultsAggregator();
    aggregator.extend([
      { title: "A", href: "https://x.com/p?utm_source=rss", body: "short" },
      { title: "A", href: "https://x.com/p?utm_source=news&utm_medium=rss", body: "longer body" },
      { title: "A", href: "https://x.com/p", body: "longest body here" },
    ]);
    const out = aggregator.ranked();
    expect(out.length).toBe(1);
    expect(out[0].body).toBe("longest body here");
    expect(out[0].href).toBe("https://x.com/p");
  });

  it("keeps pages apart when non-tracking parameters differ", () => {
    const aggregator = new ResultsAggregator();
    aggregator.extend([
      { title: "A", href: "https://x.com/p?page=1", body: "first" },
      { title: "A", href: "https://x.com/p?page=2", body: "second" },
    ]);
    expect(aggregator.ranked().length).toBe(2);
  });

  it("drops Wikimedia category pages", () => {
    const aggregator = new ResultsAggregator();
    aggregator.extend([
      { title: "Category:Wikimedia cats", href: "https://x.com/5", body: "skip me" },
      { title: "Keep me", href: "https://x.com/6", body: "keep" },
    ]);
    expect(aggregator.ranked().map((doc) => doc.href)).toEqual(["https://x.com/6"]);
  });

  it("ranks a result two engines returned above a single engine's deeper hit", () => {
    const aggregator = new ResultsAggregator();
    aggregator.extend([
      { title: "deep", href: "https://a.example/deep", body: "" },
      { title: "second", href: "https://a.example/second", body: "" },
      { title: "shared", href: "https://shared.example/hit", body: "" },
      { title: "fourth", href: "https://a.example/fourth", body: "" },
    ]);
    aggregator.extend([{ title: "shared", href: "https://shared.example/hit", body: "" }]);
    expect(aggregator.ranked()[0].href).toBe("https://shared.example/hit");
  });

  it("honours engine weights", () => {
    const aggregator = new ResultsAggregator();
    aggregator.extend([{ title: "low", href: "https://low.example/a", body: "" }], 0.5);
    aggregator.extend([{ title: "high", href: "https://high.example/b", body: "" }], 2);
    expect(aggregator.ranked()[0].href).toBe("https://high.example/b");
  });

  it("breaks ties deterministically by href", () => {
    const aggregator = new ResultsAggregator();
    aggregator.extend([{ title: "z", href: "https://z.example/a", body: "" }]);
    aggregator.extend([{ title: "a", href: "https://a.example/b", body: "" }]);
    expect(aggregator.ranked().map((doc) => doc.href)).toEqual(["https://a.example/b", "https://z.example/a"]);
  });
});

describe("capByHost", () => {
  const docs = [
    { title: "1", href: "https://example.com/a", body: "" },
    { title: "2", href: "https://www.example.com/b", body: "" },
    { title: "3", href: "https://sub.example.com/c", body: "" },
    { title: "4", href: "https://other.com/d", body: "" },
  ];

  it("caps results per registrable domain", () => {
    expect(capByHost(docs, 10, 2).map((doc) => doc.href)).toEqual([
      "https://example.com/a",
      "https://www.example.com/b",
      "https://other.com/d",
    ]);
  });

  it("respects the result limit", () => {
    expect(capByHost(docs, 2, 2).length).toBe(2);
  });

  it("treats zero as no cap", () => {
    expect(capByHost(docs, 10, 0).length).toBe(4);
  });
});

describe("registrableDomain", () => {
  it("strips www, subdomains and multi-part suffixes", () => {
    expect(registrableDomain("https://www.example.com/a")).toBe("example.com");
    expect(registrableDomain("https://news.bbc.co.uk/x")).toBe("bbc.co.uk");
    expect(registrableDomain("not a url")).toBe("");
  });
});

describe("sweep outcomes", () => {

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

describe("startpage engine", () => {
  const STARTPAGE_HTML = `
    <div class="result css-1">
      <a href="https://example.com/one" class="result-title result-link"><h2>First result</h2></a>
      <p>First snippet.</p>
    </div>
    <div class="result css-2">
      <a href="https://example.com/two" class="result-title result-link"><h2>Second result</h2></a>
      <p>Second snippet.</p>
    </div>
    <div class="result css-3"><p>No link here</p></div>
  `;

  it("extracts organic results and scopes the request to the region", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return new Response(STARTPAGE_HTML, { status: 200 });
      }),
    );
    const startpage = TEXT_ENGINES.find((engine) => engine.name === "startpage");
    expect(startpage?.provider).toBe("google");
    const results = await startpage!.search("unsloth studio", { region: "de-de", safesearch: "moderate" }, 10_000);
    expect(results).toEqual([
      { title: "First result", href: "https://example.com/one", body: "First snippet." },
      { title: "Second result", href: "https://example.com/two", body: "Second snippet." },
    ]);
    const requested = new URL(calls[0]);
    expect(requested.origin + requested.pathname).toBe("https://www.startpage.com/sp/search");
    expect(requested.searchParams.get("query")).toBe("unsloth studio");
    expect(requested.searchParams.get("qsr")).toBe("de_DE");
    expect(requested.searchParams.has("qadf")).toBe(false);
  });
});

describe("sweep deadline", () => {
  it("stops dispatching engines once the sweep budget is exhausted", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, opts?: RequestInit) => {
        calls++;
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation timed out.", "TimeoutError"));
          });
        });
      }),
    );
    const start = performance.now();
    await expect(autoTextSearch("cat", 5, 250)).rejects.toThrow(SearchTimeoutError);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(5);
  }, 10_000);
});

describe("sweep early exit", () => {
  it("aborts in-flight engines once enough results arrive", async () => {
    const universal = Array.from({ length: 5 }, (_, i) =>
      [
        `<div class="result"><div class="body"><h2><a href="https://d${i}.example/hit">D${i}</a></h2><a href="https://d${i}.example/hit">Snippet ${i}.</a></div></div>`,
        `<div data-type="web"><a href="https://b${i}.example/hit"><div class="title">B${i}</div></a></div>`,
        `<div data-hveid="x"><a href="https://g${i}.example/hit"><h3>G${i}</h3></a></div>`,
        `<ul class="results"><li><h2><a href="https://m${i}.example/hit">M${i}</a></h2><p class="s">snippet</p></li></ul>`,
        `<div class="relsrch"><div class="Title"><h3><a href="https://y${i}.example/hit">Y${i}</a></h3></div><div class="Text">text</div></div>`,
        `<li class="serp-item"><h3><a href="https://x${i}.example/hit">X${i}</a></h3><div class="text">snippet</div></li>`,
      ].join(""),
    ).join("");
    let aborted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, opts?: RequestInit) => {
        if (String(url).includes("yandex.com")) {
          return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        }
        return Promise.resolve(new Response(universal, { status: 200 }));
      }),
    );
    const start = performance.now();
    const results = await autoTextSearch("cat", 5, 10_000, undefined, {
      engines: ["duckduckgo", "startpage", "yandex"],
    });
    expect(results.length).toBe(5);
    expect(performance.now() - start).toBeLessThan(3_000);
    expect(aborted).toBe(true);
  }, 10_000);
});

describe("engine retry", () => {
  it("retries a transient failure once and keeps the retried results", async () => {
    let ddgCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("html.duckduckgo.com")) {
          ddgCalls++;
          if (ddgCalls === 1) throw new TypeError("fetch failed");
          return new Response(ddgResultsHtml(5), { status: 200 });
        }
        return new Response(null, { status: 200 });
      }),
    );
    const results = await autoTextSearch("cat", 5, 10_000);
    expect(ddgCalls).toBe(2);
    expect(results.length).toBe(5);
  });

  it("retries a null response from an engine", async () => {
    let ddgCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("html.duckduckgo.com")) {
          ddgCalls++;
          if (ddgCalls === 1) return new Response("blocked", { status: 403 });
          return new Response(ddgResultsHtml(5), { status: 200 });
        }
        return new Response(null, { status: 200 });
      }),
    );
    const results = await autoTextSearch("cat", 5, 10_000);
    expect(ddgCalls).toBe(2);
    expect(results.length).toBe(5);
  });

  it("does not retry engine timeouts", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        throw new DOMException("The operation timed out.", "TimeoutError");
      }),
    );
    await expect(autoTextSearch("cat", 5, 10_000)).rejects.toThrow(SearchTimeoutError);
    expect(calls).toBe(2);
  });

  it("does not classify a retry that cannot start as a timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        throw new TypeError("fetch failed");
      }),
    );
    await expect(autoTextSearch("cat", 100, 60)).rejects.toThrow(EmptySweepError);
  }, 5_000);

  it("does not launch a retry that cannot fit the remaining budget", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        throw new TypeError("fetch failed");
      }),
    );
    await expect(autoTextSearch("cat", 5, 400)).rejects.toThrow(EmptySweepError);
    expect(calls).toBe(2);
  });
});

describe("engine request headers", () => {
  it("sends a form content-type on the duckduckgo post", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).includes("html.duckduckgo.com")) {
          return Promise.resolve(new Response(ddgResultsHtml(5), { status: 200 }));
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      }),
    );
    const results = await autoTextSearch("cat", 5, 10_000);
    const post = calls.find((call) => call.init?.method === "POST");
    expect(post).toBeDefined();
    expect(post?.init?.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(results.length).toBe(5);
  });
});

describe("engine selection", () => {
  it("limits the sweep to the configured engines", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return new Response(ddgResultsHtml(5), { status: 200 });
      }),
    );
    const results = await autoTextSearch("cat", 5, 10_000, undefined, { engines: ["duckduckgo"] });
    expect(results.length).toBe(5);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("html.duckduckgo.com");
  });

  it("searches duckduckgo and startpage by default", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return new Response("<html><body></body></html>", { status: 200 });
      }),
    );
    await expect(autoTextSearch("cat", 5, 10_000)).rejects.toThrow(EmptySweepError);
    expect(calls.length).toBe(2);
    expect(calls.some((url) => url.includes("yandex"))).toBe(false);
  });

  it("falls back to the default engines when no configured name matches", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return new Response("<html><body></body></html>", { status: 200 });
      }),
    );
    await expect(autoTextSearch("cat", 5, 10_000, undefined, { engines: ["nope"] })).rejects.toThrow(EmptySweepError);
    expect(calls.length).toBe(2);
    expect(calls.some((url) => url.includes("yandex"))).toBe(false);
  });

  it("applies maxPerHost to the returned results", async () => {
    const sameHost = Array.from(
      { length: 4 },
      (_, i) =>
        `<div class="result"><div class="body"><h2><a href="https://one.example/p${i}">R${i}</a></h2><a href="https://one.example/p${i}">S${i}</a></div></div>`,
    ).join("");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(sameHost, { status: 200 })),
    );
    const results = await autoTextSearch("cat", 5, 10_000, undefined, { engines: ["duckduckgo"], maxPerHost: 2 });
    expect(results.length).toBe(2);
    expect(results.every((result) => new URL(result.href).hostname === "one.example")).toBe(true);
  });

  it("does not cap hosts by default", async () => {
    const sameHost = Array.from(
      { length: 5 },
      (_, i) =>
        `<div class="result"><div class="body"><h2><a href="https://one.example/p${i}">R${i}</a></h2><a href="https://one.example/p${i}">S${i}</a></div></div>`,
    ).join("");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(sameHost, { status: 200 })),
    );
    const results = await autoTextSearch("cat", 5, 10_000, undefined, { engines: ["duckduckgo"] });
    expect(results.length).toBe(5);
  });

  it("orders results by engine weight", async () => {
    const ddgHtml =
      '<div class="result"><div class="body"><h2><a href="https://ddg.example/a">D</a></h2><a href="https://ddg.example/a">snippet</a></div></div>';
    const startpageHtml = '<div class="result"><a href="https://start.example/b"><h2>S</h2></a><p>snippet</p></div>';
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => new Response(String(url).includes("startpage.com") ? startpageHtml : ddgHtml, { status: 200 })),
    );
    const results = await autoTextSearch("cat", 5, 10_000, undefined, {
      engines: ["duckduckgo", "startpage"],
      engineWeights: { startpage: 3 },
    });
    expect(results.map((result) => result.href)).toEqual(["https://start.example/b", "https://ddg.example/a"]);
  });
});

describe("engine render fallback", () => {
  it("renders the engine page when the network transports return nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("blocked", { status: 403 })),
    );
    const renderPage = vi.fn(async (_url: string, _options: { timeoutMs: number }) => ddgResultsHtml(3));
    const results = await autoTextSearch("cat", 5, 10_000, undefined, {
      engines: ["duckduckgo"],
      renderFallback: true,
      renderPage,
    });
    expect(results.length).toBe(3);
    expect(renderPage).toHaveBeenCalledTimes(1);
    const [url, options] = renderPage.mock.calls[0];
    expect(url).toContain("html.duckduckgo.com/html/");
    expect(url).toContain("q=cat");
    expect(options.timeoutMs).toBeGreaterThan(0);
  });

  it("renders when the engine answers with a challenge page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html><body>challenge required</body></html>", { status: 200 })),
    );
    const renderPage = vi.fn(async () => ddgResultsHtml(4));
    const results = await autoTextSearch("cat", 5, 10_000, undefined, {
      engines: ["duckduckgo"],
      renderFallback: true,
      renderPage,
    });
    expect(results.length).toBe(4);
    expect(renderPage).toHaveBeenCalledTimes(1);
  });

  it("skips rendering when results already arrived", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(ddgResultsHtml(5), { status: 200 })),
    );
    const renderPage = vi.fn(async () => ddgResultsHtml(1));
    const results = await autoTextSearch("cat", 5, 10_000, undefined, {
      engines: ["duckduckgo"],
      renderFallback: true,
      renderPage,
    });
    expect(results.length).toBe(5);
    expect(renderPage).not.toHaveBeenCalled();
  });

  it("does not render without the toggle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("blocked", { status: 403 })),
    );
    const renderPage = vi.fn(async () => ddgResultsHtml(1));
    await expect(
      autoTextSearch("cat", 5, 10_000, undefined, { engines: ["duckduckgo"], renderPage }),
    ).rejects.toThrow(EmptySweepError);
    expect(renderPage).not.toHaveBeenCalled();
  });

  it("keeps the failure when the renderer yields nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("blocked", { status: 403 })),
    );
    const renderPage = vi.fn(async () => null);
    await expect(
      autoTextSearch("cat", 5, 10_000, undefined, {
        engines: ["duckduckgo"],
        renderFallback: true,
        renderPage,
      }),
    ).rejects.toThrow(EmptySweepError);
    expect(renderPage).toHaveBeenCalledTimes(1);
  });

  it("renders each engine with its own request url", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("blocked", { status: 403 })),
    );
    const renderPage = vi.fn(async (_url: string, _options: { timeoutMs: number }) => "<html><body></body></html>");
    await expect(
      autoTextSearch("cat", 5, 10_000, undefined, {
        engines: ["yandex", "startpage"],
        renderFallback: true,
        renderPage,
      }),
    ).rejects.toThrow(EmptySweepError);
    const urls = renderPage.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes("yandex.com/search/site/") && url.includes("text=cat"))).toBe(true);
    expect(urls.some((url) => url.includes("startpage.com/sp/search") && url.includes("query=cat"))).toBe(true);
  });
});
