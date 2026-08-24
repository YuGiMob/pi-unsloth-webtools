import { describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  fetchPageText,
  fetchUrlRaw,
  looksLikeHtml,
  looksLikeHtmlDocument,
  requestHop,
} from "../web-fetch.ts";
import { githubRepoReadmeApiUrl } from "../web-access.ts";
import { fakeResolve, seamWithResponse } from "./helpers.ts";
import type { RawFetchSeam } from "./helpers.ts";
import { GITHUB_PAGE } from "./fixtures.ts";

function textFetch(result: { error: string | null; body: string; contentType: string }): RawFetchSeam {
  return async () => result;
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
      "<!doctype html><html><body>" +
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
    expect(out).toContain("Project Title");
    expect(out).toContain("Install with the one-line script");
    expect(out).not.toContain("<html");
    expect(calls.length).toBe(1);
  });

  it("falls back to the html page when the readme api fails", async () => {
    const rawFetch: RawFetchSeam = async (url) => {
      if (url.startsWith("https://api.github.com/")) {
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
    expect(seenDeadlines.length).toBe(2);
    expect(seenDeadlines[0]).toBeDefined();
    expect(seenDeadlines[0]).toBe(seenDeadlines[1]);
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

