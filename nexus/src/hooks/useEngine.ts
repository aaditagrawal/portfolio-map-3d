/* The one 3D engine of the page, shared by the landing hero and the world mode. three.js loads
   after the page's text (a separate chunk). If the browser cannot run WebGL 2, the page says so
   and offers the list instead. When the WebGL context is lost for good, the engine is rebuilt
   (a new generation) and the views re-apply what they show. */
import { useEffect, useRef, useState, type RefObject } from "react";
import type { NexusEngine } from "../three/engine.ts";
import { hasWebGL2 } from "../three/webgl.ts";

export type EngineStatus = "pending" | "ready" | "unavailable";

export function useEngine(reduced: boolean, pick: RefObject<((id: string | null, district?: string) => void) | null>): { engine: NexusEngine | null; status: EngineStatus } {
  const [state, setState] = useState<{ engine: NexusEngine | null; status: EngineStatus }>({ engine: null, status: "pending" });
  const [generation, setGeneration] = useState(0);
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  useEffect(() => {
    if (!hasWebGL2()) {
      setState({ engine: null, status: "unavailable" });
      return;
    }
    let alive = true;
    let engine: NexusEngine | null = null;
    import("../three/engine.ts")
      .then(({ NexusEngine }) => {
        if (!alive) return;
        engine = new NexusEngine({ onPick: (id, district) => pick.current?.(id, district), onGiveUp: () => setGeneration((g) => g + 1) }, reducedRef.current);
        setState({ engine, status: "ready" });
      })
      .catch(() => {
        if (alive) setState({ engine: null, status: "unavailable" });
      });
    return () => {
      alive = false;
      engine?.dispose();
    };
  }, [generation, pick]);

  useEffect(() => {
    state.engine?.setReducedMotion(reduced);
  }, [state.engine, reduced]);

  return state;
}
