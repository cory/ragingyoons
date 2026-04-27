import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { ENVIRONMENTS, NAMED, PLAYERS } from "../data";
import type { Screen } from "../types";
import { RaccoonAvatar } from "../components/RaccoonAvatar";

interface Props {
  go: (s: Screen) => void;
}

const SEAT_COUNT = PLAYERS.length;

export function Lobby({ go }: Props) {
  const [seconds, setSeconds] = useState(38);
  const [found, setFound] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setFound((f) => Math.min(SEAT_COUNT, f + 1)), 350);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="screen lobby" data-screen-label="02 Lobby">
      <div className="lobby-grid-bg" />
      <header className="lobby-top">
        <button className="back-btn" onClick={() => go("home")}>← LEAVE QUEUE</button>
        <div className="lobby-title">
          <div className="lobby-mode">RANKED · {SEAT_COUNT}-STRATEGIST ROYALE</div>
          <div className="lobby-sub">CALIBRATING THE BIN POOL...</div>
        </div>
        <div className="lobby-timer">{seconds.toString().padStart(2, "0")}<span className="muted">s</span></div>
      </header>

      <div className="lobby-main">
        <div className="lobby-roster">
          <div className="roster-head">
            <span>RACCOONS FOUND</span>
            <span className="roster-count">{found}<span className="muted">/{SEAT_COUNT}</span></span>
          </div>
          <div className="roster-list">
            {PLAYERS.map((p, i) => {
              const visible = i < found;
              const env = ENVIRONMENTS[p.env];
              const repr = NAMED.find((n) => n.env === p.env && n.cur === p.cur)?.id ?? "splinter";
              return (
                <div
                  key={p.id}
                  className={`roster-item ${visible ? "in" : ""}`}
                  style={{ "--env-color": env.color } as CSSProperties}
                >
                  <div className="roster-av">
                    {visible
                      ? <RaccoonAvatar archetype={repr} size={48} />
                      : <span className="roster-q">?</span>}
                  </div>
                  <div className="roster-mid">
                    <div className="roster-name">{visible ? p.name : "— SEARCHING —"}</div>
                    <div className="roster-tags">
                      {visible ? (
                        <>
                          <span style={{ color: env.color }}>{env.glyph} {env.name}</span>
                          <span className="muted">· LV {p.level + 30}</span>
                          <span className="muted">· TRASHLORD II</span>
                        </>
                      ) : (
                        <span className="muted">scanning the alleys…</span>
                      )}
                    </div>
                  </div>
                  <div className="roster-status">
                    {visible ? <span className="ready-pip">●</span> : <span className="loading-pip">···</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="lobby-tips">
          <div className="tips-head">WHILE YOU WAIT</div>
          <div className="tip-card">
            <div className="tip-num">01</div>
            <div className="tip-body">
              <b>STACK ENVIRONMENTS</b>
              <p>4 CITY raccoons trigger DENSITY (+15% atk speed when adjacent to 2+ allies).</p>
            </div>
          </div>
          <div className="tip-card">
            <div className="tip-num">02</div>
            <div className="tip-body">
              <b>DON'T HOARD TRASH</b>
              <p>Interest caps at 5¢. Spend on rerolls when you've hit lvl 6.</p>
            </div>
          </div>
          <div className="tip-card">
            <div className="tip-num">03</div>
            <div className="tip-body">
              <b>TANKS RAGE OFF DAMAGE</b>
              <p>Frontline in CITY is double-dipping the chip damage from swarm.</p>
            </div>
          </div>
          <button className="btn primary big" onClick={() => go("pregame")}>ENTER LOADOUT →</button>
        </div>
      </div>
    </div>
  );
}
