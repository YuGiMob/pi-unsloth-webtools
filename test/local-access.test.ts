import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPageText, fetchUrlRaw } from "../web-fetch.ts";
import { loadDefaultFetchSettings } from "../settings.ts";
import { makePdf } from "./helpers.ts";

const { dnsLookupMock } = vi.hoisted(() => ({ dnsLookupMock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dnsLookupMock }));

async function withServer(
  respond: (res: http.ServerResponse) => void,
  run: (port: number) => Promise<void>,
  host = "127.0.0.1",
): Promise<void> {
  const server = http.createServer((_req, res) => respond(res));
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
}

describe("private address fetching", () => {
  it("blocks loopback resolution when opted out", async () => {
    dnsLookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const result = await fetchUrlRaw("http://localhost:3000/", {
      allowPrivateAddresses: false,
      seams: {
        request: async () => {
          throw new Error("request must not run after a blocked resolve");
        },
      },
    });
    expect(result.error).toContain("non-public address 127.0.0.1");
  });

  it("blocks a reachable server when opted out", async () => {
    dnsLookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await withServer(
      (res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("reachable body");
      },
      async (port) => {
        const result = await fetchUrlRaw(`http://localhost:${port}/`, { allowPrivateAddresses: false });
        expect(result.error).toContain("Blocked");
      },
    );
  });

  it("fetches a localhost server by default", async () => {
    dnsLookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await withServer(
      (res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("local dev server body");
      },
      async (port) => {
        const result = await fetchUrlRaw(`http://localhost:${port}/`, {});
        expect(result.error).toBeNull();
        expect(result.body).toBe("local dev server body");
      },
    );
  });

  it("converts a localhost html page through fetchPageText by default", async () => {
    dnsLookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await withServer(
      (res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><head><title>Dev Server</title></head><body><p>Readable local body text.</p></body></html>");
      },
      async (port) => {
        const out = await fetchPageText(`http://localhost:${port}/`, { timeoutMs: 5000 });
        expect(out.startsWith("Title: Dev Server")).toBe(true);
        expect(out).toContain("Readable local body text.");
      },
    );
  });

  it("fetches an ipv6 loopback literal by default", async () => {
    dnsLookupMock.mockResolvedValue([{ address: "::1", family: 6 }]);
    await withServer(
      (res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ipv6 loopback body");
      },
      async (port) => {
        const result = await fetchUrlRaw(`http://[::1]:${port}/`, {});
        expect(result.error).toBeNull();
        expect(result.body).toBe("ipv6 loopback body");
      },
      "::",
    );
  });
});

describe("local file fetching", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-unsloth-local-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("extracts a local pdf", async () => {
    const file = join(dir, "doc.pdf");
    await writeFile(file, makePdf(["Local pdf marker"]));
    const out = await fetchPageText(file, { timeoutMs: 5000 });
    expect(out).toContain("## Page 1");
    expect(out).toContain("Local pdf marker");
  });

  it("reads a pdf via a file url", async () => {
    const file = join(dir, "doc.pdf");
    await writeFile(file, makePdf(["File url marker"]));
    const out = await fetchPageText(pathToFileURL(file).href, { timeoutMs: 5000 });
    expect(out).toContain("File url marker");
  });

  it("reports a malformed pdf like the remote path", async () => {
    const file = join(dir, "broken.pdf");
    await writeFile(file, Buffer.from("%PDF-1.7\nnot a complete PDF"));
    const out = await fetchPageText(file, { timeoutMs: 5000 });
    expect(out).toBe("(PDF content could not be read as text)");
  });

  it("converts a local html file with the title prefix", async () => {
    const file = join(dir, "page.html");
    await writeFile(file, "<html><head><title>Local Doc</title></head><body><p>Readable local body text.</p></body></html>");
    const out = await fetchPageText(file, { timeoutMs: 5000 });
    expect(out.startsWith("Title: Local Doc")).toBe(true);
    expect(out).toContain("Readable local body text.");
    expect(out).not.toContain("<html");
  });

  it("returns a plain text file verbatim", async () => {
    const file = join(dir, "notes.txt");
    await writeFile(file, "line one\n    indented code\nline three");
    const out = await fetchPageText(file, { timeoutMs: 5000 });
    expect(out).toContain("    indented code");
  });

  it("rejects binary files", async () => {
    const file = join(dir, "blob.bin");
    await writeFile(file, Buffer.concat(Array.from({ length: 40 }, () => Buffer.from(Array.from({ length: 256 }, (_, i) => i)))));
    const out = await fetchPageText(file, { timeoutMs: 5000 });
    expect(out).toContain("(binary content,");
  });

  it("reports missing and unreadable files", async () => {
    const out = await fetchPageText(join(dir, "missing.pdf"), { timeoutMs: 5000 });
    expect(out.startsWith("Failed to read file:")).toBe(true);
  });

  it("rejects directories", async () => {
    const out = await fetchPageText(dir, { timeoutMs: 5000 });
    expect(out.startsWith("Failed to read file:")).toBe(true);
  });

  it("marks a file cut at the read cap", async () => {
    const file = join(dir, "big.txt");
    await writeFile(file, "a".repeat(600));
    const out = await fetchPageText(file, { maxBytes: 512, timeoutMs: 5000 });
    expect(out).toContain("(page truncated at the download limit)");
  });

  it("treats local paths as urls when opted out", async () => {
    const file = join(dir, "doc.pdf");
    await writeFile(file, makePdf(["Hidden marker"]));
    const out = await fetchPageText(file, { allowLocalFiles: false, timeoutMs: 5000 });
    expect(out).toBe("Blocked: the URL has an invalid hostname or port.");
    expect(out).not.toContain("Hidden marker");
  });
});

describe("local access settings", () => {
  const previousEnv = process.env.PI_CODING_AGENT_DIR;

  afterEach(async () => {
    if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousEnv;
  });

  it("defaults both flags to true", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-unsloth-settings-"));
    try {
      process.env.PI_CODING_AGENT_DIR = root;
      const settings = await loadDefaultFetchSettings();
      expect(settings.allowPrivateAddresses).toBe(true);
      expect(settings.allowLocalFiles).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads the flags from global and project settings with project override", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-unsloth-settings-"));
    try {
      const agentDirPath = join(root, "agent");
      await mkdir(agentDirPath, { recursive: true });
      await writeFile(
        join(agentDirPath, "settings.json"),
        JSON.stringify({ webFetch: { allowPrivateAddresses: false } }),
      );
      const cwd = join(root, "project");
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({ webFetch: { allowPrivateAddresses: true, allowLocalFiles: false } }),
      );
      process.env.PI_CODING_AGENT_DIR = agentDirPath;
      const settings = await loadDefaultFetchSettings(cwd);
      expect(settings.allowPrivateAddresses).toBe(true);
      expect(settings.allowLocalFiles).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
