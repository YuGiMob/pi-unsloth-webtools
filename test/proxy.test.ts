import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { socksProxyForUrl } from "../proxy.ts";
import { fetchUrlRaw } from "../web-fetch.ts";
import { fakeResolve } from "./helpers.ts";

interface SocksCapture {
  version: number;
  methods: number[];
  username: string | null;
  password: string | null;
  atyp: number | null;
  address: string | null;
  port: number | null;
  firstByte: number | null;
}

interface SocksBehavior {
  replyCode?: number;
  recordFirstByte?: boolean;
}

interface SocksServer {
  port: number;
  captures: SocksCapture[];
  connections: () => number;
  close: () => Promise<void>;
}

interface LocalServer {
  port: number;
  close: () => Promise<void>;
}

const ATYP_IPV4 = 0x01;
const ATYP_IPV6 = 0x04;
const AUTH_USER_PASSWORD = 0x02;

function readN(socket: net.Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    function cleanup(): void {
      socket.removeListener("readable", onReadable);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    }
    function finish(error: Error | null, data?: Buffer): void {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(data!);
    }
    function onReadable(): void {
      const chunk = socket.read(length) as Buffer | null;
      if (chunk === null) return;
      finish(null, chunk);
    }
    function onError(error: Error): void {
      finish(error);
    }
    function onClose(): void {
      finish(new Error("socket closed"));
    }
    socket.on("readable", onReadable);
    socket.on("error", onError);
    socket.on("close", onClose);
    onReadable();
  });
}

function formatIpv6(bytes: Buffer): string {
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) groups.push(bytes.readUInt16BE(index).toString(16));
  return groups.join(":");
}

async function readAddress(socket: net.Socket, atyp: number): Promise<string> {
  if (atyp === ATYP_IPV4) return (await readN(socket, 4)).join(".");
  if (atyp === ATYP_IPV6) return formatIpv6(await readN(socket, 16));
  const length = (await readN(socket, 1))[0];
  return (await readN(socket, length)).toString("utf8");
}

async function handleSocksConnection(
  socket: net.Socket,
  capture: SocksCapture,
  behavior: SocksBehavior,
): Promise<void> {
  try {
    const greeting = await readN(socket, 2);
    capture.version = greeting[0];
    capture.methods = [...(await readN(socket, greeting[1]))];
    const useAuth = capture.methods.includes(AUTH_USER_PASSWORD);
    socket.write(Buffer.from([0x05, useAuth ? AUTH_USER_PASSWORD : 0x00]));
    if (useAuth) {
      const authHead = await readN(socket, 2);
      capture.username = (await readN(socket, authHead[1])).toString("utf8");
      const passwordLength = (await readN(socket, 1))[0];
      capture.password = (await readN(socket, passwordLength)).toString("utf8");
      socket.write(Buffer.from([0x01, 0x00]));
    }
    const head = await readN(socket, 4);
    capture.atyp = head[3];
    capture.address = await readAddress(socket, head[3]);
    capture.port = (await readN(socket, 2)).readUInt16BE(0);
    if (behavior.replyCode !== undefined) {
      socket.write(Buffer.from([0x05, behavior.replyCode, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]));
      socket.end();
      return;
    }
    socket.write(Buffer.from([0x05, 0x00, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]));
    if (behavior.recordFirstByte) {
      socket.once("data", (chunk: Buffer) => {
        capture.firstByte = chunk[0];
        socket.destroy();
      });
      return;
    }
    const target = net.connect({ host: capture.address, port: capture.port });
    socket.pipe(target).pipe(socket);
    target.on("error", () => socket.destroy());
    socket.on("close", () => target.destroy());
  } catch {
    socket.destroy();
  }
}

async function startSocksServer(behavior: SocksBehavior = {}): Promise<SocksServer> {
  const captures: SocksCapture[] = [];
  let connectionCount = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connectionCount++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const capture: SocksCapture = {
      version: 0,
      methods: [],
      username: null,
      password: null,
      atyp: null,
      address: null,
      port: null,
      firstByte: null,
    };
    captures.push(capture);
    void handleSocksConnection(socket, capture, behavior);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    captures,
    connections: () => connectionCount,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

async function startTextServer(body: string, host = "127.0.0.1"): Promise<LocalServer> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("socksProxyForUrl", () => {
  it("prefers the https proxy variables and decodes credentials", () => {
    vi.stubEnv("HTTPS_PROXY", "socks5://pi%2Duser:pi%3Apass@proxy.example:1080");
    vi.stubEnv("ALL_PROXY", "socks5://other.example:1080");
    expect(socksProxyForUrl(new URL("https://example.com/page"))).toEqual({
      host: "proxy.example",
      port: 1080,
      username: "pi-user",
      password: "pi:pass",
    });
  });

  it("falls back to all_proxy and defaults the socks port", () => {
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("ALL_PROXY", "socks5h://127.0.0.1");
    expect(socksProxyForUrl(new URL("https://example.com/"))).toEqual({
      host: "127.0.0.1",
      port: 1080,
      username: null,
      password: null,
    });
  });

  it("uses http proxy variables for http targets", () => {
    vi.stubEnv("HTTP_PROXY", "socks5://http-proxy.example:1081");
    vi.stubEnv("HTTPS_PROXY", "socks5://https-proxy.example:1082");
    expect(socksProxyForUrl(new URL("http://example.com/"))?.host).toBe("http-proxy.example");
    expect(socksProxyForUrl(new URL("https://example.com/"))?.host).toBe("https-proxy.example");
  });

  it("ignores unsupported proxy schemes", () => {
    vi.stubEnv("ALL_PROXY", "http://proxy.example:3128");
    expect(socksProxyForUrl(new URL("https://example.com/"))).toBeNull();
  });

  it("honors no_proxy domains, ports and wildcards", () => {
    vi.stubEnv("HTTPS_PROXY", "socks5://127.0.0.1:9050");
    vi.stubEnv("NO_PROXY", "example.com,.internal.test,other.test:8443");
    expect(socksProxyForUrl(new URL("https://example.com/"))).toBeNull();
    expect(socksProxyForUrl(new URL("https://sub.example.com/"))).toBeNull();
    expect(socksProxyForUrl(new URL("https://host.internal.test/"))).toBeNull();
    expect(socksProxyForUrl(new URL("https://other.test:8443/"))).toBeNull();
    expect(socksProxyForUrl(new URL("https://other.test/"))).not.toBeNull();
    expect(socksProxyForUrl(new URL("https://unrelated.test/"))).not.toBeNull();
    vi.stubEnv("NO_PROXY", "*");
    expect(socksProxyForUrl(new URL("https://unrelated.test/"))).toBeNull();
  });
});

describe("proxied fetch", () => {
  it("tunnels http requests through a socks5 proxy using the pinned address", async () => {
    const proxy = await startSocksServer();
    const target = await startTextServer("proxied body");
    vi.stubEnv("HTTP_PROXY", `socks5://127.0.0.1:${proxy.port}`);
    try {
      const result = await fetchUrlRaw(`http://example.com:${target.port}/`, {
        timeoutMs: 5000,
        seams: { resolve: async () => fakeResolve("127.0.0.1") },
      });
      expect(result.error).toBeNull();
      expect(result.body).toBe("proxied body");
      expect(proxy.connections()).toBe(1);
      expect(proxy.captures[0]).toMatchObject({ atyp: ATYP_IPV4, address: "127.0.0.1", port: target.port });
    } finally {
      await proxy.close();
      await target.close();
    }
  });

  it("authenticates and offers only the username/password method", async () => {
    const proxy = await startSocksServer();
    const target = await startTextServer("authed body");
    vi.stubEnv("HTTP_PROXY", `socks5://pi-user:pi-pass@127.0.0.1:${proxy.port}`);
    try {
      const result = await fetchUrlRaw(`http://example.com:${target.port}/`, {
        timeoutMs: 5000,
        seams: { resolve: async () => fakeResolve("127.0.0.1") },
      });
      expect(result.body).toBe("authed body");
      expect(proxy.captures[0].methods).toEqual([AUTH_USER_PASSWORD]);
      expect(proxy.captures[0]).toMatchObject({ username: "pi-user", password: "pi-pass" });
    } finally {
      await proxy.close();
      await target.close();
    }
  });

  it("tunnels socks5h targets the same way", async () => {
    const proxy = await startSocksServer();
    const target = await startTextServer("all proxy body");
    vi.stubEnv("ALL_PROXY", `socks5h://127.0.0.1:${proxy.port}`);
    try {
      const result = await fetchUrlRaw(`http://example.com:${target.port}/`, {
        timeoutMs: 5000,
        seams: { resolve: async () => fakeResolve("127.0.0.1") },
      });
      expect(result.body).toBe("all proxy body");
      expect(proxy.connections()).toBe(1);
    } finally {
      await proxy.close();
      await target.close();
    }
  });

  it("tunnels ipv6 targets with the ipv6 address type", async () => {
    const proxy = await startSocksServer();
    const target = await startTextServer("ipv6 body", "::1");
    vi.stubEnv("HTTP_PROXY", `socks5://127.0.0.1:${proxy.port}`);
    try {
      const result = await fetchUrlRaw(`http://example.com:${target.port}/`, {
        timeoutMs: 5000,
        seams: { resolve: async () => ({ ok: true, reason: "", ip: "::1", family: 6 }) },
      });
      expect(result.body).toBe("ipv6 body");
      expect(proxy.captures[0]).toMatchObject({ atyp: ATYP_IPV6, address: "0:0:0:0:0:0:0:1", port: target.port });
    } finally {
      await proxy.close();
      await target.close();
    }
  });

  it("bypasses the proxy for no_proxy hosts", async () => {
    const proxy = await startSocksServer();
    const target = await startTextServer("direct body");
    vi.stubEnv("HTTP_PROXY", `socks5://127.0.0.1:${proxy.port}`);
    vi.stubEnv("NO_PROXY", "example.com");
    try {
      const result = await fetchUrlRaw(`http://example.com:${target.port}/`, {
        timeoutMs: 5000,
        seams: { resolve: async () => fakeResolve("127.0.0.1") },
      });
      expect(result.body).toBe("direct body");
      expect(proxy.connections()).toBe(0);
    } finally {
      await proxy.close();
      await target.close();
    }
  });

  it("connects directly for unsupported proxy schemes", async () => {
    const proxy = await startSocksServer();
    const target = await startTextServer("direct body");
    vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${proxy.port}`);
    try {
      const result = await fetchUrlRaw(`http://example.com:${target.port}/`, {
        timeoutMs: 5000,
        seams: { resolve: async () => fakeResolve("127.0.0.1") },
      });
      expect(result.body).toBe("direct body");
      expect(proxy.connections()).toBe(0);
    } finally {
      await proxy.close();
      await target.close();
    }
  });

  it("surfaces socks5 connect failures", async () => {
    const proxy = await startSocksServer({ replyCode: 0x05 });
    vi.stubEnv("HTTP_PROXY", `socks5://127.0.0.1:${proxy.port}`);
    try {
      const result = await fetchUrlRaw("http://example.com/", {
        timeoutMs: 5000,
        seams: { resolve: async () => fakeResolve("127.0.0.1") },
      });
      expect(result.error).toContain("SOCKS5 proxy connect failed: connection refused");
    } finally {
      await proxy.close();
    }
  });

  it("reports an unreachable proxy", async () => {
    const probe = await startSocksServer();
    const deadPort = probe.port;
    await probe.close();
    vi.stubEnv("HTTP_PROXY", `socks5://127.0.0.1:${deadPort}`);
    const result = await fetchUrlRaw("http://example.com/", {
      timeoutMs: 5000,
      seams: { resolve: async () => fakeResolve("127.0.0.1") },
    });
    expect(result.error).toContain("Failed to fetch URL:");
  });

  it("starts tls inside the tunnel for https targets", async () => {
    const proxy = await startSocksServer({ recordFirstByte: true });
    vi.stubEnv("HTTPS_PROXY", `socks5://127.0.0.1:${proxy.port}`);
    try {
      await fetchUrlRaw("https://example.com/", {
        timeoutMs: 5000,
        seams: { resolve: async () => fakeResolve("93.184.216.34") },
      });
      expect(proxy.captures[0].firstByte).toBe(0x16);
    } finally {
      await proxy.close();
    }
  });

  it("bounds a stalled proxy handshake with the fetch deadline", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    vi.stubEnv("HTTP_PROXY", `socks5://127.0.0.1:${port}`);
    try {
      const result = await fetchUrlRaw("http://example.com/", {
        timeoutMs: 300,
        seams: { resolve: async () => fakeResolve("127.0.0.1") },
      });
      expect(result.error).toBe("Failed to fetch URL: timed out.");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});