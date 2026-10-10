import { unitHash } from "../lib/hash.ts";
import type { SurfaceDistrict } from "../lib/surface.ts";

export interface MoonPlacement {
  slug: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  orbit: number;
}

/** Concentric, tilted orbits keep every district visible without overlapping its planet. */
export function moonLayout(worldId: string, planetRadius: number, districts: readonly SurfaceDistrict[]): MoonPlacement[] {
  const largest = Math.max(1, ...districts.map((d) => d.count));
  const phase = unitHash(`moons:${worldId}`) * Math.PI * 2;
  const tilt = 0.28;
  const out: MoonPlacement[] = [];
  let start = 0;
  let ring = 0;
  while (start < districts.length) {
    const count = Math.min(8 + ring * 4, districts.length - start);
    const orbit = planetRadius * (1.8 + ring * 0.6);
    for (let j = 0; j < count; j++) {
      const d = districts[start + j];
      const angle = phase + (j / count) * Math.PI * 2 + ring * 0.37;
      const z = Math.sin(angle) * orbit;
      out.push({
        slug: d.slug,
        x: Math.cos(angle) * orbit,
        y: z * Math.sin(tilt),
        z: z * Math.cos(tilt),
        radius: planetRadius * (0.12 + 0.1 * Math.sqrt(Math.max(0, d.count) / largest)),
        orbit,
      });
    }
    start += count;
    ring++;
  }
  return out;
}
