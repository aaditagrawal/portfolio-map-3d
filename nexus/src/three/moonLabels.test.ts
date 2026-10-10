import { describe, expect, it } from "vitest";
import { layoutMoonLabels, MoonLabelLayout } from "./moonLabels.ts";

describe("persistent moon labels", () => {
  it.each([[390,234],[320,118],[600,720]])("fits 36 names in %i×%i without overlapping text", (w,h) => {
    const anchors=Array.from({length:36},(_,i)=>({slug:String(i),x:w/2+Math.cos(i)*70,y:h/2+Math.sin(i)*50,radius:4}));
    const result=layoutMoonLabels(anchors,{l:0,t:0,r:w,b:h});
    expect(result).toHaveLength(36);
    for (const a of result) {
      expect(a.x-a.width/2).toBeGreaterThanOrEqual(0);expect(a.x+a.width/2).toBeLessThanOrEqual(w);
      expect(a.y-8).toBeGreaterThanOrEqual(0);expect(a.y+8).toBeLessThanOrEqual(h);
      for (const b of result) if(a!==b) expect(Math.abs(a.x-b.x)>= (a.width+b.width)/2 || Math.abs(a.y-b.y)>=16).toBe(true);
    }
  });
  it("keeps dense names steady during damping and updates after a visible camera move", () => {
    const layout = new MoonLabelLayout();
    const area = { l: 0, t: 0, r: 390, b: 234 };
    const anchors = Array.from({ length: 36 }, (_, i) => ({ slug: String(i), x: 100 + i, y: 120, radius: 4 }));
    const first = layout.update(anchors, area, []);
    expect(layout.update(anchors.map((a) => ({ ...a, x: a.x + 2 })), area, [])).toBe(first);
    expect(layout.update(anchors.map((a) => ({ ...a, x: a.x + 9 })), area, [])).not.toBe(first);
  });
  it("reflows on viewport or publisher-label changes even while the camera stays still", () => {
    const layout = new MoonLabelLayout();
    const anchors = [{ slug: "region", x: 120, y: 130, radius: 4 }];
    const area = { l: 0, t: 0, r: 390, b: 234 };
    const first = layout.update(anchors, area, []);
    const narrowed = layout.update(anchors, { ...area, r: 320 }, []);
    expect(narrowed).not.toBe(first);
    const obstacle = { l: 60, r: 180, t: 100, b: 150 };
    const obstructed = layout.update(anchors, { ...area, r: 320 }, [obstacle]);
    expect(obstructed).not.toBe(narrowed);
    expect(obstructed[0].y - 8 >= obstacle.b || obstructed[0].y + 8 <= obstacle.t || obstructed[0].x - obstructed[0].width / 2 >= obstacle.r || obstructed[0].x + obstructed[0].width / 2 <= obstacle.l).toBe(true);
  });
});
