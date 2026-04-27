import type { CSSProperties } from "react";
import { CURIOSITIES, ENVIRONMENTS, NAMED, PLAYERS } from "../data";
import type { Screen } from "../types";
import { RaccoonAvatar } from "../components/RaccoonAvatar";

interface Props {
  go: (s: Screen) => void;
}

export function Results({ go }: Props) {
  const placement = 3;
  const ranked = [...PLAYERS].sort((a, b) => a.rank - b.rank);
  return (
    <div className="screen results" data-screen-label="06 Results">
      <header className="rs-top">
        <button className="back-btn" onClick={() => go("home")}>↩ HOME</button>
        <div className="rs-title">MATCH OVER</div>
        <div className="rs-meta">RANKED · 28:14 · 14 ROUNDS</div>
      </header>

      <div className="rs-main">
        <div className="rs-placement">
          <div className="rs-place-num">#{placement}</div>
          <div className="rs-place-tier">TOP-3</div>
          <div className="rs-place-lp">+24 LP</div>
          <div className="rs-place-flavor">"the bin remembers."</div>
          <div className="rs-place-rewards">
            <div><span className="muted">XP</span><b>+820</b></div>
            <div><span className="muted">¢</span><b>+140</b></div>
            <div><span className="muted">PASS</span><b>+3</b></div>
          </div>
          <button className="btn primary big" onClick={() => go("home")}>BACK TO HOME</button>
          <button className="btn ghost" onClick={() => go("progression")}>VIEW PROGRESSION</button>
        </div>

        <div className="rs-board">
          <div className="rs-board-h">FINAL STANDINGS</div>
          {ranked.map((p) => {
            const env = ENVIRONMENTS[p.env];
            const repr = NAMED.find((n) => n.env === p.env && n.cur === p.cur)?.id ?? "splinter";
            return (
              <div key={p.id} className={`rs-row ${p.id === "me" ? "you" : ""}`}>
                <div className="rs-rank">#{p.rank}</div>
                <div className="rs-row-av" style={{ "--env-color": env.color } as CSSProperties}>
                  <RaccoonAvatar archetype={repr} size={36} />
                </div>
                <div className="rs-row-name">{p.name}{p.id === "me" && <span className="muted"> · YOU</span>}</div>
                <div className="rs-row-tags">
                  <span style={{ color: env.color }}>{env.short}</span>
                  <span style={{ color: CURIOSITIES[p.cur].color }}>{CURIOSITIES[p.cur].name.slice(0, 4)}</span>
                </div>
                <div className="rs-row-rounds">
                  {Array.from({ length: 14 }).map((_, j) => (
                    <span key={j} className={`rd-pip ${j < 14 - p.rank ? "won" : "lost"}`} />
                  ))}
                </div>
                <div className="rs-row-lp">{p.rank <= 3 ? `+${28 - p.rank * 6}` : `${-12 - p.rank}`}</div>
              </div>
            );
          })}
          <div className="rs-board-foot">
            <div className="rs-stat-card">
              <div className="muted">DAMAGE DEALT</div>
              <div><b>1,840</b><span className="muted"> · #2 OF 6</span></div>
            </div>
            <div className="rs-stat-card">
              <div className="muted">TRASH SPENT</div>
              <div><b>318</b><span className="muted"> · 14 REROLLS</span></div>
            </div>
            <div className="rs-stat-card">
              <div className="muted">TOP TRAIT</div>
              <div><b style={{ color: "#e7c93a" }}>⌬ CITY (6)</b></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
