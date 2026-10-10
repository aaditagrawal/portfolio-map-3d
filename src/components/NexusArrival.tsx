/* A visitor who came through the Nexus (?from=nexus) sees where they arrived and the way back,
   once, until they close it. */
import { Orbit, X } from "lucide-react";
import { useState } from "react";
import { ARRIVED_FROM_NEXUS, NEXUS_HREF } from "../network";
import { useStore } from "../state/store";

export default function NexusArrival() {
  const [open, setOpen] = useState(ARRIVED_FROM_NEXUS);
  const view = useStore((s) => s.view);
  // The walk introduction and its HUD keep the return link in one place.
  if (!open || view === "walk") return null;
  return (
    <div className="nexus-arrival" role="status">
      <Orbit size={16} aria-hidden="true" />
      <span>
        <a href={NEXUS_HREF}>Back to Nexus</a>
      </span>
      <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Dismiss arrival note">
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
