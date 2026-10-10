/* The Nexus portal: a ring of light standing on the plaza beside the hub (PORTAL in
   src/data/hub.ts). Walking through it opens the Nexus, the Portfolio Map Network's shared world,
   where every map built on this framework is a world of its own (src/network.ts). It is the walk
   world's half of the network's one requirement, so it is always built.

   A graphite frame, translucent warm light curtains (a small shader, static under reduced
   motion), a compact Nexus nameplate on both faces, and a soft glow
   on the ground. Text is painted on a CPU-backed canvas (src/three/cpuCanvas.ts) and repainted
   when the web font arrives. */
import * as THREE from "three";
import { PORTAL } from "../../data/hub";
import { cpuCanvas } from "../../three/cpuCanvas";
import type { ScenePalette } from "./palette";
import { canvasTexture, merge, paint, withNearFade } from "./util";

/** The network's colors: the Nexus's cyan and violet. */
export const NEXUS_CYAN = "#3ee6ff";
export const NEXUS_VIOLET = "#8b5cf6";

type Own = <T extends { dispose(): void }>(x: T) => T;

export interface PortalBuild {
  group: THREE.Group;
  /** The plaque's top, for label placement. */
  top: number;
  update(time: number, reduced: boolean): void;
  dispose(): void;
}

export function buildPortal(p: ScenePalette, own: Own, nearFade: { value: THREE.Vector2 }): PortalBuild {
  const group = new THREE.Group();
  group.name = "nexus-portal";
  group.position.set(PORTAL.x, 0, PORTAL.z);
  group.rotation.y = PORTAL.facing;
  const R = PORTAL.r;
  const cy = R + 0.24;
  const amber = new THREE.Color("#e9a56e");
  const rose = new THREE.Color("#cc7292");

  // A graphite frame holds a narrow warm light along the aperture.
  const frameMaterial = own(withNearFade(new THREE.MeshLambertMaterial({ color: "#363638" }), nearFade));
  const ring = new THREE.Mesh(own(new THREE.TorusGeometry(R, 0.16, 8, 64).translate(0, cy, 0)), frameMaterial);
  ring.name = "portal-ring";
  ring.castShadow = true; ring.receiveShadow = true;
  group.add(ring);
  const innerLight = new THREE.Mesh(own(new THREE.TorusGeometry(R - 0.115, 0.024, 6, 64).translate(0, cy, 0.10)),
    own(withNearFade(new THREE.MeshBasicMaterial({ color: "#ffd1a3", toneMapped: false }), nearFade)));
  group.add(innerLight);

  // The plinth under the ring, and the two posts the walker passes between.
  const stone = p.ink.clone().lerp(new THREE.Color("#454548"), 0.7);
  const plinth = merge([
    paint(new THREE.BoxGeometry(R * 2 + 1.6, 0.16, PORTAL.depth + 0.8).translate(0, 0.08, 0), stone),
    paint(new THREE.CylinderGeometry(0.16, 0.24, cy - 0.16, 8).translate(-R - 0.1, 0.16 + (cy - 0.16) / 2, 0), stone),
    paint(new THREE.CylinderGeometry(0.16, 0.24, cy - 0.16, 8).translate(R + 0.1, 0.16 + (cy - 0.16) / 2, 0), stone),
  ]);
  const base = new THREE.Mesh(own(plinth), own(withNearFade(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), nearFade)));
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  // Slow vertical light folds leave the aperture translucent.
  const uniforms = { uTime: { value: 0 }, uA: { value: amber }, uB: { value: rose } };
  const swirl = new THREE.Mesh(
    own(new THREE.CircleGeometry(R - 0.16, 48).translate(0, cy, 0)),
    own(
      new THREE.ShaderMaterial({
        uniforms,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          uniform vec3 uA;
          uniform vec3 uB;
          varying vec2 vUv;
          void main() {
            vec2 q = vUv - 0.5;
          float edge = 1.0 - smoothstep(0.88, 1.0, length(q) * 2.0);
          float drift = uTime * 0.13;
          float bend = sin(vUv.y * 4.2 + drift) * 0.09 + sin(vUv.y * 9.0 - drift * 0.7) * 0.025;
          float folds = sin((vUv.x + bend) * 29.0 + drift);
          float fine = sin((vUv.x + bend * 0.7) * 63.0 - drift * 0.5);
          float ribbons = pow(0.5 + 0.5 * folds, 3.0);
          float veil = smoothstep(0.0, 0.22, vUv.y) * (1.0 - smoothstep(0.72, 1.0, vUv.y));
          vec3 col = mix(uA, uB, smoothstep(0.12, 0.9, vUv.y + fine * 0.07));
          col = mix(col, vec3(1.0, 0.88, 0.73), ribbons * 0.32);
          float alpha = edge * (0.10 + veil * (0.15 + ribbons * 0.40));
          gl_FragColor = vec4(col, alpha);
            #include <colorspace_fragment>
          }`,
      }),
    ),
  );
  swirl.name = "portal-curtain";
  swirl.renderOrder = 2;
  group.add(swirl);

  // A glow on the ground before and behind it.
  const [gc, gctx] = cpuCanvas(128, 128);
  const g = gctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, "rgba(238,171,117,0.24)");
  g.addColorStop(0.5, "rgba(207,116,145,0.10)");
  g.addColorStop(1, "rgba(207,116,145,0)");
  gctx.fillStyle = g;
  gctx.fillRect(0, 0, 128, 128);
  const glow = new THREE.Mesh(
    own(new THREE.PlaneGeometry(R * 2.3, R * 1.6).rotateX(-Math.PI / 2).translate(0, 0.06, 0)),
    own(new THREE.MeshBasicMaterial({ map: own(canvasTexture(gc)), transparent: true, depthWrite: false, toneMapped: false })),
  );
  group.add(glow);

  // The words on the plinth's two faces.
  const [tc, tctx] = cpuCanvas(1024, 160);
  const tex = own(canvasTexture(tc));
  const paintWords = () => {
    tctx.clearRect(0, 0, 1024, 160);
    tctx.fillStyle = "#ffffff";
    tctx.textAlign = "center";
    tctx.textBaseline = "middle";
    tctx.font = `500 88px "Instrument Sans", "DM Sans", sans-serif`;
    tctx.fillText("Nexus", 512, 80);
    tex.needsUpdate = true;
  };
  paintWords();
  let disposed = false;
  (document.fonts?.ready ?? Promise.resolve()).then(() => !disposed && paintWords());
  const wordsMat = own(withNearFade(new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1 }), nearFade));
  // A dark plaque on the ring's crown carries them, readable from both sides.
  const ww = R * 0.95;
  const wh = ww * (160 / 1024);
  const plaqueY = cy + R + 0.16 + wh / 2;
  const plaque = new THREE.Mesh(own(new THREE.BoxGeometry(ww + 0.3, wh + 0.2, 0.14).translate(0, plaqueY, 0)), own(withNearFade(new THREE.MeshLambertMaterial({ color: stone }), nearFade)));
  group.add(plaque);
  for (const side of [1, -1]) {
    const plane = new THREE.Mesh(own(new THREE.PlaneGeometry(ww, wh)), wordsMat);
    plane.position.set(0, plaqueY, side * 0.08);
    if (side < 0) plane.rotation.y = Math.PI;
    group.add(plane);
  }

  return {
    group,
    top: plaqueY + wh / 2 + 0.1,
    update(time, reduced) {
      uniforms.uTime.value = reduced ? 0 : time;
    },
    dispose() {
      disposed = true;
    },
  };
}
