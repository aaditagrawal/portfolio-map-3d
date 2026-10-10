/* Where the one 3D canvas sits. The engine moves its canvas into whichever host is mounted
   (the landing hero or the world view), and stops rendering while the host is off screen. */
import { useEffect, useRef } from "react";
import type { NexusEngine } from "../three/engine.ts";

export function SceneHost({ engine, className, label, interactive }: { engine: NexusEngine | null; className: string; label: string; interactive: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!engine || !host) return;
    engine.attach(host);
    const io = new IntersectionObserver(([e]) => engine.setActive(e.isIntersecting), { threshold: 0 });
    io.observe(host);
    return () => {
      io.disconnect();
      engine.detach(host);
    };
  }, [engine]);
  return <div ref={ref} className={`${className}${interactive ? " is-interactive" : ""}`} role="group" aria-label={label} />;
}
