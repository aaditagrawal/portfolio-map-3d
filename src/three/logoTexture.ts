/* Logo badges as textures, shared by the mind map and the walk world.

   Each badge is a rounded plate with the company's logo fitted inside and a
   rim in its district color. The plate follows the logo:
     light → white plate (most logos)
     dark  → ink plate (light-on-transparent logos)
     self  → the logo's own opaque background color
   Companies without a logo on the public directory get a monogram plate.

   Textures are cached per company+variant and painted twice: once at once
   (plate + monogram, so nothing is ever blank) and again when the image
   and web font have loaded.

   How they are stored: every badge is painted on one shared scratch canvas
   and its pixels are copied into a byte array (a DataTexture). The 3D views
   upload those bytes. Badges used to keep a canvas each, and on phones
   (Chrome on Android) logos vanished: the cached textures are uploaded again
   by every newly opened view, and a browser may evict or wipe 2D canvases
   it is holding, so the re-upload came out blank. Bytes in ordinary memory
   cannot be wiped, uploading a byte array is the simplest path every WebGL
   implementation supports, and a paint that fails keeps the last good
   pixels instead of leaving a cleared canvas behind.

   A repaint (the logo or the web font arrived) disposes the texture before
   marking it for upload, so every renderer frees its copy and allocates fresh
   storage for the new pixels: the same allocate-and-upload path as a badge's
   first upload, which /?diag measures on the device. Updating an uploaded
   texture in place (texSubImage2D, then regenerating mipmaps) is a path the
   device check never runs, and it buys nothing here. */
import * as THREE from "three";
import { COMPANIES, districtOf, initials, personInitials } from "../data/catalog";
import type { Company, LogoInfo, Person } from "../data/types";
import { SITE } from "../site";
import { cpuContext } from "./cpuCanvas";
import { companyLogo, loadImage } from "./logoInfo";

/** Logical badge size; drawing happens in these units. */
export const BADGE_W = 512;
export const BADGE_H = 256;
export const LABEL_H = 92;
/** Unlabeled walking pins use compact textures. Globe labels need more pixels when zoomed in. */
const RES = 0.75;
// Retina detail for small maps; larger catalogs share a 96 MB labeled-texture budget.
// Never reduce an existing catalog below the compact resolution used by walking pins.
const LABEL_RES = Math.max(RES, Math.min(1.5, Math.sqrt(96_000_000 / Math.max(1, COMPANIES.length) / (BADGE_W * (BADGE_H + LABEL_H) * 4 * 4 / 3))));
/** The brand ink (site.json theme.ink): label text and the dark logo plate. */
const ink = () => SITE.theme.ink;

export interface Badge {
  texture: THREE.DataTexture;
  /** width / height of the drawn badge, for sizing a plane or sprite. */
  aspect: number;
}

type Painter = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

const cache = new Map<string, Badge>();

let scratch: HTMLCanvasElement | null = null;
/** The shared scratch canvas, grown (never shrunk) to at least w×h. */
function scratchContext(w: number, h: number): CanvasRenderingContext2D {
  scratch ??= document.createElement("canvas");
  if (scratch.width < w || scratch.height < h) {
    scratch.width = Math.max(scratch.width, w);
    scratch.height = Math.max(scratch.height, h);
  }
  return cpuContext(scratch);
}

function byteTexture(w: number, h: number): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(w * h * 4), w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  return t;
}

const bakeListeners = new Set<() => void>();

/** Calls `fn` after every repaint of a badge or label texture (a logo or the web font finished
 *  loading), so a view that renders on demand can draw a frame with the new pixels. Returns the
 *  unsubscribe function. */
export function onBadgeBaked(fn: () => void): () => void {
  bakeListeners.add(fn);
  return () => {
    bakeListeners.delete(fn);
  };
}

/** Paint on the scratch canvas and copy the pixels into `tex`, rows flipped (WebGL's origin is
 *  bottom-left). If painting throws, the texture keeps its last good pixels. */
function bake(tex: THREE.DataTexture, paint: Painter): void {
  const { width: w, height: h, data } = tex.image as { width: number; height: number; data: Uint8Array };
  try {
    const ctx = scratchContext(w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    try {
      paint(ctx, w, h);
    } finally {
      ctx.restore();
    }
    const px = ctx.getImageData(0, 0, w, h).data;
    const row = w * 4;
    for (let y = 0; y < h; y++) data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    // A repaint: free every renderer's copy, so the next draw allocates and uploads it afresh.
    if (tex.version > 0) tex.dispose();
    tex.needsUpdate = true;
  } catch {
    // Keep the previous pixels; a later paint (image or font load) tries again.
    return;
  }
  for (const fn of bakeListeners) fn();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

type Logo = { img: HTMLImageElement; info: LogoInfo } | null;

function plateColor(logo: Logo): string {
  if (!logo) return "#ffffff";
  if (logo.info.plate === "dark") return ink();
  if (logo.info.plate === "self") return logo.info.bg ?? "#ffffff";
  return "#ffffff";
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number, size: number, weight = 600): number {
  let s = size;
  ctx.font = `${weight} ${s}px "Instrument Sans", system-ui, sans-serif`;
  while (ctx.measureText(text).width > maxW && s > 18) {
    s -= 2;
    ctx.font = `${weight} ${s}px "Instrument Sans", system-ui, sans-serif`;
  }
  return s;
}

function draw(ctx: CanvasRenderingContext2D, m: Company, withLabel: boolean, logo: Logo) {
  const res = withLabel ? LABEL_RES : RES;
  ctx.setTransform(res, 0, 0, res, 0, 0);
  ctx.imageSmoothingQuality = "high";
  const W = BADGE_W;
  const color = districtOf(m).color;

  const rim = 10;
  const plateH = BADGE_H;
  // rim
  roundRect(ctx, 0, 0, W, plateH, 44);
  ctx.fillStyle = color;
  ctx.fill();
  // plate
  roundRect(ctx, rim, rim, W - rim * 2, plateH - rim * 2, 36);
  ctx.fillStyle = plateColor(logo);
  ctx.fill();

  const pad = 34;
  const boxW = W - (rim + pad) * 2;
  const boxH = plateH - (rim + pad) * 2;
  if (logo) {
    // Contain the logo's artwork (its measured crop) in the plate's box; inset square and tall marks
    // a little so they carry the same visual weight as wide wordmarks (opaque logos keep their full
    // size: they are their own plate).
    const { img, info } = logo;
    const c = info.crop;
    const compact = info.plate !== "self" && c.w / c.h < 1.6;
    const k = Math.min(boxW / c.w, boxH / c.h) * (compact ? 0.8 : 1);
    const w = c.w * k;
    const h = c.h * k;
    ctx.drawImage(img, c.x, c.y, c.w, c.h, (W - w) / 2, (plateH - h) / 2, w, h);
  } else {
    // monogram
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(W / 2, plateH / 2, 82, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 76px "Instrument Sans", system-ui, sans-serif`;
    ctx.fillText(initials(m.name), W / 2, plateH / 2 + 4);
  }

  if (withLabel) {
    const y = plateH + 10;
    roundRect(ctx, 24, y, W - 48, LABEL_H - 16, 26);
    ctx.fillStyle = "rgba(255,255,255,0.96)";
    ctx.fill();
    ctx.fillStyle = ink();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    fitText(ctx, m.name, W - 96, 46);
    ctx.fillText(m.name, W / 2, y + (LABEL_H - 16) / 2 + 2);
  }
}

function badgeSize(withLabel: boolean): [number, number] {
  const res = withLabel ? LABEL_RES : RES;
  return [Math.round(BADGE_W * res), Math.round((BADGE_H + (withLabel ? LABEL_H : 0)) * res)];
}

function logoReady(m: Company): Promise<Logo> {
  const fontReady = document.fonts?.ready ?? Promise.resolve();
  return Promise.all([companyLogo(m), fontReady]).then(([logo]) => logo);
}

/** A cached badge texture for a company. `withLabel` adds the company name under the plate. */
export function companyBadge(m: Company, withLabel = false): Badge {
  const key = `${m.slug}|${withLabel ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const [w, h] = badgeSize(withLabel);
  const texture = byteTexture(w, h);
  bake(texture, (ctx) => draw(ctx, m, withLabel, null));
  const badge: Badge = { texture, aspect: w / h };
  cache.set(key, badge);
  logoReady(m).then((logo) => bake(texture, (ctx) => draw(ctx, m, withLabel, logo)));
  return badge;
}

/** A company's finished badge on a canvas of its own (diagnostics compare upload paths with it). */
export async function badgeCanvas(m: Company, withLabel = false): Promise<HTMLCanvasElement> {
  const logo = await logoReady(m);
  const [w, h] = badgeSize(withLabel);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext("2d")!, m, withLabel, logo);
  return canvas;
}

/* ---------------------------------------------------------------- people */

/** Person badge texture size in pixels (square). Headshots are 320 px; badges show at up to about 170 device pixels. */
export const PERSON_BADGE = 256;
const PERSON_FALLBACK = "#3b4a5a";
let personColorCache: string | null = null;

/**
 * The one neutral color every person badge rings in (the --person token in tokens.css). It is not
 * a district color: people belong to no industry.
 */
export function personColor(): string {
  if (personColorCache) return personColorCache;
  if (typeof document === "undefined") return PERSON_FALLBACK;
  personColorCache = getComputedStyle(document.documentElement).getPropertyValue("--person").trim() || PERSON_FALLBACK;
  return personColorCache;
}

function drawPerson(ctx: CanvasRenderingContext2D, c: Person, img: HTMLImageElement | null) {
  const S = PERSON_BADGE;
  const r = S / 2;
  const ring = 13;
  const gap = 4;
  const color = personColor();
  ctx.imageSmoothingQuality = "high";
  ctx.beginPath();
  ctx.arc(r, r, r - 1, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(r, r, r - ring, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  const inner = r - ring - gap;
  ctx.save();
  ctx.beginPath();
  ctx.arc(r, r, inner, 0, Math.PI * 2);
  ctx.clip();
  if (img) {
    // Headshots should be square (docs/configuration.md); cover the circle all the same.
    const k = Math.max((inner * 2) / img.width, (inner * 2) / img.height);
    const w = img.width * k;
    const h = img.height * k;
    ctx.drawImage(img, r - w / 2, r - h / 2, w, h);
  } else {
    // The page shows no photo: initials, never a stock or generated face.
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.round(inner * 0.78)}px "Instrument Sans", system-ui, sans-serif`;
    ctx.fillText(personInitials(c.name), r, r + 4);
  }
  ctx.restore();
}

/**
 * A cached badge texture for a person: the headshot in a circle, ringed in the person color, with
 * initials when the page shows no photo. Baked to bytes like company badges; shared by both views.
 */
export function personBadge(c: Person): Badge {
  const key = `person|${c.slug}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const texture = byteTexture(PERSON_BADGE, PERSON_BADGE);
  bake(texture, (ctx) => drawPerson(ctx, c, null));
  const badge: Badge = { texture, aspect: 1 };
  cache.set(key, badge);
  const fontReady = document.fonts?.ready ?? Promise.resolve();
  const imgReady = c.headshot ? loadImage(c.headshot) : Promise.resolve(null);
  Promise.all([imgReady, fontReady]).then(([img]) => bake(texture, (ctx) => drawPerson(ctx, c, img)));
  return badge;
}

/** A plain text label texture (district names, hub labels). */
export function labelTexture(text: string, opts: { color?: string; bg?: string; size?: number; weight?: number; padX?: number } = {}): Badge {
  const key = `label|${text}|${opts.color}|${opts.bg}|${opts.size}|${opts.weight}|${opts.padX}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const size = opts.size ?? 64;
  const padX = opts.padX ?? 36;
  const font = `${opts.weight ?? 650} ${size}px "Instrument Sans", system-ui, sans-serif`;
  const measure = scratchContext(1, 1);
  measure.font = font;
  const w = Math.min(2048, Math.ceil(measure.measureText(text).width + padX * 2));
  const h = Math.ceil(size * 1.7);
  const paint: Painter = (c) => {
    if (opts.bg) {
      roundRect(c, 0, 0, w, h, h / 2);
      c.fillStyle = opts.bg;
      c.fill();
    }
    c.font = font;
    c.fillStyle = opts.color ?? ink();
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, w / 2, h / 2 + size * 0.05);
  };
  const texture = byteTexture(w, h);
  bake(texture, paint);
  const badge: Badge = { texture, aspect: w / h };
  cache.set(key, badge);
  (document.fonts?.ready ?? Promise.resolve()).then(() => bake(texture, paint));
  return badge;
}

// Development-only handle for tests. Stripped from production builds.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __badges?: unknown }).__badges = { companyBadge, cache };
}
