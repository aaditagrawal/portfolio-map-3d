import type { Manifest } from "../../../federation/protocol.ts";
import { plural } from "../lib/copy.ts";

/** Static split-flap digits: readable without motion, with one spoken value per count. */
export function CountBoard({ metrics }: { metrics: { label: string; value: number }[] }) {
  return (
    <dl className="count-board">
      {metrics.map(({ label, value }, index) => (
        <div className={`count-metric${index === 1 ? " is-inverted" : ""}`} key={label}>
          <dt>{label}</dt>
          <dd>
            <span className="sr-only">{value.toLocaleString("en-US")}</span>
            <span className="split-number" aria-hidden="true">
              {String(value).split("").map((digit, i) => <span className="split-digit" key={i}>{digit}</span>)}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
export function MapCounts({ manifest: m }: { manifest: Manifest }) {
  return <CountBoard metrics={[
    { value: m.counts.companies, label: plural(m.counts.companies, m.labels.company, m.labels.companies) },
    { value: m.counts.districts, label: plural(m.counts.districts, m.labels.district, m.labels.districts) },
    ...(m.labels.people && m.counts.people ? [{ value: m.counts.people, label: m.labels.people }] : []),
  ]} />;
}
