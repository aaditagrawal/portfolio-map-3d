import { describe, expect, it } from "vitest";
import { Box3, Vector3 } from "three";
import { buildCar, CAR_COLLISION_RADIUS, findCarExit, findCarSpawn, canEnterCar } from "./car";

describe("explorer car", () => {
  it("stays grounded and inside its collision circle through wheel steering", () => {
    const car = buildCar();
    for (const steer of [-.5, 0, .5]) {
      car.animate(.05, 30, steer);
      car.root.updateMatrixWorld(true);
      const bounds = new Box3().setFromObject(car.root, true);
      expect(bounds.min.y).toBeGreaterThanOrEqual(-.006);
      const vertex = new Vector3();
      car.root.traverse(object => {
        if (!("geometry" in object)) return;
        const positions = (object as import("three").Mesh).geometry.attributes.position;
        for (let i = 0; i < positions.count; i++) {
          vertex.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld);
          expect(Math.hypot(vertex.x, vertex.z)).toBeLessThanOrEqual(CAR_COLLISION_RADIUS);
        }
      });
    }
    car.dispose(); car.dispose();
  });
  it("never summons or exits into rejected terrain", () => {
    expect(findCarSpawn({x:0,y:0},0,()=>false)).toBeNull();
    expect(findCarExit({x:0,y:0},0,()=>false)).toBeNull();
    const exit = findCarExit({x:4,y:7},Math.PI/2,p=>p.y>7);
    expect(exit).not.toBeNull();
    expect(Math.hypot(exit!.x-4,exit!.y-7)).toBeGreaterThan(CAR_COLLISION_RADIUS+.35);
  });
  it("summons nearby and limits boarding distance", () => {
    const spawn=findCarSpawn({x:0,y:0},0,()=>true)!;
    expect(canEnterCar({x:0,y:0},spawn)).toBe(true);
    expect(canEnterCar({x:0,y:0},{x:20,y:0})).toBe(false);
  });
});
