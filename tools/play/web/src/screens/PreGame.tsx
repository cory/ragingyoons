import type { CSSProperties } from "react";
import { useState } from "react";
import { archByid, CURIOSITIES, ENVIRONMENTS, ROLES } from "../data";
import type { Screen } from "../types";
import { RaccoonAvatar } from "../components/RaccoonAvatar";

interface Props {
  go: (s: Screen) => void;
}

const STARTER_OPTIONS = ["splinter", "duster", "brine", "mulch", "glitch", "salt"];

const BADGES = [
  { id: "density", name: "DENSITY", desc: "Start with 1 free CITY raccoon. +1 trash per round if you have 2+ adjacent allies.", glyph: "⌬" },
  { id: "rabid",   name: "RABID",   desc: "All your raccoons gain rage 20% faster on round 1-3.",                                  glyph: "⚠" },
  { id: "haggle",  name: "HAGGLE",  desc: "First reroll each round costs 0¢. Cap +5¢ interest doubled to +10¢.",                     glyph: "¢" },
  { id: "feral",   name: "FERAL",   desc: "You take 0 damage on a loss in rounds 1-2. Then +50% damage taken until round 6.",      glyph: "☠" },
];

export function PreGame({ go }: Props) {
  const [pick, setPick] = useState("splinter");
  const [badge, setBadge] = useState("density");
  const a = archByid(pick);
  if (!a) return null;
  const env = ENVIRONMENTS[a.env];
  const cur = CURIOSITIES[a.cur];
  const role = ROLES[a.role];

  return (
    <div className="screen pregame" data-screen-label="03 Pre-Game">
      <header className="pg-top">
        <button className="back-btn" onClick={() => go("lobby")}>← BACK</button>
        <div className="pg-title">CHOOSE YOUR <span className="title-rage">FIRST RACCOON</span></div>
        <div className="pg-timer">00:24</div>
      </header>

      <div className="pg-body">
        <div className="pg-options">
          {STARTER_OPTIONS.map((id) => {
            const r = archByid(id);
            if (!r) return null;
            const optEnv = ENVIRONMENTS[r.env];
            return (
              <button
                key={id}
                className={`pg-option ${pick === id ? "active" : ""}`}
                onClick={() => setPick(id)}
                style={{ "--env-color": optEnv.color } as CSSProperties}
              >
                <RaccoonAvatar archetype={id} size={64} raging={pick === id} />
                <div>
                  <div className="pg-option-name">{r.name}</div>
                  <div className="pg-option-tags">
                    <span style={{ color: optEnv.color }}>{optEnv.short}</span>
                    <span style={{ color: ROLES[r.role].color }}>{ROLES[r.role].name}</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="pg-detail">
          <div className="pg-portrait">
            <div className="pg-portrait-bg" style={{ background: `radial-gradient(circle at 50% 60%, ${env.color}33, transparent 60%)` }} />
            <RaccoonAvatar archetype={pick} size={280} raging />
          </div>
          <div className="pg-info">
            <div className="pg-info-name">{a.name}</div>
            <div className="pg-info-quote">"{role.rage.toLowerCase()}"</div>
            <div className="pg-info-rows">
              <div><span className="muted">ENV</span><b style={{ color: env.color }}>{env.name}</b></div>
              <div><span className="muted">CUR</span><b style={{ color: cur.color }}>{cur.name}</b></div>
              <div><span className="muted">ROLE</span><b style={{ color: role.color }}>{role.name}</b></div>
              <div><span className="muted">HP</span><b>{a.hp}</b></div>
              <div><span className="muted">ATK</span><b>{a.atk}</b></div>
              <div><span className="muted">RAGE</span><b>{a.rage}</b></div>
            </div>
          </div>
        </div>

        <div className="pg-badge">
          <div className="pg-badge-head">PICK A BADGE <span className="muted">(ECON / FIGHT / FATE)</span></div>
          <div className="pg-badge-list">
            {BADGES.map((b) => (
              <button key={b.id} className={`pg-badge-card ${badge === b.id ? "active" : ""}`} onClick={() => setBadge(b.id)}>
                <div className="pg-badge-glyph">{b.glyph}</div>
                <div className="pg-badge-name">{b.name}</div>
                <div className="pg-badge-desc">{b.desc}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <footer className="pg-foot">
        <button className="btn primary big" onClick={() => go("battle")}>LOCK IN & DEPLOY →</button>
      </footer>
    </div>
  );
}
