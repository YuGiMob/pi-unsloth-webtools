import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lightpandaBinary, lightpandaLaunch, renderPageWithLightpanda, type LightpandaSpawn } from "../lightpanda.ts";

interface SpawnCall {
  binary: string;
  args: string[];
}

interface SpawnSpec {
  stdout?: string;
  code?: number | null;
  errorCode?: string;
  neverClose?: boolean;
}

function makeSpawn(handler: (call: SpawnCall) => SpawnSpec) {
  const calls: SpawnCall[] = [];
  const kills: string[] = [];
  const spawnImpl: LightpandaSpawn = (binary, args) => {
    const call = { binary, args };
    calls.push(call);
    const spec = handler(call);
    const listeners = new Map<string, ((value: unknown) => void)[]>();
    const emit = (event: string, value: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(value);
    };
    const child = {
      stdout: spec.neverClose
        ? null
        : (async function* () {
            if (spec.stdout !== undefined) yield Buffer.from(spec.stdout, "utf-8");
          })(),
      stderr: null,
      on(event: string, listener: (value: unknown) => void) {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
        return child;
      },
      kill() {
        kills.push(binary);
        if (spec.neverClose) queueMicrotask(() => emit("close", null));
        return true;
      },
    };
    if (spec.errorCode) {
      queueMicrotask(() =>
        emit("error", Object.assign(new Error(`spawn ${spec.errorCode}`), { code: spec.errorCode })),
      );
    } else if (!spec.neverClose) {
      queueMicrotask(() => emit("close", spec.code ?? 0));
    }
    return child as unknown as ReturnType<LightpandaSpawn>;
  };
  return { spawnImpl, calls, kills };
}

function spawnRendering(stdout: string, options: { code?: number | null; hang?: boolean } = {}) {
  return makeSpawn((call) => {
    if (call.args[0] === "version") return { stdout: "0.2.9", code: 0 };
    if (options.hang) return { neverClose: true };
    return { stdout, code: options.code ?? 0 };
  });
}

const PUBLIC_PAGE =
  "<html><head><title>Local</title></head><body><article><h1>Doc</h1>" +
  "<p>Readable body text here.</p></article></body></html>";

const resolvePublic = async () => ({ ok: true, reason: "", ip: "93.184.216.34", family: 4 });

afterEach(() => {
  delete process.env.PI_LIGHTPANDA_BIN;
});

let binarySequence = 0;

beforeEach(() => {
  process.env.PI_LIGHTPANDA_BIN = `lightpanda-test-${++binarySequence}`;
});

describe("renderPageWithLightpanda", () => {
  it("stays disabled by settings without spawning", async () => {
    const { spawnImpl, calls } = spawnRendering(PUBLIC_PAGE);
    const out = await renderPageWithLightpanda("https://example.com/", {
      spawn: spawnImpl,
      settings: { enabled: false, binaryPath: null, command: null },
    });
    expect(out).toBeNull();
    expect(calls).toEqual([]);
  });

  it("returns null when the binary is not installed", async () => {
    const { spawnImpl } = makeSpawn(() => ({ errorCode: "ENOENT" }));
    const out = await renderPageWithLightpanda("https://example.com/", { spawn: spawnImpl });
    expect(out).toBeNull();
  });

  it("renders html through the shared markdown pipeline with provenance", async () => {
    const { spawnImpl, calls } = spawnRendering(PUBLIC_PAGE);
    const out = await renderPageWithLightpanda("https://example.com/page", {
      spawn: spawnImpl,
      resolve: resolvePublic,
      timeoutMs: 5000,
    });
    expect(out).not.toBeNull();
    expect(out?.startsWith("Title: Local\nURL: https://example.com/page\n")).toBe(true);
    expect(out).toContain("Rendered via Lightpanda (local browser; nothing sent to a third party).");
    expect(out).toContain("Readable body text here.");
    expect(out).not.toContain("<html");
    const fetchCall = calls.find((call) => call.args[0] === "fetch");
    expect(fetchCall?.args).toEqual([
      "fetch",
      "--dump",
      "html",
      "--wait-until",
      "networkidle",
      "--block-private-networks",
      "--http-timeout",
      "5000",
      "https://example.com/page",
    ]);
  });

  it("returns markdown dumps directly", async () => {
    const { spawnImpl } = spawnRendering("# Doc\n\nBody text.");
    const out = await renderPageWithLightpanda("https://example.com/page", {
      spawn: spawnImpl,
      resolve: resolvePublic,
      dump: "markdown",
    });
    expect(out?.startsWith("URL: https://example.com/page\n")).toBe(true);
    expect(out).toContain("# Doc\n\nBody text.");
  });

  it("honors a custom wait-until", async () => {
    const { spawnImpl, calls } = spawnRendering(PUBLIC_PAGE);
    await renderPageWithLightpanda("https://example.com/page", {
      spawn: spawnImpl,
      resolve: resolvePublic,
      waitUntil: "domcontentloaded",
    });
    const fetchCall = calls.find((call) => call.args[0] === "fetch");
    expect(fetchCall?.args).toContain("domcontentloaded");
  });

  it("reports a non-zero exit", async () => {
    const { spawnImpl } = spawnRendering("", { code: 3 });
    const out = await renderPageWithLightpanda("https://example.com/", {
      spawn: spawnImpl,
      resolve: resolvePublic,
    });
    expect(out).toBe("Failed to render URL: Lightpanda exited with code 3.");
  });

  it("reports empty output as no readable text", async () => {
    const { spawnImpl } = spawnRendering("");
    const out = await renderPageWithLightpanda("https://example.com/", {
      spawn: spawnImpl,
      resolve: resolvePublic,
    });
    expect(out).toBe("(page returned no readable text)");
  });

  it("kills a hung render at the deadline", async () => {
    const { spawnImpl, kills } = spawnRendering("", { hang: true });
    const out = await renderPageWithLightpanda("https://example.com/", {
      spawn: spawnImpl,
      resolve: resolvePublic,
      timeoutMs: 20,
    });
    expect(out).toBe("Failed to render URL: timed out.");
    expect(kills.length).toBe(1);
  });

  it("kills a render when the caller cancels", async () => {
    const controller = new AbortController();
    const { spawnImpl, kills } = spawnRendering("", { hang: true });
    const pending = renderPageWithLightpanda("https://example.com/", {
      spawn: spawnImpl,
      resolve: resolvePublic,
      signal: controller.signal,
      timeoutMs: 5000,
    });
    setTimeout(() => controller.abort(), 10);
    expect(await pending).toBe("Failed to render URL: cancelled.");
    expect(kills.length).toBe(1);
  });

  it("refuses local files without spawning", async () => {
    const { spawnImpl, calls } = spawnRendering(PUBLIC_PAGE);
    for (const target of ["file:///tmp/page.html", "/etc/hosts", "~/notes.txt", "./page.html"]) {
      expect(await renderPageWithLightpanda(target, { spawn: spawnImpl })).toBe(
        "Blocked: the local renderer cannot fetch local files.",
      );
    }
    expect(calls).toEqual([]);
  });

  it("refuses non-public addresses before spawning", async () => {
    const { spawnImpl, calls } = spawnRendering(PUBLIC_PAGE);
    const out = await renderPageWithLightpanda("https://example.com/", {
      spawn: spawnImpl,
      resolve: async () => ({
        ok: false,
        reason: "Blocked: refusing to fetch the non-public address 127.0.0.1.",
        ip: "",
        family: 0,
      }),
    });
    expect(out).toBe("Blocked: refusing to fetch the non-public address 127.0.0.1.");
    expect(calls.filter((call) => call.args[0] === "fetch")).toEqual([]);
  });

  it("enforces the website policy before resolving", async () => {
    const { spawnImpl, calls } = spawnRendering(PUBLIC_PAGE);
    const out = await renderPageWithLightpanda("https://example.com/", {
      spawn: spawnImpl,
      websitePolicy: { allowedDomains: ["docs.example.com"], blockedDomains: [] },
    });
    expect(out).toBe("Blocked: the website access policy disallows example.com.");
    expect(calls).toEqual([]);
  });

  it("reports resolution failures as render failures", async () => {
    const { spawnImpl } = spawnRendering(PUBLIC_PAGE);
    const out = await renderPageWithLightpanda("https://example.com/", {
      spawn: spawnImpl,
      resolve: async () => ({ ok: false, reason: "Failed to resolve host: ENOTFOUND", ip: "", family: 0 }),
    });
    expect(out).toBe("Failed to render URL: Failed to resolve host: ENOTFOUND");
  });

  it("truncates the rendered page at maxChars", async () => {
    const { spawnImpl } = spawnRendering(PUBLIC_PAGE + "<p>" + "padding ".repeat(200) + "</p>");
    const out = await renderPageWithLightpanda("https://example.com/", {
      spawn: spawnImpl,
      resolve: resolvePublic,
      maxChars: 80,
    });
    expect(out).toContain("(truncated,");
  });

  it("refuses an empty url", async () => {
    const { spawnImpl } = spawnRendering(PUBLIC_PAGE);
    expect(await renderPageWithLightpanda("   ", { spawn: spawnImpl })).toBe("Blocked: the URL is empty.");
  });
});

describe("lightpandaBinary", () => {
  it("prefers the explicit path, then settings, then the environment", () => {
    process.env.PI_LIGHTPANDA_BIN = "/env/lightpanda";
    expect(lightpandaBinary({ binaryPath: "/explicit/lightpanda", settings: { enabled: true, binaryPath: "/settings/lightpanda", command: null } })).toBe(
      "/explicit/lightpanda",
    );
    expect(lightpandaBinary({ settings: { enabled: true, binaryPath: "/settings/lightpanda", command: null } })).toBe(
      "/settings/lightpanda",
    );
    expect(lightpandaBinary({})).toBe("/env/lightpanda");
    delete process.env.PI_LIGHTPANDA_BIN;
    expect(lightpandaBinary({})).toBe("lightpanda");
  });
});

describe.skipIf(process.platform === "win32")("lightpanda child process", () => {
  it("spawns the configured binary and converts its dump", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-unsloth-lightpanda-"));
    const argsFile = join(dir, "args.txt");
    const script = join(dir, "lightpanda");
    await writeFile(
      script,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > ${argsFile}`,
        'if [ "$1" = "version" ]; then echo "0.2.9"; exit 0; fi',
        `printf '%s' '${PUBLIC_PAGE}'`,
        "exit 0",
        "",
      ].join("\n"),
    );
    await chmod(script, 0o755);
    try {
      const out = await renderPageWithLightpanda("https://example.com/real", {
        binaryPath: script,
        resolve: resolvePublic,
        timeoutMs: 10_000,
      });
      expect(out).toContain("Title: Local");
      expect(out).toContain("URL: https://example.com/real");
      expect(out).toContain("Readable body text here.");
      const args = (await readFile(argsFile, "utf-8")).trim().split("\n");
      expect(args[0]).toBe("fetch");
      expect(args).toContain("--block-private-networks");
      expect(args[args.length - 1]).toBe("https://example.com/real");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a failing binary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-unsloth-lightpanda-"));
    const script = join(dir, "lightpanda");
    await writeFile(script, '#!/bin/sh\nif [ "$1" = "version" ]; then exit 0; fi\nexit 7\n');
    await chmod(script, 0o755);
    try {
      const out = await renderPageWithLightpanda("https://example.com/", {
        binaryPath: script,
        resolve: resolvePublic,
      });
      expect(out).toBe("Failed to render URL: Lightpanda exited with code 7.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("metadata-only renders", () => {
  it("reports a dump that contains only metadata as no readable text", async () => {
    const { spawnImpl } = spawnRendering("<html><head><title>g2.com</title></head><body></body></html>");
    const out = await renderPageWithLightpanda("https://example.com/", {
      spawn: spawnImpl,
      resolve: async () => ({ ok: true, reason: "", ip: "93.184.216.34", family: 4 }),
    });
    expect(out).toBe("(page returned no readable text)");
  });
});

describe("launch command", () => {
  it("prefers an explicit command over a binary path", () => {
    expect(
      lightpandaLaunch({
        binaryPath: "/usr/bin/lightpanda",
        command: ["wsl.exe", "-e", "/home/u/.local/bin/lightpanda"],
      }),
    ).toEqual(["wsl.exe", "-e", "/home/u/.local/bin/lightpanda"]);
    expect(
      lightpandaLaunch({ settings: { enabled: true, binaryPath: null, command: ["docker", "run", "--rm", "lightpanda/browser:nightly"] } }),
    ).toEqual(["docker", "run", "--rm", "lightpanda/browser:nightly"]);
    expect(lightpandaLaunch({ settings: { enabled: true, binaryPath: "/opt/lp", command: null } })).toEqual(["/opt/lp"]);
    expect(lightpandaLaunch({ binaryPath: "/usr/bin/lightpanda" })).toEqual(["/usr/bin/lightpanda"]);
  });

  it("appends the fetch flags to a command prefix when rendering", async () => {
    const { spawnImpl, calls } = spawnRendering(PUBLIC_PAGE);
    const out = await renderPageWithLightpanda("https://example.com/page", {
      command: ["wsl.exe", "-e", "/home/u/.local/bin/lightpanda"],
      spawn: spawnImpl,
      resolve: resolvePublic,
    });
    expect(out).toContain("Readable body text here.");
    expect(calls[0].binary).toBe("wsl.exe");
    expect(calls[0].args).toEqual(["-e", "/home/u/.local/bin/lightpanda", "version"]);
    const fetchCall = calls.find((call) => call.args.includes("fetch"));
    expect(fetchCall?.args.slice(0, 3)).toEqual(["-e", "/home/u/.local/bin/lightpanda", "fetch"]);
    expect(fetchCall?.args.at(-1)).toBe("https://example.com/page");
  });

  it("returns null when the command cannot be started", async () => {
    const { spawnImpl } = makeSpawn(() => ({ errorCode: "ENOENT" }));
    const out = await renderPageWithLightpanda("https://example.com/", {
      command: ["wsl.exe", "-e", "/missing/lightpanda"],
      spawn: spawnImpl,
    });
    expect(out).toBeNull();
  });
});
