/* The globes (the "3D mind map").

   Two globes, one at a time, switched with Companies | People at the top of the stage.

   The companies globe: every company is a logo on one slowly turning sphere. Each
   district owns a tinted region of the surface, like a continent; its companies cluster inside it
   and spoke into its hub. Documented connections (sourced facts) arc between companies in brand
   teal. Selecting a company turns it to face you and draws its potential fits (derived
   suggestions, dashed) on top. Regions group companies by industry, not by location.

   The people globe: the organization's people roster as round headshots on a sphere of the same glass, evenly
   spread, each with its name underneath. It turns, drags and zooms like the companies globe.
   People are never linked to companies: no line, suggestion or highlight crosses between the
   two globes (CLAUDE.md).

   Both globes share one canvas and one controller class (controller.ts) with different content
   (globeContent.ts). Only the globe in view has a scene; switching fades the old one out and the
   new one in (an instant swap under reduced motion), and a globe the visitor comes back to
   resumes with the same rotation, camera and selection.

   The view owns its HUD and DOM overlay (district labels and person names as real buttons,
   keyboard buttons for the active region's companies, a hover tooltip). The detail sheet,
   search and panels belong to the shell. */
import { Building2, Globe2, ListTree, Minus, Pause, Play, Plus, UserRound } from "lucide-react";
import { Canvas } from "@react-three/fiber";
import { Component, Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { COMPANIES, DISTRICTS, HAS_PEOPLE, PEOPLE, SITE, companyBySlug } from "../../data/catalog";
import { L, article } from "../../site";
import { DistrictIcon } from "../../components/bits";
import SearchChip from "../../components/SearchChip";
import { usePersonHighlight, useHighlight, useStore, type Roster } from "../../state/store";
import type { PersonNode } from "./personLayout";
import { FOV, GlobeController } from "./controller";
import { personGlobeContent, companyGlobeContent } from "./globeContent";
import { firstFly, flyInput, missedFly, ownsFly } from "./globeFlies";
import type { GlobeNode, GlobeNodeBase } from "./globeLayout";
import GlobeScene from "./GlobeScene";
import { regionButtonName } from "./labels";
import { selectionLinks } from "./selection";
import "./mindmap.css";

function supportsWebGL2(): boolean {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.(REDUCED_QUERY).matches;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const mq = window.matchMedia?.(REDUCED_QUERY);
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

function Fallback({ detail }: { detail?: string }) {
  const setView = useStore((s) => s.setView);
  return (
    <div className="view mm-view mm-fallback">
      <div className="mm-fallback-card" role="status">
        <h2>The 3D globe can't run here</h2>
        <p>{detail ?? "This browser or device doesn't support WebGL 2, which the globe needs."} Every {L.company}{HAS_PEOPLE ? ` and ${L.person}` : ""} is in the list view, with the same details.</p>
        <button type="button" className="btn btn-primary" onClick={() => setView("list")}>
          <ListTree size={16} aria-hidden="true" /> Open the list
        </button>
      </div>
    </div>
  );
}

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error("Company globe failed to start:", err);
  }
  render() {
    return this.state.failed ? <Fallback detail="The 3D globe failed to start on this device." /> : this.props.children;
  }
}

/** Fresh WebGL contexts to try, per visit to the globe, when the browser never restores a lost one. */
const MAX_FRESH_CONTEXTS = 2;

export default function MindMapView() {
  const [webgl] = useState(supportsWebGL2);
  // Bumped when the WebGL context was lost and never restored: the globe starts over (a new
  // controller, scene and context), since a lost context draws nothing but the DOM labels.
  const [generation, setGeneration] = useState(0);
  const freshContext = useCallback(() => {
    console.warn("Company globe: the WebGL context was lost and not restored; starting over with a new one.");
    setGeneration((g) => g + 1);
  }, []);
  if (!webgl) return <Fallback />;
  if (generation > MAX_FRESH_CONTEXTS) return <Fallback detail="This device's graphics stopped responding to the globe." />;
  return (
    <SceneBoundary>
      <GlobeView key={generation} onContextGiveUp={freshContext} />
    </SceneBoundary>
  );
}

/** The outgoing globe fades for OUT_MS, then the incoming one settles in over IN_MS (see mindmap.css). */
const OUT_MS = 170;
const IN_MS = 340;
/** idle → out (old globe fades) → enter (new scene mounts unseen) → in (new globe fades in) → idle. */
type Phase = "idle" | "out" | "enter" | "in";

type AnyController = GlobeController<GlobeNode> | GlobeController<PersonNode>;

function GlobeView({ onContextGiveUp }: { onContextGiveUp: () => void }) {
  const reduced = useReducedMotion();
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());
  const roster = useStore((s) => s.roster);
  const live = useRef({ reduced, playing });
  live.current = { reduced, playing };

  // One controller per globe, made the first time that globe is shown, kept while the view is open.
  const ctls = useRef<{ companies?: GlobeController<GlobeNode>; people?: GlobeController<PersonNode> }>({});
  const companiesCtl = () => (ctls.current.companies ??= new GlobeController(companyGlobeContent(), { ...live.current }));
  const peopleCtl = () => (ctls.current.people ??= new GlobeController(personGlobeContent(), { ...live.current }));
  const each = (fn: (c: AnyController) => void) => {
    if (ctls.current.companies) fn(ctls.current.companies);
    if (ctls.current.people) fn(ctls.current.people);
  };

  useEffect(() => {
    each((c) => {
      c.reduced = reduced;
      c.invalidate();
    });
    // Turning reduced motion on mid-visit stops auto-rotation, as it does on load.
    if (reduced) setPlaying(false);
  }, [reduced]);
  useEffect(() => each((c) => c.setPlaying(playing)), [playing]);
  // Development only: a handle for QA scripts (camera, rotation). Stripped from production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __globes?: unknown }).__globes = ctls.current;
    return () => {
      delete (window as unknown as { __globes?: unknown }).__globes;
    };
  }, []);

  // The switch between globes.
  const [shown, setShown] = useState<Roster>(roster);
  const [phase, setPhase] = useState<Phase>("idle");
  const now = useRef({ shown, phase });
  now.current = { shown, phase };
  useEffect(() => {
    if (roster === now.current.shown) {
      // Switched back before the swap: the globe still in place comes back in.
      if (now.current.phase === "out") setPhase("in");
      return;
    }
    if (live.current.reduced) {
      setShown(roster);
      setPhase("idle");
      return;
    }
    setPhase("out");
    const t = window.setTimeout(() => {
      setShown(roster);
      setPhase("enter");
    }, OUT_MS);
    return () => window.clearTimeout(t);
  }, [roster]);
  useEffect(() => {
    if (phase === "enter") {
      // Two frames unseen: the new scene builds and uploads its textures before it fades in.
      let r2 = 0;
      const r1 = requestAnimationFrame(() => {
        r2 = requestAnimationFrame(() => setPhase("in"));
      });
      return () => {
        cancelAnimationFrame(r1);
        cancelAnimationFrame(r2);
      };
    }
    if (phase === "in") {
      const t = window.setTimeout(() => setPhase("idle"), IN_MS);
      return () => window.clearTimeout(t);
    }
  }, [phase]);

  const people = shown === "people";
  const ctl: AnyController = people ? peopleCtl() : companiesCtl();

  // Labels on either globe give way to the Companies | People switch and the HUD (the Key, the
  // hint and the buttons), which move up with the detail sheet. Measured on resize, when the
  // sheet changes height and when the HUD has finished moving; never per frame.
  const viewRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const measure = () => {
      const v = view.getBoundingClientRect();
      const boxes = [...view.querySelectorAll<HTMLElement>(".mm-switch, .mm-legend, .mm-hint, .mm-hud-right")].map((el) => {
        const r = el.getBoundingClientRect();
        return { x0: r.left - v.left - 4, y0: r.top - v.top - 4, x1: r.right - v.left + 4, y1: r.bottom - v.top + 4 };
      });
      each((c) => {
        c.reserved = boxes;
        c.invalidate();
      });
    };
    let raf = 0;
    const soon = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    measure();
    const ro = new ResizeObserver(soon);
    ro.observe(view);
    for (const el of view.querySelectorAll(".mm-switch, .mm-hud")) ro.observe(el);
    const sheet = new MutationObserver(soon);
    sheet.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    view.addEventListener("transitionend", soon);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      sheet.disconnect();
      view.removeEventListener("transitionend", soon);
    };
  }, [shown]);

  return (
    <div className="view mm-view" data-globe={shown} ref={viewRef}>
      {/* First in the tab order: which globe, then that globe's labels, then its controls. */}
      {HAS_PEOPLE && <GlobeSwitch />}
      <div className="mm-stage" data-phase={phase}>
        <div
          className="mm-shadow"
          aria-hidden="true"
          ref={(el) => {
            ctl.overlay.shadow = el;
          }}
        />
        {/* Under reduced motion the settled globe is still, so it renders only when something changes. */}
        <Canvas
          className="mm-canvas"
          frameloop={reduced ? "demand" : "always"}
          flat
          dpr={[1, 2.5]}
          gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
          camera={{ fov: FOV, near: 1, far: 4000, position: [0, 40, 260] }}
          // The stage scales a little while the globes switch; never measure the canvas mid-switch on a scroll.
          resize={{ scroll: false }}
          onCreated={({ gl }) => {
            gl.setClearColor(0x000000, 0);
            // Development only: a handle for QA scripts (renderer.info). Stripped from production builds.
            if (import.meta.env.DEV) (window as unknown as { __globeGl?: unknown }).__globeGl = gl;
          }}
          onPointerMissed={(e) => {
            if (e.type !== "click") return;
            const s = useStore.getState();
            if (now.current.shown === "people") {
              if (s.person) s.selectPerson(null);
            } else if (s.selected) s.select(null);
          }}
          aria-label={people ? `${L.People} globe: every one of ${SITE.org.name}'s ${L.people} as a headshot, evenly spread` : `${L.Company} globe: every ${L.company} as a logo, grouped into ${L.district} regions`}
          role="img"
        >
          {people ? <SceneFor key="people" ctl={peopleCtl()} reduced={reduced} onContextGiveUp={onContextGiveUp} /> : <SceneFor key="companies" ctl={companiesCtl()} reduced={reduced} onContextGiveUp={onContextGiveUp} />}
        </Canvas>
        {people ? <PersonOverlay key="people" ctl={peopleCtl()} active={roster === "people"} /> : <CompanyOverlay key="companies" ctl={companiesCtl()} active={roster === "companies"} />}
      </div>
      <Hud
        ctl={ctl}
        kind={shown}
        legend={people ? <PersonLegend /> : <CompanyLegend ctl={companiesCtl()} />}
        playing={playing}
        onTogglePlay={() => setPlaying((p) => !p)}
      />
    </div>
  );
}

/** A globe's scene. The intro (a short dolly in) plays when the globe first appears with nothing selected on it. */
function SceneFor<N extends GlobeNodeBase>({ ctl, reduced, onContextGiveUp }: { ctl: GlobeController<N>; reduced: boolean; onContextGiveUp: () => void }) {
  const [intro] = useState(() => {
    const s = useStore.getState();
    return ctl.content.roster === "people" ? !s.person : !s.selected && !s.focusDistrict;
  });
  return <GlobeScene ctl={ctl} reduced={reduced} intro={intro} onContextGiveUp={onContextGiveUp} />;
}

/**
 * Follow the store's fly requests while this globe is the one in view (see globeFlies.ts). A
 * globe on its way out stops listening, so the visitor's next moves (a person picked on the other
 * globe, say) leave its camera where it was.
 */
function useGlobeFlies<N extends GlobeNodeBase>(ctl: GlobeController<N>, roster: Roster, active: boolean) {
  useEffect(() => {
    if (!active) {
      ctl.flyNonce = Math.max(ctl.flyNonce, useStore.getState().fly?.nonce ?? 0);
      return;
    }
    const s = useStore.getState();
    const move = ctl.bound ? missedFly(roster, s.fly, ctl.flyNonce) : firstFly(roster, s);
    if (move) ctl.request(move);
    ctl.bound = true;
    ctl.flyNonce = Math.max(ctl.flyNonce, s.fly?.nonce ?? 0);
    const picked = (st: typeof s) => (roster === "people" ? st.person : st.selected);
    return useStore.subscribe((cur, prev) => {
      if (cur.fly && cur.fly.nonce !== prev.fly?.nonce) {
        ctl.flyNonce = Math.max(ctl.flyNonce, cur.fly.nonce);
        if (ownsFly(roster, cur.fly)) ctl.request(flyInput(cur.fly));
      } else {
        const slug = picked(cur);
        if (slug && slug !== picked(prev) && cur.roster === roster) ctl.request({ kind: roster === "people" ? "person" : "company", slug, turnOnly: true });
      }
    });
  }, [ctl, roster, active]);
}

/* -------------------------------------------------------------- switch */

/** Companies | People: which globe is in view. Two toggle buttons, one pressed. */
function GlobeSwitch() {
  const roster = useStore((s) => s.roster);
  const setRoster = useStore((s) => s.setRoster);
  return (
    <div className="mm-switch" role="group" aria-label="Globe">
      <button type="button" className="mm-switch-btn" aria-pressed={roster === "companies"} onClick={() => setRoster("companies")} title={`${L.Companies} (${COMPANIES.length})`}>
        <Building2 size={15} aria-hidden="true" />
        <span>{L.Companies}</span>
      </button>
      <button type="button" className="mm-switch-btn" aria-pressed={roster === "people"} onClick={() => setRoster("people")} title={`${SITE.org.name} ${L.people} (${PEOPLE.length})`}>
        <UserRound size={15} aria-hidden="true" />
        <span>{L.People}</span>
      </button>
    </div>
  );
}

/* ----------------------------------------------------- companies overlay */

function CompanyOverlay({ ctl, active }: { ctl: GlobeController<GlobeNode>; active: boolean }) {
  const highlight = useHighlight();
  const focusDistrict = useStore((s) => s.focusDistrict);
  const selected = useStore((s) => s.selected);
  const focusOn = useStore((s) => s.focusOn);
  const select = useStore((s) => s.select);
  const { regions, nodes, regionIndex, nodeIndex } = ctl.layout;
  const activeRegion = focusDistrict ? regionIndex.get(focusDistrict) ?? -1 : selected && nodeIndex.has(selected) ? nodes[nodeIndex.get(selected)!].region : -1;

  // Inputs reach the controller only while this globe is the one in view: on its way out it
  // keeps the selection, district focus and camera it had, for when the visitor comes back.
  useEffect(() => {
    if (active) ctl.setInputs(highlight, selected, focusDistrict);
  }, [ctl, active, highlight, selected, focusDistrict]);
  useGlobeFlies(ctl, "companies", active);

  // Tooltip text follows the hovered (or keyboard-focused) node; set imperatively, not per frame.
  useEffect(() => {
    ctl.onHoverChange = (i) => {
      const o = ctl.overlay;
      if (i < 0 || !o.tipName || !o.tipMeta || !o.tipDot) return;
      const nd = nodes[i];
      const d = regions[nd.region].district;
      o.tipName.textContent = nd.company.name;
      o.tipMeta.textContent = d.label;
      o.tipDot.style.background = d.color;
    };
    return () => {
      ctl.onHoverChange = null;
    };
  }, [ctl, nodes, regions]);

  useEffect(() => {
    const re = () => ctl.remeasure();
    document.fonts?.ready.then(re);
  }, [ctl]);

  return (
    // The controller reads keyboard focus from the DOM each frame; focus changes only wake it.
    <div
      className="mm-overlay"
      ref={(el) => {
        ctl.overlay.root = el;
      }}
      onFocus={() => ctl.invalidate()}
      onBlur={() => ctl.invalidate()}
    >
      <div role="group" aria-label={`${L.District} regions on the globe`}>
        {regions.map((r, i) => {
          const d = r.district;
          const isFocus = focusDistrict === d.slug;
          return (
            <Fragment key={d.slug}>
              <button
                type="button"
                ref={(el) => {
                  ctl.overlay.labels[i] = el;
                }}
                className={`mm-label${isFocus ? " is-focus" : ""}`}
                aria-pressed={isFocus}
                aria-label={regionButtonName(d, r.count)}
                title={isFocus ? `Stop focusing on ${d.label}` : `Show ${d.label}`}
                onClick={() => focusOn(isFocus ? null : d.slug)}
                onFocus={() => ctl.previewRegion(i)}
                onPointerEnter={() => ctl.setOverUI(true)}
                onPointerLeave={() => ctl.setOverUI(false)}
                data-off="true"
              >
                <span className="mm-label-icon" style={{ background: d.color }} aria-hidden="true">
                  <DistrictIcon slug={d.slug} size={12} />
                </span>
                <span className="mm-label-name">{d.short}</span>
                <span className="mm-label-count" aria-hidden="true">
                  {r.count}
                </span>
              </button>
              {i === activeRegion && r.companyIdx.length > 0 && (
                <div role="group" aria-label={`${d.label} ${L.companies}`} className="mm-node-group">
                  {r.companyIdx.map((ni) => {
                    const m = nodes[ni].company;
                    return (
                      <button
                        key={m.slug}
                        type="button"
                        className={`mm-node-btn${selected === m.slug ? " is-selected" : ""}`}
                        ref={(el) => {
                          if (el) ctl.overlay.nodeButtons.set(ni, el);
                          else ctl.overlay.nodeButtons.delete(ni);
                        }}
                        aria-label={m.name}
                        aria-current={selected === m.slug ? "true" : undefined}
                        onClick={() => select(m.slug, { fly: true })}
                        data-off="true"
                      />
                    );
                  })}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
      <div
        className="mm-tip"
        aria-hidden="true"
        data-on="false"
        ref={(el) => {
          ctl.overlay.tip = el;
          ctl.overlay.tipName = el?.querySelector("strong") ?? null;
          ctl.overlay.tipMeta = el?.querySelector(".mm-tip-meta") ?? null;
          ctl.overlay.tipDot = el?.querySelector(".mm-tip-dot") ?? null;
        }}
      >
        <strong />
        <span className="mm-tip-row">
          <span className="mm-tip-dot" />
          <span className="mm-tip-meta" />
        </span>
      </div>
    </div>
  );
}

/* ----------------------------------------------------- people overlay */

/**
 * Every person's name under their headshot, as a real button (keyboard and screen-reader route to
 * each person; the accessible name starts with the name shown). The controller positions them each
 * frame and shows the specialty on the hovered, focused or selected one.
 */
function PersonOverlay({ ctl, active }: { ctl: GlobeController<PersonNode>; active: boolean }) {
  const highlight = usePersonHighlight();
  const person = useStore((s) => s.person);
  const selectPerson = useStore((s) => s.selectPerson);

  useEffect(() => {
    if (active) ctl.setInputs(highlight, person, null);
  }, [ctl, active, highlight, person]);
  useGlobeFlies(ctl, "people", active);

  useEffect(() => {
    const re = () => ctl.remeasure();
    document.fonts?.ready.then(re);
  }, [ctl]);

  return (
    <div
      className="mm-overlay"
      ref={(el) => {
        ctl.overlay.root = el;
      }}
      onFocus={() => ctl.invalidate()}
      onBlur={() => ctl.invalidate()}
    >
      <div role="group" aria-label={`${L.People} on the globe`}>
        {ctl.layout.nodes.map((nd) => {
          const c = nd.person;
          const isSel = person === c.slug;
          const dim = !!highlight && !highlight.has(c.slug);
          return (
            <button
              key={c.slug}
              type="button"
              className={`mm-person${isSel ? " is-selected" : ""}${dim ? " is-dim" : ""}`}
              data-person={c.slug}
              ref={(el) => {
                if (el) ctl.overlay.nodeLabels.set(nd.index, el);
                else ctl.overlay.nodeLabels.delete(nd.index);
              }}
              aria-label={`${c.name}, ${c.title}`}
              aria-current={isSel ? "true" : undefined}
              onClick={() => selectPerson(c.slug, { fly: true })}
              onPointerEnter={() => {
                ctl.setOverUI(true);
                ctl.setHovered(nd.index);
              }}
              onPointerLeave={() => {
                ctl.setOverUI(false);
                if (ctl.hovered === nd.index) ctl.setHovered(-1);
              }}
              data-off="true"
              data-hot="false"
            >
              <span className="mm-person-name">{c.name}</span>
              <span className="mm-person-spec">{c.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- HUD */

/**
 * Drops the click that ends the current tap, before React Three Fiber (or anything else) sees it.
 * Ends at that click, or at the next tap if this one never produces a click (a drag).
 */
function swallowNextClick(): void {
  let armed = false;
  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    done();
  };
  // The pointerdown that called this is still dispatching: only a later one ends the swallow.
  const next = () => {
    if (armed) done();
  };
  const done = () => {
    window.removeEventListener("click", stop, true);
    window.removeEventListener("pointerdown", next, true);
  };
  window.addEventListener("click", stop, true);
  window.addEventListener("pointerdown", next, true);
  queueMicrotask(() => (armed = true));
}

function Hud({ ctl, kind, legend, playing, onTogglePlay }: { ctl: AnyController; kind: Roster; legend: ReactNode; playing: boolean; onTogglePlay: () => void }) {
  const flyHome = useStore((s) => s.flyHome);
  const selected = useStore((s) => s.selected);
  const person = useStore((s) => s.person);
  const [keyOpen, setKeyOpen] = useState(false);
  const legendRef = useRef<HTMLDivElement>(null);
  // The Key closes when the visitor goes back to the globe (a tap anywhere outside it). A tap on
  // the globe that closes the Key does only that: it must not also open the logo under the finger
  // (which dims every other logo) or close the open company.
  useEffect(() => {
    if (!keyOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!legendRef.current || legendRef.current.contains(t)) return;
      setKeyOpen(false);
      if (t?.closest?.(".mm-canvas")) swallowNextClick();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [keyOpen]);
  const people = kind === "people";
  const open = people ? person : selected;

  return (
    <>
      <div className="mm-hud mm-hud-left">
        <SearchChip />
        <div className={`mm-legend${keyOpen ? " is-open" : ""}`} ref={legendRef}>
          <button type="button" className="mm-legend-toggle" aria-expanded={keyOpen} aria-controls="mm-legend-list" onClick={() => setKeyOpen((v) => !v)}>
            Key
          </button>
          {legend}
        </div>
        {/* The hint steps aside while the detail sheet is open: the stage above it is short. */}
        {!open && (
          <p className="mm-hint">
            <span className="mm-hint-wide">Drag to turn the globe · Scroll to zoom · Select a {people ? L.person : "logo"}</span>
            <span className="mm-hint-narrow">Drag to turn · Pinch to zoom · Tap a {people ? L.person : "logo"}</span>
          </p>
        )}
      </div>
      <div className="mm-hud mm-hud-right" role="group" aria-label="Globe controls">
        <button type="button" className="mm-hud-btn" onClick={() => ctl.zoomBy(0.72)} aria-label="Zoom in" title="Zoom in">
          <Plus size={18} aria-hidden="true" />
        </button>
        <button type="button" className="mm-hud-btn" onClick={() => ctl.zoomBy(1.38)} aria-label="Zoom out" title="Zoom out">
          <Minus size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="mm-hud-btn"
          onClick={() => {
            if (people) {
              // Overview = every person again: close the open person and pull back to the whole globe.
              useStore.getState().selectPerson(null);
              ctl.request({ kind: "home" });
              return;
            }
            // Overview = the whole portfolio again, every logo at full strength: close the open company
            // (whose selection dims the other logos and shrinks the globe above the sheet), clear a
            // search or the provider finder's highlight, and return to the full globe (flyHome also
            // clears a district focus).
            const s = useStore.getState();
            s.select(null);
            if (s.query) s.setQuery("");
            if (s.panel === "finder") s.openPanel(null);
            flyHome();
          }}
          aria-label={people ? `Overview: show every ${L.person}` : `Overview: show every ${L.company}`}
          title={people ? `Overview: show every ${L.person}` : `Overview: show every ${L.company}`}
        >
          <Globe2 size={18} aria-hidden="true" />
        </button>
        <button type="button" className="mm-hud-btn" onClick={onTogglePlay} aria-pressed={playing} aria-label="Auto-rotate" title={playing ? "Pause rotation" : "Play rotation"}>
          {playing ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
        </button>
      </div>
    </>
  );
}

function CompanyLegend({ ctl }: { ctl: GlobeController<GlobeNode> }) {
  const selected = useStore((s) => s.selected);
  const P = ctl.palette;
  const sel = useMemo(() => (selected ? selectionLinks(selected) : null), [selected]);
  const selName = selected ? companyBySlug.get(selected)?.name ?? "" : "";
  const spokeGradient = useMemo(() => {
    const colors = DISTRICTS.slice(0, 5).map((d) => d.color);
    return colors.length > 1 ? `linear-gradient(90deg, ${colors.join(", ")})` : colors[0] ?? P.line;
  }, [P.line]);
  const fitCount = sel ? sel.providers.length + sel.clients.length : 0;
  return (
    <ul id="mm-legend-list" className="mm-legend-list" aria-label="What the lines mean">
      <li>
        <span className="mm-sw" style={{ background: spokeGradient }} aria-hidden="true" />
        <span>{L.District} region (spoke to its hub)</span>
      </li>
      {ctl.counts.cross > 0 && (
        <li>
          <span className="mm-sw mm-sw-faint" style={{ background: spokeGradient }} aria-hidden="true" />
          <span>Also active in another {L.district}</span>
        </li>
      )}
      <li>
        <span className="mm-sw mm-sw-bold" style={{ background: P.documented }} aria-hidden="true" />
        <span>
          Known connection{ctl.counts.documented === 0 && <span className="mm-legend-note"> · none yet</span>}
        </span>
      </li>
      {sel && (
        <li className="mm-legend-fit">
          <span className="mm-legend-head">Potential fit — suggested introduction</span>
          {fitCount > 0 ? (
            <>
              <span className="mm-legend-row">
                <span className="mm-sw mm-sw-dash" style={{ color: P.provider }} aria-hidden="true" />
                <span>Could serve {selName}</span>
              </span>
              <span className="mm-legend-row">
                <span className="mm-sw mm-sw-dash" style={{ color: P.client }} aria-hidden="true" />
                <span>{selName} could serve</span>
              </span>
            </>
          ) : (
            <span className="mm-legend-note">None derived for {selName} yet.</span>
          )}
        </li>
      )}
      <li className="mm-legend-foot">
        Regions group {L.companies} by {L.district}, not by location.
      </li>
    </ul>
  );
}

function PersonLegend() {
  return (
    <ul id="mm-legend-list" className="mm-legend-list" aria-label={`What the ${L.people} globe shows`}>
      <li>
        <span className="mm-sw-person" aria-hidden="true" />
        <span>
          {article(`${SITE.org.name} ${L.person}`).replace(/^a/, "A")} · select one for their bio
        </span>
      </li>
      <li className="mm-legend-foot">
        {L.People} are spread evenly; where one sits on the globe means nothing.
      </li>
    </ul>
  );
}
