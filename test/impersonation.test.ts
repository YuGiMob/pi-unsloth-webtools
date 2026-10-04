import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPageText, fetchUrlRaw } from "../web-fetch.ts";
import type { TlsHopResponse } from "../tls-fetch.ts";
import { GITHUB_PAGE } from "./fixtures.ts";

const BOT_WALL = "<html><body>Just a moment…</body></html>";

function okResolve() {
  return { ok: true, reason: "", ip: "93.184.216.34", family: 4 };
}

function forbidden() {
  return { status: 403, headers: { "content-type": "text/html" }, body: Buffer.from(BOT_WALL) };
}

function impersonated(body: string, headers: Record<string, string> = { "content-type": "text/html" }): TlsHopResponse {
  return { status: 200, headers, body: Buffer.from(body), truncated: false };
}

describe("tls impersonation 403 retry", () => {
  it("retries a 403 through the impersonated transport", async () => {
    const calls: string[] = [];
    const result = await fetchUrlRaw("https://example.com/bot", {
      transport: "direct-first",
      seams: {
        resolve: async () => okResolve(),
        request: async () => forbidden(),
        impersonate: async (options) => {
          calls.push(options.url.toString());
          return impersonated("<html><body>real content</body></html>");
        },
      },
    });
    expect(result.error).toBeNull();
    expect(result.body).toContain("real content");
    expect(result.contentType).toBe("text/html");
    expect(calls).toEqual(["https://example.com/bot"]);
  });

  it("passes the pinned address and extra headers to the transport", async () => {
    let seen: { pinnedIp: string | undefined; extraHeaders?: Record<string, string> } | null = null;
    await fetchUrlRaw("https://example.com/bot", {
      extraHeaders: { Accept: "application/vnd.github.raw+json" },
      transport: "direct-first",
      seams: {
        resolve: async () => okResolve(),
        request: async () => forbidden(),
        impersonate: async (options) => {
          seen = { pinnedIp: options.pinnedIp, extraHeaders: options.extraHeaders };
          return impersonated("ok");
        },
      },
    });
    expect(seen).toEqual({
      pinnedIp: "93.184.216.34",
      extraHeaders: { Accept: "application/vnd.github.raw+json" },
    });
  });

  it("does not impersonate when the tier is disabled", async () => {
    let called = 0;
    const result = await fetchUrlRaw("https://example.com/bot", {
      transport: "off",
      seams: {
        resolve: async () => okResolve(),
        request: async () => forbidden(),
        impersonate: async () => {
          called++;
          return impersonated("real content");
        },
      },
    });
    expect(called).toBe(0);
    expect(result.error).toBe("Failed to fetch URL: HTTP 403 Forbidden");
  });

  it("keeps the 403 when the impersonation module is unavailable", async () => {
    const result = await fetchUrlRaw("https://example.com/bot", {
      transport: "direct-first",
      seams: {
        resolve: async () => okResolve(),
        request: async () => forbidden(),
        impersonate: async () => null,
      },
    });
    expect(result.error).toBe("Failed to fetch URL: HTTP 403 Forbidden");
    expect(result.body).toBe("");
  });

  it("keeps the 403 when the impersonated request is also refused", async () => {
    const result = await fetchUrlRaw("https://example.com/bot", {
      transport: "direct-first",
      seams: {
        resolve: async () => okResolve(),
        request: async () => forbidden(),
        impersonate: async () => ({ ...impersonated(BOT_WALL), status: 403 }),
      },
    });
    expect(result.error).toBe("Failed to fetch URL: HTTP 403 Forbidden");
  });

  it("follows a redirect returned by the impersonated transport", async () => {
    const requested: string[] = [];
    const result = await fetchUrlRaw("https://example.com/bot", {
      transport: "direct-first",
      seams: {
        resolve: async () => okResolve(),
        request: async (opts) => {
          requested.push(opts.url.toString());
          if (opts.url.pathname === "/bot") return forbidden();
          return { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("final page") };
        },
        impersonate: async () => ({
          status: 302,
          headers: { location: "https://example.com/final" },
          body: Buffer.alloc(0),
          truncated: false,
        }),
      },
    });
    expect(result.error).toBeNull();
    expect(result.body).toBe("final page");
    expect(requested).toEqual(["https://example.com/bot", "https://example.com/final"]);
  });

  it("still applies the website policy to an impersonated redirect", async () => {
    const requested: string[] = [];
    const result = await fetchUrlRaw("https://example.com/bot", {
      websitePolicy: { allowedDomains: ["example.com"], blockedDomains: [] },
      transport: "direct-first",
      seams: {
        resolve: async () => okResolve(),
        request: async (opts) => {
          requested.push(opts.url.toString());
          return forbidden();
        },
        impersonate: async () => ({
          status: 302,
          headers: { location: "https://other.example/escape" },
          body: Buffer.alloc(0),
          truncated: false,
        }),
      },
    });
    expect(result.error).toBe("Blocked: the website access policy disallows other.example.");
    expect(requested).toEqual(["https://example.com/bot"]);
  });

  it("maps an impersonation timeout to the fetch timeout message", async () => {
    const result = await fetchUrlRaw("https://example.com/bot", {
      transport: "direct-first",
      seams: {
        resolve: async () => okResolve(),
        request: async () => forbidden(),
        impersonate: async () => {
          throw new Error("timed out");
        },
      },
    });
    expect(result.error).toBe("Failed to fetch URL: timed out.");
  });

  it("marks an impersonated body cut at the download cap", async () => {
    const result = await fetchUrlRaw("https://example.com/bot", {
      maxBytes: 20,
      transport: "direct-first",
      seams: {
        resolve: async () => okResolve(),
        request: async () => forbidden(),
        impersonate: async () => ({ ...impersonated("a".repeat(20)), truncated: true }),
      },
    });
    expect(result.body).toContain("a".repeat(20));
    expect(result.body).toContain("(page truncated at the download limit)");
  });

  it("converts an impersonated html body through the page pipeline", async () => {
    const out = await fetchPageText("https://github.com/unslothai/unsloth", {
      transport: "direct-first",
      seams: {
        resolve: async () => okResolve(),
        request: async () => forbidden(),
        impersonate: async () => impersonated(GITHUB_PAGE),
      },
      rawFetch: undefined,
    });
    expect(out).toContain("Unsloth Studio");
    expect(out).not.toContain("<html");
  });
});

describe("tls-first transport", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the impersonated transport for the first request", async () => {
    let directCalls = 0;
    const result = await fetchUrlRaw("https://example.com/page", {
      seams: {
        resolve: async () => okResolve(),
        request: async () => {
          directCalls++;
          return { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("direct body") };
        },
        impersonate: async () => impersonated("<html><body>primary content</body></html>"),
      },
    });
    expect(result.error).toBeNull();
    expect(result.body).toContain("primary content");
    expect(directCalls).toBe(0);
  });

  it("falls back to the direct transport when the primary transport fails", async () => {
    let directCalls = 0;
    const result = await fetchUrlRaw("https://example.com/page", {
      seams: {
        resolve: async () => okResolve(),
        request: async () => {
          directCalls++;
          return { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("fallback body") };
        },
        impersonate: async () => {
          throw new Error("connection reset by peer");
        },
      },
    });
    expect(result.error).toBeNull();
    expect(result.body).toBe("fallback body");
    expect(directCalls).toBe(1);
  });

  it("retries a 403 from the primary transport through the direct transport", async () => {
    const result = await fetchUrlRaw("https://example.com/page", {
      seams: {
        resolve: async () => okResolve(),
        request: async () => ({ status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("direct rescue") }),
        impersonate: async () => ({ ...impersonated(BOT_WALL), status: 403 }),
      },
    });
    expect(result.error).toBeNull();
    expect(result.body).toBe("direct rescue");
  });

  it("reports cancellation from the primary transport without falling back", async () => {
    let directCalls = 0;
    const result = await fetchUrlRaw("https://example.com/page", {
      seams: {
        resolve: async () => okResolve(),
        request: async () => {
          directCalls++;
          return { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("direct body") };
        },
        impersonate: async () => {
          throw new Error("cancelled");
        },
      },
    });
    expect(result.error).toBe("Failed to fetch URL: cancelled.");
    expect(directCalls).toBe(0);
  });

  it("uses the direct transport when the impersonation module is missing", async () => {
    const result = await fetchUrlRaw("https://example.com/page", {
      seams: {
        resolve: async () => okResolve(),
        request: async () => ({ status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("direct body") }),
        impersonate: async () => null,
      },
    });
    expect(result.error).toBeNull();
    expect(result.body).toBe("direct body");
  });

  it("does not bypass a configured socks5 proxy", async () => {
    vi.stubEnv("HTTPS_PROXY", "socks5://127.0.0.1:9");
    let impersonateCalls = 0;
    const result = await fetchUrlRaw("https://example.com/page", {
      seams: {
        resolve: async () => okResolve(),
        request: async () => ({ status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("proxied body") }),
        impersonate: async () => {
          impersonateCalls++;
          return impersonated("leaked body");
        },
      },
    });
    expect(result.error).toBeNull();
    expect(result.body).toBe("proxied body");
    expect(impersonateCalls).toBe(0);
  });
});
