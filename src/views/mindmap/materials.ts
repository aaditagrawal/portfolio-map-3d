/* Shaders for the company globe. All procedural; nothing is fetched.

   - Glass: the solid globe surface. Each fragment finds the region
     that owns it with the same additively weighted rule as territoryOf()
     in globeLayout.ts, tints itself in that district's color, and draws a
     thin seam where two territories meet.
   - FatLines: every arc in one instanced draw call per batch. Screen-space
     width, per-vertex RGBA, a per-line emphasis value (for dimming), and an
     optional dash or traveling pulse. The globe hides far-side connections.
   - SurfaceDots: the little district-colored pins under each logo and the
     hub marker at each region's center, as one Points object. */
import * as THREE from "three";
import type { Vec3 } from "./globeLayout";
import { globePalette, type GlobePalette } from "./palette";

/* 1 when world point P is in front of the globe (radius uRadius at the origin), 0 when hidden by it. */
const VISIBILITY_GLSL = /* glsl */ `
uniform float uRadius;
float globeVisibility(vec3 P) {
  vec3 C = cameraPosition;
  vec3 d = P - C;
  float t = clamp(-dot(C, d) / max(dot(d, d), 1e-6), 0.0, 1.0);
  if (t > 0.999) return 1.0;
  float dist = length(C + d * t);
  return smoothstep(uRadius - 1.6, uRadius + 0.4, dist);
}
`;

/* ---------------------------------------------------------------- glass */

export interface GlassRegion {
  center: Vec3;
  radius: number;
  color: string;
}

export function createGlassMaterial(regions: GlassRegion[]): THREE.ShaderMaterial {
  const palette = globePalette();
  const list = regions.length ? regions : [{ center: [0, 1, 0] as Vec3, radius: 0, color: "#ffffff" }];
  const n = list.length;
  return new THREE.ShaderMaterial({
    // A solid surface hides far-side artwork instead of showing unreadable ghost labels.
    transparent: false,
    depthWrite: true,
    side: THREE.FrontSide,
    defines: { REGIONS: n },
    uniforms: {
      uCenter: { value: list.map((r) => new THREE.Vector3(...r.center)) },
      uSize: { value: list.map((r) => r.radius) },
      uColor: { value: list.map((r) => new THREE.Color(r.color)) },
      uFocus: { value: -1 },
      uFocusAmt: { value: 0 },
      uLight: { value: new THREE.Vector3(-0.45, 0.75, 0.5).normalize() },
      uOpacity: { value: 1 },
      uBase: { value: new THREE.Color(palette.surface) },
      uRim: { value: new THREE.Color(palette.rim) },
      uDark: { value: palette.dark ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vLocal = normalize(position);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uCenter[REGIONS];
      uniform float uSize[REGIONS];
      uniform vec3 uColor[REGIONS];
      uniform float uFocus;
      uniform float uFocusAmt;
      uniform vec3 uLight;
      uniform float uOpacity;
      uniform vec3 uBase;
      uniform vec3 uRim;
      uniform float uDark;
      varying vec3 vLocal;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec3 p = normalize(vLocal);
        float best = 1e3;
        float second = 1e3;
        float bestIdx = -1.0;
        vec3 col = vec3(1.0);
        for (int i = 0; i < REGIONS; i++) {
          float d = acos(clamp(dot(p, uCenter[i]), -1.0, 1.0)) - uSize[i];
          if (d < best) { second = best; best = d; bestIdx = float(i); col = uColor[i]; }
          else if (d < second) { second = d; }
        }
        float edge = second - best;
        float w = fwidth(edge);
        float seam = 1.0 - smoothstep(w * 0.5, w * 1.4 + 0.0009, edge);
        // Inside a region's cap reads as "land"; between caps the tint thins out.
        float land = 1.0 - smoothstep(-0.015, 0.07, best);
        float isFocus = (uFocus > -0.5 && abs(bestIdx - uFocus) < 0.5) ? 1.0 : 0.0;
        float tint = mix(0.045, 0.16, land);
        tint *= mix(1.0, mix(0.6, 1.32, isFocus), uFocusAmt);
        vec3 n = normalize(vN);
        vec3 v = normalize(vV);
        float ndl = dot(n, uLight);
        vec3 base = mix(uBase, col, clamp(tint, 0.0, 0.32));
        vec3 c = base * (mix(0.58, 0.28, uDark) + max(ndl, 0.0) * 0.56);
        // Clamped: dot(n, v) of two normalized interpolants can round above 1, and pow() of a
        // negative base is undefined (NaN on GPUs that compute it as exp2(y * log2(x))).
        float fres = pow(clamp(1.0 - dot(n, v), 0.0, 1.0), 2.2);
        c = mix(c, uRim, seam * 0.38);
        c = mix(c, uRim, fres * 0.12);
        float spec = pow(max(dot(reflect(-uLight, n), v), 0.0), 24.0);
        c += spec * 0.045;
        gl_FragColor = vec4(c, uOpacity);
        #include <colorspace_fragment>
      }
    `,
  });
}

export function applyGlassPalette(material: THREE.ShaderMaterial, palette: GlobePalette): void {
  material.uniforms.uBase.value.set(palette.surface);
  material.uniforms.uRim.value.set(palette.rim);
  material.uniforms.uDark.value = palette.dark ? 1 : 0;
}

/* ------------------------------------------------------------ fat lines */

export interface LineSpec {
  points: Vec3[];
  color: string;
  alpha: number;
  /** Optional color at the end of the line (the start color fades into it). */
  colorEnd?: string;
  alphaEnd?: number;
}

export interface FatLineOptions {
  /** Width in CSS pixels. */
  width: number;
  /** Dash period in world units (0 = solid). */
  dash?: number;
  /** Visible share of each dash period. */
  dashRatio?: number;
  /** Dash/pulse travel speed, world units per second (0 = still). */
  flow?: number;
  /** 1 = a soft pulse travels along the line (documented links). */
  pulse?: number;
  /** Opacity multiplier for parts the globe hides. */
  backAlpha?: number;
  /**
   * 0..1: fade the line where it runs along the globe's silhouette. Many lines seen
   * edge-on at the rim stack into a bright cage; this keeps them to the face of the globe.
   */
  rimFade?: number;
  radius: number;
}

const QUAD_POS = new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0]);
const QUAD_IDX = [0, 2, 1, 2, 3, 1];

export class FatLines {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private geometry: THREE.InstancedBufferGeometry;
  private lineOf = new Int32Array(0);
  private emph: THREE.InstancedBufferAttribute | null = null;
  lineCount = 0;

  constructor(opts: FatLineOptions) {
    this.geometry = new THREE.InstancedBufferGeometry();
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uResolution: { value: new THREE.Vector2(1, 1) },
        uWidth: { value: opts.width },
        uTime: { value: 0 },
        uDash: { value: opts.dash ?? 0 },
        uDashRatio: { value: opts.dashRatio ?? 0.55 },
        uFlow: { value: opts.flow ?? 0 },
        uPulse: { value: opts.pulse ?? 0 },
        uBackAlpha: { value: opts.backAlpha ?? 0.16 },
        uRimFade: { value: opts.rimFade ?? 0 },
        uRadius: { value: opts.radius },
        uOpacity: { value: 1 },
        uPixelRatio: { value: 1 },
      },
      vertexShader: /* glsl */ `
        ${VISIBILITY_GLSL}
        uniform vec2 uResolution;
        uniform float uWidth;
        uniform float uPixelRatio;
        uniform float uBackAlpha;
        uniform float uRimFade;
        attribute vec3 instanceStart;
        attribute vec3 instanceEnd;
        attribute vec4 instanceColorStart;
        attribute vec4 instanceColorEnd;
        attribute float instanceUStart;
        attribute float instanceUEnd;
        attribute float instanceEmph;
        varying vec4 vColor;
        varying float vU;
        varying float vEdge;
        void main() {
          bool isEnd = position.y > 0.5;
          vec4 ws = modelMatrix * vec4(instanceStart, 1.0);
          vec4 we = modelMatrix * vec4(instanceEnd, 1.0);
          vec4 cs = projectionMatrix * viewMatrix * ws;
          vec4 ce = projectionMatrix * viewMatrix * we;
          vec2 ss = cs.xy / cs.w * uResolution;
          vec2 se = ce.xy / ce.w * uResolution;
          vec2 dir = se - ss;
          float len = length(dir);
          dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
          vec2 nrm = vec2(-dir.y, dir.x);
          vec4 clip = isEnd ? ce : cs;
          float w = (uWidth + 1.0) * uPixelRatio;
          clip.xy += nrm * position.x * w / uResolution * clip.w;
          gl_Position = clip;
          vec3 P = isEnd ? we.xyz : ws.xyz;
          vColor = isEnd ? instanceColorEnd : instanceColorStart;
          float facing = dot(normalize(P), normalize(cameraPosition - P));
          float rim = mix(1.0, smoothstep(-0.04, 0.42, facing), uRimFade);
          vColor.a *= instanceEmph * rim * mix(uBackAlpha, 1.0, globeVisibility(P));
          vU = isEnd ? instanceUEnd : instanceUStart;
          vEdge = position.x;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uDash;
        uniform float uDashRatio;
        uniform float uFlow;
        uniform float uPulse;
        uniform float uOpacity;
        uniform float uWidth;
        varying vec4 vColor;
        varying float vU;
        varying float vEdge;
        void main() {
          float a = vColor.a * uOpacity;
          float u = vU - uTime * uFlow;
          if (uDash > 0.0) {
            float ph = fract(u / uDash);
            float aa = 0.08;
            a *= smoothstep(0.0, aa, ph) * (1.0 - smoothstep(uDashRatio, uDashRatio + aa, ph));
          }
          if (uPulse > 0.0) {
            float ph = fract(u / 46.0);
            float glow = smoothstep(0.0, 0.18, ph) * (1.0 - smoothstep(0.18, 0.5, ph));
            a *= 0.62 + 0.38 * glow;
          }
          // Soft edges (cheap anti-aliasing across the quad's width).
          float px = (uWidth + 1.0);
          float edge = 1.0 - smoothstep(1.0 - 1.4 / px, 1.0, abs(vEdge));
          a *= edge;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vColor.rgb, a);
          #include <colorspace_fragment>
        }
      `,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.raycast = () => {};
  }

  /** Replace every line in the batch. Line i keeps index i for setEmphasis(). */
  setLines(lines: LineSpec[]): void {
    const segs = lines.reduce((a, l) => a + Math.max(0, l.points.length - 1), 0);
    const start = new Float32Array(segs * 3);
    const end = new Float32Array(segs * 3);
    const cStart = new Float32Array(segs * 4);
    const cEnd = new Float32Array(segs * 4);
    const uStart = new Float32Array(segs);
    const uEnd = new Float32Array(segs);
    const emph = new Float32Array(segs).fill(1);
    const lineOf = new Int32Array(segs);
    const c0 = new THREE.Color();
    const c1 = new THREE.Color();
    let s = 0;
    lines.forEach((l, li) => {
      c0.set(l.color);
      c1.set(l.colorEnd ?? l.color);
      const a0 = l.alpha;
      const a1 = l.alphaEnd ?? l.alpha;
      const n = l.points.length - 1;
      let u = 0;
      for (let k = 0; k < n; k++, s++) {
        const p = l.points[k];
        const q = l.points[k + 1];
        start.set(p, s * 3);
        end.set(q, s * 3);
        const t0 = k / n;
        const t1 = (k + 1) / n;
        cStart.set([c0.r + (c1.r - c0.r) * t0, c0.g + (c1.g - c0.g) * t0, c0.b + (c1.b - c0.b) * t0, a0 + (a1 - a0) * t0], s * 4);
        cEnd.set([c0.r + (c1.r - c0.r) * t1, c0.g + (c1.g - c0.g) * t1, c0.b + (c1.b - c0.b) * t1, a0 + (a1 - a0) * t1], s * 4);
        const len = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
        uStart[s] = u;
        u += len;
        uEnd[s] = u;
        lineOf[s] = li;
      }
    });
    const old = this.geometry;
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex(QUAD_IDX);
    g.setAttribute("position", new THREE.Float32BufferAttribute(QUAD_POS, 3));
    g.setAttribute("instanceStart", new THREE.InstancedBufferAttribute(start, 3));
    g.setAttribute("instanceEnd", new THREE.InstancedBufferAttribute(end, 3));
    g.setAttribute("instanceColorStart", new THREE.InstancedBufferAttribute(cStart, 4));
    g.setAttribute("instanceColorEnd", new THREE.InstancedBufferAttribute(cEnd, 4));
    g.setAttribute("instanceUStart", new THREE.InstancedBufferAttribute(uStart, 1));
    g.setAttribute("instanceUEnd", new THREE.InstancedBufferAttribute(uEnd, 1));
    this.emph = new THREE.InstancedBufferAttribute(emph, 1);
    this.emph.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("instanceEmph", this.emph);
    g.instanceCount = segs;
    this.geometry = g;
    this.mesh.geometry = g;
    this.mesh.visible = segs > 0;
    this.lineOf = lineOf;
    this.lineCount = lines.length;
    old.dispose();
  }

  /** Per-line emphasis (0..1), multiplied into alpha. */
  setEmphasis(perLine: Float32Array): void {
    if (!this.emph) return;
    const arr = this.emph.array as Float32Array;
    for (let s = 0; s < arr.length; s++) arr[s] = perLine[this.lineOf[s]] ?? 1;
    this.emph.needsUpdate = true;
  }

  setResolution(w: number, h: number, dpr: number): void {
    this.material.uniforms.uResolution.value.set(w * dpr, h * dpr);
    this.material.uniforms.uPixelRatio.value = dpr;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ---------------------------------------------------------- surface dots */

export interface DotSpec {
  pos: Vec3;
  color: string;
  alpha: number;
  /** World-space diameter. */
  size: number;
  /** 0 = solid pin, 1 = ring (hub marker). */
  ring?: number;
}

export class SurfaceDots {
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  private geometry = new THREE.BufferGeometry();
  private emph: THREE.BufferAttribute | null = null;

  constructor(radius: number) {
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uRadius: { value: radius },
        uScale: { value: 400 },
        uBackAlpha: { value: 0.1 },
      },
      vertexShader: /* glsl */ `
        ${VISIBILITY_GLSL}
        uniform float uScale;
        uniform float uBackAlpha;
        attribute vec4 aColor;
        attribute float aSize;
        attribute float aEmph;
        attribute float aRing;
        varying vec4 vColor;
        varying float vRing;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vec4 mv = viewMatrix * wp;
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max(2.0, aSize * uScale / -mv.z);
          vColor = aColor;
          vColor.a *= aEmph * mix(uBackAlpha, 1.0, globeVisibility(wp.xyz));
          vRing = aRing;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec4 vColor;
        varying float vRing;
        void main() {
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          float r = length(c);
          float disc = 1.0 - smoothstep(0.82, 1.0, r);
          float core = 1.0 - smoothstep(0.5, 0.62, r);
          // Pin: a colored dot with a white rim. Hub: colored ring, white band, colored center.
          vec3 col = mix(vec3(1.0), vColor.rgb, core);
          if (vRing > 0.5) {
            float inner = 1.0 - smoothstep(0.3, 0.38, r);
            float band = (1.0 - smoothstep(0.56, 0.64, r)) - inner;
            col = mix(vColor.rgb, vec3(1.0), band);
          }
          float a = disc * vColor.a;
          if (a < 0.004) discard;
          gl_FragColor = vec4(col, a);
          #include <colorspace_fragment>
        }
      `,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.raycast = () => {};
  }

  setDots(dots: DotSpec[]): void {
    const pos = new Float32Array(dots.length * 3);
    const col = new Float32Array(dots.length * 4);
    const size = new Float32Array(dots.length);
    const ring = new Float32Array(dots.length);
    const emph = new Float32Array(dots.length).fill(1);
    const c = new THREE.Color();
    dots.forEach((d, i) => {
      pos.set(d.pos, i * 3);
      c.set(d.color);
      col.set([c.r, c.g, c.b, d.alpha], i * 4);
      size[i] = d.size;
      ring[i] = d.ring ?? 0;
    });
    const old = this.geometry;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(col, 4));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    g.setAttribute("aRing", new THREE.BufferAttribute(ring, 1));
    this.emph = new THREE.BufferAttribute(emph, 1);
    this.emph.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("aEmph", this.emph);
    this.geometry = g;
    this.points.geometry = g;
    old.dispose();
  }

  setEmphasis(perDot: Float32Array): void {
    if (!this.emph) return;
    (this.emph.array as Float32Array).set(perDot.subarray(0, this.emph.count));
    this.emph.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
