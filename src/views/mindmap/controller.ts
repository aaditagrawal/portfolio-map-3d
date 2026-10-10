/* The globe's frame loop. React writes inputs (selection, highlight, fly
   requests, HUD commands) into one GlobeController; useFrame calls frame()
   once per frame, which turns the globe, moves the camera, fades nodes and
   arcs, and positions the DOM overlay (district labels, keyboard buttons,
   tooltip). Nothing here sets React state, so nothing re-renders per frame.

   Orientation model: the camera orbits the origin (OrbitControls, no pan);
   the globe itself spins about a fixed, slightly tilted world axis. To bring
   a node or region to the viewer, the globe turns by the smallest rotation
   that carries it to the camera's line of sight, nudged upward when the
   detail sheet covers the bottom of the stage.

   One controller class runs both globes. What a globe carries (its layout, badges, node colors
   and any lines between nodes) comes from a GlobeContent (globeContent.ts): the companies globe
   has industry regions, spokes, documented connections and potential fits; the people globe
   has only its people, evenly spread, with a name label under each, and no lines between
   anyone. Only one globe's scene is mounted at a time; a controller outlives its scene, so a
   globe the visitor switches back to resumes with the same rotation, camera and selection. */
import * as THREE from "three";
import type { DistrictSlug } from "../../data/types";
import { arcLift, arcPoints } from "./arcs";
import { badgeDim, emphasisOf } from "./dimming";
import type { GlobeContent } from "./globeContent";
import { spinAxisFor, type GlobeLayoutOf, type GlobeNode, type GlobeNodeBase, type Vec3 } from "./globeLayout";
import type { FatLines, LineSpec, SurfaceDots, DotSpec } from "./materials";
import { globePalette } from "./palette";
import type { SelectionLinks } from "./selection";

export const GLOBE_RADIUS = 60;
export const FOV = 36;
/** One revolution every ~75 s. */
const SPIN = (2 * Math.PI) / 75;
/** Rotation resumes this long after the last interaction ends. */
const RESUME_MS = 3200;
const TILT = 0.36;
const HOME_POLAR = Math.PI / 2 - 0.2;
const LABEL_LIFT = 2.6;
const SURFACE = 0.3;
/** How much brighter a cross-industry arc gets when its company or region is in focus. */
const CROSS_BOOST = 3.4;
/** Largest share of the stage height the detail sheet is allowed to push the globe out of. */
const MAX_SHEET = 0.62;
/** A company with lines to draw may pull the camera back this much past the close-up. */
const COMPANY_PULLBACK = 1.3;
/** An "overview" node fly (the people globe) comes this much closer than the whole globe above the sheet. */
const OVERVIEW_FLY_ZOOM = 0.88;

/** "person" works like "company": the node with that slug turns to the viewer. */
export type FlyKind = "company" | "person" | "district" | "home";
export interface FlyInput {
  kind: FlyKind;
  slug?: string;
  /** Turn only (keep the camera distance). */
  turnOnly?: boolean;
}

interface Turn {
  kind: "node" | "region";
  index: number;
}

interface CamTween {
  dist: number;
  polar: number | null;
}

interface LineBatches {
  spokes: FatLines;
  cross: FatLines;
  documented: FatLines;
  fits: FatLines;
  dots: SurfaceDots;
}

export interface BadgeSprite extends THREE.Sprite {
  material: THREE.SpriteMaterial;
}

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const IDENTITY = new THREE.Quaternion();

function damp(cur: number, target: number, lambda: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-lambda * dt));
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Share of a point's visibility past the globe (1 = in front, 0 = hidden behind it). Mirrors the shader. */
export function globeVisibility(P: THREE.Vector3, C: THREE.Vector3, R: number): number {
  const dx = P.x - C.x;
  const dy = P.y - C.y;
  const dz = P.z - C.z;
  const dd = dx * dx + dy * dy + dz * dz;
  const t = Math.min(1, Math.max(0, -(C.x * dx + C.y * dy + C.z * dz) / Math.max(dd, 1e-6)));
  if (t > 0.999) return 1;
  const x = C.x + dx * t;
  const y = C.y + dy * t;
  const z = C.z + dz * t;
  return smoothstep(R - 1.6, R + 0.4, Math.sqrt(x * x + y * y + z * z));
}

let focusVisibleSelector: string | null = null;
/** ":focus-visible", or plain ":focus" in browsers that do not know it (Safari before 15.4 throws). */
function focusVisible(): string {
  if (focusVisibleSelector === null) {
    try {
      document.documentElement.matches(":focus-visible");
      focusVisibleSelector = ":focus-visible";
    } catch {
      focusVisibleSelector = ":focus";
    }
  }
  return focusVisibleSelector;
}

export interface OverlayRefs {
  root: HTMLDivElement | null;
  shadow: HTMLDivElement | null;
  labels: (HTMLButtonElement | null)[];
  /** Keyboard buttons laid over the badges of the active region (companies globe). */
  nodeButtons: Map<number, HTMLButtonElement>;
  /** Name labels under the badges, one per node, which are also its buttons (people globe). */
  nodeLabels: Map<number, HTMLButtonElement>;
  tip: HTMLDivElement | null;
  tipName: HTMLElement | null;
  tipMeta: HTMLElement | null;
  tipDot: HTMLElement | null;
}

export class GlobeController<N extends GlobeNodeBase = GlobeNode> {
  readonly layout: GlobeLayoutOf<N>;
  readonly R = GLOBE_RADIUS;
  /** Badge world size and the radius their centers float at. */
  readonly badgeW: number;
  readonly badgeH: number;
  readonly badgeR: number;
  readonly palette = globePalette();

  /* orientation */
  readonly q = new THREE.Quaternion();
  readonly axis = new THREE.Vector3(Math.sin(TILT), Math.cos(TILT), 0).normalize();
  private spin = 0;
  private turn: Turn | null = null;
  private camTween: CamTween | null = null;
  private mode: "home" | "company" | "district" | "free" = "home";

  /* inputs */
  playing = true;
  reduced = false;
  dragging = false;
  pointerInside = false;
  private overUI = false;
  /** Keyboard focus is inside the DOM overlay; read from the DOM each frame (syncFocus). */
  private focusWithin = false;
  private overGlobe = false;
  private lastActive = 0;
  selected = -1;
  focusRegion = -1;
  hovered = -1;
  /** The company button with keyboard focus, or -1; read from the DOM each frame (syncFocus). */
  private kbdFocus = -1;
  private pending: FlyInput | null = null;
  private highlight: Set<string> | null = null;
  private sel: SelectionLinks | null = null;

  /* per node */
  readonly nodeLocal: THREE.Vector3[];
  readonly vis: Float32Array;
  /** How squarely each node faces the camera (1 = head on); badges fade toward the rim below 0.42. */
  readonly facing: Float32Array;
  private emphTarget: Float32Array;
  private emphCur: Float32Array;
  private scaleCur: Float32Array;
  private selAmt = 0;
  private focusAmt = 0;
  private fitsOpacity = 0;
  private emphDirty = true;

  /* per region */
  readonly regionLocal: THREE.Vector3[];
  private labelOpacity: Float32Array;
  private labelSize: { w: number; h: number }[];
  private labelOff: boolean[];

  /* per node name label (the people globe) */
  private nodeLabelOpacity: Float32Array;
  private nodeLabelOff: boolean[];
  private nodeLabelHot: boolean[];
  private nodeLabelSize: { w: number; h: number }[];

  /* scene handles, set by the scene */
  globe: THREE.Group | null = null;
  sprites: BadgeSprite[] = [];
  batches: LineBatches | null = null;
  glass: THREE.ShaderMaterial | null = null;
  core: THREE.Sprite | null = null;
  atmosphere: THREE.Sprite | null = null;
  selGlow: THREE.Sprite | null = null;
  controls: { minDistance: number; maxDistance: number } | null = null;
  readonly overlay: OverlayRefs = { root: null, shadow: null, labels: [], nodeButtons: new Map(), nodeLabels: new Map(), tip: null, tipName: null, tipMeta: null, tipDot: null };
  private canvasEl: HTMLCanvasElement | null = null;
  private cursor = "";

  /* line bookkeeping */
  private spokeOwner: Int32Array = new Int32Array(0);
  private crossOwner: Int32Array = new Int32Array(0);
  private crossTarget: Int32Array = new Int32Array(0);
  private docEnds: Int32Array = new Int32Array(0);
  private lineEmph = { spokes: new Float32Array(0), cross: new Float32Array(0), documented: new Float32Array(0), dots: new Float32Array(0) };
  readonly counts = { documented: 0, cross: 0 };

  private raycaster = new THREE.Raycaster();
  private targetV = new THREE.Vector3();
  private glowFor = -1;
  private hitSphere: THREE.Sphere;
  private sph = new THREE.Spherical();
  private time = 0;
  private size = { w: 1, h: 1 };
  private dpr = 1;
  /** Current upward projection shift in CSS pixels (half the detail sheet's height). */
  private shift = 0;
  private appliedShift = -1;
  private appliedW = 0;
  private appliedH = 0;
  private initialized = false;
  /** A frame has been drawn since init(): a detach then is a real one (not React StrictMode's rehearsal). */
  private framed = false;
  /** Where the camera stood when this globe's scene last unmounted; null until then. */
  private savedCam: THREE.Vector3 | null = null;
  /** The newest store fly request this globe has acted on or set aside (MindMapView's bindings keep it). */
  flyNonce = 0;
  /** The bindings have made this globe's first move (to the selection a deep link opened, say). */
  bound = false;
  homeDist = 200;

  /** Called when the hovered node changes (for the cursor and tooltip text). */
  onHoverChange: ((index: number) => void) | null = null;

  /**
   * Requests a frame. The scene sets it to R3F's invalidate(): under reduced motion the canvas
   * renders on demand, so every input that changes the picture calls it, and frame() keeps
   * calling it while something is still moving.
   */
  invalidate: () => void = () => {};

  constructor(
    readonly content: GlobeContent<N>,
    opts: { reduced?: boolean; playing?: boolean } = {},
  ) {
    this.reduced = opts.reduced ?? false;
    this.playing = opts.playing ?? !this.reduced;
    this.layout = content.layout;
    const aspect = content.badgeAspect;
    const fit = content.badgeFit ?? this.layout.spacing;
    // The badge diagonal spans the node spacing at the radius badges float at. The
    // badge's rounded corners and inset name pill leave a little slack (the 1.03).
    let rb = this.R + 3;
    let w = 6;
    for (let i = 0; i < 3; i++) {
      w = (fit * rb * 1.03) / Math.sqrt(1 + 1 / (aspect * aspect));
      rb = this.R + (w / aspect) * 0.62;
    }
    this.badgeW = w;
    this.badgeH = w / aspect;
    this.badgeR = rb;
    this.hitSphere = new THREE.Sphere(new THREE.Vector3(), this.badgeR + this.badgeH * 0.4);

    const n = this.layout.nodes.length;
    this.nodeLocal = this.layout.nodes.map((nd) => new THREE.Vector3(...nd.dir));
    this.vis = new Float32Array(n).fill(1);
    this.facing = new Float32Array(n).fill(1);
    this.emphTarget = new Float32Array(n).fill(1);
    this.emphCur = new Float32Array(n).fill(1);
    this.scaleCur = new Float32Array(n).fill(1);
    this.regionLocal = this.layout.regions.map((r) => new THREE.Vector3(...r.center));
    const rc = this.layout.regions.length;
    this.labelOpacity = new Float32Array(rc);
    this.labelSize = this.layout.regions.map(() => ({ w: 0, h: 0 }));
    // Matches the labels' initial markup (data-off="true"), so a label that is already visible on
    // the first frame gets switched on. Starting from false left it unclickable until it hid again.
    this.labelOff = this.layout.regions.map(() => true);
    this.nodeLabelOpacity = new Float32Array(n);
    this.nodeLabelOff = new Array<boolean>(n).fill(true);
    this.nodeLabelHot = new Array<boolean>(n).fill(false);
    this.nodeLabelSize = this.layout.nodes.map(() => ({ w: 0, h: 0 }));
    this.counts.cross = this.layout.nodes.reduce((a, nd) => a + nd.secondary.length, 0);
    this.counts.documented = content.documented().filter((l) => this.layout.nodeIndex.has(l.a) && this.layout.nodeIndex.has(l.b)).length;

    // Spin about the axis that keeps the big regions near the equator, tilted a little,
    // with the largest region turned toward the viewer to start.
    tmpQ.setFromUnitVectors(new THREE.Vector3(...spinAxisFor(this.layout.regions)), this.axis);
    this.q.copy(tmpQ);
    let biggest = 0;
    this.layout.regions.forEach((r, i) => {
      if (r.count > this.layout.regions[biggest].count) biggest = i;
    });
    if (rc) {
      const start = this.regionLocal[biggest].clone().applyQuaternion(this.q);
      const ang = Math.atan2(start.x, start.z);
      tmpQ.setFromAxisAngle(this.axis, -ang + 0.5);
      this.q.premultiply(tmpQ);
    }
  }

  /* ------------------------------------------------------------ geometry */

  /** Static arcs and pins: sector spokes, cross-industry arcs, documented links, surface dots. */
  buildStaticLines(): void {
    if (!this.batches) return;
    const { nodes, regions } = this.layout;
    const R = this.R;
    const rs = R + SURFACE;
    const P = this.palette;

    // a. Sector spokes (company -> its region's hub) and the stem up to each badge. A node in no
    //    region (a person) gets its stem only.
    const spokes: LineSpec[] = [];
    const owner: number[] = [];
    for (const nd of nodes) {
      const color = this.content.color(nd);
      if (nd.region >= 0) {
        const r = regions[nd.region];
        const ang = Math.acos(Math.min(1, Math.max(-1, nd.dir[0] * r.center[0] + nd.dir[1] * r.center[1] + nd.dir[2] * r.center[2])));
        spokes.push({ points: arcPoints(nd.dir, r.center, rs, rs, 0.35 + ang * R * 0.04), color, alpha: 0.62, alphaEnd: 0.26 });
        owner.push(nd.index);
      }
      spokes.push({ points: [scale3(nd.dir, R), scale3(nd.dir, this.badgeR - this.badgeH * 0.2)], color, alpha: 0.8 });
      owner.push(nd.index);
    }
    this.batches.spokes.setLines(spokes);
    this.spokeOwner = Int32Array.from(owner);
    this.lineEmph.spokes = new Float32Array(spokes.length).fill(1);

    // b. Cross-industry arcs (company -> each secondary region's hub). Faint by default: with
    //    dozens of them the globe would read as a ball of yarn. They light up (CROSS_BOOST) for
    //    the focused region, the hovered company and the selected company.
    const cross: LineSpec[] = [];
    const crossOwner: number[] = [];
    const crossTarget: number[] = [];
    for (const nd of nodes)
      for (const ri of nd.secondary) {
        const r = regions[ri];
        const ang = angle3(nd.dir, r.center);
        cross.push({ points: arcPoints(nd.dir, r.center, rs, rs, arcLift(ang, R, 0.42)), color: regions[nd.region].district.color, colorEnd: r.district.color, alpha: 0.2, alphaEnd: 0.13 });
        crossOwner.push(nd.index);
        crossTarget.push(ri);
      }
    this.batches.cross.setLines(cross);
    this.crossOwner = Int32Array.from(crossOwner);
    this.crossTarget = Int32Array.from(crossTarget);
    this.lineEmph.cross = new Float32Array(cross.length).fill(1);

    // c. Documented connections between companies (sourced facts). The people globe has none.
    const docs: LineSpec[] = [];
    const ends: number[] = [];
    for (const link of this.content.documented()) {
      const a = this.layout.nodeIndex.get(link.a);
      const b = this.layout.nodeIndex.get(link.b);
      if (a === undefined || b === undefined) continue;
      const da = nodes[a].dir;
      const db = nodes[b].dir;
      docs.push({ points: arcPoints(da, db, rs, rs, arcLift(angle3(da, db), R, 0.85)), color: P.documented, alpha: 0.95 });
      ends.push(a, b);
    }
    this.batches.documented.setLines(docs);
    this.docEnds = Int32Array.from(ends);
    this.lineEmph.documented = new Float32Array(docs.length).fill(1);

    // Surface pins under every badge, plus a hub marker at each region's center.
    const dots: DotSpec[] = nodes.map((nd) => ({ pos: scale3(nd.dir, R + 0.15), color: this.content.color(nd), alpha: 1, size: this.badgeW * 0.16 }));
    for (const r of regions) dots.push({ pos: scale3(r.center, R + 0.2), color: r.district.color, alpha: 1, size: this.badgeW * 0.42, ring: 1 });
    this.batches.dots.setDots(dots);
    this.lineEmph.dots = new Float32Array(dots.length).fill(1);
    this.emphDirty = true;
    // A selection may have arrived before the scene attached its batches.
    this.buildFitLines();
  }

  /** Arcs for the selected company: potential providers (warm) and clients (cool). Documented ones are already drawn.
   *  The people globe's content has no links, so a selected person draws none. */
  private buildFitLines(): void {
    if (!this.batches) return;
    const fits: LineSpec[] = [];
    const s = this.sel;
    const si = s ? this.layout.nodeIndex.get(s.company.slug) : undefined;
    if (s && si !== undefined) {
      const rs = this.R + SURFACE;
      const ds = this.layout.nodes[si].dir;
      for (const f of s.providers) {
        const i = this.layout.nodeIndex.get(f.company.slug);
        if (i === undefined) continue;
        const d = this.layout.nodes[i].dir;
        fits.push({ points: arcPoints(d, ds, rs, rs, arcLift(angle3(d, ds), this.R, 0.95)), color: this.palette.provider, alpha: 0.95 });
      }
      for (const f of s.clients) {
        const i = this.layout.nodeIndex.get(f.company.slug);
        if (i === undefined) continue;
        const d = this.layout.nodes[i].dir;
        fits.push({ points: arcPoints(ds, d, rs, rs, arcLift(angle3(ds, d), this.R, 0.72)), color: this.palette.client, alpha: 0.95 });
      }
    }
    this.batches.fits.setLines(fits);
    this.fitsOpacity = 0;
  }

  /* -------------------------------------------------------------- inputs */

  setInputs(highlight: Set<string> | null, selectedSlug: string | null, focusSlug: string | null): void {
    const selected = selectedSlug ? this.layout.nodeIndex.get(selectedSlug) ?? -1 : -1;
    const focus = focusSlug ? this.layout.regionIndex.get(focusSlug as DistrictSlug) ?? -1 : -1;
    if (selected !== this.selected) {
      if (this.selected >= 0 && selected < 0) {
        this.lastActive = performance.now();
        // The overview pulled back to fit above the sheet; with the sheet gone, fill the stage again.
        if (this.mode === "home" && this.cam && Math.abs(this.cam.position.length() - this.homeDist) > this.homeDist * 0.02) this.camTween = { dist: this.homeDist, polar: null };
      }
      this.selected = selected;
      this.sel = selected >= 0 && selectedSlug ? this.content.links(selectedSlug) : null;
      this.buildFitLines();
    }
    if (focus !== this.focusRegion) {
      if (this.focusRegion >= 0 && focus < 0) this.lastActive = performance.now();
      this.focusRegion = focus;
    }
    this.highlight = highlight;
    const related = this.sel ? this.sel.related : null;
    const selRegion = this.selected >= 0 ? this.layout.nodes[this.selected].region : -1;
    this.layout.nodes.forEach((nd, i) => {
      // With a company selected: it and the companies linked to it stay bright; its industry peers
      // stay readable for context; everything else steps back (dimming.ts). People share no
      // region: with one selected, the others step back to the peers' level.
      this.emphTarget[i] = emphasisOf({
        inHighlight: !this.highlight || this.highlight.has(nd.slug),
        hasSelection: this.selected >= 0,
        selectedOrRelated: i === this.selected || !!related?.has(nd.slug),
        sameRegion: nd.region === selRegion,
      });
    });
    this.emphDirty = true;
    this.invalidate();
  }

  /** Queue a camera/globe move; executed on the next frame (the camera may not exist yet). */
  request(f: FlyInput): void {
    this.pending = f;
    this.invalidate();
  }

  setPlaying(v: boolean): void {
    this.playing = v;
    if (v) this.lastActive = 0;
    this.invalidate();
  }

  zoomBy(k: number): void {
    const cur = this.camTween?.dist ?? this.currentDist;
    this.camTween = { dist: this.clampDist(cur * k), polar: null };
    this.mode = "free";
    this.invalidate();
  }

  /** Keyboard focus on a district label: turn that region toward the viewer without zooming. */
  previewRegion(i: number): void {
    if (i < 0 || i >= this.layout.regions.length) return;
    this.turn = { kind: "region", index: i };
    this.invalidate();
  }

  /** Keyboard focus on a company button: show its tooltip and turn it into view if it is near the edge. */
  private focusNode(i: number): void {
    if (i !== this.kbdFocus) this.emphDirty = true;
    this.kbdFocus = i;
    this.onHoverChange?.(i >= 0 ? i : this.hovered);
    if (i < 0) return;
    if (this.vis[i] < 0.9 || this.facing[i] < 0.45) this.turn = { kind: "node", index: i };
  }

  /**
   * Keyboard focus in the overlay, read from the DOM each frame instead of tracked through focus
   * and blur events, which left it stale: moving from a company button to a district label never
   * leaves the overlay, and Chromium fires no blur when a focused company button is removed
   * (Escape unmounts them). Only keyboard focus (:focus-visible) holds rotation: browsers also
   * focus a label the visitor clicks, and that must not stop the globe until the next click.
   */
  private syncFocus(): void {
    const a = document.activeElement;
    const root = this.overlay.root;
    const inside = a instanceof HTMLElement && a !== root && !!root?.contains(a);
    this.focusWithin = inside && a.matches(focusVisible());
    let k = -1;
    if (inside)
      for (const map of [this.overlay.nodeButtons, this.overlay.nodeLabels])
        for (const [i, el] of map)
          if (el === a) {
            k = i;
            break;
          }
    if (k !== this.kbdFocus) this.focusNode(k);
  }

  setHovered(i: number): void {
    if (i === this.hovered) return;
    this.hovered = i;
    this.emphDirty = true;
    this.onHoverChange?.(i >= 0 ? i : this.kbdFocus);
    this.invalidate();
  }

  /** The pointer is over a district label (rotation holds while it is). */
  setOverUI(v: boolean): void {
    this.overUI = v;
    this.invalidate();
  }

  interactionStart(): void {
    this.dragging = true;
    this.turn = null;
    this.camTween = null;
    this.mode = "free";
    this.lastActive = performance.now();
    this.invalidate();
  }

  interactionEnd(): void {
    this.dragging = false;
    this.lastActive = performance.now();
    this.invalidate();
  }

  attachCanvas(el: HTMLCanvasElement | null): void {
    this.canvasEl = el;
  }

  /* ------------------------------------------------------------- camera */

  private cam: THREE.PerspectiveCamera | null = null;

  private get currentDist(): number {
    return this.cam ? this.cam.position.length() : this.homeDist;
  }

  private halfFovs(): { v: number; h: number } {
    const v = THREE.MathUtils.degToRad(FOV) / 2;
    const h = Math.atan(Math.tan(v) * (this.size.w / Math.max(1, this.size.h)));
    return { v, h };
  }

  /** Vertical half-FOV of the part of the stage above the detail sheet (f = share it covers). */
  private visibleHalfV(f: number): number {
    const { v } = this.halfFovs();
    return Math.atan((1 - f) * Math.tan(v));
  }

  private computeHomeDist(): number {
    return this.overviewDist(0);
  }

  /** Distance at which the whole globe fits the stage above a sheet covering share f of it. */
  private overviewDist(f: number): number {
    const { h } = this.halfFovs();
    const rho = this.badgeR + this.badgeH * 0.6;
    // Portrait framing leaves room for the badges and atmosphere at both edges.
    const fill = this.size.w / Math.max(1, this.size.h) < 0.8 ? 0.9 : 0.86;
    return rho / Math.sin(Math.min(this.visibleHalfV(f), h) * fill);
  }

  /** Close enough that logos read, far enough to keep the company's neighbors in view. */
  private companyDist(): number {
    const { h } = this.halfFovs();
    const aspect = this.size.w / Math.max(1, this.size.h);
    const across = 4 + 7 * Math.min(1, aspect);
    const byWidth = (this.badgeW * across) / (2 * Math.tan(h));
    // A company fly always comes with a selection, so plan for the sheet even before it opens.
    const byHeight = (this.badgeH * 6.5) / (2 * Math.tan(this.visibleHalfV(this.sheetFraction(true))));
    const gap = Math.min(Math.max(byWidth, byHeight, 24), this.R * 2);
    return this.clampDist(this.badgeR + gap);
  }

  /**
   * Distance for a company fly. With no lines to draw, a close-up. When the company has
   * documented links or potential fits, pull back far enough that most of the companies at
   * the other end are in view above the detail sheet, so the arcs read as connections
   * instead of sweeping off the screen.
   */
  private companyFlyDist(i: number): number {
    const close = this.companyDist();
    const s = this.content.links(this.layout.nodes[i].slug);
    if (!s || s.related.size === 0) return close;
    const d0 = this.layout.nodes[i].dir;
    const angles: number[] = [];
    for (const slug of s.related) {
      const j = this.layout.nodeIndex.get(slug);
      if (j !== undefined && j !== i) angles.push(angle3(d0, this.layout.nodes[j].dir));
    }
    if (!angles.length) return close;
    angles.sort((a, b) => a - b);
    // Frame the nearer half of them. The rest still read as arcs heading over the horizon,
    // and the company itself has to stay big enough to recognize.
    const spread = Math.min(angles[Math.max(0, Math.ceil(angles.length * 0.5) - 1)], 0.75) + this.layout.spacing * 0.5;
    const f = this.sheetFraction(true);
    const { h } = this.halfFovs();
    const half = Math.min(this.visibleHalfV(f), h) * 0.9;
    const r = this.badgeR;
    const want = r * Math.cos(spread) + (r * Math.sin(spread) + this.badgeH) / Math.tan(half);
    return this.clampDist(Math.min(close * COMPANY_PULLBACK, Math.max(close, want)));
  }

  private regionDist(i: number): number {
    const r = this.layout.regions[i];
    const { h } = this.halfFovs();
    const a = Math.min(r.radius + this.layout.spacing * 0.6, Math.PI / 2);
    const half = Math.min(this.visibleHalfV(this.selected >= 0 ? this.sheetFraction() : 0), h) * 0.8;
    return this.clampDist(this.badgeR * Math.cos(a) + (this.badgeR * Math.sin(a) + this.badgeH) / Math.tan(half));
  }

  private clampDist(d: number): number {
    return Math.min(this.homeDist * 1.7, Math.max(this.R + 14, d));
  }

  /** Height of the detail sheet in CSS pixels as published by the sheet (0 when closed). */
  private sheetPx(): number {
    return parseFloat(document.documentElement.style.getPropertyValue("--sheet-h")) || 0;
  }

  /** Fraction of the stage height (from the bottom) the detail sheet covers, or will once it opens. */
  private sheetFraction(assumeOpen = this.selected >= 0): number {
    const css = this.sheetPx();
    const est = window.innerWidth <= 760 ? window.innerHeight * 0.52 : Math.min(window.innerHeight * 0.46, 430);
    const sheet = css > 0 ? css : assumeOpen ? est : 0;
    return Math.min(MAX_SHEET, Math.max(0, sheet / Math.max(1, this.size.h)));
  }

  /**
   * Keep the globe centered in the part of the stage the sheet leaves visible: shift the
   * projection (not the camera) up by half the sheet's height. Orbit, zoom, picking and the
   * DOM overlay all go through the projection matrix, so they follow without special cases.
   */
  private updateViewShift(cam: THREE.PerspectiveCamera, dt: number): void {
    const target = Math.min(this.sheetPx(), this.size.h * MAX_SHEET) / 2;
    this.shift = this.reduced ? target : damp(this.shift, target, 7, dt);
    if (Math.abs(this.shift - target) < 0.3) this.shift = target;
    const { w, h } = this.size;
    if (Math.abs(this.shift - this.appliedShift) < 0.05 && w === this.appliedW && h === this.appliedH && (cam.view?.enabled ?? false) === this.shift > 0) return;
    if (this.shift > 0) cam.setViewOffset(w, h, 0, this.shift, w, h);
    else cam.clearViewOffset();
    this.appliedShift = this.shift;
    this.appliedW = w;
    this.appliedH = h;
  }

  /** World direction a node/region should face: straight at the camera (the view shift keeps that above the sheet). */
  private targetDir(cam: THREE.PerspectiveCamera, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(cam.position).normalize();
  }

  private execute(f: FlyInput): void {
    if (f.kind === "home") {
      this.turn = null;
      this.camTween = { dist: this.overviewDist(this.selected >= 0 ? this.sheetFraction() : 0), polar: HOME_POLAR };
      this.mode = "home";
      this.lastActive = 0;
      return;
    }
    if (f.kind === "company" || f.kind === "person") {
      const i = f.slug ? this.layout.nodeIndex.get(f.slug) : undefined;
      if (i === undefined) return;
      this.turn = { kind: "node", index: i };
      if (!f.turnOnly) {
        if (this.content.flyTo === "overview") {
          // The whole globe above the sheet; closing the sheet then fills the stage again (see setInputs).
          // A portrait stage is already filled edge to edge by the overview: no closer there.
          const zoom = this.size.w / Math.max(1, this.size.h) < 0.8 ? 1 : OVERVIEW_FLY_ZOOM;
          this.camTween = { dist: this.clampDist(this.overviewDist(this.sheetFraction(true)) * zoom), polar: null };
          this.mode = "home";
        } else {
          this.camTween = { dist: this.companyFlyDist(i), polar: null };
          this.mode = "company";
        }
      }
      return;
    }
    const ri = f.slug ? this.layout.regionIndex.get(f.slug as DistrictSlug) : undefined;
    if (ri === undefined) return;
    this.turn = { kind: "region", index: ri };
    if (!f.turnOnly) {
      this.camTween = { dist: this.regionDist(ri), polar: null };
      this.mode = "district";
    }
  }

  /* -------------------------------------------------------------- frame */

  init(cam: THREE.PerspectiveCamera, w: number, h: number, intro: boolean): void {
    this.cam = cam;
    this.size = { w, h };
    this.homeDist = this.computeHomeDist();
    // The camera is shared with the other globe, which set its own view offset: apply ours again.
    this.appliedShift = -1;
    // Fresh label elements start hidden (data-off="true", unmeasured).
    this.labelOff.fill(true);
    this.nodeLabelOff.fill(true);
    this.nodeLabelHot.fill(false);
    this.remeasure();
    if (this.savedCam) {
      // Back from the other globe: the camera returns to where this globe left it. Rotation,
      // selection and any tween in progress live on this controller and carry on.
      cam.position.copy(this.savedCam);
      cam.lookAt(0, 0, 0);
    } else {
      const start = intro && !this.reduced ? this.homeDist * 1.32 : this.homeDist;
      this.sph.set(start, HOME_POLAR, 0.0);
      cam.position.setFromSpherical(this.sph);
      cam.lookAt(0, 0, 0);
      if (intro && !this.reduced) this.camTween = { dist: this.homeDist, polar: HOME_POLAR };
    }
    this.framed = false;
    this.initialized = true;
    this.invalidate();
  }

  /**
   * The scene is unmounting (the other globe takes its place, or the view closes). Recompany the
   * camera so the globe comes back as it was, and drop state tied to the old DOM and canvas.
   */
  detach(cam: THREE.PerspectiveCamera): void {
    // React StrictMode rehearses an unmount before the first frame; that is not a visit to keep.
    if (this.initialized && this.framed) this.savedCam = cam.position.clone();
    this.initialized = false;
    this.hovered = -1;
    this.kbdFocus = -1;
    this.dragging = false;
    this.pointerInside = false;
    this.overGlobe = false;
    this.overUI = false;
    this.focusWithin = false;
    this.glowFor = -1;
    this.cursor = "";
    this.emphDirty = true;
  }

  resize(w: number, h: number): void {
    if (w === this.size.w && h === this.size.h) return;
    this.size = { w, h };
    this.invalidate();
    const prevHome = this.homeDist;
    this.homeDist = this.computeHomeDist();
    if (this.controls) {
      this.controls.minDistance = this.R + 14;
      this.controls.maxDistance = this.homeDist * 1.7;
    }
    if (this.cam && this.mode === "home" && Math.abs(prevHome - this.homeDist) > 0.5) {
      const d = this.overviewDist(this.selected >= 0 ? this.sheetFraction() : 0);
      if (this.camTween) this.camTween.dist = d;
      else this.cam.position.setLength(d);
    }
  }

  frame(cam: THREE.PerspectiveCamera, pointer: THREE.Vector2, dt: number): void {
    if (!this.initialized || !this.globe) return;
    this.framed = true;
    this.cam = cam;
    // Never negative or NaN: either would poison the eased emphasis and scale for good.
    dt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
    const now = performance.now();
    if (!this.reduced) this.time += dt;

    this.updateViewShift(cam, dt);
    if (this.pending) {
      this.execute(this.pending);
      this.pending = null;
    }

    // Is the pointer over the globe? (analytic ray-sphere test, no scene raycast)
    this.overGlobe = false;
    if (this.pointerInside) {
      this.raycaster.setFromCamera(pointer, cam);
      this.overGlobe = this.raycaster.ray.intersectsSphere(this.hitSphere);
    }

    // Auto-rotation: pauses while anyone is looking at something, resumes a little later.
    this.syncFocus();
    const hold = this.holding();
    if (hold) this.lastActive = now;
    const want = this.playing && !hold && now - this.lastActive > RESUME_MS ? SPIN : 0;
    this.spin = this.reduced ? want : damp(this.spin, want, want > 0 ? 1.1 : 2.6, dt);
    if (this.spin > 1e-5) {
      tmpQ.setFromAxisAngle(this.axis, this.spin * dt);
      this.q.premultiply(tmpQ);
    }

    // Turn a node or region toward the viewer.
    if (this.turn) {
      const t = this.turn;
      const local = t.kind === "node" ? this.nodeLocal[t.index] : this.regionLocal[t.index];
      if (!local) this.turn = null;
      else {
        const w = tmpV.copy(local).applyQuaternion(this.q);
        const target = this.targetDir(cam, this.targetV);
        tmpQ.setFromUnitVectors(w, target);
        const ang = 2 * Math.acos(Math.min(1, Math.abs(tmpQ.w)));
        if (this.reduced || ang < 2e-4) {
          this.q.premultiply(tmpQ);
          if (!this.camTween) this.turn = null;
        } else {
          tmpQ2.copy(IDENTITY).slerp(tmpQ, 1 - Math.exp(-dt * 3.4));
          this.q.premultiply(tmpQ2);
        }
      }
    }
    this.q.normalize();
    this.globe.quaternion.copy(this.q);

    // Camera distance / elevation tween.
    if (this.camTween) {
      this.sph.setFromVector3(cam.position);
      const k = this.reduced ? 1 : 1 - Math.exp(-dt * 2.8);
      this.sph.radius += (this.camTween.dist - this.sph.radius) * k;
      if (this.camTween.polar !== null) this.sph.phi += (this.camTween.polar - this.sph.phi) * k;
      cam.position.setFromSpherical(this.sph);
      cam.lookAt(0, 0, 0);
      const done = Math.abs(this.camTween.dist - this.sph.radius) < 0.05 && (this.camTween.polar === null || Math.abs(this.camTween.polar - this.sph.phi) < 1e-3);
      if (done) this.camTween = null;
    }

    const emphChanged = this.animateEmphasis(dt);
    this.updateNodes(cam, dt);
    this.updateUniforms(cam, dt);
    this.updateOverlay(cam, dt);

    const cursor = this.hovered >= 0 ? "pointer" : this.dragging ? "grabbing" : "grab";
    if (cursor !== this.cursor && this.canvasEl) {
      this.canvasEl.style.cursor = cursor;
      this.cursor = cursor;
    }

    // Rendering on demand: ask for the next frame while anything is still moving, including the
    // wait before auto-rotation resumes. A settled, paused globe draws nothing until an input changes.
    if (this.pending || this.turn || this.camTween || this.spin > 1e-5 || (this.playing && !this.holding()) || emphChanged) this.invalidate();
  }

  /** Something the visitor is doing or looking at holds auto-rotation. */
  private holding(): boolean {
    return this.dragging || this.overGlobe || this.overUI || this.focusWithin || this.selected >= 0 || this.focusRegion >= 0 || this.turn !== null;
  }

  /** Eases node emphasis toward its targets and updates the line batches; true if anything changed. */
  private animateEmphasis(dt: number): boolean {
    const k = this.reduced ? 1 : 1 - Math.exp(-dt * 7);
    let changed = this.emphDirty;
    this.emphDirty = false;
    for (let i = 0; i < this.emphCur.length; i++) {
      const d = this.emphTarget[i] - this.emphCur[i];
      if (Math.abs(d) < 1e-3) {
        if (d !== 0) {
          this.emphCur[i] = this.emphTarget[i];
          changed = true;
        }
      } else {
        this.emphCur[i] += d * k;
        changed = true;
      }
    }
    const selT = this.selected >= 0 ? 1 : 0;
    if (Math.abs(selT - this.selAmt) > 1e-3) {
      this.selAmt += (selT - this.selAmt) * k;
      changed = true;
    } else if (this.selAmt !== selT) {
      this.selAmt = selT;
      changed = true;
    }
    if (!changed || !this.batches) return changed;

    const cur = this.emphCur;
    const sel = this.selected;
    const sa = this.selAmt;
    const sp = this.lineEmph.spokes;
    for (let l = 0; l < sp.length; l++) {
      const n = this.spokeOwner[l];
      sp[l] = cur[n] * (1 + ((n === sel ? 1 : 0.5) - 1) * sa);
    }
    this.batches.spokes.setEmphasis(sp);
    const cr = this.lineEmph.cross;
    const fr = this.focusRegion;
    const hov = this.hovered >= 0 ? this.hovered : this.kbdFocus;
    const nodes = this.layout.nodes;
    for (let l = 0; l < cr.length; l++) {
      const n = this.crossOwner[l];
      // Emphasis above 1 brightens a deliberately faint arc.
      const boost = n === sel ? CROSS_BOOST : n === hov ? CROSS_BOOST * 0.85 : fr >= 0 && (this.crossTarget[l] === fr || nodes[n].region === fr) ? CROSS_BOOST * 0.5 : 1;
      cr[l] = cur[n] * boost * (1 + ((n === sel ? 1 : 0.3) - 1) * sa);
    }
    this.batches.cross.setEmphasis(cr);
    const doc = this.lineEmph.documented;
    for (let l = 0; l < doc.length; l++) {
      const a = this.docEnds[l * 2];
      const b = this.docEnds[l * 2 + 1];
      const touches = a === sel || b === sel;
      doc[l] = Math.min(cur[a], cur[b]) * (1 + ((touches ? 1 : 0.15) - 1) * sa);
      if (touches) doc[l] = 1;
    }
    this.batches.documented.setEmphasis(doc);
    const dots = this.lineEmph.dots;
    for (let i = 0; i < dots.length; i++) dots[i] = i < cur.length ? cur[i] : 1;
    this.batches.dots.setEmphasis(dots);
    return true;
  }

  private updateNodes(cam: THREE.PerspectiveCamera, dt: number): void {
    const C = cam.position;
    const k = this.reduced ? 1 : 1 - Math.exp(-dt * 10);
    const backOp = this.content.fade?.back ?? 0;
    const rimOp = this.content.fade?.rim ?? 0;
    for (let i = 0; i < this.sprites.length; i++) {
      const s = this.sprites[i];
      const P = tmpV.copy(this.nodeLocal[i]).multiplyScalar(this.badgeR).applyQuaternion(this.q);
      const vis = globeVisibility(P, C, this.R);
      const len = P.length();
      const toCam = tmpV2.copy(C).sub(P).normalize();
      const facing = (P.x * toCam.x + P.y * toCam.y + P.z * toCam.z) / len;
      this.vis[i] = vis;
      this.facing[i] = facing;
      // Fade toward the rim, where badges crowd in perspective; far-side badges stay hidden.
      // Dimmed (de-emphasized) badges fade toward paper but stay mostly solid, and every logo stays
      // recognizable: a selection or search steps the others back, it never blanks them (dimming.ts).
      const dim = badgeDim(this.emphCur[i]);
      const front = rimOp + (1 - rimOp) * smoothstep(0.08, 0.3, facing);
      const op = (vis * front + (1 - vis) * backOp) * dim.opacity;
      s.material.opacity = op;
      (s.material.userData.fade as { value: number }).value = dim.fade;
      s.visible = op > 0.12;
      const active = i === this.selected ? 1.3 : i === this.hovered || i === this.kbdFocus ? 1.16 : 1;
      this.scaleCur[i] += (active - this.scaleCur[i]) * k;
      const sc = this.scaleCur[i];
      s.scale.set(this.badgeW * sc, this.badgeH * sc, 1);
      s.renderOrder = i === this.selected || i === this.hovered ? 5 : vis > 0.5 ? 3 : 0;
    }
    if (this.selGlow) {
      const i = this.selected;
      if (i >= 0) {
        const pulse = this.reduced ? 1 : 1 + 0.06 * Math.sin(this.time * 2.6);
        this.selGlow.position.copy(this.nodeLocal[i]).multiplyScalar(this.badgeR - 0.05);
        this.selGlow.scale.setScalar(this.badgeW * 1.7 * pulse);
        this.selGlow.material.opacity = 0.1 + 0.25 * this.vis[i];
        if (this.glowFor !== i) {
          this.selGlow.material.color.set(this.content.glow?.(this.layout.nodes[i]) ?? this.content.color(this.layout.nodes[i]));
          this.glowFor = i;
        }
        this.selGlow.visible = true;
      } else this.selGlow.visible = false;
    }
  }

  private updateUniforms(cam: THREE.PerspectiveCamera, dt: number): void {
    if (this.batches) {
      for (const b of [this.batches.spokes, this.batches.cross, this.batches.documented, this.batches.fits]) b.material.uniforms.uTime.value = this.time;
      const target = this.selected >= 0 ? 1 : 0;
      this.fitsOpacity = this.reduced ? target : damp(this.fitsOpacity, target, 5, dt);
      this.batches.fits.material.uniforms.uOpacity.value = this.fitsOpacity;
      // Free the fit arcs once they have faded out after a selection is cleared.
      if (!target && this.fitsOpacity < 0.01 && this.batches.fits.lineCount) this.batches.fits.setLines([]);
      // gl_PointSize is in device pixels.
      this.batches.dots.material.uniforms.uScale.value = (this.size.h * this.dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    }
    if (this.glass) {
      const target = this.focusRegion >= 0 ? 1 : 0;
      this.focusAmt = this.reduced ? target : damp(this.focusAmt, target, 4, dt);
      if (this.focusRegion >= 0) this.glass.uniforms.uFocus.value = this.focusRegion;
      else if (this.focusAmt < 0.01) this.glass.uniforms.uFocus.value = -1;
      this.glass.uniforms.uFocusAmt.value = this.focusAmt;
    }
    if (this.core) {
      // The core is a quiet anchor: it steps back when something is selected or the camera is close.
      const D = cam.position.length();
      const near = smoothstep(this.homeDist * 0.55, this.homeDist * 0.95, D);
      this.core.material.opacity = 0.8 * (0.3 + 0.7 * near) * (1 - 0.55 * this.selAmt);
    }
    if (this.atmosphere) {
      const D = cam.position.length();
      const rs = (this.R * D) / Math.sqrt(Math.max(1, D * D - this.R * this.R));
      this.atmosphere.scale.setScalar((2 * rs) / 0.8);
    }
  }

  setResolution(w: number, h: number, dpr: number): void {
    this.dpr = dpr;
    this.invalidate();
    if (!this.batches) return;
    for (const b of [this.batches.spokes, this.batches.cross, this.batches.documented, this.batches.fits]) b.setResolution(w, h, dpr);
    this.batches.dots.material.uniforms.uScale.value = (h * dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(FOV) / 2));
  }

  /* ------------------------------------------------------------- overlay */

  private placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
  /** Stage areas labels give way to (the Companies | People switch and the HUD), in stage pixels. */
  reserved: { x0: number; y0: number; x1: number; y1: number }[] = [];
  private order: number[] = [];
  private lx = new Float32Array(0);
  private ly = new Float32Array(0);
  private lwant = new Float32Array(0);
  private lprio = new Float32Array(0);
  private byPrio = (a: number, b: number) => this.lprio[b] - this.lprio[a];

  /** Re-measure label sizes (after fonts load or a resize). */
  remeasure(): void {
    for (const s of [...this.labelSize, ...this.nodeLabelSize]) {
      s.w = 0;
      s.h = 0;
    }
    this.invalidate();
  }

  private updateOverlay(cam: THREE.PerspectiveCamera, dt: number): void {
    const W = this.size.w;
    const H = this.size.h;
    const C = cam.position;
    const k = this.reduced ? 1 : 1 - Math.exp(-dt * 9);
    const n = this.layout.regions.length;
    if (this.lx.length !== n) {
      this.lx = new Float32Array(n);
      this.ly = new Float32Array(n);
      this.lwant = new Float32Array(n);
      this.lprio = new Float32Array(n);
      this.order = Array.from({ length: n }, (_, i) => i);
    }
    const xs = this.lx;
    const ys = this.ly;
    const want = this.lwant;
    const prio = this.lprio;

    // Soft ground shadow under the globe (screen space; fades out once the globe overfills the stage).
    const shadow = this.overlay.shadow;
    if (shadow) {
      const D = C.length();
      const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
      const rPx = (Math.tan(Math.asin(Math.min(0.999, this.R / D))) / tanHalf) * (H / 2);
      // The globe's center on screen (the view shift moves it up while the sheet is open).
      const cy = H / 2 - this.shift;
      const visH = H - this.shift * 2;
      const op = 1 - smoothstep(visH * 0.4, visH * 0.56, rPx);
      const sw = rPx * 1.7;
      const sh = rPx * 0.2;
      shadow.style.transform = `translate3d(${(W / 2 - sw / 2).toFixed(1)}px, ${(cy + rPx * 0.98 - sh / 2).toFixed(1)}px, 0) scale(${(sw / 100).toFixed(4)}, ${(sh / 100).toFixed(4)})`;
      shadow.style.opacity = op.toFixed(3);
    }

    // Label anchors sit over each region's center. When that center nears the horizon, the
    // anchor slides toward the viewer (staying inside the region) so a region keeps its name
    // for as long as part of it is in view.
    const viewDir = tmpV3.copy(C).normalize();
    const horizon = Math.acos(Math.min(1, (this.R + LABEL_LIFT) / Math.max(C.length(), this.R + LABEL_LIFT + 1e-3))) - 0.16;
    for (let i = 0; i < n; i++) {
      const A = tmpV.copy(this.regionLocal[i]).applyQuaternion(this.q);
      const ang = A.angleTo(viewDir);
      if (ang > horizon) {
        const slide = Math.min(ang - horizon, this.layout.regions[i].radius * 0.85);
        const axis = tmpV2.crossVectors(A, viewDir);
        if (axis.lengthSq() > 1e-10) A.applyQuaternion(tmpQ.setFromAxisAngle(axis.normalize(), slide));
      }
      A.multiplyScalar(this.R + LABEL_LIFT);
      const vis = globeVisibility(A, C, this.R);
      const toCam = tmpV2.copy(C).sub(A).normalize();
      const facing = A.dot(toCam) / A.length();
      A.project(cam);
      xs[i] = ((A.x + 1) / 2) * W;
      ys[i] = ((1 - A.y) / 2) * H;
      // Every region on the visible side gets its label, down to the horizon; overlaps resolve below.
      // A short ramp, so a resting globe shows labels either clearly or not at all.
      want[i] = smoothstep(0.35, 0.6, vis) * smoothstep(0.0, 0.07, facing);
      prio[i] = facing + (i === this.focusRegion ? 10 : 0);
    }
    this.order.sort(this.byPrio);
    this.placed.length = 0;
    for (const r of this.reserved) this.placed.push(r);
    for (const i of this.order) {
      const el = this.overlay.labels[i];
      if (!el) continue;
      const size = this.labelSize[i];
      if (!size.w) {
        size.w = el.offsetWidth;
        size.h = el.offsetHeight;
      }
      let target = want[i];
      // Keep labels inside the stage on narrow screens (they slide along the edge instead of clipping).
      xs[i] = Math.min(W - size.w / 2 - 6, Math.max(size.w / 2 + 6, xs[i]));
      ys[i] = Math.max(size.h + 6, ys[i]);
      const x0 = xs[i] - size.w / 2 - 4;
      const x1 = xs[i] + size.w / 2 + 4;
      const y1 = ys[i] + 2;
      const y0 = ys[i] - size.h - 2;
      if (target > 0.05) {
        const hit = this.placed.some((r) => x0 < r.x1 && x1 > r.x0 && y0 < r.y1 && y1 > r.y0);
        if (hit && i !== this.focusRegion) target = 0;
        else this.placed.push({ x0, y0, x1, y1 });
      }
      this.labelOpacity[i] += (target - this.labelOpacity[i]) * k;
      if (Math.abs(target - this.labelOpacity[i]) < 0.01) this.labelOpacity[i] = target;
      const op = this.labelOpacity[i];
      el.style.transform = `translate3d(${xs[i].toFixed(1)}px, ${ys[i].toFixed(1)}px, 0) translate(-50%, -100%)`;
      el.style.opacity = op.toFixed(3);
      const off = op < 0.2;
      if (off !== this.labelOff[i]) {
        this.labelOff[i] = off;
        el.dataset.off = off ? "true" : "false";
      }
    }

    // Keyboard buttons over the badges of the active region.
    const ppuK = H / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    const view = cam.matrixWorldInverse;
    for (const [i, el] of this.overlay.nodeButtons) {
      const P = tmpV.copy(this.nodeLocal[i]).multiplyScalar(this.badgeR).applyQuaternion(this.q);
      const depth = -tmpV2.copy(P).applyMatrix4(view).z;
      P.project(cam);
      const ppu = ppuK / Math.max(1, depth);
      const w = this.badgeW * this.scaleCur[i] * ppu;
      const h = this.badgeH * this.scaleCur[i] * ppu;
      el.style.transform = `translate3d(${(((P.x + 1) / 2) * W - w / 2).toFixed(1)}px, ${(((1 - P.y) / 2) * H - h / 2).toFixed(1)}px, 0)`;
      el.style.width = `${w.toFixed(1)}px`;
      el.style.height = `${h.toFixed(1)}px`;
      el.dataset.off = this.vis[i] < 0.5 ? "true" : "false";
    }

    if (this.overlay.nodeLabels.size) this.updateNodeLabels(cam, k, ppuK);

    // Tooltip for the hovered (or keyboard-focused) node.
    const tip = this.overlay.tip;
    if (tip) {
      const i = this.hovered >= 0 ? this.hovered : this.kbdFocus;
      // The selected company is already named in the detail sheet.
      if (i >= 0 && i !== this.selected && this.vis[i] > 0.5) {
        const P = tmpV.copy(this.nodeLocal[i]).multiplyScalar(this.badgeR).applyQuaternion(this.q);
        const depth = -tmpV2.copy(P).applyMatrix4(view).z;
        P.project(cam);
        const h = this.badgeH * this.scaleCur[i] * (ppuK / Math.max(1, depth));
        const x = ((P.x + 1) / 2) * W;
        const y = ((1 - P.y) / 2) * H - h / 2 - 8;
        tip.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
        if (tip.dataset.on !== "true") tip.dataset.on = "true";
      } else if (tip.dataset.on !== "false") tip.dataset.on = "false";
    }
  }

  private nlx = new Float32Array(0);
  private nly = new Float32Array(0);
  private nlWant = new Float32Array(0);
  private nlPrio = new Float32Array(0);
  private nlOrder: number[] = [];
  private byLabelPrio = (a: number, b: number) => this.nlPrio[b] - this.nlPrio[a];

  /**
   * Name labels under the badges (the people globe); each label is also its node's button. Every
   * badge on the visible side gets its name, fading out toward the rim. Where two labels would
   * overlap, the one facing the viewer more squarely wins, and the hovered, keyboard-focused or
   * selected node always shows (its label then adds the specialty on a second line).
   */
  private updateNodeLabels(cam: THREE.PerspectiveCamera, k: number, ppuK: number): void {
    const W = this.size.w;
    const H = this.size.h;
    const n = this.layout.nodes.length;
    if (this.nlx.length !== n) {
      this.nlx = new Float32Array(n);
      this.nly = new Float32Array(n);
      this.nlWant = new Float32Array(n);
      this.nlPrio = new Float32Array(n);
      this.nlOrder = Array.from({ length: n }, (_, i) => i);
    }
    const xs = this.nlx;
    const ys = this.nly;
    const want = this.nlWant;
    const prio = this.nlPrio;
    const labels = this.overlay.nodeLabels;
    const view = cam.matrixWorldInverse;
    for (const [i, el] of labels) {
      const P = tmpV.copy(this.nodeLocal[i]).multiplyScalar(this.badgeR).applyQuaternion(this.q);
      const depth = -tmpV2.copy(P).applyMatrix4(view).z;
      P.project(cam);
      const h = this.badgeH * this.scaleCur[i] * (ppuK / Math.max(1, depth));
      xs[i] = ((P.x + 1) / 2) * W;
      ys[i] = ((1 - P.y) / 2) * H + h / 2 + NODE_LABEL_GAP;
      const hot = i === this.hovered || i === this.kbdFocus || i === this.selected;
      if (hot !== this.nodeLabelHot[i]) {
        this.nodeLabelHot[i] = hot;
        el.dataset.hot = hot ? "true" : "false";
        this.nodeLabelSize[i].w = 0;
      }
      // A short ramp, as for region labels: a resting globe shows a name clearly or not at all.
      want[i] = smoothstep(0.5, 0.62, this.vis[i]) * smoothstep(0.02, 0.08, this.facing[i]);
      prio[i] = this.facing[i] + (hot ? 10 : 0);
    }
    // Region labels (none on the people globe) were placed first and keep their room.
    this.nlOrder.sort(this.byLabelPrio);
    for (const i of this.nlOrder) {
      const el = labels.get(i);
      if (!el) continue;
      const size = this.nodeLabelSize[i];
      if (!size.w) {
        size.w = el.offsetWidth;
        size.h = el.offsetHeight;
      }
      let target = want[i];
      // Keep the label inside the stage (it slides along the edge instead of clipping).
      xs[i] = Math.min(W - size.w / 2 - 6, Math.max(size.w / 2 + 6, xs[i]));
      const x0 = xs[i] - size.w / 2 - 3;
      const x1 = xs[i] + size.w / 2 + 3;
      const y0 = ys[i] - 2;
      const y1 = ys[i] + size.h + 2;
      if (target > 0.05) {
        const hit = this.placed.some((r) => x0 < r.x1 && x1 > r.x0 && y0 < r.y1 && y1 > r.y0);
        if (hit && !this.nodeLabelHot[i]) target = 0;
        else this.placed.push({ x0, y0, x1, y1 });
      }
      const op0 = this.nodeLabelOpacity[i];
      let op = op0 + (target - op0) * k;
      if (Math.abs(target - op) < 0.01) op = target;
      this.nodeLabelOpacity[i] = op;
      el.style.transform = `translate3d(${xs[i].toFixed(1)}px, ${ys[i].toFixed(1)}px, 0) translate(-50%, 0)`;
      el.style.opacity = op.toFixed(3);
      const off = op < 0.2;
      if (off !== this.nodeLabelOff[i]) {
        this.nodeLabelOff[i] = off;
        el.dataset.off = off ? "true" : "false";
      }
    }
  }
}

/** Space kept between a name label and the badge above it, CSS pixels. */
const NODE_LABEL_GAP = 5;

function scale3(v: Vec3, k: number): Vec3 {
  return [v[0] * k, v[1] * k, v[2] * k];
}

function angle3(a: Vec3, b: Vec3): number {
  return Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
}
