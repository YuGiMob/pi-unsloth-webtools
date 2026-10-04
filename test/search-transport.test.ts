import { afterEach, describe, expect, it, vi } from "vitest";
import { autoTextSearch, EmptySweepError, SearchTimeoutError } from "../engines.ts";
import { ddgSearch, webSearch, type SearchClient } from "../web-search.ts";
import type { TlsHopOptions, TlsHopResponse } from "../tls-fetch.ts";

const DDG_URL = "https://html.duckduckgo.com/html/";
const EMPTY_PAGE = "<html><body></body></html>";

function ddgPage(count: number): string {
  return Array.from(
    { length: count },
    (_, i) =>
      `<div class="result"><div class="body"><h2><a href="https://example-${i}.com/${i}">Result ${i}</a></h2><a href="https://example-${i}.com/${i}">Snippet ${i}.</a></div></div>`,
  ).join("");
}

function tlsResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): TlsHopResponse {
  return { status, headers, body: Buffer.from(body), truncated: false };
}

function impersonationStub(handler: (options: TlsHopOptions) => TlsHopResponse | null) {
  const calls: TlsHopOptions[] = [];
  return {
    calls,
    impersonate: async (options: TlsHopOptions) => {
      calls.push(options);
      return handler(options);
    },
  };
}

function directStub(handler: (url: string) => Response) {
  const calls: string[] = [];
  const run = async (url: string | URL | Request) => {
    calls.push(String(url));
    return handler(String(url));
  };
  return { calls, run };
}

function emptyResult(url: string): Response {
  return new Response(url === DDG_URL ? ddgPage(5) : EMPTY_PAGE, { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("engine transport selection", () => {
  it("routes engine requests through the impersonated transport first", async () => {
    const { calls, impersonate } = impersonationStub((options) =>
      tlsResponse(options.url.toString() === DDG_URL ? ddgPage(5) : EMPTY_PAGE),
    );
    const direct = directStub(() => new Response(EMPTY_PAGE, { status: 200 }));
    vi.stubGlobal("fetch", direct.run);
    const results = await autoTextSearch("cat", 5, 10_000, undefined, {
      transport: "tls-first",
      impersonate,
    });
    expect(results.length).toBe(5);
    expect(direct.calls).toEqual([]);
    expect(calls.some((call) => call.url.toString() === DDG_URL)).toBe(true);
  });

  it("keeps the plain transport when no impersonation is requested", async () => {
    const { calls, impersonate } = impersonationStub(() => tlsResponse(ddgPage(5)));
    const direct = directStub(emptyResult);
    vi.stubGlobal("fetch", direct.run);
    const results = await autoTextSearch("cat", 5, 10_000, undefined, { impersonate });
    expect(results.length).toBe(5);
    expect(calls).toEqual([]);
    expect(direct.calls).toContain(DDG_URL);
  });

  it("falls back to the plain transport when the impersonation module is unavailable", async () => {
    const { impersonate } = impersonationStub(() => null);
    const direct = directStub(emptyResult);
    vi.stubGlobal("fetch", direct.run);
    const results = await autoTextSearch("cat", 5, 10_000, undefined, {
      transport: "tls-first",
      impersonate,
    });
    expect(results.length).toBe(5);
    expect(direct.calls).toContain(DDG_URL);
  });

  it("falls back to the plain transport when the impersonated request fails", async () => {
    const impersonate = async () => {
      throw new Error("connection reset by peer");
    };
    const direct = directStub(emptyResult);
    vi.stubGlobal("fetch", direct.run);
    const results = await autoTextSearch("cat", 5, 10_000, undefined, {
      transport: "tls-first",
      impersonate,
    });
    expect(results.length).toBe(5);
    expect(direct.calls).toContain(DDG_URL);
  });

  it("retries a refused impersonated request through the plain transport", async () => {
    const { impersonate } = impersonationStub(() => tlsResponse("blocked", 403));
    const direct = directStub(emptyResult);
    vi.stubGlobal("fetch", direct.run);
    const results = await autoTextSearch("cat", 5, 10_000, undefined, {
      transport: "tls-first",
      impersonate,
    });
    expect(results.length).toBe(5);
    expect(direct.calls).toContain(DDG_URL);
  });

  it("retries a refused direct request through the impersonated transport", async () => {
    const { calls, impersonate } = impersonationStub((options) =>
      tlsResponse(options.url.toString() === DDG_URL ? ddgPage(5) : EMPTY_PAGE),
    );
    const direct = directStub(() => new Response("blocked", { status: 403 }));
    vi.stubGlobal("fetch", direct.run);
    const results = await autoTextSearch("cat", 5, 10_000, undefined, {
      transport: "direct-first",
      impersonate,
    });
    expect(results.length).toBe(5);
    expect(calls.some((call) => call.url.toString() === DDG_URL)).toBe(true);
  });

  it("falls back to the plain transport for a truncated impersonated body", async () => {
    const { impersonate } = impersonationStub((options) =>
      options.url.toString() === DDG_URL
        ? { ...tlsResponse(ddgPage(5)), truncated: true }
        : tlsResponse(EMPTY_PAGE),
    );
    const direct = directStub(emptyResult);
    vi.stubGlobal("fetch", direct.run);
    const results = await autoTextSearch("cat", 5, 10_000, undefined, {
      transport: "tls-first",
      impersonate,
    });
    expect(results.length).toBe(5);
    expect(direct.calls).toContain(DDG_URL);
  });

  it("treats a timed-out impersonated request as a timeout without falling back", async () => {
    const impersonate = async () => {
      throw new Error("timed out");
    };
    const direct = directStub(emptyResult);
    vi.stubGlobal("fetch", direct.run);
    await expect(
      autoTextSearch("cat", 5, 10_000, undefined, { transport: "tls-first", impersonate }),
    ).rejects.toThrow(SearchTimeoutError);
    expect(direct.calls).toEqual([]);
  });

  it("keeps the direct path when a socks5 proxy is configured", async () => {
    vi.stubEnv("HTTPS_PROXY", "socks5://127.0.0.1:9");
    const { calls, impersonate } = impersonationStub(() => tlsResponse(ddgPage(5)));
    const direct = directStub(emptyResult);
    vi.stubGlobal("fetch", direct.run);
    const results = await autoTextSearch("cat", 5, 10_000, undefined, {
      transport: "tls-first",
      impersonate,
    });
    expect(results.length).toBe(5);
    expect(calls).toEqual([]);
  });

  it("uses the impersonated transport by default through ddgSearch", async () => {
    const { impersonate } = impersonationStub((options) =>
      tlsResponse(options.url.toString() === DDG_URL ? ddgPage(5) : EMPTY_PAGE),
    );
    const direct = directStub(() => new Response(EMPTY_PAGE, { status: 200 }));
    vi.stubGlobal("fetch", direct.run);
    const results = await ddgSearch("cat", 5, undefined, 10_000, { impersonate });
    expect(results.length).toBe(5);
    expect(direct.calls).toEqual([]);
  });
});

describe("engine redirect handling", () => {
  it("follows an allowed redirect and converts a posted redirect to a get", async () => {
    const { calls, impersonate } = impersonationStub((options) => {
      const url = options.url.toString();
      if (url === DDG_URL) return tlsResponse("", 301, { location: "/redirected" });
      if (url === "https://html.duckduckgo.com/redirected") return tlsResponse(ddgPage(5));
      return tlsResponse(EMPTY_PAGE);
    });
    const direct = directStub(() => new Response(EMPTY_PAGE, { status: 200 }));
    vi.stubGlobal("fetch", direct.run);
    const results = await autoTextSearch("cat", 5, 10_000, undefined, {
      transport: "tls-first",
      impersonate,
    });
    expect(results.length).toBe(5);
    const initial = calls.find((call) => call.url.toString() === DDG_URL);
    expect(initial?.method).toBe("POST");
    expect(String(initial?.body)).toContain("q=cat");
    const followed = calls.find((call) => call.url.toString().endsWith("/redirected"));
    expect(followed?.method).toBe("GET");
    expect(followed?.body).toBeUndefined();
  });

  it("refuses a redirect the website policy disallows", async () => {
    const { calls, impersonate } = impersonationStub((options) =>
      options.url.toString() === DDG_URL
        ? tlsResponse("", 302, { location: "https://evil.example/landing" })
        : tlsResponse(EMPTY_PAGE),
    );
    const direct = directStub(() => {
      throw new Error("direct fetch must not run");
    });
    vi.stubGlobal("fetch", direct.run);
    const policy = { allowedDomains: ["duckduckgo.com"], blockedDomains: [] };
    await expect(
      autoTextSearch("cat", 5, 10_000, undefined, { transport: "tls-first", policy, impersonate }),
    ).rejects.toThrow(EmptySweepError);
    expect(calls.every((call) => !call.url.toString().includes("evil.example"))).toBe(true);
    expect(direct.calls).toEqual([]);
  });

  it("refuses a redirect to a private address literal", async () => {
    const { calls, impersonate } = impersonationStub((options) =>
      options.url.toString() === DDG_URL
        ? tlsResponse("", 302, { location: "http://127.0.0.1/" })
        : tlsResponse(EMPTY_PAGE),
    );
    const direct = directStub(() => new Response(EMPTY_PAGE, { status: 200 }));
    vi.stubGlobal("fetch", direct.run);
    await expect(
      autoTextSearch("cat", 5, 10_000, undefined, { transport: "tls-first", impersonate }),
    ).rejects.toThrow(EmptySweepError);
    expect(calls.every((call) => !call.url.toString().includes("127.0.0.1"))).toBe(true);
    expect(direct.calls).toEqual([]);
  });
});

describe("search client options", () => {
  it("forwards the transport and website policy to the search client", async () => {
    const seen: unknown[] = [];
    const client: SearchClient = async (_query, _maxResults, _signal, _timeoutMs, options) => {
      seen.push(options);
      return [];
    };
    const policy = { allowedDomains: ["arxiv.org"], blockedDomains: [] };
    await webSearch("q", { transport: "off", websitePolicy: policy, client });
    expect(seen).toEqual([{ transport: "off", policy }]);
  });
});
