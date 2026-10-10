import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MARK, closedPath, ringFront } from "./mark.ts";

// The small favicon keeps the crystal and orbit, leaving out the fine cage and background.
const favicon = readFileSync(new URL("../../public/favicon.svg", import.meta.url), "utf8");

describe("the Nexus mark", () => {
  it("keeps the crystal and orbit on a transparent background in the favicon", () => {
    for (const d of [closedPath(MARK.crystal), closedPath(MARK.facet), ringFront()]) expect(favicon).toContain(`d="${d}"`);
    expect(favicon).not.toContain("<rect");
    expect(favicon).not.toContain("<circle");
    const { rx, ry, tilt } = MARK.ring;
    expect(favicon).toContain(`rx="${rx}" ry="${ry}" transform="rotate(${tilt} 32 32)"`);
  });

  it("joins the cage to the crystal: every strut ends on a corner of one or the other", () => {
    const corners = new Set([...MARK.cage, ...MARK.crystal].map(([x, y]) => `${x},${y}`));
    for (const [x, y] of MARK.struts) expect(corners.has(`${x},${y}`), `${x},${y}`).toBe(true);
  });
});
