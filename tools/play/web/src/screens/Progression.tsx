import type { CSSProperties } from "react";
import { ENVIRONMENTS, NAMED } from "../data";
import type { Screen } from "../types";
import { RaccoonAvatar } from "../components/RaccoonAvatar";

interface Props {
  go: (s: Screen) => void;
}

const FREE_REW = ["ICON", "EMOTE", "TRASH", "SHARD", "SKIN"];
const FREE_GLYPH = ["◆", "★", "¢", "✦", "☠"];
const PREM_REW = ["SKIN", "BANNER", "POSE", "VFX", "TRAIL"];

export function Progression({ go }: Props) {
  const tiers = Array.from({ length: 30 }, (_, i) => i + 1);
  const currentTier = 14;
  const roster = NAMED.concat(NAMED).slice(0, 24);

  return (
    <div className="screen progression" data-screen-label="07 Progression">
      <header className="pr-top">
        <button className="back-btn" onClick={() => go("home")}>↩ HOME</button>
        <div className="pr-title">SEASON 03 · GARBAGE GLAM</div>
        <div className="pr-meta">42 DAYS LEFT · TIER {currentTier}/50</div>
      </header>

      <div className="pr-section">
        <div className="pr-section-h">RAGE PASS</div>
        <div className="pr-pass">
          {tiers.map((t) => {
            const unlocked = t <= currentTier;
            const isCurrent = t === currentTier;
            return (
              <div key={t} className={`pr-tier ${unlocked ? "unlocked" : ""} ${isCurrent ? "current" : ""}`}>
                <div className="pr-tier-num">T{t}</div>
                <div className="pr-tier-reward free">
                  <div className="pr-rew-glyph">{FREE_GLYPH[t % FREE_GLYPH.length]}</div>
                  <div className="pr-rew-lbl">{FREE_REW[t % FREE_REW.length]}</div>
                </div>
                <div className="pr-tier-reward prem">
                  <div className="pr-rew-glyph">⚡</div>
                  <div className="pr-rew-lbl">{PREM_REW[t % PREM_REW.length]}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="pr-section">
        <div className="pr-section-h">YOUR ROSTER <span className="muted">· 24 / 64 RACCOONS</span></div>
        <div className="pr-roster">
          {roster.map((r, i) => {
            const env = ENVIRONMENTS[r.env];
            const owned = i % 3 !== 2;
            return (
              <div
                key={i}
                className={`pr-rac ${owned ? "" : "locked"}`}
                style={{ "--env-color": env.color } as CSSProperties}
              >
                <RaccoonAvatar archetype={r.id} size={56} />
                <div className="pr-rac-name">{r.name}</div>
                <div className="pr-rac-mastery">
                  <div className="pr-mast-bar">
                    <div className="pr-mast-fill" style={{ width: owned ? `${(i * 7) % 100}%` : "0%" }} />
                  </div>
                  <span className="muted">M{owned ? Math.floor(i / 3) : 0}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
