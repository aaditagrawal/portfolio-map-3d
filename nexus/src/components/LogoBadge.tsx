/* A world's badge in lists and panels: its logo (from the Nexus's own origin) on a light plate,
   or its initials in ink that reads on its accent. Decorative: the name always stands beside it. */
import { useState } from "react";
import { inkOn } from "../lib/color.ts";
import { initials } from "../lib/copy.ts";

export function LogoBadge({ name, accent, logo, size = 40 }: { name: string; accent: string; logo: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style = {
    width: `calc(${size} * var(--badge-unit, 1px))`,
    height: `calc(${size} * var(--badge-unit, 1px))`,
    fontSize: `calc(${Math.round(size * 0.38)} * var(--badge-unit, 1px))`,
  };
  if (logo && !failed) {
    return (
      <span className="badge badge-logo" style={style} aria-hidden="true">
        <img src={`${import.meta.env.BASE_URL}${logo}`} alt="" onError={() => setFailed(true)} />
      </span>
    );
  }
  return (
    <span className="badge" style={{ ...style, background: accent, color: inkOn(accent) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
