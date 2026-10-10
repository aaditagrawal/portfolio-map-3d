/* The Nexus mark's geometry: the core of the 3D world (three/engine.ts buildCore) drawn flat,
   in a 64 x 64 box centered on (32, 32). A crystal (the icosahedron seen along a three-fold
   axis: a hexagon and a facet) inside a geodesic cage, a tilted ring that passes behind the
   crystal and in front of it, and a glow. Icons.tsx (Mark) and three/paint.ts (drawMark) draw
   it; public/favicon.svg keeps the crystal and orbit without the fine cage. */

export type Point = readonly [number, number];

export const MARK = {
  /** The ring, an ellipse tilted by `tilt` degrees. */
  ring: { rx: 30, ry: 8.5, tilt: -14 },
  /** The cage's outline: a dodecagon. */
  cage: [
    [32, 11],
    [42.5, 13.8],
    [50.2, 21.5],
    [53, 32],
    [50.2, 42.5],
    [42.5, 50.2],
    [32, 53],
    [21.5, 50.2],
    [13.8, 42.5],
    [11, 32],
    [13.8, 21.5],
    [21.5, 13.8],
  ],
  /** The cage's struts: one zigzag between the cage and the crystal's corners. */
  struts: [
    [21.5, 13.8],
    [32, 18],
    [42.5, 13.8],
    [44.1, 25],
    [53, 32],
    [44.1, 39],
    [42.5, 50.2],
    [32, 46],
    [21.5, 50.2],
    [19.9, 39],
    [11, 32],
    [19.9, 25],
  ],
  /** The crystal's outline: a hexagon. */
  crystal: [
    [32, 18],
    [44.1, 25],
    [44.1, 39],
    [32, 46],
    [19.9, 39],
    [19.9, 25],
  ],
  /** The facet facing the viewer: a triangle. */
  facet: [
    [32, 26.3],
    [37.8, 36.3],
    [26.2, 36.3],
  ],
} as const satisfies {
  ring: { rx: number; ry: number; tilt: number };
  cage: readonly Point[];
  struts: readonly Point[];
  crystal: readonly Point[];
  facet: readonly Point[];
};

/** A closed SVG path through `points`: "M32 18 44.1 25 ... Z". */
export function closedPath(points: readonly Point[]): string {
  return `M${points.map(([x, y]) => `${x} ${y}`).join(" ")}Z`;
}

/** The ring's front half (the arc below its center, before the tilt), as an SVG path. */
export function ringFront(): string {
  const { rx, ry } = MARK.ring;
  return `M${32 - rx} 32a${rx} ${ry} 0 0 0 ${rx * 2} 0`;
}
