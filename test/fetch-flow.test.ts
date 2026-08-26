import { describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import {
  FetchCancelledError,
  fetchPageText,
  fetchUrlRaw,
  looksLikeHtml,
  looksLikeHtmlDocument,
  requestHop,
} from "../web-fetch.ts";
import { githubRepoReadmeApiUrl } from "../web-access.ts";
import { fakeResolve, makePdf, seamWithResponse } from "./helpers.ts";
import type { RawFetchSeam } from "./helpers.ts";
import { GITHUB_PAGE } from "./fixtures.ts";

const { dnsLookupMock } = vi.hoisted(() => ({ dnsLookupMock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dnsLookupMock }));

function textFetch(result: { error: string | null; body: string; contentType: string }): RawFetchSeam {
  return async () => result;
}

async function withServer(
  respond: (res: http.ServerResponse) => void,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = http.createServer((_req, res) => respond(res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
}

describe("github readme rewrite", () => {
  it("maps repo root urls to the readme api", () => {
    expect(githubRepoReadmeApiUrl("https://github.com/unslothai/unsloth")).toBe(
      "https://api.github.com/repos/unslothai/unsloth/readme",
    );
    expect(githubRepoReadmeApiUrl("https://github.com/unslothai/unsloth/")).toBe(
      "https://api.github.com/repos/unslothai/unsloth/readme",
    );
    expect(githubRepoReadmeApiUrl("http://www.github.com/owner/repo.git")).toBe(
      "https://api.github.com/repos/owner/repo/readme",
    );
  });

  it("leaves non-repo urls alone", () => {
    for (const url of [
      "https://github.com/unslothai/unsloth/tree/main/studio",
      "https://github.com/unslothai/unsloth/issues/123",
      "https://github.com/topics/llm",
      "https://github.com/orgs/unslothai/repositories",
      "https://github.com/login/oauth",
      "https://github.com/unslothai",
      "https://example.com/owner/repo",
      "https://raw.githubusercontent.com/owner/repo/main/README.md",
    ]) {
      expect(githubRepoReadmeApiUrl(url)).toBeNull();
    }
  });

  it("prefers the github readme api with raw accept headers", async () => {
    const calls: { url: string; extraHeaders?: Record<string, string> }[] = [];
    const rawFetch: RawFetchSeam = async (url, options) => {
      calls.push({ url, extraHeaders: options.extraHeaders });
      return { error: null, body: "# Unsloth\n\nFine-tune LLMs faster.", contentType: "text/plain" };
    };
    const out = await fetchPageText("https://github.com/unslothai/unsloth", { rawFetch });
    expect(out).toContain("Fine-tune LLMs faster.");
    expect(out).toContain("README of https://github.com/unslothai/unsloth");
    expect(calls.length).toBe(1);
    expect(calls[0].extraHeaders?.Accept).toBe("application/vnd.github.raw+json");
  });

  it("converts an html readme from the api instead of falling back", async () => {
    const htmlReadme =
      "<!doctype html><html><head><title>Project Docs</title></head><body>" +
      "<h1>Project Title</h1>" +
      "<p>Install with the one-line script and read the docs.</p>" +
      "</body></html>";
    const calls: string[] = [];
    const rawFetch: RawFetchSeam = async (url) => {
      calls.push(url);
      return { error: null, body: htmlReadme, contentType: "text/html" };
    };
    const out = await fetchPageText("https://github.com/unslothai/unsloth", { rawFetch });
    expect(out).toContain("README of https://github.com/unslothai/unsloth");
    expect(out).toContain("Title: Project Docs");
    expect(out).toContain("Project Title");
    expect(out).toContain("Install with the one-line script");
    expect(out).not.toContain("<html");
    expect(calls.length).toBe(1);
  });

  it("falls back to the raw readme url when the api fails", async () => {
    const calls: string[] = [];
    const rawFetch: RawFetchSeam = async (url) => {
      calls.push(url);
      if (url.startsWith("https://api.github.com/")) {
        return { error: "Failed to fetch URL: HTTP 403 rate limited", body: "", contentType: "" };
      }
      return { error: null, body: "# Raw Readme\n\nFresh content from the raw endpoint.", contentType: "text/plain" };
    };
    const out = await fetchPageText("https://github.com/unslothai/unsloth", { rawFetch });
    expect(out).toContain("Fresh content from the raw endpoint.");
    expect(out).toContain("README of https://github.com/unslothai/unsloth");
    expect(calls).toEqual([
      "https://api.github.com/repos/unslothai/unsloth/readme",
      "https://raw.githubusercontent.com/unslothai/unsloth/HEAD/README.md",
    ]);
  });

  it("falls back to the html page when the readme api and raw url fail", async () => {
    const rawFetch: RawFetchSeam = async (url) => {
      if (url.startsWith("https://api.github.com/") || url.startsWith("https://raw.githubusercontent.com/")) {
        return { error: "Failed to fetch URL: HTTP 403 rate limited", body: "", contentType: "" };
      }
      return { error: null, body: GITHUB_PAGE, contentType: "text/html" };
    };
    const out = await fetchPageText("https://github.com/unslothai/unsloth", { rawFetch });
    expect(out).toContain("Unsloth Studio");
    expect(out).not.toContain("Uh oh!");
    expect(out).not.toContain("There was an error while loading");
  });

  it("falls back when the readme api returns an error status", async () => {
    const out = await fetchPageText("https://github.com/unslothai/unsloth", {
      seams: {
        resolve: async () => fakeResolve(),
        request: async (opts) => {
          if (opts.url.hostname === "api.github.com") {
            return {
              status: 403,
              headers: { "content-type": "application/json" },
              body: Buffer.from(
                '{"message":"API rate limit exceeded","documentation_url":"https://docs.github.com/rest"}',
              ),
            };
          }
          if (opts.url.hostname === "raw.githubusercontent.com") {
            return {
              status: 404,
              headers: { "content-type": "text/plain" },
              body: Buffer.from("404: Not Found"),
            };
          }
          return {
            status: 200,
            headers: { "content-type": "text/html" },
            body: Buffer.from(GITHUB_PAGE),
          };
        },
      },
    });
    expect(out).toContain("Unsloth Studio");
    expect(out).not.toContain("rate limit");
  });

  it("keeps markdown readmes with fenced html examples verbatim", async () => {
    const mdReadme =
      "```html\n" +
      "<!DOCTYPE html>\n" +
      "<html><body><h1>Demo</h1></body></html>\n" +
      "```\n\n" +
      "# My Project\n\nInstall and run.\n";
    const rawFetch = textFetch({ error: null, body: mdReadme, contentType: "text/plain" });
    const out = await fetchPageText("https://github.com/unslothai/unsloth", { rawFetch });
    expect(out).toContain("README of https://github.com/unslothai/unsloth");
    expect(out).toContain("```html");
    expect(out).toContain("<!DOCTYPE html>");
    expect(out).toContain("# My Project");
  });

  it("keeps markdown readmes with a leading table verbatim", async () => {
    const mdReadme =
      '<table align="center">\n' +
      '<tr><td><img src="logo.png"></td><td>Badges</td></tr>\n' +
      "</table>\n\n" +
      "# My Project\n\n" +
      "- feature one\n" +
      "- feature two\n\n" +
      "```python\nprint('hi')\n```\n";
    const rawFetch = textFetch({ error: null, body: mdReadme, contentType: "text/plain" });
    const out = await fetchPageText("https://github.com/unslothai/unsloth", { rawFetch });
    expect(out).toContain("- feature one\n- feature two");
    expect(out).toContain("```python");
    expect(out).toContain("# My Project");
  });

  it("keeps markdown readmes with a leading block tag verbatim", async () => {
    const mdReadme =
      "<blockquote>Note: pre-release.</blockquote>\n\n" +
      "# My Project\n\n" +
      "Install:\n\n" +
      "- step one\n" +
      "- step two\n\n" +
      "```bash\npip install myproject\n```\n";
    const rawFetch = textFetch({ error: null, body: mdReadme, contentType: "text/plain" });
    const out = await fetchPageText("https://github.com/unslothai/unsloth", { rawFetch });
    expect(out).toContain("README of https://github.com/unslothai/unsloth");
    expect(out).toContain("# My Project");
    expect(out).toContain("- step one");
    expect(out).toContain("```bash");
  });
});

describe("fetch_page_text conversion paths", () => {
  it("returns non-html bodies raw", async () => {
    const raw = "line one\n    indented code\nline three";
    const rawFetch = textFetch({ error: null, body: raw, contentType: "text/plain" });
    const out = await fetchPageText("https://raw.githubusercontent.com/o/r/main/file.txt", {
      rawFetch,
    });
    expect(out).toContain("    indented code");
  });

  it("prefixes html pages with the document title", async () => {
    const rawFetch = textFetch({
      error: null,
      body:
        "<html><head><title>Pi Docs &amp; Guides</title></head><body><main><h1>Doc</h1><p>Readable body text here.</p></main></body></html>",
      contentType: "text/html",
    });
    const out = await fetchPageText("https://example.com/doc", { rawFetch });
    expect(out.startsWith("Title: Pi Docs & Guides")).toBe(true);
    expect(out).toContain("Readable body text here.");
  });

  it("omits the title prefix for pages without a title element", async () => {
    const rawFetch = textFetch({
      error: null,
      body:
        "<html><body><main><h1>Doc</h1><p>Readable body text here.</p></main></body></html>",
      contentType: "text/html",
    });
    const out = await fetchPageText("https://example.com/doc", { rawFetch });
    expect(out).not.toContain("Title:");
    expect(out).toContain("Readable body text here.");
  });

  it("ignores svg and template titles when extracting the document title", async () => {
    const rawFetch = textFetch({
      error: null,
      body:
        "<html><head><title>Real Docs</title></head><body>" +
        "<svg><title>Decorative label</title></svg>" +
        "<template><title>Template junk</title></template>" +
        "<main><h1>Doc</h1><p>Readable body text here.</p></main></body></html>",
      contentType: "text/html",
    });
    const out = await fetchPageText("https://example.com/doc", { rawFetch });
    expect(out.startsWith("Title: Real Docs")).toBe(true);
    expect(out).not.toContain("Decorative label");
    expect(out).not.toContain("Template junk");
  });

  it("uses only the first title element when titles repeat", async () => {
    const rawFetch = textFetch({
      error: null,
      body:
        "<html><head><title>First Title</title><title>Second Title</title></head><body><main><h1>Doc</h1><p>Readable body text here.</p></main></body></html>",
      contentType: "text/html",
    });
    const out = await fetchPageText("https://example.com/doc", { rawFetch });
    expect(out.startsWith("Title: First Title")).toBe(true);
    expect(out).not.toContain("Second Title");
  });

  it("ignores svg and template titles that precede the document title", async () => {
    const rawFetch = textFetch({
      error: null,
      body:
        "<html><head><svg><title>Decorative label</title></svg><template><title>Template junk</title></template><title>Real Docs</title></head><body><main><h1>Doc</h1><p>Readable body text here.</p></main></body></html>",
      contentType: "text/html",
    });
    const out = await fetchPageText("https://example.com/doc", { rawFetch });
    expect(out.startsWith("Title: Real Docs")).toBe(true);
    expect(out).not.toContain("Decorative label");
    expect(out).not.toContain("Template junk");
  });

  it("converts html bodies with the main-content heuristic", async () => {
    const rawFetch = textFetch({ error: null, body: GITHUB_PAGE, contentType: "text/html" });
    const out = await fetchPageText("https://github.com/unslothai/unsloth/tree/main", { rawFetch });
    expect(out).toContain("Unsloth Studio");
    expect(out).not.toContain("Uh oh!");
  });

  it("propagates fetch errors", async () => {
    const rawFetch = textFetch({
      error: "Failed to fetch URL: HTTP 404 Not Found",
      body: "",
      contentType: "",
    });
    const out = await fetchPageText("https://example.com/missing", { rawFetch });
    expect(out).toBe("Failed to fetch URL: HTTP 404 Not Found");
  });

  it("converts pages whose inline scripts contain `<` comparisons", async () => {
    const body =
      "<html><head>" +
      "<script>if (\"u\"<typeof navigator) x()</script>" +
      Array.from({ length: 12 }, (_, i) => `<script>let v${i} = 1 < 2 < 3;</script>`).join("") +
      "</head><body><main><h1>Doc Title</h1><p>" +
      "Readable documentation body text. ".repeat(20) +
      "</p></main></body></html>";
    const rawFetch = textFetch({ error: null, body, contentType: "text/html" });
    const out = await fetchPageText("https://example.com/docs/studio", { rawFetch });
    expect(out).toContain("Doc Title");
    expect(out).toContain("Readable documentation body text.");
    expect(out).not.toContain("<script");
  });

  it("sniffs html without a content-type", async () => {
    const rawFetch = textFetch({ error: null, body: GITHUB_PAGE, contentType: "" });
    const out = await fetchPageText("https://example.com/no-content-type", { rawFetch });
    expect(out).toContain("Unsloth Studio");
    expect(out).not.toContain("<html");
    expect(out).not.toContain("Uh oh!");
  });

  it("converts bare html fragments without a content-type", async () => {
    const fragment = "<article><h1>Doc Title</h1><p>Readable fragment body.</p></article>";
    const rawFetch = textFetch({ error: null, body: fragment, contentType: "" });
    const out = await fetchPageText("https://example.com/fragment", { rawFetch });
    expect(out).toContain("Doc Title");
    expect(out).toContain("Readable fragment body.");
    expect(out).not.toContain("<article");
  });

  it("keeps plain text raw without a content-type", async () => {
    const raw = "line one\n    indented code\nline three";
    const rawFetch = textFetch({ error: null, body: raw, contentType: "" });
    const out = await fetchPageText("https://example.com/no-content-type.txt", { rawFetch });
    expect(out).toContain("    indented code");
  });

  it("sniffs and converts mislabeled text/plain html", async () => {
    const rawFetch = textFetch({ error: null, body: GITHUB_PAGE, contentType: "text/plain" });
    const out = await fetchPageText("https://example.com/mislabeled", { rawFetch });
    expect(out).toContain("Unsloth Studio");
    expect(out).not.toContain("<html");
  });
});

describe("html sniffing", () => {
  it("recognizes real documents", () => {
    expect(looksLikeHtml("<!DOCTYPE html><html></html>")).toBe(true);
    expect(looksLikeHtml("\n  <HTML lang='en'>")).toBe(true);
    expect(looksLikeHtml("# Markdown README\n\n<h1>embedded html later</h1>")).toBe(false);
    expect(looksLikeHtml("plain text")).toBe(false);
  });

  it("keeps markdown with a leading fenced html example as markdown", () => {
    const fenced =
      "```html\n<!DOCTYPE html>\n<html><body><div>hi</div></body></html>\n```\n\n# Real README\n";
    expect(looksLikeHtml(fenced)).toBe(false);
    expect(looksLikeHtml("Use the <html> element to start a page.")).toBe(false);
    expect(looksLikeHtml('<p align="center"><img src="logo.png"></p>\n\n# Project\n')).toBe(false);
    expect(looksLikeHtml('<div align="center">\n\n# Project\n\n</div>\n')).toBe(false);
    expect(looksLikeHtml('<h1 align="center">Project</h1>\n\nMarkdown body.\n')).toBe(false);
    expect(looksLikeHtml("<https://example.com> is the homepage")).toBe(false);
  });

  it("detects bare html fragments", () => {
    expect(looksLikeHtml("<body><p>hello</p></body>")).toBe(true);
    expect(looksLikeHtml("\n<article><h1>Title</h1><p>Body</p></article>")).toBe(true);
    expect(looksLikeHtml("<section>content</section>")).toBe(true);
  });

  it("keeps leading-table markdown as markdown", () => {
    expect(looksLikeHtml("<table><tr><td>cell</td></tr></table>")).toBe(false);
    expect(
      looksLikeHtml('<table align="center"><tr><td><img src="logo.png"></td></tr></table>\n\n# Project\n'),
    ).toBe(false);
    expect(looksLikeHtml("<tr><td>cell</td></tr>")).toBe(false);
  });

  it("matches only real documents for the readme gate", () => {
    expect(looksLikeHtmlDocument("<!doctype html><html><body>x</body></html>")).toBe(true);
    expect(looksLikeHtmlDocument("\n  <HTML lang='en'>")).toBe(true);
    expect(looksLikeHtmlDocument("<body><h1>x</h1></body>")).toBe(true);
    for (const frag of [
      "<blockquote>q</blockquote>",
      "<ul><li>x</li></ul>",
      "<pre>x</pre>",
      "<dl><dt>x</dt></dl>",
    ]) {
      expect(looksLikeHtmlDocument(frag)).toBe(false);
    }
  });

  it("sniffs html past leading comments and xml declarations", () => {
    expect(looksLikeHtml("<!-- generated by a builder -->\n<!DOCTYPE html><html><body>x</body></html>")).toBe(true);
    expect(looksLikeHtml("<!-- one --> <!-- two -->\n<html><body>x</body></html>")).toBe(true);
    expect(looksLikeHtml("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<html><body>x</body></html>")).toBe(true);
    expect(looksLikeHtmlDocument("<!-- c -->\n<!doctype html><html><body>x</body></html>")).toBe(true);
  });

  it("keeps markdown with a leading html comment as markdown", () => {
    expect(looksLikeHtml("<!-- comment -->\n# Readme\n\nText.")).toBe(false);
    expect(looksLikeHtml("<!-- comment -->\n```html\n<div>x</div>\n```\n# Title")).toBe(false);
  });
});

describe("dns resolution budget", () => {
  it("resolves through the built-in resolver without a resolve seam", async () => {
    dnsLookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const result = await fetchUrlRaw("https://example.com/", {
      seams: {
        request: async () => ({ status: 200, headers: {}, body: Buffer.from("hello") }),
      },
    });
    expect(result.error).toBeNull();
    expect(dnsLookupMock).toHaveBeenCalledWith(
      "example.com",
      expect.objectContaining({ all: true, verbatim: true }),
    );
  });

  it("reports cancellation when the signal aborts during resolution", async () => {
    const controller = new AbortController();
    dnsLookupMock.mockImplementation(
      (_hostname: string, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        }),
    );
    const resultPromise = fetchUrlRaw("https://example.com/", {
      signal: controller.signal,
      seams: {
        request: async () => ({ status: 200, headers: {}, body: Buffer.from("x") }),
      },
    });
    controller.abort();
    const result = await resultPromise;
    expect(result.error).toBe("Failed to fetch URL: cancelled.");
  });

  it("bounds dns resolution by the deadline", async () => {
    dnsLookupMock.mockImplementation(
      (_hostname: string, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        }),
    );
    const result = await fetchUrlRaw("https://example.com/", {
      deadlineMs: Date.now() + 50,
      seams: {
        request: async () => ({ status: 200, headers: {}, body: Buffer.from("x") }),
      },
    });
    expect(result.error).toBe("Failed to fetch URL: timed out.");
  });

  it("does not treat an oversized budget as an instant resolver timeout", async () => {
    dnsLookupMock.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve([{ address: "93.184.216.34", family: 4 }]), 20),
        ),
    );
    const result = await fetchUrlRaw("https://example.com/", {
      timeoutMs: 2 ** 31 + 1_000,
      seams: {
        request: async () => ({ status: 200, headers: {}, body: Buffer.from("ok") }),
      },
    });
    expect(result.error).toBeNull();
    expect(result.body).toBe("ok");
  });

  it("prefers ipv4 when a host publishes both families", async () => {
    dnsLookupMock.mockResolvedValue([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "93.184.216.34", family: 4 },
    ]);
    const seen: { ip: string; family: number }[] = [];
    const result = await fetchUrlRaw("https://example.com/", {
      seams: {
        request: async (opts) => {
          seen.push({ ip: opts.pinnedIp, family: opts.family });
          return { status: 200, headers: {}, body: Buffer.from("ok") };
        },
      },
    });
    expect(result.error).toBeNull();
    expect(seen).toEqual([{ ip: "93.184.216.34", family: 4 }]);
  });

  it("falls back to the next resolved address on connection failure", async () => {
    const attempts: { ip: string; family: number }[] = [];
    const result = await fetchUrlRaw("https://example.com/", {
      seams: {
        resolve: async () => ({
          ok: true,
          reason: "",
          ip: "2606:4700:4700::1111",
          family: 6,
          alternates: [{ ip: "93.184.216.34", family: 4 }],
        }),
        request: async (opts) => {
          attempts.push({ ip: opts.pinnedIp, family: opts.family });
          if (opts.family === 6) throw new Error("ECONNREFUSED");
          return { status: 200, headers: {}, body: Buffer.from("fallback ok") };
        },
      },
    });
    expect(result.error).toBeNull();
    expect(result.body).toBe("fallback ok");
    expect(attempts).toEqual([
      { ip: "2606:4700:4700::1111", family: 6 },
      { ip: "93.184.216.34", family: 4 },
    ]);
  });

  it("does not fall back after cancellation or timeout", async () => {
    let calls = 0;
    const result = await fetchUrlRaw("https://example.com/", {
      seams: {
        resolve: async () => ({
          ok: true,
          reason: "",
          ip: "2606:4700:4700::1111",
          family: 6,
          alternates: [{ ip: "93.184.216.34", family: 4 }],
        }),
        request: async () => {
          calls++;
          throw new FetchCancelledError();
        },
      },
    });
    expect(calls).toBe(1);
    expect(result.error).toBe("Failed to fetch URL: cancelled.");
  });
});

describe("fetch deadlines and cancellation", () => {
  it("aborts across redirects on the overall deadline", async () => {
    const clock = { t: 1000 };
    let hops = 0;
    const result = await fetchUrlRaw("https://example.com/start", {
      deadlineMs: clock.t + 8_000,
      nowMs: () => clock.t,
      seams: {
        resolve: async () => ({ ok: true, reason: "", ip: "203.0.113.7", family: 4 }),
        request: async () => {
          clock.t += 5_000;
          hops++;
          return {
            status: 302,
            headers: { location: "https://example.com/next" },
            body: Buffer.alloc(0),
          };
        },
      },
    });
    expect(result.error).toBe("Failed to fetch URL: timed out.");
    expect(result.body).toBe("");
    expect(hops).toBeLessThan(5);
  });

  it("aborts before any network when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    let opened = 0;
    const result = await fetchUrlRaw("https://example.com/", {
      signal: controller.signal,
      seams: {
        resolve: async () => ({ ok: true, reason: "", ip: "203.0.113.7", family: 4 }),
        request: async () => {
          opened++;
          throw new Error("network must not be touched after cancel");
        },
      },
    });
    expect(result.error).toBe("Failed to fetch URL: cancelled.");
    expect(opened).toBe(0);
  });

  it("shares one deadline across the readme attempt and the fallback", async () => {
    const seenDeadlines: (number | undefined)[] = [];
    const rawFetch: RawFetchSeam = async (_url, options) => {
      seenDeadlines.push(options.deadlineMs);
      return { error: "Failed to fetch URL: HTTP 429 rate limited", body: "", contentType: "" };
    };
    const out = await fetchPageText("https://github.com/unslothai/unsloth", {
      timeoutMs: 30_000,
      rawFetch,
    });
    expect(out).toBe("Failed to fetch URL: HTTP 429 rate limited");
    expect(seenDeadlines.length).toBe(3);
    expect(seenDeadlines[0]).toBeDefined();
    expect(seenDeadlines[0]).toBe(seenDeadlines[1]);
    expect(seenDeadlines[1]).toBe(seenDeadlines[2]);
  });

  it("aborts a slow body read at the deadline", async () => {
    const clock = { t: 1000 };
    const result = await fetchUrlRaw("https://example.com/", {
      deadlineMs: clock.t + 5_000,
      nowMs: () => clock.t,
      seams: {
        resolve: async () => ({ ok: true, reason: "", ip: "203.0.113.7", family: 4 }),
        request: async () => {
          clock.t += 10_000;
          return {
            status: 200,
            headers: {},
            body: Buffer.alloc(16, 0x78),
          };
        },
      },
    });
    expect(result.error).toBe("Failed to fetch URL: timed out.");
    expect(result.body).toBe("");
  });

  it("stops a body that outlives the deadline mid-stream", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("a".repeat(64));
      const timer = setInterval(() => res.write("b".repeat(64)), 20);
      res.on("close", () => clearInterval(timer));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const deadline = Date.now() + 300;
    await expect(
      requestHop({
        url: new URL(`http://127.0.0.1:${address.port}/`),
        pinnedIp: "127.0.0.1",
        family: 4,
        headers: {},
        maxBytes: 1024 * 1024,
        maxPdfBytes: 10 * 1024 * 1024,
        inactivityMs: 60_000,
        deadlineMs: deadline,
      }),
    ).rejects.toThrow("timed out");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 5000);

  it("rejects embedded credentials before resolution", async () => {
    let resolved = 0;
    const result = await fetchUrlRaw("https://user:secret@example.com:8443/page?q=1", {
      seams: {
        resolve: async () => {
          resolved++;
          return { ok: true, reason: "", ip: "203.0.113.7", family: 4 };
        },
      },
    });
    expect(result.error).toContain("credentials");
    expect(result.body).toBe("");
    expect(resolved).toBe(0);
  });

  it("reports an empty content-type instead of the RFC default", async () => {
    const result = await fetchUrlRaw("https://example.com/", {
      seams: seamWithResponse(Buffer.from("<html><body>hello</body></html>"), null),
    });
    expect(result.error).toBeNull();
    expect(result.body).toContain("hello");
    expect(result.contentType).toBe("");
  });
});

describe("non-followed redirect statuses", () => {
  it("reports the status with its standard reason", async () => {
    const result = await fetchUrlRaw("https://example.com/", {
      seams: {
        resolve: async () => ({ ok: true, reason: "", ip: "203.0.113.7", family: 4 }),
        request: async () => ({ status: 300, headers: {}, body: Buffer.alloc(0) }),
      },
    });
    expect(result.error).toBe("Failed to fetch URL: HTTP 300 Multiple Choices");
  });
});

describe("error statuses", () => {
  it("reports 4xx and 5xx responses as errors", async () => {
    for (const [status, expected] of [
      [400, "HTTP 400 Bad Request"],
      [403, "HTTP 403 Forbidden"],
      [404, "HTTP 404 Not Found"],
      [429, "HTTP 429 Too Many Requests"],
      [500, "HTTP 500 Internal Server Error"],
      [503, "HTTP 503 Service Unavailable"],
    ] as const) {
      const result = await fetchUrlRaw("https://example.com/", {
        seams: {
          resolve: async () => fakeResolve(),
          request: async () => ({
            status,
            headers: { "content-type": "text/html" },
            body: Buffer.from("<html><body>error page</body></html>"),
          }),
        },
      });
      expect(result.error).toBe(`Failed to fetch URL: ${expected}`);
      expect(result.body).toBe("");
      expect(result.contentType).toBe("");
    }
  });
});

describe("malformed redirect locations", () => {
  it("returns a clean error instead of throwing", async () => {
    const result = await fetchUrlRaw("https://example.com/start", {
      seams: {
        resolve: async () => ({ ok: true, reason: "", ip: "203.0.113.7", family: 4 }),
        request: async () => ({
          status: 302,
          headers: { location: "http://[::1" },
          body: Buffer.alloc(0),
        }),
      },
    });
    expect(result.error).toBe("Failed to fetch URL: the redirect has an invalid Location.");
    expect(result.body).toBe("");
  });
});

describe("request headers", () => {
  it("requests identity content-encoding", async () => {
    let seen: Record<string, string> = {};
    const result = await fetchUrlRaw("https://example.com/", {
      seams: {
        resolve: async () => ({ ok: true, reason: "", ip: "203.0.113.7", family: 4 }),
        request: async (opts) => {
          seen = opts.headers;
          return { status: 200, headers: {}, body: Buffer.from("hello") };
        },
      },
    });
    expect(result.error).toBeNull();
    expect(seen["Accept-Encoding"]).toBe("identity");
  });
});

describe("download cap truncation", () => {
  const CAP_NOTICE = "\n\n... (page truncated at the download limit)";
  const count = (out: string) => out.split("(page truncated at the download limit)").length - 1;

  it("marks a page cut at the download cap as truncated", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "600" });
      res.end("a".repeat(600));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    try {
      const out = await fetchPageText(`http://example.com:${address.port}/`, {
        timeoutMs: 5_000,
        maxBytes: 512,
        seams: { resolve: async () => ({ ok: true, reason: "", ip: "127.0.0.1", family: 4 }) },
      });
      expect(out).toContain("(page truncated at the download limit)");
      expect(count(out)).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not mark a body that ends exactly at the cap", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "512" });
      res.end("b".repeat(512));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    try {
      const out = await fetchPageText(`http://example.com:${address.port}/`, {
        timeoutMs: 5_000,
        maxBytes: 512,
        seams: { resolve: async () => ({ ok: true, reason: "", ip: "127.0.0.1", family: 4 }) },
      });
      expect(out).not.toContain("(page truncated at the download limit)");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not mark an exact-cap body as truncated without a content-length", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("c".repeat(512));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    try {
      const out = await fetchPageText(`http://example.com:${address.port}/`, {
        timeoutMs: 5_000,
        maxBytes: 512,
        seams: { resolve: async () => ({ ok: true, reason: "", ip: "127.0.0.1", family: 4 }) },
      });
      expect(out).toBe("c".repeat(512));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("restores the cap notice when main-content scoping drops it", async () => {
    const body =
      "<html><head><title>T</title></head><body><article><h1>Doc</h1><p>" +
      "Readable body text. ".repeat(200) +
      "</p></article></body></html>" + CAP_NOTICE;
    const out = await fetchPageText("https://example.com/doc", {
      rawFetch: async () => ({ error: null, body, contentType: "text/html" }),
    });
    expect(count(out)).toBe(1);
    expect(out.trimEnd().endsWith("... (page truncated at the download limit)")).toBe(true);
  });

  it("does not duplicate the cap notice on the whole-document path", async () => {
    const body =
      "<html><head><title>T</title></head><body><p>Readable body text.</p></body></html>" +
      CAP_NOTICE;
    const out = await fetchPageText("https://example.com/doc", {
      rawFetch: async () => ({ error: null, body, contentType: "text/html" }),
    });
    expect(count(out)).toBe(1);
    expect(out).toContain("Readable body text.");
  });
});

describe("redirect target validation", () => {
  it("rejects a well-formed ipv6 loopback redirect through resolution", async () => {
    const result = await fetchUrlRaw("https://example.com/start", {
      seams: {
        resolve: async (hostname) =>
          hostname === "::1"
            ? { ok: false, reason: "Blocked: refusing to fetch the non-public address ::1.", ip: "", family: 0 }
            : { ok: true, reason: "", ip: "93.184.216.34", family: 4 },
        request: async () => ({
          status: 302,
          headers: { location: "http://[::1]:8080/" },
          body: Buffer.alloc(0),
        }),
      },
    });
    expect(result.error).toBe("Blocked: refusing to fetch the non-public address ::1.");
    expect(result.body).toBe("");
  });
});

describe("content-encoding decompression", () => {
  it("decompresses gzip bodies from servers that ignore the identity request", async () => {
    const text = "gzip encoded page text marker";
    const encoded = gzipSync(Buffer.from(text));
    await withServer(
      (res) => {
        res.writeHead(200, {
          "content-type": "text/plain",
          "content-encoding": "gzip",
          "content-length": String(encoded.length),
        });
        res.end(encoded);
      },
      async (port) => {
        const result = await fetchUrlRaw(`http://example.com:${port}/`, {
          seams: { resolve: async () => ({ ok: true, reason: "", ip: "127.0.0.1", family: 4 }) },
        });
        expect(result.error).toBeNull();
        expect(result.body).toBe(text);
      },
    );
  });

  it("decompresses deflate and brotli bodies", async () => {
    for (const [encoding, encode] of [
      ["deflate", deflateSync],
      ["br", brotliCompressSync],
    ] as const) {
      const text = `${encoding} encoded body marker`;
      const encoded = encode(Buffer.from(text));
      await withServer(
        (res) => {
          res.writeHead(200, {
            "content-type": "text/plain",
            "content-encoding": encoding,
            "content-length": String(encoded.length),
          });
          res.end(encoded);
        },
        async (port) => {
          const result = await fetchUrlRaw(`http://example.com:${port}/`, {
            seams: { resolve: async () => ({ ok: true, reason: "", ip: "127.0.0.1", family: 4 }) },
          });
          expect(result.error).toBeNull();
          expect(result.body).toBe(text);
        },
      );
    }
  });

  it("falls back to raw inflate for headerless deflate streams", async () => {
    const text = "raw deflate marker";
    const encoded = deflateRawSync(Buffer.from(text));
    await withServer(
      (res) => {
        res.writeHead(200, {
          "content-type": "text/plain",
          "content-encoding": "deflate",
          "content-length": String(encoded.length),
        });
        res.end(encoded);
      },
      async (port) => {
        const result = await fetchUrlRaw(`http://example.com:${port}/`, {
          seams: { resolve: async () => ({ ok: true, reason: "", ip: "127.0.0.1", family: 4 }) },
        });
        expect(result.error).toBeNull();
        expect(result.body).toBe(text);
      },
    );
  });

  it("keeps identity bodies untouched", async () => {
    await withServer(
      (res) => {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "identity" });
        res.end("plain body marker");
      },
      async (port) => {
        const result = await fetchUrlRaw(`http://example.com:${port}/`, {
          seams: { resolve: async () => ({ ok: true, reason: "", ip: "127.0.0.1", family: 4 }) },
        });
        expect(result.error).toBeNull();
        expect(result.body).toBe("plain body marker");
      },
    );
  });

  it("marks a gzip page cut at the cap as truncated instead of binary", async () => {
    const text = "gzip capped page marker ".repeat(200);
    const encoded = gzipSync(Buffer.from(text));
    await withServer(
      (res) => {
        res.writeHead(200, {
          "content-type": "text/plain",
          "content-encoding": "gzip",
          "content-length": String(encoded.length),
        });
        res.end(encoded);
      },
      async (port) => {
        const result = await fetchUrlRaw(`http://example.com:${port}/`, {
          maxBytes: 512,
          seams: { resolve: async () => ({ ok: true, reason: "", ip: "127.0.0.1", family: 4 }) },
        });
        expect(result.error).toBeNull();
        expect(result.body).toContain("gzip capped page marker");
        expect(result.body).toContain("(page truncated at the download limit)");
      },
    );
  });

  it("extends the pdf budget to gzip-encoded pdfs", async () => {
    const pdf = makePdf(["Gzip encoded pdf marker"]);
    const encoded = gzipSync(pdf);
    await withServer(
      (res) => {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-encoding": "gzip",
          "content-length": String(encoded.length),
        });
        res.end(encoded);
      },
      async (port) => {
        const result = await fetchUrlRaw(`http://example.com:${port}/`, {
          maxBytes: 256,
          seams: { resolve: async () => ({ ok: true, reason: "", ip: "127.0.0.1", family: 4 }) },
        });
        expect(result.error).toBeNull();
        expect(result.body).toContain("Gzip encoded pdf marker");
      },
    );
  });

  it("keeps the decoded prefix when a gzip stream fails mid-way", async () => {
    const text = "gzip partial stream marker ".repeat(5000);
    const encoded = gzipSync(Buffer.from(text));
    const half = Math.floor(encoded.length / 2);
    await withServer(
      (res) => {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        res.write(encoded.subarray(0, half));
        res.end();
      },
      async (port) => {
        const result = await fetchUrlRaw(`http://example.com:${port}/`, {
          seams: { resolve: async () => ({ ok: true, reason: "", ip: "127.0.0.1", family: 4 }) },
        });
        expect(result.error).toBeNull();
        expect(result.body).toContain("gzip partial stream marker");
        expect(result.body).toContain("(page truncated at the download limit)");
      },
    );
  });
});

describe("page metadata prefix", () => {
  it("prefixes author, date and site lines when declared", async () => {
    const rawFetch = textFetch({
      error: null,
      body:
        "<html><head><title>Example Docs</title>" +
        '<meta name="author" content="Jane Doe">' +
        '<meta property="article:published_time" content="2026-07-12T10:30:00Z">' +
        '<meta property="og:site_name" content="Example Docs">' +
        "</head><body><main><h1>Doc</h1><p>Readable body text here.</p></main></body></html>",
      contentType: "text/html",
    });
    const out = await fetchPageText("https://example.com/doc", { rawFetch });
    expect(
      out.startsWith(
        "Title: Example Docs\nAuthor: Jane Doe\nDate: 2026-07-12T10:30:00Z\nSite: Example Docs\n\n",
      ),
    ).toBe(true);
    expect(out).toContain("Readable body text here.");
  });

  it("omits metadata lines that are not declared", async () => {
    const rawFetch = textFetch({
      error: null,
      body:
        "<html><head><title>Plain</title></head><body><main><p>Readable body text here.</p></main></body></html>",
      contentType: "text/html",
    });
    const out = await fetchPageText("https://example.com/doc", { rawFetch });
    expect(out.startsWith("Title: Plain\n\n")).toBe(true);
    expect(out).not.toContain("\nAuthor:");
    expect(out).not.toContain("\nDate:");
    expect(out).not.toContain("\nSite:");
  });

  it("uses the first declaration for each field", async () => {
    const rawFetch = textFetch({
      error: null,
      body:
        "<html><head><title>Docs</title>" +
        '<meta name="author" content="First Author">' +
        '<meta property="article:author" content="Second Author">' +
        '<meta name="dc.date" content="2025-01-01">' +
        '<meta property="article:published_time" content="2026-07-12">' +
        "</head><body><main><p>Readable body text here.</p></main></body></html>",
      contentType: "text/html",
    });
    const out = await fetchPageText("https://example.com/doc", { rawFetch });
    expect(out.startsWith("Title: Docs\nAuthor: First Author\nDate: 2025-01-01\n\n")).toBe(true);
  });

  it("reads author and date from self-closing meta tags", async () => {
    const rawFetch = textFetch({
      error: null,
      body:
        "<html><head><title>Docs</title>" +
        '<meta name="author" content="Jane Doe"/>' +
        '<meta property="article:published_time" content="2026-07-12T10:30:00Z"/>' +
        "</head><body><main><p>Readable body text here.</p></main></body></html>",
      contentType: "text/html",
    });
    const out = await fetchPageText("https://example.com/doc", { rawFetch });
    expect(out.startsWith("Title: Docs\nAuthor: Jane Doe\nDate: 2026-07-12T10:30:00Z\n\n")).toBe(true);
  });

  it("collapses whitespace and caps long meta values", async () => {
    const longAuthor = "x".repeat(400);
    const rawFetch = textFetch({
      error: null,
      body:
        "<html><head><title>T</title>" +
        '<meta name="author" content="  Jane   Doe  ">' +
        `<meta property="og:site_name" content="${longAuthor}">` +
        "</head><body><main><p>Readable body text here.</p></main></body></html>",
      contentType: "text/html",
    });
    const out = await fetchPageText("https://example.com/doc", { rawFetch });
    expect(out).toContain("Author: Jane Doe");
    expect(out).toContain(`Site: ${'x'.repeat(300)}`);
    expect(out).not.toContain("x".repeat(301));
  });

  it("does not split surrogate pairs at the meta cap", async () => {
    const rawFetch = textFetch({
      error: null,
      body:
        "<html><head><title>T</title>" +
        `<meta name="author" content="${'x'.repeat(299)}\u{1F600}tail">` +
        "</head><body><main><p>Readable body text here.</p></main></body></html>",
      contentType: "text/html",
    });
    const out = await fetchPageText("https://example.com/doc", { rawFetch });
    expect(out).toContain(`Author: ${'x'.repeat(299)}\n`);
    expect(out).not.toContain("\ufffd");
  });
});
