import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPageText } from "../web-render.ts";
import { loadJinaApiKey } from "../settings.ts";

const { dnsLookupMock } = vi.hoisted(() => ({ dnsLookupMock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dnsLookupMock }));

const PUBLIC = [{ address: "93.184.216.34", family: 4 }];

function jinaResponse(payload: unknown, status = 200, statusText?: string): Response {
  return new Response(JSON.stringify(payload), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  dnsLookupMock.mockReset();
});

describe("renderPageText", () => {
  it("renders jina json with title, url, provenance and content", async () => {
    dnsLookupMock.mockResolvedValue(PUBLIC);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jinaResponse({ data: { title: "Example Page", url: "https://example.com/final", content: "# Hello\n\nBody." } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await renderPageText("https://example.com/page");
    expect(out).toContain("Title: Example Page");
    expect(out).toContain("URL: https://example.com/final");
    expect(out).toContain("Rendered via the Jina Reader (r.jina.ai).");
    expect(out).toContain("# Hello");
    const [target, init] = fetchMock.mock.calls[0];
    expect(target).toBe("https://r.jina.ai/" + encodeURIComponent("https://example.com/page"));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Accept).toBe("application/json");
  });

  it("normalizes bare hosts and falls back to the requested url", async () => {
    dnsLookupMock.mockResolvedValue(PUBLIC);
    vi.stubGlobal("fetch", vi.fn(async () => jinaResponse({ data: { content: "Body." } })));
    const out = await renderPageText("example.com/page");
    expect(out).toContain("URL: https://example.com/page");
    expect(out).not.toContain("Title:");
  });

  it("sends the bearer token when an api key is configured", async () => {
    dnsLookupMock.mockResolvedValue(PUBLIC);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jinaResponse({ data: { content: "Body." } }));
    vi.stubGlobal("fetch", fetchMock);
    await renderPageText("https://example.com/", { apiKey: " secret " });
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret");
  });

  it("omits the bearer token without an api key", async () => {
    dnsLookupMock.mockResolvedValue(PUBLIC);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jinaResponse({ data: { content: "Body." } }));
    vi.stubGlobal("fetch", fetchMock);
    await renderPageText("https://example.com/");
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("refuses local files and paths before any network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const target of ["file:///tmp/page.html", "/etc/hosts", "~/notes.txt", "./page.html"]) {
      expect(await renderPageText(target)).toBe("Blocked: the Jina Reader cannot fetch local files.");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dnsLookupMock).not.toHaveBeenCalled();
  });

  it("refuses non-public resolved addresses", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const cases: [string, string, number][] = [
      ["localhost", "127.0.0.1", 4],
      ["[::1]", "::1", 6],
      ["router.lan", "192.168.1.1", 4],
      ["169.254.169.254", "169.254.169.254", 4],
    ];
    for (const [host, address, family] of cases) {
      dnsLookupMock.mockResolvedValue([{ address, family }]);
      const out = await renderPageText(`http://${host}/`);
      expect(out.startsWith("Blocked: refusing to fetch the non-public address")).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies resolution failures as render failures", async () => {
    dnsLookupMock.mockRejectedValue(
      Object.assign(new Error("getaddrinfo ENOTFOUND example.com"), { code: "ENOTFOUND" }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await renderPageText("https://example.com/");
    expect(out.startsWith("Failed to render URL:")).toBe(true);
    expect(out).toContain("Failed to resolve host");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces the website policy before resolving", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await renderPageText("https://example.com/", {
      websitePolicy: { allowedDomains: ["docs.example.com"], blockedDomains: [] },
    });
    expect(out).toBe("Blocked: the website access policy disallows example.com.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dnsLookupMock).not.toHaveBeenCalled();
  });

  it("truncates rendered content at maxChars", async () => {
    dnsLookupMock.mockResolvedValue(PUBLIC);
    vi.stubGlobal("fetch", vi.fn(async () => jinaResponse({ data: { content: "x".repeat(500) } })));
    const out = await renderPageText("https://example.com/", { maxChars: 100 });
    expect(out).toContain("(truncated,");
  });

  it("reports pages without readable content", async () => {
    dnsLookupMock.mockResolvedValue(PUBLIC);
    vi.stubGlobal("fetch", vi.fn(async () => jinaResponse({ data: { content: "   " } })));
    expect(await renderPageText("https://example.com/")).toBe("(page returned no readable text)");
  });

  it("reports a missing data envelope", async () => {
    dnsLookupMock.mockResolvedValue(PUBLIC);
    vi.stubGlobal("fetch", vi.fn(async () => jinaResponse({ code: 200 })));
    expect(await renderPageText("https://example.com/")).toBe(
      "Failed to render URL: the Jina Reader returned no content.",
    );
  });

  it("surfaces jina error details", async () => {
    dnsLookupMock.mockResolvedValue(PUBLIC);
    vi.stubGlobal("fetch", vi.fn(async () => jinaResponse({ message: "Invalid API key" }, 401)));
    expect(await renderPageText("https://example.com/")).toBe("Failed to render URL: 401 Invalid API key");
  });

  it("reports a non-json error response with its status", async () => {
    dnsLookupMock.mockResolvedValue(PUBLIC);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gateway", { status: 502, statusText: "Bad Gateway" })));
    expect(await renderPageText("https://example.com/")).toBe("Failed to render URL: 502 Bad Gateway");
  });

  it("reports a non-json success response", async () => {
    dnsLookupMock.mockResolvedValue(PUBLIC);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })),
    );
    const out = await renderPageText("https://example.com/");
    expect(out).toContain("non-JSON response (HTTP 200)");
  });

  it("times out a slow reader call", async () => {
    dnsLookupMock.mockResolvedValue(PUBLIC);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("The operation timed out.", "TimeoutError")),
              { once: true },
            );
          }),
      ),
    );
    expect(await renderPageText("https://example.com/", { timeoutMs: 30 })).toBe("Failed to render URL: timed out.");
  });

  it("reports cancellation before dispatch", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await renderPageText("https://example.com/", { signal: controller.signal })).toBe(
      "Failed to render URL: cancelled.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports cancellation during the reader call", async () => {
    dnsLookupMock.mockResolvedValue(PUBLIC);
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
              once: true,
            });
            setTimeout(() => controller.abort(), 10);
          }),
      ),
    );
    expect(await renderPageText("https://example.com/", { signal: controller.signal })).toBe(
      "Failed to render URL: cancelled.",
    );
  });

  it("refuses an empty url", async () => {
    expect(await renderPageText("   ")).toBe("Blocked: the URL is empty.");
  });
});

describe("jina api key settings", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousKey = process.env.JINA_API_KEY;

  afterEach(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousKey === undefined) delete process.env.JINA_API_KEY;
    else process.env.JINA_API_KEY = previousKey;
  });

  it("prefers the settings key over the environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-unsloth-jina-"));
    try {
      await writeFile(join(root, "settings.json"), JSON.stringify({ unslothWebTools: { jinaApiKey: " from-settings " } }));
      process.env.PI_CODING_AGENT_DIR = root;
      process.env.JINA_API_KEY = "from-env";
      expect(await loadJinaApiKey()).toBe("from-settings");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-unsloth-jina-"));
    try {
      process.env.PI_CODING_AGENT_DIR = root;
      process.env.JINA_API_KEY = " from-env ";
      expect(await loadJinaApiKey()).toBe("from-env");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads the webRender alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-unsloth-jina-"));
    try {
      await writeFile(join(root, "settings.json"), JSON.stringify({ webRender: { jinaApiKey: "alias-key" } }));
      process.env.PI_CODING_AGENT_DIR = root;
      delete process.env.JINA_API_KEY;
      expect(await loadJinaApiKey()).toBe("alias-key");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});