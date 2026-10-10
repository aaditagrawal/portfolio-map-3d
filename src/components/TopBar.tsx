import { ArrowLeft, ArrowRight, CircleHelp, Footprints, LayoutGrid, Moon, Network, Orbit, Search, Shapes, Sun, Waypoints, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { COMPANIES, HAS_FINDER, HAS_PEOPLE, PEOPLE, SITE, districtBySlug, siteFile } from "../data/catalog";
import { LABELS } from "../data/labels";
import { searchAll } from "../data/search";
import type { Company, Person } from "../data/types";
import { NETWORK_NAME, NEXUS_HREF } from "../network";
import { L } from "../site";
import { useStore, type Roster, type View } from "../state/store";
import { PersonThumb, LogoThumb } from "./bits";

const VIEWS: { id: View; label: string; Icon: typeof Network }[] = [
  { id: "mindmap", label: "Globe", Icon: Network },
  { id: "walk", label: "Walk", Icon: Footprints },
  { id: "list", label: "List", Icon: LayoutGrid },
];

/** The interface theme (light or dark) and its toggle, kept in localStorage. */
export function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("portfolio-map-theme", next);
    } catch {
      /* storage blocked: the toggle still works for this visit */
    }
    setTheme(next);
  };
  return [theme, toggle];
}

export default function TopBar() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const panel = useStore((s) => s.panel);
  const openPanel = useStore((s) => s.openPanel);
  const [theme, toggleTheme] = useTheme();

  return (
    <header className="topbar">
      <Brand />

      <nav className="view-switch" aria-label="View">
        {VIEWS.map(({ id, label, Icon }) => (
          <button key={id} type="button" className="view-switch-btn" aria-pressed={view === id} onClick={() => setView(id)} title={label}>
            <Icon size={16} aria-hidden="true" />
            <span className="view-switch-label">{label}</span>
          </button>
        ))}
      </nav>

      <div className="topbar-actions">
        <SearchBox />
        {HAS_FINDER && (
          <button type="button" className="btn btn-cta" aria-label="Find a provider" aria-pressed={panel === "finder"} onClick={() => openPanel(panel === "finder" ? null : "finder")}>
            <Waypoints size={16} aria-hidden="true" />
            <span className="hide-sm">Find a provider</span>
          </button>
        )}
        <button type="button" className="btn btn-quiet btn-icon-sm" aria-pressed={panel === "districts"} onClick={() => openPanel(panel === "districts" ? null : "districts")} aria-label={L.Districts} title={L.Districts}>
          <Shapes size={16} aria-hidden="true" className="only-xs" />
          <span className="hide-xs">{L.Districts}</span>
        </button>
        {/* The network's one requirement: every map links to the Nexus (src/network.ts). */}
        <a className="icon-btn nexus-link" href={NEXUS_HREF} title={`The Nexus: every map in the ${NETWORK_NAME}`} aria-label={`Open the Nexus, the shared world of every map in the ${NETWORK_NAME}`}>
          <Orbit size={18} aria-hidden="true" />
          <span className="nexus-link-label">Nexus</span>
        </a>
        {/* On the narrowest screens the theme toggle moves into the About panel, so the Nexus link keeps its place. */}
        <button type="button" className="icon-btn theme-toggle" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} title="Theme">
          {theme === "dark" ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
        </button>
        <button type="button" className="icon-btn" aria-pressed={panel === "help"} onClick={() => openPanel(panel === "help" ? null : "help")} aria-label="About this map" title="About this map">
          <CircleHelp size={18} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

/** The publisher's logo (light and dark theme versions) or its name, and the map's name. */
function Brand() {
  const light = siteFile(SITE.org.logo);
  const dark = siteFile(SITE.org.logoOnDark) ?? light;
  const logos = light ? (
    <>
      <img className="brand-logo brand-logo-light" src={light} alt={SITE.org.name} height={32} />
      <img className="brand-logo brand-logo-dark" src={dark ?? light} alt={SITE.org.name} height={32} />
    </>
  ) : (
    <span className="brand-name">{SITE.org.name}</span>
  );
  return (
    <div className="brand">
      <a className="brand-home" href={import.meta.env.BASE_URL} title={`${SITE.org.name} home`} aria-label={`${SITE.org.name}, home`}>
        {logos}
      </a>
      <span className="brand-title">
        {L.Company} <em>Map</em>
      </span>
    </div>
  );
}

type Option =
  | { kind: "company"; company: Company; id: string }
  | { kind: "person"; person: Person; id: string }
  /** More match than the group shows: open them all in the list view. */
  | { kind: "all"; roster: Roster; count: number; id: string };
interface Group {
  key: "companies" | "people";
  label: string;
  options: Option[];
}

function SearchBox() {
  const query = useStore((s) => s.query);
  const setQuery = useStore((s) => s.setQuery);
  const select = useStore((s) => s.select);
  const selectPerson = useStore((s) => s.selectPerson);
  const setView = useStore((s) => s.setView);
  const setRoster = useStore((s) => s.setRoster);
  const setInputLocked = useStore((s) => s.setInputLocked);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** A press inside the search is in progress: a blur it causes is not "leaving" the search. */
  const pressing = useRef(false);

  // Companies (names, services, founders, keywords…) and people (name and title only), in two groups.
  const groups = useMemo<Group[]>(() => {
    const r = searchAll(query, COMPANIES, PEOPLE, LABELS);
    const more = (roster: Roster, shown: number): Option[] => (r.total[roster] > shown ? [{ kind: "all", roster, count: r.total[roster], id: `sr-all-${roster}` }] : []);
    const all: Group[] = [
      { key: "companies", label: L.Companies, options: [...r.companies.map((company): Option => ({ kind: "company", company, id: `sr-m-${company.slug}` })), ...more("companies", r.companies.length)] },
      { key: "people", label: L.People, options: [...r.people.map((person): Option => ({ kind: "person", person, id: `sr-c-${person.slug}` })), ...more("people", r.people.length)] },
    ];
    const g = all.filter((x) => x.options.length > 0);
    return r.peopleFirst ? g.reverse() : g;
  }, [query]);
  const results = useMemo(() => groups.flatMap((g) => g.options), [groups]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !isTyping(e.target))) {
        e.preventDefault();
        setExpanded(true);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    };
    const onDown = (e: PointerEvent) => {
      pressing.current = !!wrapRef.current?.contains(e.target as Node);
      if (!pressing.current) setOpen(false);
    };
    const onUp = () => {
      pressing.current = false;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, []);

  // The phone layout's full-width field folds back into the toggle; the query (and its highlight) stays.
  const collapse = () => {
    setOpen(false);
    setExpanded(false);
  };
  const choose = (o: Option) => {
    if (o.kind === "company") select(o.company.slug, { fly: true });
    else if (o.kind === "all") {
      // Every match, as cards: the list view filters by the same search text.
      setView("list");
      setRoster(o.roster);
    } else {
      // The query would otherwise keep lighting up companies beside a person's sheet; people have no link to companies.
      setQuery("");
      selectPerson(o.person.slug, { fly: true });
    }
    collapse();
    inputRef.current?.blur();
  };
  const q = query.trim();
  const searchWhat = `Search ${L.companies}${HAS_PEOPLE ? ` and ${L.people}` : ""}`;
  const listed = open && results.length > 0;

  return (
    <div
      className={`search ${expanded ? "search-expanded" : ""}`}
      ref={wrapRef}
      onBlur={(e) => {
        if (!pressing.current && !wrapRef.current?.contains(e.relatedTarget as Node | null)) collapse();
      }}
    >
      <button
        type="button"
        ref={toggleRef}
        className={`icon-btn search-toggle ${q ? "has-query" : ""}`}
        aria-label={q ? `${searchWhat} (showing matches for “${q}”)` : searchWhat}
        onClick={() => { setExpanded(true); requestAnimationFrame(() => inputRef.current?.focus()); }}
      >
        <Search size={18} aria-hidden="true" />
      </button>
      <div className="search-field">
        <button type="button" className="search-back" aria-label="Close search" onClick={() => { collapse(); requestAnimationFrame(() => toggleRef.current?.focus()); }}>
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <Search size={16} aria-hidden="true" className="search-icon" />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={listed}
          aria-controls={listed ? "search-results" : undefined}
          aria-activedescendant={listed && results[active] ? results[active].id : undefined}
          aria-label={`Search ${L.companies} by name, service, founder or keyword${HAS_PEOPLE ? `, and ${L.people} by name or title` : ""}`}
          placeholder={`Search ${L.companies}${HAS_PEOPLE ? `, ${L.people}` : ""}${HAS_FINDER ? ", services" : ""}…`}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => { setOpen(true); setInputLocked(true); }}
          onBlur={() => setInputLocked(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === "Enter" && results[active]) { e.preventDefault(); choose(results[active]); }
            // Handled here: the sheet and an open panel ignore this Esc.
            else if (e.key === "Escape") { e.preventDefault(); if (query) setQuery(""); else { collapse(); inputRef.current?.blur(); } }
          }}
        />
        {query && (
          <button type="button" className="search-clear" aria-label="Clear search" onClick={() => { setQuery(""); inputRef.current?.focus(); }}>
            <X size={14} aria-hidden="true" />
          </button>
        )}
        <kbd className="search-kbd hide-sm" aria-hidden="true">/</kbd>
      </div>
      <p className="search-results search-empty" role="status">
        {open && q && results.length === 0 ? `No ${L.companies}${HAS_PEOPLE ? ` or ${L.people}` : ""} match “${q}”.` : null}
      </p>
      {listed && (
        <div className="search-results" id="search-results" role="listbox" aria-label={`Matching ${L.companies}${HAS_PEOPLE ? ` and ${L.people}` : ""}`}>
          {groups.map((g) => (
            <div key={g.key} role="group" aria-label={g.label} className="search-group">
              {/* Group names show once people are among the results. */}
              {groups.some((x) => x.key === "people") && (
                <div className="search-group-head" aria-hidden="true">
                  {g.label}
                </div>
              )}
              {g.options.map((o) => {
                const i = results.indexOf(o);
                return (
                  <div key={o.id} id={o.id} role="option" aria-selected={i === active} className={`search-option${i === active ? " is-active" : ""}`}
                    onPointerDown={(e) => e.preventDefault()} onClick={() => choose(o)} onMouseEnter={() => setActive(i)}>
                    {o.kind === "all" ? (
                      <>
                        <span className="search-all-icon" aria-hidden="true">
                          <LayoutGrid size={15} />
                        </span>
                        <span className="search-all-text">
                          See all {o.count} {o.roster === "people" ? L.people : L.companies} in the list
                        </span>
                        <ArrowRight size={15} aria-hidden="true" className="search-all-arrow" />
                      </>
                    ) : o.kind === "company" ? (
                      <>
                        <LogoThumb company={o.company} size={26} />
                        <span className="search-result-text">
                          <strong>{o.company.name}</strong>
                          <span>{districtBySlug.get(o.company.district)!.label}</span>
                        </span>
                      </>
                    ) : (
                      <>
                        <PersonThumb person={o.person} size={34} />
                        <span className="search-result-text">
                          <strong>{o.person.name}</strong>
                          <span>
                            {L.Person} · {o.person.title}
                          </span>
                        </span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}
