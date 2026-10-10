import { afterEach, describe, expect, it, vi } from "vitest";
import { readScenePalette, watchScenePalette } from "./palette";

afterEach(() => vi.unstubAllGlobals());

describe("walk scene theme", () => {
  it("updates an existing subscriber once per palette change and removes its listeners", () => {
    let dark = false;
    let refresh = () => {};
    const disconnect = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal("getComputedStyle", () => ({
      colorScheme: dark ? "dark" : "light",
      getPropertyValue: (name: string) => name === "--scene-sky-top" ? dark ? "#09090b" : "#9fd3ea" : "",
    }));
    vi.stubGlobal("MutationObserver", class {
      constructor(callback: () => void) { refresh = callback; }
      observe() {}
      disconnect = disconnect;
    });
    vi.stubGlobal("window", { matchMedia: () => ({ addEventListener: vi.fn(), removeEventListener: remove }) });
    const change = vi.fn();
    const stop = watchScenePalette(change);
    refresh(); // A sheet style change does not rebuild scenery.
    expect(change).not.toHaveBeenCalled();
    dark = true;
    refresh();
    refresh();
    expect(change).toHaveBeenCalledTimes(1);
    const palette = readScenePalette();
    expect(palette.dark).toBe(true);
    expect(palette.skyTop.getHexString()).toBe("09090b");
    expect(palette.sun.getHexString()).toBe("d4d4d8");
    dark = false;
    refresh();
    expect(change).toHaveBeenCalledTimes(2);
    stop();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("change", refresh);
  });
});
