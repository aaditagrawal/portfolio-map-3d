/* One world, in words: its name, counts in its own labels, districts, and a filterable list
   of its companies, each linking into the map. A side panel on wide screens, a bottom sheet on
   phones. The parent gives it key={world id}, so its filters start fresh for each world. */
import { useEffect, useMemo, useRef, useState } from "react";
import { instanceHref, type ManifestCompany, type ManifestDistrict } from "../../../federation/protocol.ts";
import { capitalize, formatDate, hostOf } from "../lib/copy.ts";
import { filterCompanies, type IndexedWorld } from "../lib/search.ts";
import { ArrowRight, ChevronDown, Close, External } from "./Icons.tsx";
import { WorldIdentity } from "./WorldIdentity.tsx";
import { MapCounts } from "./CountBoard.tsx";
import { DistrictIcon, districtLabel } from "./DistrictIcon.tsx";
import "../styles/directory.css";

const PAGE = 60;

interface Props {
  iw: IndexedWorld;
  highlight: string | null;
  initialFilter: string;
  initialDistrict?: string;
  onDistrictChange?: (slug: string | null) => void;
  enterHref?: string;
  onClose: () => void;
}

export function WorldPanel({ iw, highlight, initialFilter, initialDistrict, onDistrictChange, enterHref, onClose }: Props) {
  const w = iw.world;
  const m = w.manifest;
  const [filter, setFilter] = useState(initialFilter);
  const [district, setDistrict] = useState<string | null>(() =>
    initialDistrict && m.districts.some((d) => d.slug === initialDistrict) ? initialDistrict : null,
  );
  const list = useMemo(() => filterCompanies(iw, filter, district), [iw, filter, district]);
  const hlIndex = highlight ? list.findIndex((c) => c.company.slug === highlight) : -1;
  const [limit, setLimit] = useState(() => Math.max(PAGE, hlIndex + 20));
  const title = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLDetailsElement>(null);
  const districts = useMemo(() => new Map(m.districts.map((d) => [d.slug, d])), [m]);
  const selectedDistrict = district ? districts.get(district) : undefined;

  useEffect(() => {
    title.current?.focus({ preventScroll: true });
  }, []);

  // Bring the company chosen in search into view, once.
  const scrolled = useRef<string | null>(null);
  useEffect(() => {
    if (!highlight || scrolled.current === highlight) return;
    scrolled.current = highlight;
    body.current?.querySelector<HTMLElement>(`[data-slug="${CSS.escape(highlight)}"]`)?.scrollIntoView({ block: "center" });
  }, [highlight]);

  return (
    <aside className={`panel directory-panel${w.status === "unreachable" ? " is-dim" : ""}`} aria-labelledby="panel-title">
      <div className="panel-head">
        <div className="panel-title">
          <h2 id="panel-title" ref={title} tabIndex={-1}>
            <WorldIdentity name={w.name} accent={w.accent} logo={w.logo} />
          </h2>
          <p className="panel-host">{hostOf(w.url)}</p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={`Close ${w.name}`}>
          <Close />
        </button>
      </div>
      <div className="panel-body" ref={body}>
        {w.status === "unreachable" ? (
          <p className="status status-unreachable">Map unavailable. Data from {formatDate(m.updated)}.</p>
        ) : null}
        <MapCounts manifest={m} />
        <a className="btn btn-primary btn-block panel-enter" href={enterHref ?? instanceHref(w.url)}>
          Enter planet <ArrowRight size={18} aria-hidden="true" />
        </a>
        <div className="net-actions">
          <a className="text-link" href={instanceHref(w.url)}>Visit map <External size={16} /></a>
          {w.publisher.website ? <a className="text-link" href={w.publisher.website}>Visit link <External size={16} /></a> : null}
        </div>

        <div className="panel-list-head">
          <h3 className="panel-h">{capitalize(m.labels.companies)}</h3>
          <span className="panel-list-count" role="status">
            {list.length === iw.companies.length ? iw.companies.length : `${list.length} of ${iw.companies.length}`}
          </span>
        </div>
        <label className="sr-only" htmlFor="panel-filter">
          Filter {m.labels.companies}
        </label>
        <input
          id="panel-filter"
          className="field"
          type="search"
          placeholder={`Filter ${m.labels.companies}`}
          value={filter}
          autoComplete="off"
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filter) {
              e.stopPropagation();
              setFilter("");
            }
          }}
        />
        <div className="district-picker-row">
          <details className="district-picker" ref={picker}>
            <summary className="district-picker-summary">
              <DistrictIcon label={selectedDistrict?.label ?? m.labels.districts} />
              <span>{selectedDistrict ? districtLabel(selectedDistrict.label) : `All ${m.labels.districts}`}</span>
              <ChevronDown size={16} className="district-picker-chevron" aria-hidden="true" />
            </summary>
            <div className="district-filter-grid" role="group" aria-label={`Filter by ${m.labels.district}`}>
              {m.districts.map((d) => (
                <button
                  key={d.slug}
                  type="button"
                  className="district-filter"
                  aria-label={`${d.label}, ${d.count} ${m.labels.companies}`}
                  title={d.label}
                  aria-pressed={district === d.slug}
                  onClick={() => {
                    const nextDistrict = district === d.slug ? null : d.slug;
                    setDistrict(nextDistrict);
                    onDistrictChange?.(nextDistrict);
                    if (picker.current) {
                      picker.current.open = false;
                      picker.current.querySelector("summary")?.focus();
                    }
                  }}
                >
                  <DistrictIcon label={d.label} />
                  <span className="district-filter-label">{districtLabel(d.label)}</span>
                  <span className="district-filter-count">{d.count}</span>
                </button>
              ))}
            </div>
          </details>
          {district ? (
            <button type="button" className="icon-btn district-clear" onClick={() => {
              setDistrict(null);
              onDistrictChange?.(null);
            }} aria-label={`Show all ${m.labels.companies}`}>
              <Close size={16} />
            </button>
          ) : null}
        </div>
        {list.length ? (
          <ul className="co-list">
            {list.slice(0, limit).map(({ company: c }) => {
              const d = districts.get(c.district);
              return (
                <CompanyRow key={c.slug} company={c} district={d} worldUrl={w.url} worldName={w.name} highlighted={c.slug === highlight} />
              );
            })}
          </ul>
        ) : (
          <p className="muted">No {m.labels.companies} match.</p>
        )}
        {list.length > limit ? (
          <button type="button" className="btn btn-outline btn-block" onClick={() => setLimit(Infinity)}>
            Show all {list.length}
          </button>
        ) : null}
        <p className="panel-foot">
          Updated {formatDate(m.updated)}
          {w.checked ? ` · checked ${formatDate(w.checked)}` : ""}
        </p>
      </div>
    </aside>
  );
}

function CompanyRow({ company, district, worldUrl, worldName, highlighted }: {
  company: ManifestCompany;
  district: ManifestDistrict | undefined;
  worldUrl: string;
  worldName: string;
  highlighted: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const descriptionId = `company-description-${company.slug}`;
  return (
    <li data-slug={company.slug} className={`co${highlighted ? " is-hl" : ""}`}>
      <div className="co-header">
        <a className="co-link" href={instanceHref(worldUrl, company.slug)}>
          <span className="co-name">{company.name}</span>
          <span className="sr-only">, in {worldName}</span>
          <External size={16} className="co-ext" aria-hidden="true" />
        </a>
        {company.description ? (
          <button
            type="button"
            className="icon-btn co-description-toggle"
            aria-label={`${expanded ? "Hide" : "Show"} description for ${company.name}`}
            aria-expanded={expanded}
            aria-controls={descriptionId}
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronDown size={18} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {district ? (
        <span className="co-category" title={district.label}>
          <DistrictIcon label={district.label} size={16} />
          <span aria-hidden="true">{districtLabel(district.label)}</span>
          <span className="sr-only">{district.label}</span>
        </span>
      ) : null}
      {company.description ? <p id={descriptionId} className="co-description" hidden={!expanded}>{company.description}</p> : null}
    </li>
  );
}
