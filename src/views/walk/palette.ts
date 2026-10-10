/* The walk world's current theme, read from --scene-* and brand tokens.
   District colors keep their meaning in both themes. */
import * as THREE from "three";
import "./scene-theme.css";

export interface ScenePalette {
  dark: boolean;
  skyTop: THREE.Color;
  skyBottom: THREE.Color;
  sea: THREE.Color;
  seaDeep: THREE.Color;
  sand: THREE.Color;
  grass: THREE.Color;
  grassDark: THREE.Color;
  road: THREE.Color;
  plaza: THREE.Color;
  tree: THREE.Color;
  treeDark: THREE.Color;
  trunk: THREE.Color;
  rock: THREE.Color;
  /* The hub building (src/views/walk/hub.ts) and the plaza around it. */
  paint: THREE.Color;
  coping: THREE.Color;
  membrane: THREE.Color;
  roofWhite: THREE.Color;
  fascia: THREE.Color;
  concrete: THREE.Color;
  mulch: THREE.Color;
  glass: THREE.Color;
  signPanel: THREE.Color;
  navy: THREE.Color;
  ink: THREE.Color;
  /** Daylight or neutral moonlight. */
  sun: THREE.Color;
  /** The same colors as CSS strings, for the 2D minimap. */
  css: Record<string, string>;
}

const TOKENS: Record<string, [string, string]> = {
  skyTop: ["--scene-sky-top", "#9fd3ea"],
  skyBottom: ["--scene-sky-bottom", "#eaf6f8"],
  sea: ["--scene-sea", "#3f9fbf"],
  seaDeep: ["--scene-sea-deep", "#2a7fa3"],
  sand: ["--scene-sand", "#ecdcb0"],
  grass: ["--scene-grass", "#a9cf8a"],
  grassDark: ["--scene-grass-dark", "#8fbd72"],
  road: ["--scene-road", "#efe6d2"],
  plaza: ["--scene-plaza", "#f3eee4"],
  tree: ["--scene-tree", "#5f9f5a"],
  treeDark: ["--scene-tree-dark", "#3f7d46"],
  trunk: ["--scene-trunk", "#8a6a4a"],
  rock: ["--scene-rock", "#b9b2a6"],
  paint: ["--scene-paint", "#ece8df"],
  coping: ["--scene-coping", "#c8ccce"],
  membrane: ["--scene-membrane", "#a3aab0"],
  roofWhite: ["--scene-roof-white", "#eef1f0"],
  fascia: ["--scene-fascia", "#3a3d42"],
  concrete: ["--scene-concrete", "#b8b5ad"],
  mulch: ["--scene-mulch", "#4a3a2c"],
  glass: ["--scene-glass", "#22303a"],
  signPanel: ["--scene-sign-panel", "#f7f6f2"],
  navy: ["--brand-navy", "#2d4a65"],
  ink: ["--brand-ink", "#1d1f24"],
};

export function readScenePalette(): ScenePalette {
  const cs = typeof document !== "undefined" ? getComputedStyle(document.documentElement) : null;
  const css: Record<string, string> = {};
  const colors: Record<string, THREE.Color> = {};
  for (const [key, [name, fallback]] of Object.entries(TOKENS)) {
    const raw = cs?.getPropertyValue(name).trim() || fallback;
    let c: THREE.Color;
    try {
      c = new THREE.Color(raw);
    } catch {
      c = new THREE.Color(fallback);
    }
    colors[key] = c;
    css[key] = `#${c.getHexString()}`;
  }
  const dark = cs?.colorScheme.includes("dark") ?? false;
  const sun = dark ? new THREE.Color("#d4d4d8") : new THREE.Color(1, 1, 1).lerp(colors.sand, 0.32);
  css.sun = `#${sun.getHexString()}`;
  return { ...(colors as Omit<ScenePalette, "dark" | "sun" | "css">), dark, sun, css } as ScenePalette;
}

/** Watch theme changes without rebuilding the avatar, camera or multiplayer session. */
export function watchScenePalette(change: (palette: ScenePalette) => void): () => void {
  const initial = readScenePalette();
  let last = JSON.stringify([initial.dark, initial.css]);
  const refresh = () => {
    const palette = readScenePalette();
    const key = JSON.stringify([palette.dark, palette.css]);
    if (key === last) return;
    last = key;
    change(palette);
  };
  const observer = new MutationObserver(refresh);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", refresh);
  return () => {
    observer.disconnect();
    media.removeEventListener("change", refresh);
  };
}

/**
 * The People area's color in the walk world (--scene-person): a lighter tint of the person color,
 * since the badge ring's slate reads near black on large flat-shaded props. Not a district color.
 */
export function personSceneColor(): string {
  const raw = typeof document !== "undefined" ? getComputedStyle(document.documentElement).getPropertyValue("--scene-person").trim() : "";
  return raw || "#6f8296";
}

/** A new color `t` of the way from a to b. */
export function mix(a: THREE.Color, b: THREE.Color | string, t: number): THREE.Color {
  return a.clone().lerp(typeof b === "string" ? new THREE.Color(b) : b, t);
}
