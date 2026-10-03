import { describe, expect, it } from "vitest";
import { impersonatedRequest, type ImpersonationLoader } from "../tls-fetch.ts";

function streamOf(...chunks: string[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const chunk of chunks) yield Buffer.from(chunk, "utf-8");
  })();
}

interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: AsyncIterable<Uint8Array> | null;
  throwError?: Error;
}

function fakeLoader(
  handler: (url: string, init: Record<string, unknown>) => FakeResponse,
  onTransport?: () => void,
): ImpersonationLoader {
  return async () => ({
    createTransport: async () => {
      onTransport?.();
      return { close: async () => {} };
    },
    fetch: async (url: string, init: Record<string, unknown>) => {
      const spec = handler(url, init);
      if (spec.throwError) throw spec.throwError;
      const headers = spec.headers ?? {};
      return {
        status: spec.status ?? 200,
        url,
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
        body: spec.body === undefined ? null : spec.body,
      };
    },
  });
}

function hostnameFor(name: string): URL {
  return new URL(`https://${name}/page`);
}

describe("impersonatedRequest", () => {
  it("returns null when the impersonation module is unavailable", async () => {
    const result = await impersonatedRequest({
      url: hostnameFor("missing.example"),
      pinnedIp: "93.184.216.34",
      family: 4,
      timeoutMs: 5000,
      maxBytes: 1024,
      loader: async () => null,
    });
    expect(result).toBeNull();
  });

  it("returns the status, body and content-type", async () => {
    const result = await impersonatedRequest({
      url: hostnameFor("ok.example"),
      pinnedIp: "93.184.216.34",
      family: 4,
      timeoutMs: 5000,
      maxBytes: 1024,
      loader: fakeLoader(() => ({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: streamOf("<html>", "<body>hi</body></html>"),
      })),
    });
    expect(result).toMatchObject({ status: 200, truncated: false });
    expect(result?.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(result?.body.toString("utf-8")).toBe("<html><body>hi</body></html>");
  });

  it("pins the resolved address in the transport", async () => {
    let transportOptions: Record<string, unknown> | null = null;
    const loader: ImpersonationLoader = async () => ({
      createTransport: async (options) => {
        transportOptions = options;
        return {};
      },
      fetch: async () => ({ status: 200, url: "", headers: { get: () => null }, body: null }),
    });
    await impersonatedRequest({
      url: hostnameFor("pinned.example"),
      pinnedIp: "203.0.113.7",
      family: 4,
      timeoutMs: 5000,
      maxBytes: 1024,
      loader,
    });
    expect(transportOptions).toMatchObject({
      resolve: { "pinned.example": "203.0.113.7" },
      browser: "chrome_145",
    });
  });

  it("reuses one transport per host, address and profile", async () => {
    let created = 0;
    const loader = fakeLoader(
      () => ({ status: 200, body: streamOf("a") }),
      () => created++,
    );
    const options = {
      url: hostnameFor("reuse.example"),
      pinnedIp: "93.184.216.34",
      family: 4,
      timeoutMs: 5000,
      maxBytes: 1024,
      loader,
    };
    await impersonatedRequest(options);
    await impersonatedRequest(options);
    expect(created).toBe(1);
  });

  it("passes redirects through with their location header", async () => {
    const result = await impersonatedRequest({
      url: hostnameFor("redirect.example"),
      pinnedIp: "93.184.216.34",
      family: 4,
      timeoutMs: 5000,
      maxBytes: 1024,
      loader: fakeLoader(() => ({ status: 302, headers: { location: "https://elsewhere.example/" } })),
    });
    expect(result).toMatchObject({ status: 302 });
    expect(result?.headers.location).toBe("https://elsewhere.example/");
  });

  it("requests manual redirect handling and drops emulation-conflicting headers", async () => {
    let seen: Record<string, unknown> = {};
    await impersonatedRequest({
      url: hostnameFor("headers.example"),
      pinnedIp: "93.184.216.34",
      family: 4,
      timeoutMs: 5000,
      maxBytes: 1024,
      extraHeaders: { Host: "evil.example", "User-Agent": "spoofed", "Accept-Encoding": "gzip", "X-Keep": "yes" },
      loader: fakeLoader((_url, init) => {
        seen = init;
        return { status: 200 };
      }),
    });
    expect(seen.redirect).toBe("manual");
    expect(seen.headers).toEqual({ "X-Keep": "yes" });
  });

  it("caps the body and marks it truncated", async () => {
    const result = await impersonatedRequest({
      url: hostnameFor("cap.example"),
      pinnedIp: "93.184.216.34",
      family: 4,
      timeoutMs: 5000,
      maxBytes: 10,
      loader: fakeLoader(() => ({ status: 200, body: streamOf("a".repeat(50)) })),
    });
    expect(result?.truncated).toBe(true);
    expect(result?.body.length).toBe(10);
  });

  it("does not mark a body that ends exactly at the cap", async () => {
    const result = await impersonatedRequest({
      url: hostnameFor("exact.example"),
      pinnedIp: "93.184.216.34",
      family: 4,
      timeoutMs: 5000,
      maxBytes: 10,
      loader: fakeLoader(() => ({ status: 200, body: streamOf("a".repeat(10)) })),
    });
    expect(result?.truncated).toBe(false);
    expect(result?.body.length).toBe(10);
  });

  it("maps a caller abort to a cancellation error", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      impersonatedRequest({
        url: hostnameFor("abort.example"),
        pinnedIp: "93.184.216.34",
        family: 4,
        timeoutMs: 5000,
        maxBytes: 1024,
        signal: controller.signal,
        loader: fakeLoader(() => {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }),
      }),
    ).rejects.toThrow("cancelled");
  });

  it("maps an elapsed budget to a timeout error", async () => {
    await expect(
      impersonatedRequest({
        url: hostnameFor("timeout.example"),
        pinnedIp: "93.184.216.34",
        family: 4,
        timeoutMs: 5,
        maxBytes: 1024,
        loader: fakeLoader(
          () =>
            ({
              throwError: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
            }) as unknown as FakeResponse,
        ),
      }),
    ).rejects.toThrow("timed out");
  });

  it("surfaces native request errors unchanged", async () => {
    await expect(
      impersonatedRequest({
        url: hostnameFor("failure.example"),
        pinnedIp: "93.184.216.34",
        family: 4,
        timeoutMs: 5000,
        maxBytes: 1024,
        loader: fakeLoader(() => ({ throwError: new Error("connection reset by peer") })),
      }),
    ).rejects.toThrow("connection reset by peer");
  });

  it("ignores an opaque response", async () => {
    const result = await impersonatedRequest({
      url: hostnameFor("opaque.example"),
      pinnedIp: "93.184.216.34",
      family: 4,
      timeoutMs: 5000,
      maxBytes: 1024,
      loader: fakeLoader(() => ({ status: 0 })),
    });
    expect(result).toBeNull();
  });
});

describe("impersonated pdf budget", () => {
  const pdfBody = Buffer.concat([
    Buffer.from("%PDF-1.4\n"),
    Buffer.from("stream content padding ".repeat(40)),
  ]);

  it("extends the cap for a pdf body", async () => {
    const result = await impersonatedRequest({
      url: hostnameFor("pdf-budget.example"),
      pinnedIp: "93.184.216.34",
      family: 4,
      timeoutMs: 5000,
      maxBytes: 64,
      maxPdfBytes: 64 * 1024,
      loader: fakeLoader(() => ({
        status: 200,
        body: (async function* () {
          yield pdfBody;
        })(),
      })),
    });
    expect(result?.truncated).toBe(false);
    expect(result?.body.length).toBe(pdfBody.length);
  });

  it("keeps the text cap for a non-pdf body", async () => {
    const text = Buffer.from("plain text body ".repeat(40));
    const result = await impersonatedRequest({
      url: hostnameFor("text-budget.example"),
      pinnedIp: "93.184.216.34",
      family: 4,
      timeoutMs: 5000,
      maxBytes: 64,
      maxPdfBytes: 64 * 1024,
      loader: fakeLoader(() => ({
        status: 200,
        body: (async function* () {
          yield text;
        })(),
      })),
    });
    expect(result?.truncated).toBe(true);
    expect(result?.body.length).toBe(64);
  });

  it("sees a pdf behind a leading bom and whitespace", async () => {
    const withPrefix = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0x20]), pdfBody]);
    const result = await impersonatedRequest({
      url: hostnameFor("pdf-prefix.example"),
      pinnedIp: "93.184.216.34",
      family: 4,
      timeoutMs: 5000,
      maxBytes: 64,
      maxPdfBytes: 64 * 1024,
      loader: fakeLoader(() => ({
        status: 200,
        body: (async function* () {
          yield withPrefix;
        })(),
      })),
    });
    expect(result?.truncated).toBe(false);
    expect(result?.body.length).toBe(withPrefix.length);
  });
});
