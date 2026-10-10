/* The Nexus: the framework's landing page (/) and the shared world (?world). One 3D engine
   serves both: it drifts behind the landing page's headline and becomes the world when the
   visitor enters. */
import { useCallback, useEffect, useRef, useState } from "react";
import { webModelContext } from "../../federation/agent.ts";
import { Landing } from "./components/Landing.tsx";
import { WorldMode } from "./components/WorldMode.tsx";
import { useEngine } from "./hooks/useEngine.ts";
import { useReducedMotion } from "./hooks/useMedia.ts";
import { useNetwork } from "./hooks/useNetwork.ts";
import { navigate, useRoute } from "./hooks/useRoute.ts";
import { coreSubtitle, engineWorlds } from "./three/fromModel.ts";
import "./styles/aurora.css";

export function App() {
  const route = useRoute();
  const reduced = useReducedMotion();
  const [attempt, setAttempt] = useState(0);
  const net = useNetwork(route.sample, attempt);
  const pickRef = useRef<((id: string | null, district?: string) => void) | null>(null);
  const { engine, status: gl } = useEngine(reduced, pickRef);
  const model = net.status === "ready" ? net.model : null;

  useEffect(() => {
    if (engine && model) engine.setWorlds(engineWorlds(model), coreSubtitle(model));
  }, [engine, model]);

  const enter = useCallback((world?: string) => navigate({ mode: "world", world: world ?? null, from: null, via: null, sample: route.sample }), [route.sample]);

  // In a browser with WebMCP, AI agents get the Nexus's tools (src/agent.ts) once the network is loaded.
  useEffect(() => {
    if (!model || !webModelContext()) return;
    let alive = true;
    let off: () => void = () => undefined;
    void import("./agent.ts").then((m) => {
      if (alive) off = m.registerNexusTools(model, enter);
    });
    return () => {
      alive = false;
      off();
    };
  }, [model, enter]);

  if (route.mode === "world") {
    return <WorldMode route={route} net={net} engine={engine} gl={gl} reduced={reduced} pickRef={pickRef} onRetry={() => setAttempt((n) => n + 1)} />;
  }
  return <Landing route={route} net={net} engine={engine} gl={gl} onEnter={enter} pickRef={pickRef} />;
}
