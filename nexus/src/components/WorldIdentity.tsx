import { LogoBadge } from "./LogoBadge.tsx";

/** One name-and-logo treatment across cards, the world list and detail panels. */
export function WorldIdentity({ name, accent, logo }: { name: string; accent: string; logo: string | null }) {
  return (
    <span className="world-pill">
      <LogoBadge name={name} accent={accent} logo={logo} size={28} />
      <span className="world-pill-name">{name}</span>
    </span>
  );
}
