import { describe, expect, it } from "vitest";
import {
  checkUrlAccess,
  githubRepoRawReadmeUrl,
  githubRepoReadmeApiUrl,
  hostnameAllowed,
  isPublicIp,
  normalizeDomain,
  normalizeUrlScheme,
  scopeSearchQuery,
  websitePolicyPrompt,
} from "../web-access.ts";
import { truncatePageText } from "../web-fetch.ts";

describe("normalizeUrlScheme", () => {
  it("rewrites bare hosts to https", () => {
    expect(normalizeUrlScheme("google.com")).toBe("https://google.com");
    expect(normalizeUrlScheme("www.google.com/x")).toBe("https://www.google.com/x");
    expect(normalizeUrlScheme("//google.com")).toBe("https://google.com");
    expect(normalizeUrlScheme("https://google.com")).toBe("https://google.com");
    expect(normalizeUrlScheme("http://google.com")).toBe("http://google.com");
    expect(normalizeUrlScheme("example.com:8443/path")).toBe("https://example.com:8443/path");
    expect(normalizeUrlScheme("example.com:8443")).toBe("https://example.com:8443");
    expect(normalizeUrlScheme("sub.example.co.uk:8080")).toBe("https://sub.example.co.uk:8080");
  });

  it("leaves real schemes and invalid forms untouched", () => {
    expect(normalizeUrlScheme("ftp://x.com")).toBe("ftp://x.com");
    expect(normalizeUrlScheme("file:///etc/passwd")).toBe("file:///etc/passwd");
    expect(normalizeUrlScheme("javascript:alert(1)")).toBe("javascript:alert(1)");
    expect(normalizeUrlScheme("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(normalizeUrlScheme("file:80")).toBe("file:80");
    expect(normalizeUrlScheme("javascript:443/path")).toBe("javascript:443/path");
    expect(normalizeUrlScheme("/login")).toBe("/login");
    expect(normalizeUrlScheme("example.com:99999")).toBe("example.com:99999");
    expect(normalizeUrlScheme("example.com:abc")).toBe("example.com:abc");
  });
});

describe("checkUrlAccess", () => {
  it("rejects empty urls", () => {
    const [allowed, reason] = checkUrlAccess("", null);
    expect(allowed).toBe(false);
    expect(reason).toBe("Blocked: the URL is empty.");
  });

  it("rejects invalid characters", () => {
    const [allowed, reason] = checkUrlAccess("https://exa mple.com", null);
    expect(allowed).toBe(false);
    expect(reason).toBe("Blocked: the URL contains invalid characters.");
    const [allowed2] = checkUrlAccess("https://example.com\\evil", null);
    expect(allowed2).toBe(false);
  });

  it("rejects non-http schemes", () => {
    const [allowed, reason] = checkUrlAccess("ftp://x.com", null);
    expect(allowed).toBe(false);
    expect(reason).toBe("Blocked: only http/https URLs are allowed.");
  });

  it("rejects credentials and encoded hosts", () => {
    const [allowed, reason] = checkUrlAccess("https://user:pass@example.com", null);
    expect(allowed).toBe(false);
    expect(reason).toBe("Blocked: URLs with credentials or encoded hostnames are not allowed.");
  });

  it("accepts plain https urls", () => {
    const [allowed, , hostname] = checkUrlAccess("https://example.com/path", null);
    expect(allowed).toBe(true);
    expect(hostname).toBe("example.com");
  });

  it("enforces website policies", () => {
    const policy = { allowedDomains: ["docs.example.com"], blockedDomains: ["bad.example.com"] };
    expect(checkUrlAccess("https://docs.example.com/x", policy)[0]).toBe(true);
    expect(checkUrlAccess("https://sub.docs.example.com/x", policy)[0]).toBe(true);
    expect(checkUrlAccess("https://other.com/x", policy)[0]).toBe(false);
    expect(checkUrlAccess("https://bad.example.com/x", policy)[0]).toBe(false);
  });

  it("fails closed when a policy exceeds the domain cap", () => {
    const overLimit = {
      allowedDomains: Array.from({ length: 101 }, (_, i) => `d${i}.example`),
      blockedDomains: [],
    };
    expect(checkUrlAccess("https://d0.example/x", overLimit)[0]).toBe(false);
    expect(hostnameAllowed("d0.example", overLimit)).toBe(false);
  });
});

describe("normalizeDomain", () => {
  it("lowercases, strips trailing dots and IDNA-encodes", () => {
    expect(normalizeDomain("EXAMPLE.com.")).toBe("example.com");
    expect(normalizeDomain("münchen.de")).toBe("xn--mnchen-3ya.de");
  });

  it("rejects schemes, ports, and weird forms", () => {
    expect(() => normalizeDomain("https://x.com")).toThrow();
    expect(() => normalizeDomain("x.com:443")).toThrow();
    expect(() => normalizeDomain("")).toThrow();
    expect(() => normalizeDomain("0x7f.0.0.1")).toThrow();
  });
});

describe("isPublicIp", () => {
  it("blocks private, loopback, link-local and reserved addresses", () => {
    expect(isPublicIp("127.0.0.1")).toBe(false);
    expect(isPublicIp("10.0.0.5")).toBe(false);
    expect(isPublicIp("192.168.1.1")).toBe(false);
    expect(isPublicIp("172.16.0.1")).toBe(false);
    expect(isPublicIp("169.254.169.254")).toBe(false);
    expect(isPublicIp("100.64.0.1")).toBe(false);
    expect(isPublicIp("0.0.0.0")).toBe(false);
    expect(isPublicIp("224.0.0.1")).toBe(false);
    expect(isPublicIp("::1")).toBe(false);
    expect(isPublicIp("::")).toBe(false);
    expect(isPublicIp("fe80::1")).toBe(false);
    expect(isPublicIp("fc00::1")).toBe(false);
    expect(isPublicIp("fd12::1")).toBe(false);
    expect(isPublicIp("ff02::1")).toBe(false);
    expect(isPublicIp("::ffff:192.168.1.1")).toBe(false);
    expect(isPublicIp("192.88.99.1")).toBe(false);
    expect(isPublicIp("2001:1::1")).toBe(false);
    expect(isPublicIp("2001:1::2")).toBe(false);
    expect(isPublicIp("2001:2::1")).toBe(false);
    expect(isPublicIp("2001:1:0:0:0:0:0:1")).toBe(false);
    expect(isPublicIp("2001:1:0:0:0:0:0:2")).toBe(false);
  });

  it("blocks ipv4-embedding tunnel prefixes", () => {
    expect(isPublicIp("2002:7f00:1::1")).toBe(false);
    expect(isPublicIp("2002:808:808::")).toBe(false);
    expect(isPublicIp("2001:0:4136:e378:8000:63bf:3fff:fdd2")).toBe(false);
    expect(isPublicIp("2001::1")).toBe(false);
  });

  it("blocks ipv4-compatible and long-form mapped forms", () => {
    expect(isPublicIp("::7f00:1")).toBe(false);
    expect(isPublicIp("::c0a8:101")).toBe(false);
    expect(isPublicIp("::a00:1")).toBe(false);
    expect(isPublicIp("0:0:0:0:0:ffff:7f00:1")).toBe(false);
    expect(isPublicIp("0:0:0:0:0:0:0:1")).toBe(false);
  });

  it("blocks all ipv4-mapped forms, even for public addresses", () => {
    expect(isPublicIp("::ffff:8.8.8.8")).toBe(false);
    expect(isPublicIp("0:0:0:0:0:ffff:1.1.1.1")).toBe(false);
    expect(isPublicIp("::ffff:808:808")).toBe(false);
  });

  it("blocks zero-padded spellings that evade run detection", () => {
    expect(isPublicIp("0000:0000:0000:0000:0000:0000:0000:0001")).toBe(false);
    expect(isPublicIp("0000:0000:0000:0000:0000:ffff:7f00:1")).toBe(false);
    expect(isPublicIp("0000:0000:0000:0000:0000:0000:0000:0000")).toBe(false);
  });

  it("accepts public addresses", () => {
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("1.1.1.1")).toBe(true);
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
  });

  it("blocks documentation and TEST-NET ranges", () => {
    expect(isPublicIp("192.0.2.1")).toBe(false);
    expect(isPublicIp("198.51.100.7")).toBe(false);
    expect(isPublicIp("203.0.113.7")).toBe(false);
  });
});

describe("websitePolicyPrompt and scopeSearchQuery", () => {
  it("builds a prompt only when restricted", () => {
    expect(websitePolicyPrompt(null)).toBe("");
    const policy = { allowedDomains: ["a.com"], blockedDomains: ["b.com"] };
    const prompt = websitePolicyPrompt(policy);
    expect(prompt).toContain("a.com");
    expect(prompt).toContain("b.com");
  });

  it("scopes queries with site filters", () => {
    expect(scopeSearchQuery("llama", null)).toBe("llama");
    const policy = { allowedDomains: ["a.com", "b.com"], blockedDomains: [] };
    const scoped = scopeSearchQuery("llama", policy);
    expect(scoped).toContain("site:a.com");
    expect(scoped).toContain("site:b.com");
  });
});

describe("githubRepoReadmeApiUrl", () => {
  it("rewrites repo root pages", () => {
    expect(githubRepoReadmeApiUrl("https://github.com/unslothai/unsloth")).toBe(
      "https://api.github.com/repos/unslothai/unsloth/readme",
    );
    expect(githubRepoReadmeApiUrl("https://github.com/unslothai/unsloth/")).toBe(
      "https://api.github.com/repos/unslothai/unsloth/readme",
    );
    expect(githubRepoReadmeApiUrl("https://github.com/unslothai/unsloth.git")).toBe(
      "https://api.github.com/repos/unslothai/unsloth/readme",
    );
    expect(githubRepoRawReadmeUrl("https://github.com/unslothai/unsloth")).toBe(
      "https://raw.githubusercontent.com/unslothai/unsloth/HEAD/README.md",
    );
    expect(githubRepoRawReadmeUrl("https://github.com/unslothai/unsloth.git")).toBe(
      "https://raw.githubusercontent.com/unslothai/unsloth/HEAD/README.md",
    );
  });

  it("leaves non-repo pages alone", () => {
    for (const url of [
      "https://github.com/unslothai/unsloth/blob/main/README.md",
      "https://github.com/login",
      "https://example.com/unslothai/unsloth",
    ]) {
      expect(githubRepoReadmeApiUrl(url)).toBeNull();
      expect(githubRepoRawReadmeUrl(url)).toBeNull();
    }
  });
});

describe("truncatePageText", () => {
  it("marks truncated pages", () => {
    const text = "x".repeat(300);
    const out = truncatePageText(text, 100);
    expect(out.length).toBeLessThan(200);
    expect(out).toContain("(truncated, 300 chars total)");
  });

  it("keeps the download-cap notice intact when maxChars truncates", () => {
    for (const suffix of [
      "\n\n... (page truncated at the download limit)",
      "... (page truncated at the download limit)",
    ]) {
      const capped = "x".repeat(400) + suffix;
      const out = truncatePageText(capped, 100);
      expect(out).toContain("(page truncated at the download limit)");
      expect(out).toContain(`(truncated, ${capped.length} chars total)`);
    }
  });

  it("returns pages within the budget unchanged", () => {
    expect(truncatePageText("hello", 1000)).toBe("hello");
  });

  it("reports empty pages", () => {
    expect(truncatePageText("", 1000)).toBe("(page returned no readable text)");
  });
});
