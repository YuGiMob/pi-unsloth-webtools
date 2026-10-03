import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { visibleChars } from "../html-to-md.ts";
import { lightpandaLaunch, renderPageWithLightpanda } from "../lightpanda.ts";

const enabled = process.env.PI_LIGHTPANDA_E2E === "1";
const binary = process.env.PI_LIGHTPANDA_E2E_BIN?.trim() || process.env.PI_LIGHTPANDA_BIN?.trim() || "lightpanda";

describe.skipIf(!enabled || process.platform === "win32")("lightpanda renderer (live)", () => {
  const launch = lightpandaLaunch({ binaryPath: binary });
  const printable = launch.length === 1 ? launch[0] : launch.join(" ");

  it("runs the resolved command", () => {
    const version = execFileSync(launch[0], [...launch.slice(1), "version"], { encoding: "utf-8" }).trim();
    console.log(`renderer command: ${printable} -> ${version}`);
    expect(version.length).toBeGreaterThan(0);
  }, 60_000);

  it("renders a plain page through the local binary", async () => {
    const text = await renderPageWithLightpanda("https://example.com/", { binaryPath: binary, timeoutMs: 90_000 });
    expect(text).not.toBeNull();
    expect(text?.startsWith("Failed to render URL:")).toBe(false);
    expect(text?.startsWith("Blocked:")).toBe(false);
    expect(text).toContain("URL: https://example.com/");
    expect(text).toContain("Rendered via Lightpanda");
    expect(visibleChars(text ?? "")).toBeGreaterThan(150);
  }, 150_000);

  it("renders a JavaScript-heavy page through the local binary", async () => {
    const text = await renderPageWithLightpanda("https://react.dev/learn", { binaryPath: binary, timeoutMs: 120_000 });
    expect(text).not.toBeNull();
    expect(text?.startsWith("Failed to render URL:")).toBe(false);
    expect(visibleChars(text ?? "")).toBeGreaterThan(2_000);
  }, 180_000);
});
