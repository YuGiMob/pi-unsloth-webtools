import { describe, expect, it } from "vitest";
import { fetchPageText, fetchUrlRaw } from "../web-fetch.ts";
import { isPublicIp } from "../web-access.ts";
import { seamWithResponse } from "./helpers.ts";

describe("ssrf ip guard", () => {
  it("blocks unspecified and mapped loopback forms", () => {
    expect(isPublicIp("0.0.0.0")).toBe(false);
    expect(isPublicIp("::")).toBe(false);
    expect(isPublicIp("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicIp("::ffff:8.8.8.8")).toBe(false);
    expect(isPublicIp("0:0:0:0:0:ffff:7f00:1")).toBe(false);
  });

  it("blocks scoped and zero-padded non-public forms", () => {
    expect(isPublicIp("fe80::1%eth0")).toBe(false);
    expect(isPublicIp("0000:0000:0000:0000:0000:0000:0000:0001")).toBe(false);
    expect(isPublicIp("0000:0000:0000:0000:0000:0000:0000:0000")).toBe(false);
  });

  it("propagates a blocked resolution", async () => {
    const result = await fetchUrlRaw("https://example.com/", {
      seams: {
        resolve: async () => ({ ok: false, reason: "Blocked: refusing to fetch the non-public address 127.0.0.1.", ip: "", family: 0 }),
        request: async () => {
          throw new Error("request must not run after a blocked resolve");
        },
      },
    });
    expect(result.error).toContain("Blocked:");
  });

  it("blocks redirects that resolve to non-public addresses", async () => {
    const requested: string[] = [];
    const result = await fetchUrlRaw("https://example.com/start", {
      seams: {
        resolve: async (hostname) => {
          if (hostname === "127.0.0.1") {
            return { ok: false, reason: "Blocked: refusing to fetch the non-public address 127.0.0.1.", ip: "", family: 0 };
          }
          return { ok: true, reason: "", ip: "93.184.216.34", family: 4 };
        },
        request: async (opts) => {
          requested.push(opts.url.toString());
          return { status: 302, headers: { location: "http://127.0.0.1/" }, body: Buffer.alloc(0) };
        },
      },
    });
    expect(result.error).toContain("Blocked:");
    expect(requested).toHaveLength(1);
  });
});

describe("request header guard", () => {
  it("never lets extraHeaders override Host", async () => {
    let seenHost = "";
    const result = await fetchUrlRaw("https://example.com:8443/path", {
      extraHeaders: { Host: "evil.example", host: "evil2.example", "X-Keep": "yes" },
      seams: {
        resolve: async () => ({ ok: true, reason: "", ip: "93.184.216.34", family: 4 }),
        request: async (opts) => {
          seenHost = opts.headers["Host"] ?? opts.headers["host"] ?? "";
          expect(opts.headers["X-Keep"]).toBe("yes");
          expect(opts.headers["host"]).toBeUndefined();
          return { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("hi") };
        },
      },
    });
    expect(result.error).toBeNull();
    expect(seenHost).toBe("example.com:8443");
  });
});

describe("wayback snapshot guard", () => {
  it("refuses a snapshot url that fails access checks", async () => {
    const fetched: string[] = [];
    const out = await fetchPageText("https://example.com/gone", {
      rawFetch: async (url) => {
        fetched.push(url);
        if (url.includes("archive.org/wayback/available")) {
          return {
            error: null,
            body: JSON.stringify({
              archived_snapshots: {
                closest: { available: true, url: "http://169.254.169.254/latest/meta-data", timestamp: "20200102030405", status: "200" },
              },
            }),
            contentType: "application/json",
          };
        }
        return { error: "Failed to fetch URL: HTTP 404 Not Found", body: "", contentType: "" };
      },
    });
    expect(out).toBe("Failed to fetch URL: HTTP 404 Not Found");
    expect(fetched.some((url) => url.includes("169.254.169.254"))).toBe(false);
  });

  it("still follows a public snapshot url", async () => {
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
        if (url.includes("web.archive.org")) {
          return { error: null, body: "archived copy", contentType: "text/plain" };
        }
        return { error: "Failed to fetch URL: HTTP 404 Not Found", body: "", contentType: "" };
      },
    });
    expect(out).toContain("archived copy");
  });

  it("keeps serving text when the resolver reports a public address", async () => {
    const out = await fetchPageText("https://example.com/", {
      timeoutMs: 5000,
      seams: seamWithResponse(Buffer.from("hello"), "text/plain"),
    });
    expect(out).toBe("hello");
  });
});
