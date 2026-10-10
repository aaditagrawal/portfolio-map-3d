/* The static world: sky, sea, the island, the hub and the Nexus portal on the plaza, roads,
   industry districts with their landmarks and entry arches, and decor.

   Built imperatively once per mount (geometry comes only from
   src/data/layout.ts), merged into a handful of draw calls, and disposed
   on unmount. Districts group companies by industry; nothing here places a
   company at a physical location. The People area (see areas.ts) is built
   by the same district code, in the one person color. */
import * as THREE from "three";
import { plazaLamps, plazaSeats } from "../../data/hub";
import { CORE_RADIUS, PLAZA_RADIUS, ROAD_WIDTH, decorPoints, hashString, seededRandom, type AreaSlug, type WorldLayout } from "../../data/layout";
import { cpuCanvas, cpuContext } from "../../three/cpuCanvas";
import { labelTexture } from "../../three/logoTexture";
import { buildHub, drawHubGround } from "./hub";
import { buildPortal } from "./portal";
import { mix, type ScenePalette } from "./palette";
import { SEA_LEVEL, type Terrain } from "./terrain";
import { canvasTexture, clamp, merge, paint, smoothstep, valueNoise2D, withNearFade } from "./util";

export interface Collider {
  x: number;
  z: number;
  r: number;
  /** Height of the obstacle, for keeping the follow camera's view over it. */
  h?: number;
}

export interface BoxCollider {
  x: number;
  z: number;
  hx: number;
  hz: number;
  /** Rotation about y (three.js rotation.y); absent for an axis-aligned box. */
  rot?: number;
  h?: number;
}

export interface World {
  root: THREE.Group;
  colliders: Collider[];
  /** Tall things the follow camera should look over (tree crowns, landmarks, the hub). Not walking obstacles. */
  blockers: Collider[];
  /** District entry arches, as foreground clutter for choosing fly-to views. */
  arches: Collider[];
  boxes: BoxCollider[];
  sun: THREE.DirectionalLight;
  /** Unit vector toward the sun (the light follows the walker along it). */
  sunDir: THREE.Vector3;
  hemi: THREE.HemisphereLight;
  /** View-distance range [gone, solid] over which props near the lens dissolve (set per frame by the engine). */
  nearFade: { value: THREE.Vector2 };
  /** Height of each district landmark's top, for label placement. */
  landmarkTop: number;
  /** Height of the hub's highest point (the top of its rooftop sign), for label placement. */
  hubTop: number;
  /** The hub's rooftop sign in world space: its pole's foot (x, z and height on the roof), width, bottom and top. Its face turns to the camera. */
  beacon: { x: number; z: number; foot: number; w: number; y0: number; y1: number };
  /** Walker head position and radius for the hub's see-through cutaway (w = 0: off). Set per frame by the engine. */
  hubOccluder: { value: THREE.Vector4 };
  /** Paint a district's (or the People area's) icon, an SVG string, onto its landmark emblem. */
  setDistrictIcon(slug: AreaSlug, svg: string): void;
  /** Replace static scenery in place while retaining the engine's root group and state. */
  setPalette(palette: ScenePalette): void;
  update(time: number, dt: number, reduced: boolean, cameraYaw: number): void;
  dispose(): void;
}

const LANDMARK_TOP = 9.6;

/** What the district code needs to know about each disc on the ring (a district or the People area). */
export interface AreaLook {
  slug: AreaSlug;
  short: string;
  color: string;
}

export function buildWorld(layout: WorldLayout, districts: readonly AreaLook[], terrain: Terrain, p: ScenePalette): World {
  let current = buildWorldParts(layout, districts, terrain, p);
  const root = current.root;
  const icons = new Map<AreaSlug, string>();
  const setDistrictIcon = (slug: AreaSlug, svg: string) => {
    icons.set(slug, svg);
    current.setDistrictIcon(slug, svg);
  };
  const setPalette = (palette: ScenePalette) => {
    const next = buildWorldParts(layout, districts, terrain, palette);
    const previous = current;
    root.clear();
    root.add(...next.root.children);
    current = next;
    Object.assign(world, next, { root, setPalette, setDistrictIcon });
    previous.dispose();
    for (const [slug, svg] of icons) current.setDistrictIcon(slug, svg);
  };
  const world: World = { ...current, root, setPalette, setDistrictIcon };
  return world;
}

function buildWorldParts(layout: WorldLayout, districts: readonly AreaLook[], terrain: Terrain, p: ScenePalette): Omit<World, "setPalette"> {
  const root = new THREE.Group();
  root.name = "world";
  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(x: T) => {
    disposables.push(x);
    return x;
  };
  const colliders: Collider[] = [];
  const boxes: BoxCollider[] = [];
  const blockers: Collider[] = [];
  const arches: Collider[] = [];
  const districtBy = new Map(districts.map((d) => [d.slug, d]));
  const nearFade = { value: new THREE.Vector2(0, 0) };
  /** Vertex-colored, flat-shaded props that dissolve near the camera. */
  const propMaterial = () => own(withNearFade(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), nearFade));

  /* ---------------- sky, light, fog ---------------- */
  const sunDir = new THREE.Vector3(-36, 58, 42).normalize();
  const sky = new THREE.Mesh(
    own(new THREE.SphereGeometry(1100, 32, 16)),
    own(
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          top: { value: p.skyTop.clone() },
          bottom: { value: p.skyBottom.clone() },
          glow: { value: p.dark ? new THREE.Color("#52525b") : mix(p.sun, p.sand, 0.4) },
          night: { value: p.dark ? 1 : 0 },
          sunDir: { value: sunDir },
        },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 top;
          uniform vec3 bottom;
          uniform vec3 glow;
          uniform vec3 sunDir;
          uniform float night;
          varying vec3 vDir;
          void main() {
            float t = smoothstep(-0.02, 0.55, vDir.y);
            vec3 col = mix(bottom, top, t);
            float s = max(dot(vDir, sunDir), 0.0);
            col = mix(col, glow, pow(s, 6.0) * 0.55 + pow(s, 64.0) * 0.4);
            // Fixed points on the sky sphere retain depth during camera movement.
            vec3 dir = normalize(vDir);
            vec2 uv = vec2(atan(dir.z, dir.x) * 0.15915494 + 0.5, asin(dir.y) * 0.31830989 + 0.5);
            vec2 cell = uv * vec2(960.0, 480.0);
            float seed = fract(sin(dot(floor(cell), vec2(12.9898, 78.233))) * 43758.5453);
            float star = step(0.9985, seed) * (1.0 - smoothstep(0.0, 0.18, length(fract(cell) - 0.5)));
            col += vec3(0.34) * star * smoothstep(0.03, 0.35, dir.y) * night;
            gl_FragColor = vec4(col, 1.0);
            #include <colorspace_fragment>
          }`,
      }),
    ),
  );
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  root.add(sky);

  const hemi = new THREE.HemisphereLight(p.dark ? "#e4e4e7" : p.skyBottom, p.dark ? "#a1a1aa" : mix(p.grass, p.sand, 0.3), p.dark ? 1.8 : 1.35);
  root.add(hemi);
  if (p.dark) root.add(new THREE.AmbientLight("#ffffff", 0.65));
  const sun = new THREE.DirectionalLight(p.sun, p.dark ? 1.85 : 2.15);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 220;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  root.add(sun, sun.target);

  /* ---------------- island ground ---------------- */
  {
    const R = layout.islandRadius;
    const size = 2 * (R + 84);
    const seg = 176;
    const g = own(new THREE.PlaneGeometry(size, size, seg, seg));
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const noise = valueNoise2D(hashString("walk-ground"));
    const c = new THREE.Color();
    const shallow = mix(p.sand, p.sea, 0.45);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = terrain.heightAt(x, z);
      pos.setY(i, h);
      const r = Math.hypot(x, z);
      const a = Math.atan2(z, x);
      const m = noise(x * 0.035, z * 0.035) * 0.65 + noise(x * 0.14 + 9, z * 0.14 + 4) * 0.35;
      c.copy(p.grass).lerp(p.grassDark, clamp(m * 1.25 - 0.15, 0, 1));
      c.lerp(p.sand, 0.1 * noise(x * 0.02 + 30, z * 0.02 + 11) + clamp(h / 3.4, 0, 1) * 0.12);
      c.lerp(p.sand, terrain.sandAt(r, a));
      const depth = SEA_LEVEL - h;
      if (depth > 0) c.lerp(shallow, smoothstep(0, 0.8, depth)).lerp(p.seaDeep, smoothstep(0.6, 6, depth));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    const ground = new THREE.Mesh(g, own(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })));
    ground.receiveShadow = true;
    ground.name = "ground";
    root.add(ground);

    const floor = new THREE.Mesh(own(new THREE.CircleGeometry(1400, 48)), own(new THREE.MeshBasicMaterial({ color: p.seaDeep })));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -7.9;
    root.add(floor);
  }

  /* ---------------- sea ---------------- */
  const seaNormal = (() => {
    const size = 128;
    const [cv, ctx] = cpuCanvas(size, size);
    const img = ctx.createImageData(size, size);
    const n = valueNoise2D(hashString("walk-sea"));
    // Tileable: sample a torus-wrapped noise by blending the seams.
    const hAt = (x: number, y: number) => {
      const fx = x / size;
      const fy = y / size;
      const s = (u: number, v: number) => n(u * 0.12, v * 0.12) + 0.45 * n(u * 0.29 + 40, v * 0.29 + 40);
      return (
        s(x, y) * (1 - fx) * (1 - fy) + s(x - size, y) * fx * (1 - fy) + s(x, y - size) * (1 - fx) * fy + s(x - size, y - size) * fx * fy
      );
    };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = hAt(x + 1, y) - hAt(x - 1, y);
        const dy = hAt(x, y + 1) - hAt(x, y - 1);
        const o = (y * size + x) * 4;
        img.data[o] = clamp(128 + dx * 230, 0, 255);
        img.data[o + 1] = clamp(128 + dy * 230, 0, 255);
        img.data[o + 2] = 255;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const t = own(canvasTexture(cv, false));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(140, 140);
    return t;
  })();
  const seaMat = own(
    new THREE.MeshPhongMaterial({
      color: p.sea,
      specular: p.dark ? new THREE.Color("#71717a") : mix(p.sun, p.skyTop, 0.2),
      shininess: 70,
      transparent: true,
      opacity: 0.8,
      normalMap: seaNormal,
      normalScale: new THREE.Vector2(0.5, 0.5),
      depthWrite: false,
    }),
  );
  const sea = new THREE.Mesh(own(new THREE.CircleGeometry(1400, 72)), seaMat);
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = SEA_LEVEL;
  sea.renderOrder = 1;
  root.add(sea);

  // A soft line of surf along the waterline.
  const foamMat = own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false }));
  {
    const N = 320;
    const verts: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const s = terrain.shoreAt(a);
      for (const r of [s - 3.7, s - 2.4]) verts.push(Math.cos(a) * r, SEA_LEVEL + 0.03, Math.sin(a) * r);
      if (i < N) {
        const k = i * 2;
        idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
      }
    }
    const g = own(new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    g.setIndex(idx);
    const foam = new THREE.Mesh(g, foamMat);
    foam.renderOrder = 2;
    root.add(foam);
  }

  /* ---------------- plaza ---------------- */
  {
    // The enlarged plaza needs more texels for crisp joints up close: 2048 on a desktop, 1024 on a
    // touch device (a 2048 canvas texture costs about 22 MB of GPU memory with its mipmaps).
    const S = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches ? 1024 : 2048;
    const [cv, ctx] = cpuCanvas(S, S);
    const k = S / (PLAZA_RADIUS * 2);
    const css = (c: THREE.Color) => `#${c.getHexString()}`;
    ctx.fillStyle = css(p.plaza);
    ctx.fillRect(0, 0, S, S);
    const rand = seededRandom(hashString("walk-plaza"));
    // Concentric paving courses with offset joints, each stone slightly varied.
    for (let r = 1.2; r < PLAZA_RADIUS; r += 1.25) {
      const n = Math.max(6, Math.round((2 * Math.PI * r) / 1.6));
      const off = rand() * Math.PI;
      for (let i = 0; i < n; i++) {
        const a0 = off + (i / n) * Math.PI * 2;
        const a1 = off + ((i + 1) / n) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(S / 2, S / 2, (r + 1.25) * k, a0, a1);
        ctx.arc(S / 2, S / 2, r * k, a1, a0, true);
        ctx.closePath();
        ctx.fillStyle = css(mix(p.plaza, rand() > 0.5 ? p.sand : p.rock, rand() * 0.16));
        ctx.fill();
        ctx.strokeStyle = css(mix(p.plaza, p.rock, 0.45));
        ctx.lineWidth = Math.max(1.2, 0.07 * k);
        ctx.stroke();
      }
    }
    // An inlay ring just inside the lamps.
    ctx.strokeStyle = css(mix(p.sand, p.trunk, 0.35));
    ctx.lineWidth = 0.16 * k;
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, (PLAZA_RADIUS - 3.2) * k, 0, Math.PI * 2);
    ctx.stroke();
    // The hub's own ground: the paved forecourt and the path to the spawn (src/views/walk/hub.ts).
    ctx.save();
    ctx.setTransform(k, 0, 0, k, PLAZA_RADIUS * k, PLAZA_RADIUS * k);
    drawHubGround(ctx, p, k);
    ctx.restore();
    const tex = own(canvasTexture(cv));
    tex.anisotropy = 8;
    const plaza = new THREE.Mesh(own(new THREE.CircleGeometry(PLAZA_RADIUS, 96)), own(new THREE.MeshLambertMaterial({ map: tex })));
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.y = 0.03;
    plaza.receiveShadow = true;
    root.add(plaza);
    const curb = new THREE.Mesh(
      own(new THREE.RingGeometry(PLAZA_RADIUS - 0.05, PLAZA_RADIUS + 0.6, 96)),
      own(new THREE.MeshLambertMaterial({ color: mix(p.plaza, p.rock, 0.55) })),
    );
    curb.rotation.x = -Math.PI / 2;
    curb.position.y = 0.04;
    curb.receiveShadow = true;
    root.add(curb);
  }

  /* ---------------- roads ---------------- */
  {
    const [cv, ctx] = cpuCanvas(64, 256);
    const css = (c: THREE.Color) => `#${c.getHexString()}`;
    ctx.fillStyle = css(p.road);
    ctx.fillRect(0, 0, 64, 256);
    const rand = seededRandom(hashString("walk-road"));
    for (let i = 0; i < 260; i++) {
      ctx.fillStyle = css(mix(p.road, rand() > 0.5 ? p.sand : p.rock, 0.25 + rand() * 0.2));
      ctx.globalAlpha = 0.35;
      ctx.fillRect(rand() * 64, rand() * 256, 2 + rand() * 3, 2 + rand() * 3);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = css(mix(p.road, p.rock, 0.6));
    ctx.fillRect(0, 0, 5, 256);
    ctx.fillRect(59, 0, 5, 256);
    ctx.fillStyle = css(mix(p.road, p.rock, 0.3));
    for (let y = 16; y < 256; y += 64) ctx.fillRect(30, y, 4, 30);
    const tex = own(canvasTexture(cv));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;

    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (const disc of layout.discs) {
      const r0 = PLAZA_RADIUS - 0.4;
      const r1 = Math.hypot(disc.x, disc.z) - disc.r + 0.4;
      const ux = Math.cos(disc.angle);
      const uz = Math.sin(disc.angle);
      const nx = -uz * (ROAD_WIDTH / 2);
      const nz = ux * (ROAD_WIDTH / 2);
      const len = r1 - r0;
      const steps = Math.max(1, Math.ceil(len / 6));
      const base = pos.length / 3;
      for (let s = 0; s <= steps; s++) {
        const r = r0 + (len * s) / steps;
        const cx = ux * r;
        const cz = uz * r;
        pos.push(cx - nx, 0.045, cz - nz, cx + nx, 0.045, cz + nz);
        const v = ((len * s) / steps) / (ROAD_WIDTH * 1.6);
        uv.push(0, v, 1, v);
        if (s < steps) {
          const k = base + s * 2;
          idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
        }
      }
    }
    const g = own(new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // Index winding may face down; force normals up.
    const nrm = g.attributes.normal;
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
    const roads = new THREE.Mesh(
      g,
      own(new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 })),
    );
    roads.receiveShadow = true;
    root.add(roads);
  }

  /* ---------------- districts: ground patches, rings, landmarks, arches ---------------- */
  const emblems: { mesh: THREE.Group; base: number; phase: number; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; color: string }[] = [];
  const emblemBySlug = new Map<AreaSlug, (typeof emblems)[number]>();
  {
    const flat: THREE.BufferGeometry[] = [];
    const solid: THREE.BufferGeometry[] = [];
    const flatAt = (g: THREE.BufferGeometry, x: number, y: number, z: number, color: THREE.Color) => {
      g.rotateX(-Math.PI / 2);
      g.translate(x, y, z);
      flat.push(paint(g, color));
    };
    const solidAt = (g: THREE.BufferGeometry, x: number, y: number, z: number, color: THREE.Color, rotY = 0) => {
      if (rotY) g.rotateY(rotY);
      g.translate(x, y, z);
      solid.push(paint(g, color));
    };
    const stone = mix(p.plaza, p.rock, 0.3);
    const stoneDark = mix(p.plaza, p.rock, 0.65);

    for (const disc of layout.discs) {
      const d = districtBy.get(disc.slug);
      if (!d) continue;
      const col = new THREE.Color(d.color);
      const tint = mix(p.grass, col, 0.26).lerp(p.plaza, 0.12);
      flatAt(new THREE.CircleGeometry(disc.r, 72), disc.x, 0.02, disc.z, tint);
      flatAt(new THREE.RingGeometry(disc.r - 0.6, disc.r, 96), disc.x, 0.034, disc.z, col);
      flatAt(new THREE.RingGeometry(disc.r - 1.5, disc.r - 1.25, 96), disc.x, 0.034, disc.z, mix(tint, col, 0.45));
      flatAt(new THREE.CircleGeometry(CORE_RADIUS - 0.4, 48), disc.x, 0.038, disc.z, mix(p.plaza, col, 0.08));
      flatAt(new THREE.RingGeometry(CORE_RADIUS - 0.4, CORE_RADIUS, 48), disc.x, 0.04, disc.z, mix(col, p.plaza, 0.15));

      // Landmark: a stepped stone plinth, an obelisk in the district color, a capstone.
      solidAt(new THREE.CylinderGeometry(2.3, 2.5, 0.3, 6), disc.x, 0.15, disc.z, stoneDark);
      solidAt(new THREE.CylinderGeometry(1.85, 2.05, 0.35, 6), disc.x, 0.47, disc.z, stone);
      solidAt(new THREE.CylinderGeometry(0.62, 1.05, 5.4, 4), disc.x, 3.35, disc.z, col, Math.PI / 4);
      solidAt(new THREE.CylinderGeometry(1.1, 1.1, 0.22, 4), disc.x, 0.75, disc.z, mix(col, p.ink, 0.25), Math.PI / 4);
      solidAt(new THREE.ConeGeometry(0.72, 0.9, 4), disc.x, 6.5, disc.z, mix(col, p.plaza, 0.55), Math.PI / 4);
      colliders.push({ x: disc.x, z: disc.z, r: 2.2, h: 9.6 });
      blockers.push({ x: disc.x, z: disc.z, r: 2.4, h: 9.6 });
      // Four bollards around the core.
      for (let i = 0; i < 4; i++) {
        const a = disc.angle + Math.PI / 4 + (i * Math.PI) / 2;
        const bx = disc.x + Math.cos(a) * (CORE_RADIUS - 0.9);
        const bz = disc.z + Math.sin(a) * (CORE_RADIUS - 0.9);
        solidAt(new THREE.CylinderGeometry(0.16, 0.2, 0.8, 6), bx, 0.4, bz, stone);
        solidAt(new THREE.SphereGeometry(0.2, 8, 6), bx, 0.9, bz, mix(col, p.plaza, 0.35));
        colliders.push({ x: bx, z: bz, r: 0.3, h: 1.1 });
      }

      // Entry arch where the road meets the district.
      const ux = Math.cos(disc.angle);
      const uz = Math.sin(disc.angle);
      const ar = Math.hypot(disc.x, disc.z) - disc.r + 0.2;
      const ax = ux * ar;
      const az = uz * ar;
      const sign = labelTexture(d.short, { color: p.css.ink, bg: "#ffffff", size: 56, weight: 700, padX: 30 });
      own(sign.texture); // cached as bytes; disposing frees this renderer's copy only
      const signH = 0.82;
      const signW = signH * sign.aspect;
      const span = Math.max(ROAD_WIDTH + 1.4, signW + 0.8);
      const yaw = -disc.angle + Math.PI / 2; // local +z points along the road, outward
      const px = -uz;
      const pz = ux;
      for (const side of [-1, 1]) {
        const qx = ax + px * (span / 2) * side;
        const qz = az + pz * (span / 2) * side;
        solidAt(new THREE.BoxGeometry(0.34, 4.3, 0.34), qx, 2.15, qz, col, yaw);
        solidAt(new THREE.BoxGeometry(0.56, 0.3, 0.56), qx, 0.15, qz, stoneDark, yaw);
        colliders.push({ x: qx, z: qz, r: 0.45, h: 4.6 });
      }
      // Fly-to views avoid parking the camera just behind an arch (its sign would fill the frame).
      // Not a follow-camera blocker: the gateway is open, and framing the walker through it looks right.
      arches.push({ x: ax, z: az, r: span / 2 + 0.4, h: 4.8 });
      solidAt(new THREE.BoxGeometry(span + 0.7, 0.36, 0.42), ax, 4.35, az, col, yaw);
      solidAt(new THREE.BoxGeometry(span + 0.2, 0.12, 0.3), ax, 3.62, az, mix(col, p.ink, 0.3), yaw);
      const signMat = own(withNearFade(new THREE.MeshBasicMaterial({ map: sign.texture, transparent: true, toneMapped: false }), nearFade));
      const signGeo = own(new THREE.PlaneGeometry(signW, signH));
      for (const flip of [0, Math.PI]) {
        const m = new THREE.Mesh(signGeo, signMat);
        m.position.set(ax, 3.95, az);
        // The road runs along the arch's normal; one face toward the plaza, one toward the district.
        m.rotation.y = Math.atan2(-ux, -uz) + flip;
        m.position.x += -ux * 0.23 * (flip ? -1 : 1);
        m.position.z += -uz * 0.23 * (flip ? -1 : 1);
        root.add(m);
      }

      // Emblem: a medallion floating above the obelisk, carrying the district icon.
      const [cv] = cpuCanvas(256, 256);
      const tex = own(canvasTexture(cv));
      const medallion = new THREE.Group();
      const faceMat = own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
      const face = new THREE.Mesh(own(new THREE.CircleGeometry(1.25, 40)), faceMat);
      face.position.z = 0.07;
      const back = new THREE.Mesh(face.geometry, faceMat);
      back.rotation.y = Math.PI;
      back.position.z = -0.07;
      const rim = new THREE.Mesh(
        own(new THREE.CylinderGeometry(1.33, 1.33, 0.12, 40)),
        own(new THREE.MeshLambertMaterial({ color: col })),
      );
      rim.rotation.x = Math.PI / 2;
      rim.castShadow = true;
      medallion.add(rim, face, back);
      medallion.position.set(disc.x, 8.1, disc.z);
      root.add(medallion);
      const entry = { mesh: medallion, base: 8.1, phase: (hashString(d.slug) % 628) / 100, canvas: cv, tex, color: d.color };
      drawEmblem(entry.canvas, d.color, null);
      tex.needsUpdate = true;
      emblems.push(entry);
      emblemBySlug.set(d.slug, entry);
    }

    const flatGeo = own(merge(flat));
    const flatNrm = flatGeo.attributes.normal;
    for (let i = 0; i < flatNrm.count; i++) flatNrm.setXYZ(i, 0, 1, 0);
    const patches = new THREE.Mesh(
      flatGeo,
      own(new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 })),
    );
    patches.receiveShadow = true;
    root.add(patches);
    const landmarks = new THREE.Mesh(own(merge(solid)), propMaterial());
    landmarks.castShadow = true;
    landmarks.receiveShadow = true;
    root.add(landmarks);
  }

  /* ---------------- the hub (src/views/walk/hub.ts) and the Nexus portal beside it ---------------- */
  const hub = buildHub(p, own, nearFade);
  root.add(hub.group, hub.beaconHead);
  colliders.push(...hub.colliders);
  boxes.push(...hub.boxes);
  blockers.push(...hub.blockers);
  const portal = buildPortal(p, own, nearFade);
  root.add(portal.group);

  /* ---------------- plaza furniture: lamps, benches, planters ---------------- */
  {
    const lampSpots = plazaLamps(layout);
    const iron = mix(p.navy, p.ink, 0.35);
    const lampParts = [
      paint(new THREE.CylinderGeometry(0.06, 0.1, 3.2, 6).translate(0, 1.6, 0), iron),
      paint(new THREE.CylinderGeometry(0.2, 0.24, 0.2, 8).translate(0, 0.1, 0), iron),
      paint(new THREE.SphereGeometry(0.28, 10, 8).translate(0, 3.35, 0), mix(p.sun, p.sand, 0.2)),
      paint(new THREE.ConeGeometry(0.34, 0.26, 8).translate(0, 3.64, 0), iron),
    ];
    const lampGeo = own(merge(lampParts));
    const lampMat = propMaterial();
    const lamps = new THREE.InstancedMesh(lampGeo, lampMat, lampSpots.length);
    const m4 = new THREE.Matrix4();
    lampSpots.forEach((l, i) => {
      m4.makeTranslation(l.x, 0, l.z);
      lamps.setMatrixAt(i, m4);
      colliders.push({ x: l.x, z: l.z, r: 0.3, h: 3.9 });
    });
    lamps.castShadow = true;
    root.add(lamps);
    own(lamps);

    // Benches and planters alternate around a ring inside the lamps, clear of the roads, the spawn and the building.
    const benchParts = [
      paint(new THREE.BoxGeometry(2.0, 0.12, 0.6).translate(0, 0.5, 0), p.trunk),
      paint(new THREE.BoxGeometry(2.0, 0.5, 0.1).translate(0, 0.85, -0.28), p.trunk),
      paint(new THREE.BoxGeometry(0.12, 0.5, 0.55).translate(-0.85, 0.25, 0), p.ink),
      paint(new THREE.BoxGeometry(0.12, 0.5, 0.55).translate(0.85, 0.25, 0), p.ink),
    ];
    const benchGeo = own(merge(benchParts));
    const planterParts = [
      paint(new THREE.CylinderGeometry(1.0, 0.85, 0.7, 10).translate(0, 0.35, 0), mix(p.plaza, p.rock, 0.5)),
      paint(new THREE.IcosahedronGeometry(0.95, 1).scale(1, 0.7, 1).translate(0, 1.05, 0), p.tree),
    ];
    const planterGeo = own(merge(planterParts));
    const spots = plazaSeats(layout);
    const benches = new THREE.InstancedMesh(benchGeo, lampMat, Math.max(1, spots.filter((s) => s.kind === "bench").length));
    const planters = new THREE.InstancedMesh(planterGeo, lampMat, Math.max(1, spots.filter((s) => s.kind === "planter").length));
    let bi = 0;
    let pi = 0;
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (const s of spots) {
      // Benches face the plaza center.
      q.setFromAxisAngle(up, Math.atan2(-s.x, -s.z));
      m4.compose(new THREE.Vector3(s.x, 0.03, s.z), q, new THREE.Vector3(1, 1, 1));
      if (s.kind === "bench") {
        benches.setMatrixAt(bi++, m4);
        colliders.push({ x: s.x, z: s.z, r: 1.0, h: 1.0 });
      } else {
        planters.setMatrixAt(pi++, m4);
        colliders.push({ x: s.x, z: s.z, r: 1.15, h: 1.8 });
      }
    }
    benches.count = bi;
    planters.count = pi;
    benches.castShadow = planters.castShadow = true;
    benches.receiveShadow = planters.receiveShadow = true;
    root.add(benches, planters);
    own(benches);
    own(planters);
  }

  /* ---------------- decor: trees, pines, palms, shrubs, rocks ---------------- */
  {
    const items = decorPoints(layout, 460, hashString("walk-decor"));
    const decorMat = propMaterial();
    const round = own(
      merge([
        paint(new THREE.CylinderGeometry(0.2, 0.3, 1.8, 6).translate(0, 0.9, 0), p.trunk),
        paint(new THREE.IcosahedronGeometry(1.45, 1).translate(0, 2.6, 0), p.tree),
        paint(new THREE.IcosahedronGeometry(1.0, 1).translate(0.7, 2.2, 0.35), mix(p.tree, p.grass, 0.3)),
      ]),
    );
    const pine = own(
      merge([
        paint(new THREE.CylinderGeometry(0.18, 0.26, 1.2, 6).translate(0, 0.6, 0), p.trunk),
        paint(new THREE.ConeGeometry(1.45, 2.4, 7).translate(0, 2.0, 0), p.treeDark),
        paint(new THREE.ConeGeometry(1.1, 2.0, 7).translate(0, 3.2, 0), mix(p.treeDark, p.tree, 0.4)),
      ]),
    );
    const palmParts: THREE.BufferGeometry[] = [];
    {
      // A gently leaning trunk of stacked segments, then a crown of fronds.
      let x = 0;
      for (let i = 0; i < 5; i++) {
        const seg = new THREE.CylinderGeometry(0.17 - i * 0.015, 0.21 - i * 0.015, 0.95, 6);
        seg.rotateZ(-0.06 * i);
        seg.translate(x, 0.47 + i * 0.9, 0);
        x += 0.07 * i;
        palmParts.push(paint(seg, i % 2 ? mix(p.trunk, p.sand, 0.3) : p.trunk));
      }
      const top = new THREE.Vector3(x, 4.6, 0);
      for (let i = 0; i < 7; i++) {
        const frond = new THREE.ConeGeometry(0.36, 2.6, 4);
        frond.scale(1, 1, 0.25);
        frond.translate(0, 1.3, 0);
        frond.rotateZ(-1.15 - (i % 2) * 0.25);
        frond.rotateY((i / 7) * Math.PI * 2);
        frond.translate(top.x, top.y, top.z);
        palmParts.push(paint(frond, i % 2 ? p.tree : mix(p.tree, p.grassDark, 0.5)));
      }
      palmParts.push(paint(new THREE.IcosahedronGeometry(0.32, 0).translate(top.x, top.y - 0.1, 0), p.trunk));
    }
    const palm = own(merge(palmParts));
    const shrub = own(merge([paint(new THREE.IcosahedronGeometry(0.95, 1).scale(1.15, 0.7, 1).translate(0, 0.45, 0), mix(p.tree, p.grass, 0.45))]));
    const rock = own(merge([paint(new THREE.DodecahedronGeometry(0.85, 0).scale(1.3, 0.75, 1).translate(0, 0.32, 0), p.rock)]));

    type Kind = "round" | "pine" | "palm" | "shrub" | "rock";
    const groups: Record<Kind, { x: number; z: number; s: number; y: number; rot: number; tint: number }[]> = {
      round: [],
      pine: [],
      palm: [],
      shrub: [],
      rock: [],
    };
    const rand = seededRandom(hashString("walk-decor-jitter"));
    for (const it of items) {
      const r = Math.hypot(it.x, it.z);
      const a = Math.atan2(it.z, it.x);
      const s = terrain.shoreAt(a);
      const y = terrain.heightAt(it.x, it.z);
      if (y < SEA_LEVEL + 0.1) continue;
      const coastal = r > s - 20;
      let kind: Kind = it.k === 0 ? "round" : it.k === 1 ? "pine" : it.k === 2 ? "shrub" : "rock";
      if (coastal && (kind === "round" || kind === "pine")) kind = "palm";
      else if (!coastal && r < layout.ringRadius && kind === "pine" && rand() < 0.5) kind = "round";
      groups[kind].push({ x: it.x, z: it.z, s: it.s, y, rot: rand() * Math.PI * 2, tint: rand() });
      const cr = kind === "shrub" ? 0.6 : kind === "rock" ? 0.75 : 0.45;
      const ch = kind === "round" ? 4.1 : kind === "pine" ? 4.3 : kind === "palm" ? 4.9 : kind === "shrub" ? 1.0 : 0.7;
      // Canopies are wider than trunks: the camera clears the crown, the walker only bumps the trunk.
      colliders.push({ x: it.x, z: it.z, r: cr * it.s, h: y + ch * it.s });
      if (kind === "round" || kind === "pine" || kind === "palm") blockers.push({ x: it.x, z: it.z, r: (kind === "palm" ? 1.7 : 1.5) * it.s, h: y + ch * it.s });
    }
    const geos: Record<Kind, THREE.BufferGeometry> = { round, pine, palm, shrub, rock };
    const color = new THREE.Color();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const m4 = new THREE.Matrix4();
    for (const kind of Object.keys(groups) as Kind[]) {
      const list = groups[kind];
      if (!list.length) continue;
      const mesh = new THREE.InstancedMesh(geos[kind], decorMat, list.length);
      list.forEach((it, i) => {
        q.setFromAxisAngle(up, it.rot);
        const sy = kind === "rock" ? it.s * 0.9 : it.s;
        m4.compose(new THREE.Vector3(it.x, it.y - 0.06, it.z), q, new THREE.Vector3(it.s, sy, it.s));
        mesh.setMatrixAt(i, m4);
        const v = 0.88 + it.tint * 0.24;
        color.setRGB(v, v * (0.98 + it.tint * 0.04), v * 0.97);
        mesh.setColorAt(i, color);
      });
      mesh.castShadow = kind !== "rock" && kind !== "shrub";
      mesh.receiveShadow = true;
      root.add(mesh);
      own(mesh);
    }
  }

  /* ---------------- clouds ---------------- */
  const clouds: THREE.Sprite[] = [];
  {
    const [cv, ctx] = cpuCanvas(256, 128);
    const rand = seededRandom(hashString("walk-clouds"));
    for (let i = 0; i < 16; i++) {
      const r = 18 + rand() * 30;
      const x = 50 + rand() * 156;
      const y = 50 + rand() * 30;
      const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, "rgba(255,255,255,0.9)");
      gr.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = gr;
      ctx.fillRect(0, 0, 256, 128);
    }
    const tex = own(canvasTexture(cv));
    const field = seededRandom(hashString("walk-cloud-field"));
    for (let i = 0; i < 14; i++) {
      const mat = own(new THREE.SpriteMaterial({ map: tex, color: p.dark ? "#52525b" : "#ffffff", transparent: true, opacity: 0.55 + field() * 0.3, depthWrite: false, fog: false }));
      const s = new THREE.Sprite(mat);
      const a = field() * Math.PI * 2;
      const r = 180 + field() * 420;
      s.position.set(Math.cos(a) * r, 80 + field() * 70, Math.sin(a) * r);
      const k = 90 + field() * 120;
      s.scale.set(k, k * 0.45, 1);
      s.userData.speed = 1 + field() * 2;
      s.renderOrder = -5;
      clouds.push(s);
      root.add(s);
    }
  }

  /* ---------------- emblem icons ---------------- */
  function setDistrictIcon(slug: AreaSlug, svg: string) {
    const e = emblemBySlug.get(slug);
    if (!e) return;
    const img = new Image();
    img.onload = () => {
      drawEmblem(e.canvas, e.color, img);
      e.tex.needsUpdate = true;
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  /* ---------------- per-frame ---------------- */
  function update(time: number, dt: number, reduced: boolean, cameraYaw: number) {
    // The hub's rooftop sign turns to face the camera (a yaw, not motion: kept under reduced motion).
    hub.update(cameraYaw);
    portal.update(time, reduced);
    for (const e of emblems) {
      e.mesh.rotation.y = cameraYaw;
      e.mesh.position.y = reduced ? e.base : e.base + Math.sin(time * 1.1 + e.phase) * 0.18;
    }
    if (reduced) return;
    seaNormal.offset.set(time * 0.006, time * 0.009);
    foamMat.opacity = 0.38 + Math.sin(time * 0.9) * 0.14;
    for (const c of clouds) {
      c.position.x += c.userData.speed * dt;
      if (c.position.x > 650) c.position.x = -650;
    }
  }

  function dispose() {
    hub.dispose();
    portal.dispose();
    for (const d of disposables) d.dispose();
    sun.dispose();
    // three.js shares one geometry between every Sprite; its renderer 'dispose' listener would
    // otherwise keep this dead view alive (the globe does the same on unmount).
    clouds[0]?.geometry.dispose();
  }

  return {
    root,
    colliders,
    blockers,
    arches,
    boxes,
    sun,
    sunDir,
    hemi,
    nearFade,
    landmarkTop: LANDMARK_TOP,
    hubTop: hub.hubTop,
    beacon: hub.beacon,
    hubOccluder: hub.occluder,
    setDistrictIcon,
    update,
    dispose,
  };
}

/** A round medallion: white face, district-color ring, the icon in the district color. */
function drawEmblem(canvas: HTMLCanvasElement, color: string, icon: HTMLImageElement | null) {
  const ctx = cpuContext(canvas);
  const S = canvas.width;
  ctx.clearRect(0, 0, S, S);
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S / 2 - 18, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  if (icon) {
    const k = S * 0.52;
    ctx.drawImage(icon, (S - k) / 2, (S - k) / 2, k, k);
  }
}
