import { afterEach, describe, expect, it, vi } from "vitest";
import { applyGlassPalette, createGlassMaterial } from "./materials";
import { globePalette } from "./palette";

afterEach(() => vi.unstubAllGlobals());

describe("mounted globe theme", () => {
  it("reads a changed theme instead of retaining the palette from the first render", () => {
    let scheme = "light";
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal("getComputedStyle", () => ({ colorScheme: scheme, getPropertyValue: () => "" }));
    const light = globePalette();
    const surface = createGlassMaterial([]);
    scheme = "dark";
    const dark = globePalette();
    applyGlassPalette(surface, dark);
    expect(light.dark).toBe(false);
    expect(dark.dark).toBe(true);
    expect(dark.surface).not.toBe(light.surface);
    expect(surface.uniforms.uBase.value.getHexString()).toBe("18181b");
    expect(surface.uniforms.uDark.value).toBe(1);
    // Logo plates retain their artwork contrast while the scene changes around them.
    expect(dark.paper).toBe(light.paper);
    expect(surface.transparent).toBe(false);
    expect(surface.depthWrite).toBe(true);
    surface.dispose();
  });
});
