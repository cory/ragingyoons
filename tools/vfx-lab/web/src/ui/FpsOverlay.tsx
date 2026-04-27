import { useEffect, useState } from "react";
import type { Engine } from "@babylonjs/core";

export function FpsOverlay({ engine }: { engine: Engine | null }) {
  const [fps, setFps] = useState(0);

  useEffect(() => {
    if (!engine) return;
    const id = window.setInterval(() => {
      setFps(Math.round(engine.getFps()));
    }, 250);
    return () => window.clearInterval(id);
  }, [engine]);

  return <div className="fps">{fps} fps</div>;
}
