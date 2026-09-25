import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { stripIpv6Brackets } from "./web-access.ts";

export interface SocksProxy {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}

export interface TunnelOptions {
  proxy: SocksProxy;
  ip: string;
  family: number;
  port: number;
  servername: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface Budget {
  timeoutMs: number;
  signal?: AbortSignal;
}

const HTTPS_PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];
const HTTP_PROXY_VARS = ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
const NO_PROXY_VARS = ["NO_PROXY", "no_proxy"];
const SOCKS_PROTOCOLS = new Set(["socks5:", "socks5h:"]);
const DEFAULT_SOCKS_PORT = 1080;
const SOCKS_VERSION = 0x05;
const SOCKS_AUTH_NONE = 0x00;
const SOCKS_AUTH_USER_PASSWORD = 0x02;
const SOCKS_AUTH_REJECTED = 0xff;
const SOCKS_COMMAND_CONNECT = 0x01;
const SOCKS_ATYP_IPV4 = 0x01;
const SOCKS_ATYP_DOMAIN = 0x03;
const SOCKS_ATYP_IPV6 = 0x04;
const SOCKS_REPLY_MESSAGES: Record<number, string> = {
  1: "general failure",
  2: "connection not allowed",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
};

function firstEnv(names: readonly string[]): string | null {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function decodeCredential(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseSocksProxy(value: string | null | undefined): SocksProxy | null {
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!SOCKS_PROTOCOLS.has(parsed.protocol)) return null;
  if (!parsed.hostname) return null;
  const port = parsed.port ? Number(parsed.port) : DEFAULT_SOCKS_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const username = parsed.username ? decodeCredential(parsed.username) : "";
  const password = parsed.password ? decodeCredential(parsed.password) : "";
  return { host: parsed.hostname, port, username: username || null, password: password || null };
}

function noProxyEntries(): string[] {
  const raw = firstEnv(NO_PROXY_VARS);
  if (!raw) return [];
  return raw.split(/[\s,]+/).filter((entry) => entry.length > 0);
}

function splitHostPort(entry: string): { host: string; port: number | null } {
  if (entry.startsWith("[")) {
    const end = entry.indexOf("]");
    if (end === -1) return { host: entry, port: null };
    const host = entry.slice(1, end);
    const rest = entry.slice(end + 1);
    if (rest.startsWith(":") && /^\d+$/.test(rest.slice(1))) return { host, port: Number(rest.slice(1)) };
    return { host, port: null };
  }
  const colon = entry.lastIndexOf(":");
  if (colon > 0 && entry.indexOf(":") === colon && /^\d+$/.test(entry.slice(colon + 1))) {
    return { host: entry.slice(0, colon), port: Number(entry.slice(colon + 1)) };
  }
  return { host: entry, port: null };
}

function bypassesProxy(hostname: string, port: number): boolean {
  const host = hostname.toLowerCase();
  for (const rawEntry of noProxyEntries()) {
    const entry = rawEntry.toLowerCase();
    if (entry === "*") return true;
    const { host: rawHost, port: entryPort } = splitHostPort(entry);
    if (entryPort !== null && entryPort !== port) continue;
    const pattern = rawHost.replace(/^\./, "").replace(/\.$/, "");
    if (!pattern) continue;
    if (host === pattern) return true;
    if (!net.isIP(pattern) && host.endsWith(`.${pattern}`)) return true;
  }
  return false;
}

export function socksProxyForUrl(url: URL): SocksProxy | null {
  const proxy = parseSocksProxy(firstEnv(url.protocol === "https:" ? HTTPS_PROXY_VARS : HTTP_PROXY_VARS));
  if (!proxy) return null;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (bypassesProxy(stripIpv6Brackets(url.hostname), port)) return null;
  return proxy;
}

function readExact(socket: net.Socket, length: number, budget: Budget): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (budget.signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    function cleanup(): void {
      if (timer) clearTimeout(timer);
      budget.signal?.removeEventListener("abort", onAbort);
      socket.removeListener("readable", onReadable);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    }
    function finish(error: Error | null, data?: Buffer): void {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(data!);
      }
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
      finish(new Error("SOCKS5 proxy closed the connection"));
    }
    function onAbort(): void {
      finish(new Error("cancelled"));
    }
    timer = setTimeout(() => finish(new Error("timed out")), budget.timeoutMs);
    budget.signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("readable", onReadable);
    socket.on("error", onError);
    socket.on("close", onClose);
    onReadable();
  });
}

function writeAll(socket: net.Socket, data: Buffer, budget: Budget): Promise<void> {
  return new Promise((resolve, reject) => {
    if (budget.signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    function cleanup(): void {
      if (timer) clearTimeout(timer);
      budget.signal?.removeEventListener("abort", onAbort);
      socket.removeListener("error", onError);
    }
    function finish(error: Error | null): void {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve();
      }
    }
    function onError(error: Error): void {
      finish(error);
    }
    function onAbort(): void {
      finish(new Error("cancelled"));
    }
    timer = setTimeout(() => finish(new Error("timed out")), budget.timeoutMs);
    budget.signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("error", onError);
    socket.write(data, (error: Error | null | undefined) => finish(error ?? null));
  });
}

function connectProxy(proxy: SocksProxy, budget: Budget): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    if (budget.signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    function cleanup(): void {
      if (timer) clearTimeout(timer);
      budget.signal?.removeEventListener("abort", onAbort);
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      socket.removeListener("timeout", onTimeout);
      socket.setTimeout(0);
    }
    function finish(error: Error | null): void {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    }
    function onConnect(): void {
      finish(null);
    }
    function onError(error: Error): void {
      finish(error);
    }
    function onTimeout(): void {
      finish(new Error("timed out"));
    }
    function onAbort(): void {
      finish(new Error("cancelled"));
    }
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.setTimeout(budget.timeoutMs, onTimeout);
    budget.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(new Error("timed out")), budget.timeoutMs);
  });
}

async function authenticate(socket: net.Socket, proxy: SocksProxy, budget: Budget): Promise<void> {
  const username = Buffer.from(proxy.username ?? "", "utf8");
  const password = Buffer.from(proxy.password ?? "", "utf8");
  if (username.length > 255 || password.length > 255) throw new Error("SOCKS5 proxy credentials are too long");
  await writeAll(
    socket,
    Buffer.concat([Buffer.from([0x01, username.length]), username, Buffer.from([password.length]), password]),
    budget,
  );
  const reply = await readExact(socket, 2, budget);
  if (reply[0] !== 0x01 || reply[1] !== 0x00) throw new Error("SOCKS5 proxy authentication failed");
}

function ipv4Bytes(ip: string): Buffer {
  const parts = ip.split(".");
  if (parts.length !== 4) throw new Error(`Invalid IPv4 address: ${ip}`);
  const bytes = Buffer.alloc(4);
  parts.forEach((part, index) => {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error(`Invalid IPv4 address: ${ip}`);
    bytes[index] = value;
  });
  return bytes;
}

function ipv6Bytes(ip: string): Buffer {
  const halves = ip.split("::");
  if (halves.length > 2) throw new Error(`Invalid IPv6 address: ${ip}`);
  const toGroups = (part: string) => (part ? part.split(":") : []);
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  for (const group of [...head, ...tail]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) throw new Error(`Invalid IPv6 address: ${ip}`);
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) throw new Error(`Invalid IPv6 address: ${ip}`);
  const groups = [...head, ...Array.from({ length: missing }, () => "0"), ...tail];
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2));
  return bytes;
}

function addressBytes(ip: string, family: number): { atyp: number; bytes: Buffer } {
  if (family === 6 || ip.includes(":")) return { atyp: SOCKS_ATYP_IPV6, bytes: ipv6Bytes(ip) };
  return { atyp: SOCKS_ATYP_IPV4, bytes: ipv4Bytes(ip) };
}

async function sendConnect(socket: net.Socket, options: TunnelOptions, budget: Budget): Promise<void> {
  const address = addressBytes(options.ip, options.family);
  const port = Buffer.alloc(2);
  port.writeUInt16BE(options.port);
  await writeAll(
    socket,
    Buffer.concat([Buffer.from([SOCKS_VERSION, SOCKS_COMMAND_CONNECT, 0x00, address.atyp]), address.bytes, port]),
    budget,
  );
  const head = await readExact(socket, 4, budget);
  if (head[0] !== SOCKS_VERSION) throw new Error("SOCKS5 proxy returned an invalid version");
  if (head[1] !== 0x00) {
    const reason = SOCKS_REPLY_MESSAGES[head[1]] ?? `reply ${head[1]}`;
    throw new Error(`SOCKS5 proxy connect failed: ${reason}`);
  }
  const atyp = head[3];
  if (atyp === SOCKS_ATYP_IPV4) {
    await readExact(socket, 6, budget);
  } else if (atyp === SOCKS_ATYP_IPV6) {
    await readExact(socket, 18, budget);
  } else if (atyp === SOCKS_ATYP_DOMAIN) {
    const length = (await readExact(socket, 1, budget))[0];
    await readExact(socket, length + 2, budget);
  } else {
    throw new Error("SOCKS5 proxy returned an invalid address type");
  }
}

async function socksHandshake(socket: net.Socket, options: TunnelOptions, budget: Budget): Promise<void> {
  const methods = options.proxy.username !== null ? [SOCKS_AUTH_USER_PASSWORD] : [SOCKS_AUTH_NONE];
  await writeAll(socket, Buffer.from([SOCKS_VERSION, methods.length, ...methods]), budget);
  const greeting = await readExact(socket, 2, budget);
  if (greeting[0] !== SOCKS_VERSION) throw new Error("SOCKS5 proxy returned an invalid version");
  const method = greeting[1];
  if (method === SOCKS_AUTH_REJECTED) throw new Error("SOCKS5 proxy rejected all authentication methods");
  if (method === SOCKS_AUTH_USER_PASSWORD) {
    await authenticate(socket, options.proxy, budget);
  } else if (method !== SOCKS_AUTH_NONE) {
    throw new Error(`SOCKS5 proxy selected an unsupported authentication method (${method})`);
  }
  await sendConnect(socket, options, budget);
}

export async function openTunnel(options: TunnelOptions): Promise<net.Socket> {
  const budget: Budget = { timeoutMs: options.timeoutMs, signal: options.signal };
  const socket = await connectProxy(options.proxy, budget);
  try {
    await socksHandshake(socket, options, budget);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function tlsWrap(socket: net.Socket, servername: string): tls.TLSSocket {
  if (net.isIP(servername)) return tls.connect({ socket, host: servername });
  return tls.connect({ socket, servername });
}

function tunnelCreateConnection(
  open: () => Promise<Duplex>,
  callback?: (err: Error | null, stream: Duplex) => void,
): Duplex | null | undefined {
  if (typeof callback !== "function") return undefined;
  open().then(
    (stream) => callback(null, stream),
    (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), undefined as unknown as Duplex),
  );
  return undefined;
}

export function tunnelAgent(url: URL, options: TunnelOptions): http.Agent {
  const open = (): Promise<Duplex> =>
    openTunnel(options).then((socket) => (url.protocol === "https:" ? tlsWrap(socket, options.servername) : socket));
  if (url.protocol === "https:") {
    class SecureTunnelAgent extends https.Agent {
      constructor() {
        super({ keepAlive: false });
      }
      override createConnection(
        _options: http.ClientRequestArgs,
        callback?: (err: Error | null, stream: Duplex) => void,
      ): Duplex | null | undefined {
        return tunnelCreateConnection(open, callback);
      }
    }
    return new SecureTunnelAgent();
  }
  class PlainTunnelAgent extends http.Agent {
    constructor() {
      super({ keepAlive: false });
    }
    override createConnection(
      _options: http.ClientRequestArgs,
      callback?: (err: Error | null, stream: Duplex) => void,
    ): Duplex | null | undefined {
      return tunnelCreateConnection(open, callback);
    }
  }
  return new PlainTunnelAgent();
}