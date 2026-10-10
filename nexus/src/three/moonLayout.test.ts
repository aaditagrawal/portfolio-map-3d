import { describe, expect, it } from "vitest";
import { moonLayout } from "./moonLayout.ts";

describe("district moon placement", () => {
  it("keeps 36 regional moons apart and outside their planet", () => {
    const districts = Array.from({ length: 36 }, (_, i) => ({ slug: `region-${i}`, color: "#ffffff", count: i === 0 ? 0 : i * 12 }));
    const moons = moonLayout("india", 4.4, districts);
    expect(moons.map((m) => m.slug)).toEqual(districts.map((d) => d.slug));
    for (let i = 0; i < moons.length; i++) {
      const a = moons[i];
      expect(Math.hypot(a.x, a.y, a.z) - a.radius).toBeGreaterThan(4.4);
      for (let j = i + 1; j < moons.length; j++) {
        const b = moons[j];
        expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeGreaterThan(a.radius + b.radius);
      }
    }
    expect(moonLayout("india", 4.4, districts)).toEqual(moons);
  });

  it("handles empty districts and counts without removing a region", () => {
    expect(moonLayout("empty", 2, [])).toEqual([]);
    const moons = moonLayout("zeros", 2, [{ slug: "north", count: 0, color: "#ffffff" }, { slug: "south", count: 0, color: "#ffffff" }]);
    expect(moons).toHaveLength(2);
    expect(moons.every((m) => Number.isFinite(m.radius) && m.radius > 0)).toBe(true);
  });
});
