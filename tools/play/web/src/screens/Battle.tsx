import { useEffect, useMemo, useState } from "react";
import {
  activeTraits,
  archByid,
  CURIOSITIES,
  ENEMY_BOARD,
  ENVIRONMENTS,
  ITEMS,
  MY_BENCH,
  MY_BOARD,
  NAMED,
  PLAYERS,
  ROLES,
  SHOP_LINEUP,
  tierOf,
} from "../data";
import type { BattlePhase, BoardUnit, Player, Screen, ShopOffer } from "../types";
import { BattleField3D } from "../components/BattleField3D";
import { BenchSlot } from "../components/BenchSlot";
import { HexBoard } from "../components/HexBoard";
import { PlayerRow } from "../components/PlayerRow";
import { RaccoonAvatar } from "../components/RaccoonAvatar";
import { ShopCard } from "../components/ShopCard";
import { TraitBadge } from "../components/TraitBadge";

interface Props {
  go: (s: Screen) => void;
  phase?: BattlePhase;
  /** Comp ids passed through to the live 3D battlefield. Changes cause
   *  the canvas to re-init and a fresh battle to start. */
  battleCompA?: string;
  battleCompB?: string;
  /** Bumping this triggers a battlefield reset with the same comps. */
  battleRestartCounter?: number;
}

// NOTE: design has 9 bench slots; v0 spec says 10 hand slots. Keeping 9
// for visual fidelity; bump when wiring real player state.
const BENCH_LEN = 9;

export function Battle({ go, phase: phaseProp, battleCompA, battleCompB, battleRestartCounter }: Props) {
  const [board] = useState<BoardUnit[]>(MY_BOARD);
  const [bench, setBench] = useState(MY_BENCH);
  const [enemyBoard] = useState<BoardUnit[]>(ENEMY_BOARD);
  const [trash, setTrash] = useState(34);
  const [hp] = useState(76);
  const [level, setLevel] = useState(6);
  const [xp, setXp] = useState(18);
  const xpNeeded = 36;
  const [round] = useState("3-2");
  const [phase, setPhase] = useState<BattlePhase>(phaseProp ?? "planning");
  const [shop, setShop] = useState<(ShopOffer | null)[]>(SHOP_LINEUP);
  const [hoveredPlayer, setHoveredPlayer] = useState<string | null>(null);
  const [hoveredUid, setHoveredUid] = useState<string | null>(null);
  const [, setDraggingBenchId] = useState<string | null>(null);
  const [combatTime, setCombatTime] = useState(0);
  const [raging, setRaging] = useState<Set<string>>(new Set());
  const [shopLocked, setShopLocked] = useState(false);

  // sync external phase changes (from dev panel)
  useEffect(() => {
    if (phaseProp) setPhase(phaseProp);
  }, [phaseProp]);

  // Combat ticker — visual only; real timing comes from the server later
  useEffect(() => {
    if (phase !== "combat") {
      setCombatTime(0);
      setRaging(new Set());
      return;
    }
    const t = setInterval(() => {
      setCombatTime((ct) => {
        const next = ct + 0.1;
        if (Math.random() < 0.15) {
          const all = [...board, ...enemyBoard];
          const pick = all[Math.floor(Math.random() * all.length)];
          setRaging((prev) => {
            const ns = new Set(prev);
            ns.add(pick.uid);
            setTimeout(() => {
              setRaging((p) => {
                const n = new Set(p);
                n.delete(pick.uid);
                return n;
              });
            }, 800);
            return ns;
          });
        }
        if (next > 28) {
          setPhase("planning");
          return 0;
        }
        return next;
      });
    }, 100);
    return () => clearInterval(t);
  }, [phase, board, enemyBoard]);

  const traits = useMemo(() => activeTraits(board), [board]);

  function buy(idx: number) {
    const slot = shop[idx];
    if (!slot || trash < slot.cost) return;
    setTrash((t) => t - slot.cost);
    setShop((s) => s.map((x, i) => (i === idx ? null : x)));
    setBench((b) => [...b, { uid: "b" + Date.now(), archetype: slot.archetype, level: 1 }]);
  }
  function reroll() {
    if (trash < 2) return;
    setTrash((t) => t - 2);
    setShop(
      Array.from({ length: 5 }).map(() => {
        const a = NAMED[Math.floor(Math.random() * NAMED.length)];
        return { archetype: a.id, cost: a.tier };
      }),
    );
  }
  function buyXp() {
    if (trash < 4) return;
    setTrash((t) => t - 4);
    setXp((x) => {
      const nx = x + 4;
      if (nx >= xpNeeded) {
        setLevel((l) => l + 1);
        return nx - xpNeeded;
      }
      return nx;
    });
  }

  return (
    <div className="screen battle" data-screen-label="04 Battle">
      <div className="battle-top">
        <button className="back-btn small" onClick={() => go("home")}>↩ MENU</button>
        <div className="round-pill">
          <span className="round-num">ROUND {round}</span>
          <span className="round-sep">·</span>
          <span className={`round-phase ${phase}`}>{phase === "combat" ? "⚔ COMBAT" : "◷ PLANNING"}</span>
          {phase === "planning" && <span className="round-timer">0:24</span>}
          {phase === "combat" && <span className="round-timer">{combatTime.toFixed(1)}s</span>}
        </div>
        <div className="battle-traits">
          {Object.entries(traits.env).map(([id, count]) => (
            <TraitBadge key={`e-${id}`} kind="env" traitId={id} count={count!} tier={tierOf(count!, "env")} />
          ))}
          {Object.entries(traits.cur).map(([id, count]) => (
            <TraitBadge key={`c-${id}`} kind="cur" traitId={id} count={count!} tier={tierOf(count!, "cur")} />
          ))}
          {Object.entries(traits.role).map(([id, count]) => (
            <TraitBadge key={`r-${id}`} kind="role" traitId={id} count={count!} tier={tierOf(count!, "role")} />
          ))}
        </div>
      </div>

      <div className="battle-main">
        <aside className="battle-rail">
          <div className="rail-head">
            <span>STANDINGS</span>
            <span className="muted">RD {round}</span>
          </div>
          {PLAYERS.map((p) => (
            <PlayerRow
              key={p.id}
              player={p}
              isYou={p.id === "me"}
              isHovered={hoveredPlayer === p.id}
              onHover={() => setHoveredPlayer(p.id)}
              onLeave={() => setHoveredPlayer(null)}
            />
          ))}
          <div className="rail-foot">
            <span className="muted">NEXT BUST</span>
            <span><b>SAUCE_PAW</b> · 28HP</span>
          </div>
        </aside>

        <section className="battle-center">
          <div className="board-label enemy">
            <div className="bl-side">VS</div>
            <div className="bl-name">TRASHKING_42</div>
            <div className="bl-meta">88HP · CITY/LOCKPICKERS</div>
          </div>
          <div className="board-wrap battle3d-wrap">
            <BattleField3D
              compA={battleCompA}
              compB={battleCompB}
              restartCounter={battleRestartCounter}
            />
          </div>
          <div className="board-label mine">
            <div className="bl-side">YOU</div>
            <div className="bl-name">{board.length}<span className="muted">/{level} ON FIELD</span></div>
            <div className="bl-meta">DRAG FROM BENCH ↓</div>
          </div>

          <div className="bench-row">
            <div className="bench-slots">
              {Array.from({ length: BENCH_LEN }).map((_, i) => {
                const u = bench[i];
                return (
                  <BenchSlot
                    key={i}
                    unit={u}
                    onDragStart={() => setDraggingBenchId(u?.uid ?? null)}
                  />
                );
              })}
            </div>
            <div className="bench-trash">
              <div className="bench-trash-glyph">🗑</div>
              <div className="bench-trash-label">SELL</div>
            </div>
          </div>
        </section>

        <aside className="battle-right">
          {hoveredPlayer && hoveredPlayer !== "me"
            ? <PlayerPreview playerId={hoveredPlayer} />
            : <UnitDetail uid={hoveredUid} board={board} enemyBoard={enemyBoard} />}
        </aside>
      </div>

      <div className="battle-bot">
        <div className="hud">
          <div className="hud-block">
            <div className="hud-lbl">HP</div>
            <div className="hud-val hp">{hp}<span className="hud-max">/100</span></div>
          </div>
          <div className="hud-block">
            <div className="hud-lbl">LV</div>
            <div className="hud-val">{level}</div>
            <div className="xp-bar"><div className="xp-fill" style={{ width: `${(xp / xpNeeded) * 100}%` }} /></div>
            <div className="hud-tiny">{xp}/{xpNeeded} XP</div>
          </div>
          <div className="hud-block">
            <div className="hud-lbl">TRASH</div>
            <div className="hud-val gold"><span className="gold-glyph">¢</span>{trash}</div>
            <div className="hud-tiny">+{Math.min(5, Math.floor(trash / 10))}¢ int</div>
          </div>
          <button className="hud-btn" onClick={buyXp} disabled={trash < 4}>
            <div className="bk-cost">¢4</div>
            <div className="bk-label">BUY XP</div>
            <div className="bk-sub">+4 XP</div>
          </button>
          <button className="hud-btn" onClick={reroll} disabled={trash < 2}>
            <div className="bk-cost">¢2</div>
            <div className="bk-label">REROLL</div>
            <div className="bk-sub">↻ shop</div>
          </button>
          <button className={`hud-btn ${shopLocked ? "on" : ""}`} onClick={() => setShopLocked(!shopLocked)}>
            <div className="bk-cost">{shopLocked ? "ON" : "OFF"}</div>
            <div className="bk-label">LOCK</div>
            <div className="bk-sub">keep shop</div>
          </button>
        </div>

        <div className="shop">
          {shop.map((s, i) => (
            <ShopCard key={i} slot={s} idx={i} trash={trash} onBuy={buy} />
          ))}
        </div>
      </div>

      {phase === "combat" && (
        <div className="combat-overlay">
          <div className="combat-flash" />
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Right panel: opponent preview (shown on rail hover)
// ─────────────────────────────────────────────────────────────────────
function PlayerPreview({ playerId }: { playerId: string }) {
  const p: Player | undefined = PLAYERS.find((x) => x.id === playerId);
  if (!p) return null;
  const env = ENVIRONMENTS[p.env];
  const fakeBoard = NAMED.filter((n) => n.env === p.env || n.cur === p.cur)
    .slice(0, 6)
    .map((n, i) => ({
      uid: `pp-${n.id}`,
      archetype: n.id,
      q: i % 7,
      r: Math.floor(i / 7) + 2,
      level: 1 + (i % 3),
      items: [],
    }));

  return (
    <div className="pp">
      <div className="pp-head">
        <div className="pp-rank">#{p.rank}</div>
        <div>
          <div className="pp-name">{p.name}</div>
          <div className="pp-meta" style={{ color: env.color }}>
            {env.glyph} {env.name} / {CURIOSITIES[p.cur].name}
          </div>
        </div>
      </div>
      <div className="pp-stats">
        <div><span className="muted">HP</span><b>{p.hp}</b></div>
        <div><span className="muted">¢</span><b>{p.trash}</b></div>
        <div><span className="muted">LV</span><b>{p.level}</b></div>
        <div>
          <span className="muted">STREAK</span>
          <b style={{ color: p.streak.startsWith("W") ? "#4ade80" : "#ef4444" }}>{p.streak}</b>
        </div>
      </div>
      <div className="pp-board-label">CURRENT BOARD</div>
      <div className="pp-board">
        <HexBoard rows={4} cols={7} board={fakeBoard} side="other" />
      </div>
      <div className="pp-board-traits muted">
        Last seen: 4 SUBURBAN · 3 FARMERS · 2 TANK
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Right panel: unit detail (shown on board hover)
// ─────────────────────────────────────────────────────────────────────
function UnitDetail({ uid, board, enemyBoard }: { uid: string | null; board: BoardUnit[]; enemyBoard: BoardUnit[] }) {
  const u = uid ? [...board, ...enemyBoard].find((x) => x.uid === uid) : null;
  if (!u) {
    return (
      <div className="ud empty">
        <div className="ud-empty-head">HOVER A RACCOON</div>
        <div className="ud-empty-sub">…or hover an opponent on the left rail to scout their board.</div>
        <div className="ud-tip">
          <b>TIP:</b> Combine 3 lvl-1 of the same archetype to make a lvl-2. 9 → lvl-3. Yes, it's that one.
        </div>
      </div>
    );
  }
  const a = archByid(u.archetype);
  if (!a) return null;
  const env = ENVIRONMENTS[a.env];
  const cur = CURIOSITIES[a.cur];
  const role = ROLES[a.role];
  return (
    <div className="ud">
      <div className="ud-portrait">
        <div className="ud-portrait-bg" style={{ background: `radial-gradient(circle at 50% 50%, ${env.color}44, transparent)` }} />
        <RaccoonAvatar archetype={u.archetype} size={140} />
        <div className="ud-tier">
          {Array.from({ length: u.level || 1 }).map((_, i) => <span key={i}>★</span>)}
        </div>
      </div>
      <div className="ud-name">{a.name}</div>
      <div className="ud-traits">
        <span style={{ color: env.color }}>{env.glyph} {env.name}</span>
        <span style={{ color: cur.color }}>{cur.glyph} {cur.name}</span>
        <span style={{ color: role.color }}>{role.glyph} {role.name}</span>
      </div>
      <div className="ud-stats">
        <div><span className="muted">HP</span><b>{a.hp * (u.level || 1)}</b></div>
        <div><span className="muted">ATK</span><b>{a.atk * (u.level || 1)}</b></div>
        <div><span className="muted">RAGE</span><b>{a.rage}</b></div>
        <div><span className="muted">RANGE</span><b>{role.shape === "TINY" ? "4" : role.shape === "BIG" ? "1" : "2"}</b></div>
      </div>
      <div>
        <div className="ud-section-h">RAGE SOURCE</div>
        <div className="ud-section-b">{role.rage}</div>
      </div>
      <div>
        <div className="ud-section-h">SYNERGY</div>
        <div className="ud-section-b">
          <div>{env.synergy}</div>
          <div>{cur.synergy}</div>
        </div>
      </div>
      {u.items && u.items.length > 0 && (
        <div>
          <div className="ud-section-h">ITEMS</div>
          <div className="ud-items">
            {u.items.map((it, i) => {
              const item = ITEMS[it];
              return (
                <div key={i} className="ud-item">
                  <span className="ud-item-glyph">{item?.glyph}</span>
                  <div>
                    <div><b>{item?.name}</b></div>
                    <div className="muted">{item?.desc}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
