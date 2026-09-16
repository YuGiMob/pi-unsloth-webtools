import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configDir,
  configPath,
  readConfig,
  readConfigWithStatus,
  toggleWebRender,
  updateConfig,
  writeConfig,
} from "../config.ts";
import { withTempConfig } from "./config-helpers.ts";

describe("config defaults", () => {
  it("enables web render when no config file exists", async () => {
    await withTempConfig(async () => {
      expect((await readConfig()).webRenderEnabled).toBe(true);
      expect((await readConfigWithStatus()).corrupted).toBe(false);
    });
  });

  it("reads a stored value", async () => {
    await withTempConfig(async () => {
      await writeConfig({ webRenderEnabled: false });
      expect((await readConfig()).webRenderEnabled).toBe(false);
    });
  });

  it("ignores unknown fields on read", async () => {
    await withTempConfig(async () => {
      await mkdir(configDir(), { recursive: true });
      await writeFile(configPath(), JSON.stringify({ autoRead: true, webRenderEnabled: false }));
      expect((await readConfig()).webRenderEnabled).toBe(false);
    });
  });
});

describe("config toggling", () => {
  it("flips webRenderEnabled and persists it", async () => {
    await withTempConfig(async () => {
      expect(await toggleWebRender()).toBe(false);
      expect((await readConfig()).webRenderEnabled).toBe(false);
      expect(await toggleWebRender()).toBe(true);
      expect((await readConfig()).webRenderEnabled).toBe(true);
    });
  });

  it("serializes concurrent updates", async () => {
    await withTempConfig(async () => {
      await Promise.all([toggleWebRender(), toggleWebRender()]);
      expect((await readConfig()).webRenderEnabled).toBe(true);
      expect(await readdir(configDir())).toEqual(["config.json"]);
    });
  });

  it("applies updates through updateConfig", async () => {
    await withTempConfig(async () => {
      const config = await updateConfig((current) => {
        current.webRenderEnabled = false;
      });
      expect(config.webRenderEnabled).toBe(false);
      expect((await readConfig()).webRenderEnabled).toBe(false);
    });
  });

  it("leaves no temp files behind after writeConfig", async () => {
    await withTempConfig(async () => {
      await writeConfig({ webRenderEnabled: false });
      expect(await readdir(configDir())).toEqual(["config.json"]);
    });
  });
});

describe("config corruption handling", () => {
  it("falls back to defaults and quarantines a non-object config", async () => {
    await withTempConfig(async () => {
      await mkdir(configDir(), { recursive: true });
      await writeFile(configPath(), JSON.stringify([1, 2]));
      const { config, corrupted } = await readConfigWithStatus();
      expect(corrupted).toBe(true);
      expect(config.webRenderEnabled).toBe(true);
      const entries = await readdir(configDir());
      expect(entries.some((entry) => entry.startsWith("config.json.corrupt-"))).toBe(true);
    });
  });

  it("falls back to defaults for a non-boolean value", async () => {
    await withTempConfig(async () => {
      await mkdir(configDir(), { recursive: true });
      await writeFile(configPath(), JSON.stringify({ webRenderEnabled: "yes" }));
      const { config, corrupted } = await readConfigWithStatus();
      expect(corrupted).toBe(true);
      expect(config.webRenderEnabled).toBe(true);
    });
  });

  it("uses the default without quarantining when the field is absent", async () => {
    await withTempConfig(async () => {
      await mkdir(configDir(), { recursive: true });
      await writeFile(configPath(), JSON.stringify({ something: true }));
      const { config, corrupted } = await readConfigWithStatus();
      expect(corrupted).toBe(false);
      expect(config.webRenderEnabled).toBe(true);
    });
  });
});

describe("config location", () => {
  it("honors XDG_CONFIG_HOME", async () => {
    await withTempConfig(async (dir) => {
      process.env.XDG_CONFIG_HOME = join(dir, "xdg");
      await writeConfig({ webRenderEnabled: false });
      expect(configPath()).toBe(join(dir, "xdg", "pi-unsloth-webtools", "config.json"));
      expect((await readConfig()).webRenderEnabled).toBe(false);
    });
  });

  it.skipIf(process.platform === "win32")("falls back to ~/.config", async () => {
    await withTempConfig(async (dir) => {
      expect(configPath()).toBe(join(dir, ".config", "pi-unsloth-webtools", "config.json"));
    });
  });
});
