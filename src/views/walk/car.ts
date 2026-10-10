/** A compact explorer car. Network units, forward +z, tires touch y=0. */
import * as Three from "three";

export const CAR_SPEED = 30;
export const CAR_SPRINT_SPEED = 40;
/** Encloses the complete vehicle, including bumpers. */
export const CAR_COLLISION_RADIUS = 1.2;
export const CAR_ENTER_DISTANCE = 2.8;
export const CAR_WHEEL_RADIUS = 0.27;
export interface CarPoint { x: number; y: number }
export type CarCanStand = (point: CarPoint, radius: number) => boolean;
export interface CarModel {
  root: Three.Group;
  /** Signed travel speed in network units/second; steer in radians. */
  animate(dt: number, speed: number, steer?: number): void;
  dispose(): void;
}

function offset(point: CarPoint, heading: number, side: number, forward: number): CarPoint {
  return { x: point.x + Math.cos(heading) * side + Math.sin(heading) * forward,
    y: point.y - Math.sin(heading) * side + Math.cos(heading) * forward };
}
/** Searches nearby clear ground. Never silently falls back to an obstructed position. */
export function findCarSpawn(point: CarPoint, heading: number, canStand: CarCanStand): CarPoint | null {
  for (const distance of [2.6, 4, 5.5]) {
    for (const angle of [Math.PI / 2, -Math.PI / 2, 0, Math.PI, Math.PI / 4, -Math.PI / 4]) {
      const candidate = offset(point, heading, Math.sin(angle) * distance, Math.cos(angle) * distance);
      if (canStand(candidate, CAR_COLLISION_RADIUS)) return candidate;
    }
  }
  return null;
}
/** Exit outside the full car collision circle, including room for the walker. */
export function findCarExit(point: CarPoint, heading: number, canStand: CarCanStand, walkerRadius = 0.35): CarPoint | null {
  for (const gap of [0.2, 0.7, 1.4]) {
    const distance = CAR_COLLISION_RADIUS + walkerRadius + gap;
    for (const [side, forward] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const candidate = offset(point, heading, side * distance, forward * distance);
      if (canStand(candidate, walkerRadius)) return candidate;
    }
  }
  return null;
}
export function canEnterCar(walker: CarPoint, car: CarPoint): boolean {
  return Math.hypot(walker.x - car.x, walker.y - car.y) <= CAR_ENTER_DISTANCE;
}

/** THREE injection keeps the standalone map on its existing renderer version. */
export function createCarKit(THREE: typeof Three) {
  function buildCar(color = "#e6ac49"): CarModel {
    const root = new THREE.Group();
    root.name = "explorer-car";
    const owned: Three.BufferGeometry[] = [];
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    function part(geometry: Three.BufferGeometry, x: number, y: number, z: number, tone: string) {
      const g = geometry.index ? geometry.toNonIndexed() : geometry;
      if (g !== geometry) geometry.dispose();
      g.translate(x, y, z);
      const c = new THREE.Color(tone);
      const values = new Float32Array(g.attributes.position.count * 3);
      for (let i = 0; i < values.length; i += 3) { values[i] = c.r; values[i + 1] = c.g; values[i + 2] = c.b; }
      g.setAttribute("color", new THREE.BufferAttribute(values, 3));
      return g;
    }
    function mesh(parts: Three.BufferGeometry[]) {
      const count = parts.reduce((n, p) => n + p.attributes.position.count, 0);
      const positions = new Float32Array(count * 3);
      const colors = new Float32Array(count * 3);
      let cursor = 0;
      for (const p of parts) {
        positions.set(p.attributes.position.array, cursor);
        colors.set(p.attributes.color.array, cursor);
        cursor += p.attributes.position.count * 3;
        p.dispose();
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      g.computeVertexNormals(); owned.push(g);
      const object = new THREE.Mesh(g, material);
      object.castShadow = true; object.receiveShadow = true;
      return object;
    }
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, tone: string) =>
      part(new THREE.BoxGeometry(w, h, d), x, y, z, tone);
    // Opaque blue glazing reads at a distance without transparent sorting or extra materials.
    const body = [
      box(1.12, .30, 1.72, 0, .49, 0, color),
      box(1.02, .12, 1.8, 0, .30, 0, "#27272a"),
      box(.93, .42, .87, 0, .82, -.12, "#355c72"),
      box(1.02, .09, .98, 0, 1.075, -.12, color),
      box(1.10, .08, .55, 0, .69, .58, color),
      box(1.18, .12, .12, 0, .36, .93, "#3f3f46"),
      box(1.18, .12, .12, 0, .36, -.93, "#3f3f46"),
      box(.43, .12, .025, 0, .50, .872, "#27272a"),
      box(.12, .07, .025, -.45, .64, -.874, "#ef705d"),
      box(.12, .07, .025, .45, .64, -.874, "#ef705d"),
      box(.22, .12, .025, -.40, .58, .875, "#fff3c4"),
      box(.22, .12, .025, .40, .58, .875, "#fff3c4"),
    ];
    for (const side of [-1, 1]) {
      for (const z of [-.54, .03, .30]) body.push(box(.07, .42, .06, side * .48, .83, z, color));
      body.push(box(.08, .10, .20, side * .60, .79, .24, "#27272a"));
      body.push(box(.025, .045, .12, side * .565, .59, -.17, "#e4e4e7"));
    }
    root.add(mesh(body));
    const wheelGeometry = [
      part(new THREE.CylinderGeometry(CAR_WHEEL_RADIUS, CAR_WHEEL_RADIUS, .16, 12).rotateZ(Math.PI / 2), 0, 0, 0, "#18181b"),
      part(new THREE.CylinderGeometry(.14, .14, .172, 8).rotateZ(Math.PI / 2), 0, 0, 0, "#a1a1aa"),
      box(.18, .05, .24, 0, 0, 0, "#52525b"),
    ];
    const template = mesh(wheelGeometry);
    const wheels: { steering: Three.Group; wheel: Three.Mesh; front: boolean }[] = [];
    for (const side of [-1, 1]) for (const z of [-.61, .61]) {
      const steering = new THREE.Group();
      steering.position.set(side * .59, CAR_WHEEL_RADIUS, z);
      const wheel = template.clone();
      steering.add(wheel); root.add(steering);
      wheels.push({ steering, wheel, front: z > 0 });
    }
    let disposed = false;
    return {
      root,
      animate(dt, speed, steer = 0) {
        if (!Number.isFinite(dt) || !Number.isFinite(speed) || !Number.isFinite(steer)) return;
        const turn = Math.max(-.5, Math.min(.5, steer));
        for (const { steering, wheel, front } of wheels) {
          steering.rotation.y = front ? turn : 0;
          wheel.rotation.x = (wheel.rotation.x + speed * Math.max(0, Math.min(dt, .1)) / CAR_WHEEL_RADIUS) % (Math.PI * 2);
        }
      },
      dispose() { if (disposed) return; disposed = true; for (const g of owned) g.dispose(); material.dispose(); },
    };
  }
  return { buildCar };
}
export const buildCar = createCarKit(Three).buildCar;
