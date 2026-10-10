/* Scene colors for the globe, read from the current CSS tokens in
   src/styles/tokens.css so the 3D scene and the HUD legend share one
   source. District colors never come from here: they come from data
   (district.color). The fallbacks only apply if a token is missing. */

export interface GlobePalette {
  dark: boolean;
  surface: string;
  rim: string;
  /** Documented connections (sourced facts). */
  documented: string;
  /** Potential providers of the selected company (derived suggestions). */
  provider: string;
  /** Potential clients of the selected company (derived suggestions). */
  client: string;
  /** Neutral line color for the legend's structure swatch. */
  line: string;
  /** The core's rim and glow (the accent). */
  teal: string;
  ink: string;
  paper: string;
  /** Atmosphere tint around the globe. */
  atmosphere: string;
  /** Glass tint of the people globe (no regions: one even tint). */
  personGlass: string;
  /** Stems and surface pins under the people's badges. */
  personStem: string;
}

const FALLBACK: GlobePalette = {
  dark: false,
  surface: "#e4e4e7",
  rim: "#a1a1aa",
  documented: "#0c7a8c",
  provider: "#eda100",
  client: "#2a78d6",
  line: "#9aa9b4",
  teal: "#0c7a8c",
  ink: "#1d1f24",
  paper: "#ffffff",
  atmosphere: "#a1a1aa",
  personGlass: "#a1a1aa",
  personStem: "#71717a",
};

export function globePalette(): GlobePalette {
  if (typeof document === "undefined") return FALLBACK;
  const cs = getComputedStyle(document.documentElement);
  const dark = cs.colorScheme.includes("dark");
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    dark,
    surface: dark ? "#18181b" : "#e4e4e7",
    rim: dark ? "#52525b" : "#a1a1aa",
    documented: v("--mindmap-documented", v("--brand-accent", FALLBACK.documented)),
    provider: v("--mindmap-provider", FALLBACK.provider),
    client: v("--mindmap-client", FALLBACK.client),
    line: v("--mindmap-line", FALLBACK.line),
    teal: v("--brand-accent", FALLBACK.teal),
    ink: v("--brand-ink", FALLBACK.ink),
    // Publisher artwork and badge dimming use a light plate in either interface theme.
    paper: "#ffffff",
    atmosphere: dark ? "#71717a" : "#a1a1aa",
    personGlass: dark ? "#3f3f46" : "#a1a1aa",
    personStem: v("--text-muted", FALLBACK.personStem),
  };
}

/** Theme toggles and OS changes repaint an already-mounted scene. */
export function watchGlobePalette(change: (palette: GlobePalette) => void): () => void {
  let last = "";
  const refresh = () => {
    const palette = globePalette();
    const key = JSON.stringify(palette);
    if (key === last) return;
    last = key;
    change(palette);
  };
  const observer = new MutationObserver(refresh);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", refresh);
  refresh();
  return () => {
    observer.disconnect();
    media.removeEventListener("change", refresh);
  };
}
