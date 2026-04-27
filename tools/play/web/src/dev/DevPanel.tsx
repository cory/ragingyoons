// Local-only dev panel for jumping between screens, toggling battle
// phase, and switching the accent / grime tweaks. No postMessage host
// protocol — this isn't running inside the design tool anymore.
import type { CSSProperties } from "react";
import type { BattlePhase, Screen } from "../types";

const SCREEN_OPTIONS: { value: Screen; label: string }[] = [
  { value: "home",        label: "01 · Home" },
  { value: "lobby",       label: "02 · Lobby" },
  { value: "pregame",     label: "03 · Pre-Game" },
  { value: "battle",      label: "04 · Battle" },
  { value: "results",     label: "06 · Results" },
  { value: "progression", label: "07 · Progression" },
];

const ACCENT_PRESETS: { color: string; name: string }[] = [
  { color: "#ff6a2a", name: "Rage Orange" },
  { color: "#e7ff3a", name: "Hazard Lime" },
  { color: "#3aff8a", name: "Biohazard" },
  { color: "#ff3a8a", name: "Neon Pink" },
  { color: "#3acaff", name: "Sodium Cyan" },
  { color: "#d94a3a", name: "Dumpster Red" },
];

const INTENSITIES = ["low", "med", "high"] as const;

interface Props {
  screen: Screen;
  setScreen: (s: Screen) => void;
  phase: BattlePhase;
  setPhase: (p: BattlePhase) => void;
  accent: string;
  setAccent: (c: string) => void;
  intensity: "low" | "med" | "high";
  setIntensity: (i: "low" | "med" | "high") => void;
  onClose: () => void;
  comps: string[];
  battleCompA: string;
  setBattleCompA: (id: string) => void;
  battleCompB: string;
  setBattleCompB: (id: string) => void;
  onRestartBattle: () => void;
}

export function DevPanel(props: Props) {
  return (
    <div className="dev-panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h4>DEV · backtick to toggle</h4>
        <button className="dev-panel-toggle" onClick={props.onClose}>×</button>
      </div>

      <div className="dev-panel-row">
        <label>ACTIVE SCREEN</label>
        <select value={props.screen} onChange={(e) => props.setScreen(e.target.value as Screen)}>
          {SCREEN_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {props.screen === "battle" && (
        <>
          <div className="dev-panel-row">
            <label>BATTLE PHASE</label>
            <div className="dev-panel-segs">
              {(["planning", "combat"] as BattlePhase[]).map((p) => (
                <button key={p} className={p === props.phase ? "on" : ""} onClick={() => props.setPhase(p)}>
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div className="dev-panel-row">
            <label>COMP A (PLAYER)</label>
            <select value={props.battleCompA} onChange={(e) => props.setBattleCompA(e.target.value)}>
              {props.comps.length === 0 && <option value={props.battleCompA}>{props.battleCompA}</option>}
              {props.comps.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div className="dev-panel-row">
            <label>COMP B (ENEMY)</label>
            <select value={props.battleCompB} onChange={(e) => props.setBattleCompB(e.target.value)}>
              {props.comps.length === 0 && <option value={props.battleCompB}>{props.battleCompB}</option>}
              {props.comps.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div className="dev-panel-row">
            <button
              className="dev-panel-toggle"
              style={{ width: "100%", padding: "6px 10px" }}
              onClick={props.onRestartBattle}
            >
              ↻ RESTART BATTLE
            </button>
          </div>
        </>
      )}

      <div className="dev-panel-row">
        <label>ACCENT (RAGE)</label>
        <div className="dev-panel-presets">
          {ACCENT_PRESETS.map((p) => (
            <button
              key={p.color}
              title={p.name}
              className={p.color === props.accent ? "on" : ""}
              style={{ "--swatch": p.color, background: p.color } as CSSProperties}
              onClick={() => props.setAccent(p.color)}
            />
          ))}
        </div>
      </div>

      <div className="dev-panel-row">
        <label>GRIME INTENSITY</label>
        <div className="dev-panel-segs">
          {INTENSITIES.map((i) => (
            <button key={i} className={i === props.intensity ? "on" : ""} onClick={() => props.setIntensity(i)}>
              {i}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
