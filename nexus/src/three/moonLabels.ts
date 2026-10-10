import { overlaps, type Rect } from "../lib/declutter.ts";

export interface MoonAnchor { slug: string; x: number; y: number; radius: number; }
export interface MoonLabelPosition { slug: string; x: number; y: number; width: number; }

/** Pack every annotation into the available scene. Dense views use a compact grid;
 *  sparse views keep each name beside its moon. Text never overlaps another name. */
export function layoutMoonLabels(anchors: readonly MoonAnchor[], area: Rect, obstacles: readonly Rect[] = []): MoonLabelPosition[] {
  if (!anchors.length) return [];
  const width = Math.max(44, area.r - area.l);
  const height = Math.max(18, area.b - area.t);
  const maxRows = Math.max(1, Math.floor(height / 18));
  const columns = Math.max(Math.ceil(anchors.length / maxRows), Math.floor(width / (width < 500 ? 88 : 116)), 1);
  const cellWidth = width / columns;
  const labelWidth = Math.max(40, Math.min(width < 500 ? 82 : 108, cellWidth - 6));
  const rows = Math.min(maxRows, Math.max(1, Math.ceil((anchors.length + Math.min(8, anchors.length)) / columns)));
  const cellHeight = height / rows;
  const slots: { x: number; y: number }[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) slots.push({ x: area.l + cellWidth * (col + 0.5), y: area.t + cellHeight * (row + 0.5) });
  const bounds = (x: number, y: number): Rect => ({ l: x - labelWidth / 2, r: x + labelWidth / 2, t: y - 8, b: y + 8 });
  const occupied = [...obstacles];
  const result: MoonLabelPosition[] = [];
  const order = [...anchors].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const a of order) {
    const candidates = anchors.length <= 14 ? [{ x: a.x, y: a.y - a.radius - 14 }, { x: a.x, y: a.y + a.radius + 14 }, ...slots] : slots;
    const valid = candidates.filter((p) => {
      const r = bounds(p.x, p.y);
      return r.l >= area.l && r.r <= area.r && r.t >= area.t && r.b <= area.b && !occupied.some((other) => overlaps(r, other, 2));
    });
    valid.sort((p, q) => (p.x - a.x) ** 2 + (p.y - a.y) ** 2 - (q.x - a.x) ** 2 - (q.y - a.y) ** 2);
    let p = valid[0];
    // Tiny screens can leave no room around a large publisher pill. Keep all moon
    // names available; the publisher stamp has lower priority in that situation.
    if (!p) p = slots.filter((s) => !result.some((r) => Math.abs(r.x - s.x) < labelWidth && Math.abs(r.y - s.y) < 18))[0];
    if (!p) continue;
    result.push({ slug: a.slug, x: p.x, y: p.y, width: labelWidth });
    occupied.push(bounds(p.x, p.y));
  }
  return result;
}

interface MoonName { slug: string; name: string; count: number; unit: string; }

/** Keep names steady during subpixel camera damping. Repack after a visible move
 *  or a changed HUD, while the lightweight leader endpoints keep tracking moons. */
export class MoonLabelLayout {
  private anchors: MoonAnchor[] = [];
  private area: Rect | null = null;
  private obstacles: Rect[] = [];
  private positions: MoonLabelPosition[] = [];

  update(anchors: readonly MoonAnchor[], area: Rect, obstacles: readonly Rect[]): MoonLabelPosition[] {
    const sameRect = (a: Rect, b: Rect) => a.l === b.l && a.r === b.r && a.t === b.t && a.b === b.b;
    const threshold = anchors.length > 14 ? 8 : 2;
    const unchanged = this.area && sameRect(area, this.area) && anchors.length === this.anchors.length && obstacles.length === this.obstacles.length &&
      obstacles.every((r, i) => sameRect(r, this.obstacles[i])) && anchors.every((a, i) => {
        const p = this.anchors[i];
        return a.slug === p.slug && Math.abs(a.radius - p.radius) < 1 && (a.x - p.x) ** 2 + (a.y - p.y) ** 2 < threshold ** 2;
      });
    if (unchanged) return this.positions;
    this.area = { ...area };
    this.anchors = anchors.map((a) => ({ ...a }));
    this.obstacles = obstacles.map((r) => ({ ...r }));
    this.positions = layoutMoonLabels(anchors, area, obstacles);
    return this.positions;
  }
}

/** Native text stays sharp without a texture, and 44px targets remain keyboard accessible. */
export class MoonLabels {
  readonly root = document.createElement("div");
  private readonly lines = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly paths = new Map<string, SVGPathElement>();
  private readonly pathData = new Map<string, string>();
  private readonly layout = new MoonLabelLayout();
  private readonly bySlug = new Map<string, MoonAnchor>();
  private positions: MoonLabelPosition[] = [];
  private selected: string | null = null;
  private down: { x: number; y: number; pointerId: number } | null = null;
  private dragged = false;

  constructor(names: readonly MoonName[], private readonly pick: (slug: string) => void, private readonly hover: (slug: string | null) => void, canvas: HTMLCanvasElement) {
    this.root.className = "moon-annotations";
    this.root.style.cssText = "position:absolute;inset:0;z-index:4;pointer-events:none;overflow:hidden";
    this.lines.style.cssText = "position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none";
    this.lines.setAttribute("aria-hidden", "true");
    this.root.append(this.lines);
    const style = document.createElement("style");
    style.textContent = `.moon-annotation{position:absolute;display:flex;align-items:center;justify-content:center;gap:4px;height:44px;min-width:44px;padding:0 3px;border:0;border-radius:6px;background:none;color:var(--text-muted,#a1a1aa);font:400 10px/14px var(--font,"DM Sans",sans-serif);pointer-events:auto;cursor:pointer;touch-action:none;white-space:nowrap;transform:translate(-50%,-50%)}.moon-annotation span{overflow:hidden;text-overflow:ellipsis;min-width:0;text-shadow:0 1px 4px var(--bg,#090909),0 -1px 4px var(--bg,#090909)}.moon-annotation small{font-size:9px;opacity:.7;font-variant-numeric:tabular-nums}.moon-annotation:hover,.moon-annotation[aria-pressed=true]{color:var(--text,#f4f4f5)}.moon-annotation:focus-visible{outline:1px solid var(--text,#f4f4f5);outline-offset:-5px;background:var(--surface,#18181b)}`;
    this.root.append(style);
    for (const name of names) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "moon-annotation";
      button.dataset.moon = name.slug;
      button.setAttribute("aria-label", `${name.name}, ${name.count} ${name.unit}`);
      button.setAttribute("aria-pressed", "false");
      button.title = `${name.name} · ${name.count} ${name.unit}`;
      const text = document.createElement("span"); text.textContent = name.name;
      const count = document.createElement("small"); count.textContent = String(name.count);
      button.append(text, count);
      button.addEventListener("click", (e) => {
        // Invisible touch targets may overlap in a dense map: select the name
        // nearest the pointer, while keyboard activation uses the focused button.
        if (e.detail && this.dragged) return;
        const slug = e.detail ? this.nearest(e.clientX, e.clientY) ?? name.slug : name.slug;
        this.pick(slug);
      });
      button.addEventListener("focus", () => this.hover(name.slug));
      button.addEventListener("blur", () => this.hover(null));
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("fill", "none");path.setAttribute("stroke", "currentColor");path.setAttribute("stroke-width", ".7");
      path.style.cssText = "color:var(--text-muted,#a1a1aa);opacity:.25";
      this.paths.set(name.slug, path);this.lines.append(path);
      this.buttons.set(name.slug, button);this.root.append(button);
    }
    // An annotation can start an orbit gesture too. Transfer the captured pointer
    // to the canvas after the tap threshold; tiny names never block the scene.
    this.root.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !(e.target instanceof Element)) return;
      this.dragged = false;
      this.down = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
      e.target.closest("button")?.setPointerCapture(e.pointerId);
    });
    this.root.addEventListener("pointermove", (e) => {
      const d = this.down;
      if (d && d.pointerId === e.pointerId && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) {
        this.down = null;this.dragged = true;this.hover(null);
        const init = { pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary, button: 0, buttons: e.buttons, clientX: d.x, clientY: d.y, cancelable: true };
        canvas.dispatchEvent(new PointerEvent("pointerdown", init));
        canvas.dispatchEvent(new PointerEvent("pointermove", { ...init, clientX: e.clientX, clientY: e.clientY }));
      } else if (!e.buttons) this.hover(this.nearest(e.clientX, e.clientY));
    });
    this.root.addEventListener("pointerup", () => { this.down = null; });
    this.root.addEventListener("pointercancel", () => { this.down = null; });
    this.root.addEventListener("wheel", (e) => {
      e.preventDefault();
      canvas.dispatchEvent(new WheelEvent("wheel", { deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey, cancelable: true }));
    }, { passive: false });
    this.root.addEventListener("pointerleave", () => this.hover(null));
  }

  private nearest(clientX: number, clientY: number): string | null {
    const rect = this.root.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    let distance = Infinity, slug: string | null = null;
    for (const p of this.positions) {
      if (Math.abs(x - p.x) > Math.max(22, p.width / 2) || Math.abs(y - p.y) > 22) continue;
      const d = (x - p.x) ** 2 + (y - p.y) ** 2;
      if (d < distance) {distance = d;slug = p.slug;}
    }
    return slug;
  }

  setSelected(slug: string | null): void {
    if (this.selected === slug) return;
    this.selected = slug;
    for (const [key, button] of this.buttons) button.setAttribute("aria-pressed", String(key === slug));
  }

  update(anchors: readonly MoonAnchor[], area: Rect, obstacles: readonly Rect[]): void {
    const positions = this.layout.update(anchors, area, obstacles);
    const moved = this.positions !== positions;
    this.positions = positions;
    for (const a of anchors) this.bySlug.set(a.slug, a);
    for (const p of this.positions) {
      const button = this.buttons.get(p.slug)!;
      const x = Math.round(p.x), y = Math.round(p.y);
      if (moved) { button.style.left = `${x}px`;button.style.top = `${y}px`;button.style.width = `${p.width}px`; }
      const a = this.bySlug.get(p.slug)!;
      const path = this.paths.get(p.slug)!;
      const d = (a.x - p.x) ** 2 + (a.y - p.y) ** 2 < 144 ? "" : `M${Math.round(a.x)},${Math.round(a.y)}L${x},${y}`;
      if (this.pathData.get(p.slug) !== d) { this.pathData.set(p.slug, d);path.setAttribute("d", d); }
    }
  }

  dispose(): void {this.root.remove();}
}
