/* What each globe carries.

   The controller (controller.ts) and the scene (GlobeScene.tsx) are shared by both globes; a
   GlobeContent tells them what goes on the sphere and what selecting a node does:

   - The companies globe: every company as a logo badge in its industry region, with spokes,
     documented connections and, for a selected company, potential fits.
   - The people globe: every person as a round headshot badge ringed in the one person color,
     evenly spread (personLayout.ts), with no lines at all. People have no link to any company,
     district or industry (CLAUDE.md), so this content draws none and derives none. */
import { PEOPLE, DISTRICTS, COMPANIES } from "../../data/catalog";
import type { Link } from "../../data/graph";
import { useStore, type Roster } from "../../state/store";
import { BADGE_H, BADGE_W, LABEL_H, personBadge, companyBadge, type Badge } from "../../three/logoTexture";
import { personGlobeLayout, type PersonNode } from "./personLayout";
import { computeGlobeLayout, type GlobeLayoutOf, type GlobeNode, type GlobeNodeBase } from "./globeLayout";
import type { GlassRegion } from "./materials";
import { globePalette } from "./palette";
import { allDocumentedLinks, selectionLinks, type SelectionLinks } from "./selection";

export interface GlobeContent<N extends GlobeNodeBase> {
  /** Which roster this globe shows (store.roster). */
  roster: Roster;
  layout: GlobeLayoutOf<N>;
  /** Badge width / height. */
  badgeAspect: number;
  /** Angular node spacing a badge's diagonal spans (badge size); the layout's spacing when absent. */
  badgeFit?: number;
  badge(node: N): Badge;
  /** Stem and pin color for a node; also its selection glow unless glow() says otherwise. */
  color(node: N): string;
  /**
   * How badges fade: `back` is the opacity of a badge seen through the glass on the far side;
   * badges fade from full toward `rim` as they turn to the globe's edge. Defaults 0.12 and 0.22,
   * which keep 127 logos from crowding at the rim; the sparse people globe fades less.
   */
  fade?: { back: number; rim: number };
  /**
   * Where a node fly takes the camera. "close-up" (companies): near enough to read the logo, pulled
   * back to show its connections. "overview": the whole globe above the detail sheet, the node
   * turned to the front (the people globe; the sheet already shows the face up close).
   */
  flyTo?: "close-up" | "overview";
  glow?(node: N): string;
  /** Territories the glass tints (see createGlassMaterial). */
  glass: GlassRegion[];
  /** Documented connections to draw between nodes. */
  documented(): Link[];
  /** What a selected node draws lines to, or null for nothing. */
  links(slug: string): SelectionLinks | null;
  /** The visitor picked a node on the globe. */
  pick(node: N): void;
}

export function companyGlobeContent(): GlobeContent<GlobeNode> {
  const layout = computeGlobeLayout(DISTRICTS, COMPANIES);
  return {
    roster: "companies",
    layout,
    badgeAspect: BADGE_W / (BADGE_H + LABEL_H),
    badge: (nd) => companyBadge(nd.company, true),
    color: (nd) => layout.regions[nd.region].district.color,
    glass: layout.regions.map((r) => ({ center: r.center, radius: r.radius, color: r.district.color })),
    documented: allDocumentedLinks,
    links: selectionLinks,
    pick: (nd) => useStore.getState().select(nd.company.slug, { fly: true }),
  };
}

/**
 * Badge size on the people globe, as the angular spacing a badge's diagonal spans. The people
 * sit about 0.79 rad apart; this makes each headshot about a third of that across, which leaves
 * room for a name label under every one.
 */
export const PERSON_BADGE_FIT = 0.34;

export function personGlobeContent(): GlobeContent<PersonNode> {
  const layout = personGlobeLayout(PEOPLE);
  const P = globePalette();
  const none: Link[] = [];
  return {
    roster: "people",
    layout,
    badgeAspect: 1,
    badgeFit: PERSON_BADGE_FIT,
    badge: (nd) => personBadge(nd.person),
    color: () => globePalette().personStem,
    glow: () => globePalette().teal,
    // Eighteen faces never crowd the rim, and faces seen through the glass read as ghosts: fade those more.
    fade: { back: 0, rim: 0.42 },
    flyTo: "overview",
    // One territory larger than the sphere: an even, pale tint all over (no regions, no seams).
    glass: [{ center: [0, 1, 0], radius: 4, color: P.personGlass }],
    documented: () => none,
    links: () => null,
    pick: (nd) => useStore.getState().selectPerson(nd.person.slug, { fly: true }),
  };
}
