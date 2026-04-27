import { useEffect, useState } from "react";
import { DevPanel } from "./dev/DevPanel";
import { Battle } from "./screens/Battle";
import { Home } from "./screens/Home";
import { Lobby } from "./screens/Lobby";
import { PreGame } from "./screens/PreGame";
import { Progression } from "./screens/Progression";
import { Results } from "./screens/Results";
import type { BattlePhase, Screen } from "./types";

export function App() {
  const [screen, setScreen] = useState<Screen>("battle");
  const [phase, setPhase] = useState<BattlePhase>("planning");
  const [accent, setAccent] = useState("#ff6a2a");
  const [intensity, setIntensity] = useState<"low" | "med" | "high">("high");
  const [devOpen, setDevOpen] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-glow", `${accent}55`);
    root.dataset.intensity = intensity;
  }, [accent, intensity]);

  // Backtick toggles the dev panel. Ignore when typing in inputs.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "`") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      setDevOpen((v) => !v);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (s: Screen) => setScreen(s);

  let view;
  switch (screen) {
    case "home":        view = <Home go={go} />; break;
    case "lobby":       view = <Lobby go={go} />; break;
    case "pregame":     view = <PreGame go={go} />; break;
    case "battle":      view = <Battle go={go} phase={phase} />; break;
    case "results":     view = <Results go={go} />; break;
    case "progression": view = <Progression go={go} />; break;
    default:            view = <Home go={go} />;
  }

  return (
    <>
      {view}
      {devOpen && (
        <DevPanel
          screen={screen}
          setScreen={setScreen}
          phase={phase}
          setPhase={setPhase}
          accent={accent}
          setAccent={setAccent}
          intensity={intensity}
          setIntensity={setIntensity}
          onClose={() => setDevOpen(false)}
        />
      )}
    </>
  );
}
