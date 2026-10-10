/* Every world as a button: the way to reach each one without pointing at the 3D scene. */
import { shortCountLine } from "../lib/copy.ts";
import type { NetworkModel } from "../lib/network.ts";
import { WorldIdentity } from "./WorldIdentity.tsx";

export function WorldList({ model, current, onSelect }: { model: NetworkModel; current: string | null; onSelect: (id: string) => void }) {
  if (!model.worlds.length) return <p className="wl-empty">No maps have joined yet.</p>;
  return (
    <ul className="wl">
      {model.worlds.map((w) => (
        <li key={w.id}>
          <button type="button" className="wl-item" aria-current={current === w.id ? "true" : undefined} onClick={() => onSelect(w.id)}>
            <WorldIdentity name={w.name} accent={w.accent} logo={w.logo} />
            <span className="wl-text">
              <span className="wl-meta">{shortCountLine(w.manifest)}</span>
              {w.status === "unreachable" ? <span className="wl-status">Not reachable at last check</span> : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
