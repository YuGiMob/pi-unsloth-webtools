import { describe, expect, it } from "vitest";
import { readConfig, toggleWebRender } from "../config.ts";
import { configRows, WebToolsConfigOverlay } from "../config-ui.ts";
import { testTheme, waitFor, withTempConfig } from "./config-helpers.ts";

describe("configRows", () => {
  it("reflects the stored setting", () => {
    expect(configRows({ webRenderEnabled: true })[0]).toMatchObject({ key: "webRenderEnabled", enabled: true });
    expect(configRows({ webRenderEnabled: false })[0]).toMatchObject({ key: "webRenderEnabled", enabled: false });
  });
});

describe("WebToolsConfigOverlay", () => {
  function makeOverlay(overrides: { done?: () => void; onToggle?: (key: "webRenderEnabled") => Promise<void> } = {}) {
    const toggles: string[] = [];
    const overlay = new WebToolsConfigOverlay({
      tui: { requestRender: () => {} },
      theme: testTheme(),
      done: overrides.done ?? (() => {}),
      onToggle: async (key) => {
        toggles.push(key);
        await (overrides.onToggle ?? toggleWebRender)(key);
      },
    });
    return { overlay, toggles };
  }

  it("renders the web render row", async () => {
    await withTempConfig(async () => {
      const { overlay } = makeOverlay();
      await overlay.load();
      const text = overlay.render(60).join("\n");
      expect(text).toContain("Web Tools Config");
      expect(text).toContain("JavaScript rendering");
      expect(text).toContain("[x]");
    });
  });

  it("toggles the setting with space and reloads the row", async () => {
    await withTempConfig(async () => {
      const { overlay, toggles } = makeOverlay();
      await overlay.load();
      overlay.handleInput(" ");
      expect(toggles).toEqual(["webRenderEnabled"]);
      await waitFor(async () => (await readConfig()).webRenderEnabled === false);
      expect(overlay.render(60).join("\n")).toContain("[ ]");
    });
  });

  it("closes on escape", async () => {
    let closed = 0;
    const { overlay } = makeOverlay({
      done: () => {
        closed++;
      },
    });
    await withTempConfig(async () => {
      await overlay.load();
      overlay.handleInput("\x1b");
      expect(closed).toBe(1);
    });
  });
});
