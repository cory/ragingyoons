/**
 * Synthetic 2D battle viewer.
 *
 * Top-down canvas, simple shapes per side. Runs N battles in-browser
 * via the canonical sim module, captures a per-tick frame buffer, and
 * lets the user replay any single battle or render a heatmap of all
 * positions across all runs.
 *
 * Intent: visual sanity-check that the sim is doing what we think,
 * NOT a tool for design exploration. Mirror runs with same seeds
 * should look identical; runs with different seeds should look
 * meaningfully different even when starting positions match.
 *
 * Future: this snapshot stream is the foundation for the eventual
 * server-streamed spectator. Same shape, different transport.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  resolveTimeout,
  setupBattle,
  tick,
  type BattleConfig,
  type BattleState,
  type ContentBundle,
} from "@sim/index.js";
import { MemoryLogger } from "@sim/log.js";
import { loadContentFromApi, type ViewerBattle, type ViewerFrame } from "./sim-bridge.js";

const CANVAS_W = 720;
const CANVAS_H = 720;
const BOUNDS_W = 100;
const BOUNDS_H = 100;
const PX_PER_M_X = CANVAS_W / BOUNDS_W;
const PX_PER_M_Y = CANVAS_H / BOUNDS_H;

const SIDE_COLORS = {
  0: { bin: "#3a6db8", rac: "#7da9e6", text: "#9bc4f0" },
  1: { bin: "#b83a3a", rac: "#e67d7d", text: "#f09b9b" },
};

function captureFrame(state: BattleState, attacks: import("./sim-bridge.js").ViewerAttack[]): ViewerFrame {
  const bins: ViewerFrame["bins"] = [];
  for (let i = 0; i < state.bin.count; i++) {
    bins.push({
      id: state.bin.id[i],
      owner: state.bin.owner[i] as 0 | 1,
      x: state.bin.x[i],
      y: state.bin.y[i],
      hp: state.bin.hp[i],
      hpMax: state.bin.hpMax[i],
      alive: state.bin.alive[i] as 0 | 1,
      envIdx: state.bin.envIdx[i],
      curIdx: state.bin.curIdx[i],
    });
  }
  const racs: ViewerFrame["racs"] = [];
  for (let i = 0; i < state.rac.count; i++) {
    if (!state.rac.alive[i]) continue;
    racs.push({
      id: state.rac.id[i],
      owner: state.rac.owner[i] as 0 | 1,
      x: state.rac.x[i],
      y: state.rac.y[i],
      hp: state.rac.hp[i],
      hpMax: state.rac.hpMax[i],
      alive: 1,
      role: state.rac.role[i],
      envIdx: state.rac.env[i],
      curIdx: state.rac.cur[i],
    });
  }
  const projs: ViewerFrame["projs"] = [];
  for (let i = 0; i < state.atk.count; i++) {
    if (!state.atk.alive[i]) continue;
    projs.push({
      x: state.atk.x[i],
      y: state.atk.y[i],
      vx: state.atk.vx[i],
      vy: state.atk.vy[i],
      owner: state.atk.sourceOwner[i] as 0 | 1,
    });
  }
  return { tick: state.tick, bins, racs, attacks, projs };
}

/** Build attack-line entries from the just-emitted log lines. Looks up
 *  src + tgt positions in the current state. The runner drains the
 *  MemoryLogger between ticks; everything else (battle_start, tick_summary,
 *  ...) is discarded for viewer purposes. */
function collectAttacksFromLog(
  state: BattleState,
  rawLines: string[],
): import("./sim-bridge.js").ViewerAttack[] {
  const out: import("./sim-bridge.js").ViewerAttack[] = [];
  for (const line of rawLines) {
    if (line.length === 0) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.event_kind !== "rac_attack") continue;
    const srcId = Number(row.rac_id);
    const tgtId = Number(row.target_id);
    const tgtKind = row.target_kind === "bin" ? "bin" : "rac";
    // Linear scan for ids — fine at our entity counts.
    let sx = 0, sy = 0, sFound = false;
    for (let i = 0; i < state.rac.count; i++) {
      if (state.rac.id[i] === srcId) {
        sx = state.rac.x[i];
        sy = state.rac.y[i];
        sFound = true;
        break;
      }
    }
    if (!sFound) continue;
    let tx = 0, ty = 0, tFound = false;
    if (tgtKind === "bin") {
      for (let i = 0; i < state.bin.count; i++) {
        if (state.bin.id[i] === tgtId) {
          tx = state.bin.x[i];
          ty = state.bin.y[i];
          tFound = true;
          break;
        }
      }
    } else {
      for (let i = 0; i < state.rac.count; i++) {
        if (state.rac.id[i] === tgtId) {
          tx = state.rac.x[i];
          ty = state.rac.y[i];
          tFound = true;
          break;
        }
      }
    }
    if (!tFound) continue;
    // Skip archer attacks here — projectiles are drawn separately
    // from frame.projs as in-flight streaks. The flash-line aesthetic
    // is just for instant-hit melee + cavalry charge contact.
    if (row.delivery === "projectile") continue;
    out.push({ srcX: sx, srcY: sy, tgtX: tx, tgtY: ty, tgtKind });
  }
  return out;
}

function uuidv4(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  a[6] = (a[6] & 0x0f) | 0x40;
  a[8] = (a[8] & 0x3f) | 0x80;
  const h = [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function runBattle(content: ContentBundle, compA: string, compB: string, seed: number, ticks: number): ViewerBattle {
  const battleId = uuidv4();
  const cfg: BattleConfig = {
    seed,
    battleId,
    compA,
    compB,
    bounds: { w: BOUNDS_W, h: BOUNDS_H },
    verbosity: "events",
  };
  const log = new MemoryLogger({
    battle_id: battleId,
    seed,
    service_version: "viewer",
    content_version: content.version,
  });
  const state = setupBattle(content, cfg);
  log.setTickReader(() => state.tick);
  log.drain(); // toss any setup events
  const frames: ViewerFrame[] = [captureFrame(state, [])];
  for (let i = 0; i < ticks; i++) {
    tick(state, content, log);
    const lines = log.drain();
    const attacks = collectAttacksFromLog(state, lines);
    frames.push(captureFrame(state, attacks));
    if (state.winner !== -1 || state.endReason !== null) break;
  }
  if (state.winner === -1 && state.endReason === null) resolveTimeout(state);
  return {
    seed,
    frames,
    winner: state.winner,
    reason: state.endReason ?? "timeout",
    finalTick: state.tick,
  };
}

function worldToCanvas(x: number, y: number): [number, number] {
  // Center origin in canvas, +x right, +y up (so flip y).
  const cx = CANVAS_W * 0.5 + x * PX_PER_M_X;
  const cy = CANVAS_H * 0.5 - y * PX_PER_M_Y;
  return [cx, cy];
}

// role idx → label + shape drawer
const ROLE_LABEL = ["T", "A", "C", "I"]; // tank / archer / cavalry / infantry
const CUR_LABEL = ["L", "T", "F", "B"];  // lockpickers / tinkerers / farmers / barbarians

/** Draw a role-specific shape centered at (cx, cy) with the given fill. */
function drawRoleShape(
  ctx: CanvasRenderingContext2D,
  role: number,
  cx: number,
  cy: number,
  fill: string,
): void {
  ctx.fillStyle = fill;
  if (role === 0) {
    // Tank: bigger square (big in all dimensions).
    ctx.fillRect(cx - 4.5, cy - 4.5, 9, 9);
  } else if (role === 1) {
    // Archer: tiny triangle (tiny + ranged "arrow").
    ctx.beginPath();
    ctx.moveTo(cx, cy - 4);
    ctx.lineTo(cx - 3, cy + 3);
    ctx.lineTo(cx + 3, cy + 3);
    ctx.closePath();
    ctx.fill();
  } else if (role === 2) {
    // Cavalry: diamond (tall and a bit wider).
    ctx.beginPath();
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx + 3.5, cy);
    ctx.lineTo(cx, cy + 5);
    ctx.lineTo(cx - 3.5, cy);
    ctx.closePath();
    ctx.fill();
  } else {
    // Infantry: circle (default).
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Tiny HP bar above an entity. Hidden when full HP (less visual noise). */
function drawHpBar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  hp: number,
  hpMax: number,
  width: number,
): void {
  if (hpMax <= 0) return;
  const frac = Math.max(0, Math.min(1, hp / hpMax));
  if (frac >= 0.999) return;
  const w = width;
  const x = cx - w * 0.5;
  const y = cy - 9;
  ctx.fillStyle = "#000a";
  ctx.fillRect(x - 0.5, y - 0.5, w + 1, 3);
  ctx.fillStyle = frac > 0.5 ? "#7dd97d" : frac > 0.25 ? "#d9c87d" : "#d97d7d";
  ctx.fillRect(x, y, w * frac, 2);
}

function drawFrame(ctx: CanvasRenderingContext2D, frame: ViewerFrame): void {
  ctx.fillStyle = "#161616";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Battlefield outline + center line.
  ctx.strokeStyle = "#2a2a2a";
  ctx.strokeRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.beginPath();
  ctx.moveTo(CANVAS_W * 0.5, 0);
  ctx.lineTo(CANVAS_W * 0.5, CANVAS_H);
  ctx.stroke();

  // Bins: square with curiosity letter overlaid + HP bar.
  for (const b of frame.bins) {
    const [cx, cy] = worldToCanvas(b.x, b.y);
    const c = SIDE_COLORS[b.owner];
    if (b.alive) {
      ctx.fillStyle = c.bin;
      ctx.fillRect(cx - 9, cy - 9, 18, 18);
      ctx.strokeStyle = "#0008";
      ctx.strokeRect(cx - 9, cy - 9, 18, 18);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 11px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(CUR_LABEL[b.curIdx] ?? "?", cx, cy + 1);
      ctx.textBaseline = "alphabetic";
      drawHpBar(ctx, cx, cy - 4, b.hp, b.hpMax, 16);
    } else {
      ctx.strokeStyle = "#444";
      ctx.beginPath();
      ctx.moveTo(cx - 7, cy - 7);
      ctx.lineTo(cx + 7, cy + 7);
      ctx.moveTo(cx + 7, cy - 7);
      ctx.lineTo(cx - 7, cy + 7);
      ctx.stroke();
    }
  }

  // Attacks: thin lines from attacker to target, drawn UNDER the
  // raccoons but OVER the field. Bin-targeted attacks get a warmer
  // color (yellow-orange) so the eye picks up "this is a bin push."
  if (frame.attacks.length > 0) {
    for (const a of frame.attacks) {
      const [sx, sy] = worldToCanvas(a.srcX, a.srcY);
      const [tx, ty] = worldToCanvas(a.tgtX, a.tgtY);
      ctx.strokeStyle = a.tgtKind === "bin" ? "#f3c46c" : "#ff5a5a";
      ctx.lineWidth = a.tgtKind === "bin" ? 1.4 : 0.9;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
  }

  // Projectiles: short streak in direction of travel. Streak length =
  // ~3 sim-ticks of travel so the eye can see the velocity vector even
  // when arrows are sparse. Tinted by shooter side.
  if (frame.projs.length > 0) {
    ctx.lineWidth = 1.2;
    const STREAK_TICKS = 3;
    const dt = 1 / 15; // sim tick rate
    for (const p of frame.projs) {
      const [hx, hy] = worldToCanvas(p.x, p.y);
      const tailX = p.x - p.vx * dt * STREAK_TICKS;
      const tailY = p.y - p.vy * dt * STREAK_TICKS;
      const [tx, ty] = worldToCanvas(tailX, tailY);
      ctx.strokeStyle = p.owner === 0 ? "#cfe0ff" : "#ffd5cf";
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      // Bright head dot.
      ctx.fillStyle = p.owner === 0 ? "#ffffff" : "#ffe0d8";
      ctx.fillRect(hx - 1, hy - 1, 2, 2);
    }
    ctx.lineWidth = 1;
  }

  // Raccoons: shape by role + HP bar above.
  for (const r of frame.racs) {
    const [cx, cy] = worldToCanvas(r.x, r.y);
    const c = SIDE_COLORS[r.owner];
    drawRoleShape(ctx, r.role, cx, cy, c.rac);
    drawHpBar(ctx, cx, cy, r.hp, r.hpMax, 10);
  }

  // HUD: counts per side + role breakdown.
  const counts = {
    0: { T: 0, A: 0, C: 0, I: 0, bins: 0 },
    1: { T: 0, A: 0, C: 0, I: 0, bins: 0 },
  };
  for (const r of frame.racs) {
    const slot = counts[r.owner];
    const k = ROLE_LABEL[r.role] as "T" | "A" | "C" | "I";
    slot[k]++;
  }
  for (const b of frame.bins) {
    if (b.alive) counts[b.owner].bins++;
  }
  ctx.font = "11px ui-monospace, monospace";
  ctx.textAlign = "left";
  ctx.fillStyle = SIDE_COLORS[0].text;
  ctx.fillText(
    `A  bins ${counts[0].bins}  T${counts[0].T} A${counts[0].A} C${counts[0].C} I${counts[0].I}`,
    8, 14,
  );
  ctx.textAlign = "right";
  ctx.fillStyle = SIDE_COLORS[1].text;
  ctx.fillText(
    `T${counts[1].T} A${counts[1].A} C${counts[1].C} I${counts[1].I}  bins ${counts[1].bins}  B`,
    CANVAS_W - 8, 14,
  );
  ctx.textAlign = "center";
  ctx.fillStyle = "#888";
  ctx.fillText(`tick ${frame.tick}`, CANVAS_W * 0.5, 14);

  // Legend (bottom-left).
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const legendY = CANVAS_H - 14;
  ctx.fillStyle = "#888";
  ctx.fillText("legend:", 8, legendY);
  let lx = 60;
  for (const [role, label] of [
    [0, "tank"],
    [1, "archer"],
    [2, "cavalry"],
    [3, "infantry"],
  ] as const) {
    drawRoleShape(ctx, role, lx, legendY, "#aaa");
    ctx.fillStyle = "#aaa";
    ctx.fillText(label, lx + 8, legendY);
    lx += 8 + ctx.measureText(label).width + 14;
  }
  ctx.textBaseline = "alphabetic";
}

function drawHeatmap(ctx: CanvasRenderingContext2D, battles: ViewerBattle[]): void {
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Grid bins for accumulation. 4x4 px cells = 200×120 grid.
  const CELL_PX = 4;
  const cols = Math.floor(CANVAS_W / CELL_PX);
  const rows = Math.floor(CANVAS_H / CELL_PX);
  const heatA = new Uint32Array(cols * rows);
  const heatB = new Uint32Array(cols * rows);
  let maxHeat = 1;
  for (const battle of battles) {
    for (const frame of battle.frames) {
      for (const r of frame.racs) {
        const [px, py] = worldToCanvas(r.x, r.y);
        const cx = Math.floor(px / CELL_PX);
        const cy = Math.floor(py / CELL_PX);
        if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
        const idx = cy * cols + cx;
        if (r.owner === 0) {
          heatA[idx] += 1;
          if (heatA[idx] > maxHeat) maxHeat = heatA[idx];
        } else {
          heatB[idx] += 1;
          if (heatB[idx] > maxHeat) maxHeat = heatB[idx];
        }
      }
    }
  }

  // Render: side A as blue intensity, side B as red intensity, blended.
  const img = ctx.createImageData(CANVAS_W, CANVAS_H);
  for (let y = 0; y < CANVAS_H; y++) {
    for (let x = 0; x < CANVAS_W; x++) {
      const cx = Math.floor(x / CELL_PX);
      const cy = Math.floor(y / CELL_PX);
      const idx = cy * cols + cx;
      const a = heatA[idx] / maxHeat;
      const b = heatB[idx] / maxHeat;
      const off = (y * CANVAS_W + x) * 4;
      img.data[off + 0] = Math.min(255, b * 255);
      img.data[off + 1] = Math.min(255, (a + b) * 64);
      img.data[off + 2] = Math.min(255, a * 255);
      img.data[off + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Center line on top.
  ctx.strokeStyle = "#fff3";
  ctx.beginPath();
  ctx.moveTo(CANVAS_W * 0.5, 0);
  ctx.lineTo(CANVAS_W * 0.5, CANVAS_H);
  ctx.stroke();

  // Title.
  ctx.fillStyle = "#bbb";
  ctx.font = "12px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.fillText(`heatmap of ${battles.length} battles (max cell hits = ${maxHeat})`, CANVAS_W * 0.5, 14);
}

interface RunOpts {
  compA: string;
  compB: string;
  startSeed: number;
  count: number;
  ticks: number;
}

export function BattleViewer(): JSX.Element {
  const [content, setContent] = useState<ContentBundle | null>(null);
  const [contentErr, setContentErr] = useState<string | null>(null);
  const [comps, setComps] = useState<string[]>([]);
  const [opts, setOpts] = useState<RunOpts>({
    compA: "test-city-swarm",
    compB: "test-suburban-wall",
    startSeed: 0xc0ffee,
    count: 1,
    ticks: 1000,
  });
  const [battles, setBattles] = useState<ViewerBattle[]>([]);
  const [selectedBattle, setSelectedBattle] = useState(0);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [mode, setMode] = useState<"single" | "heatmap">("single");
  const [running, setRunning] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Load content once on mount.
  useEffect(() => {
    loadContentFromApi()
      .then((c) => {
        setContent(c);
        const compIds = [...c.comps.keys()].sort();
        setComps(compIds);
        if (compIds.length > 0) {
          setOpts((o) => ({
            ...o,
            compA: compIds.includes(o.compA) ? o.compA : compIds[0],
            compB: compIds.includes(o.compB) ? o.compB : compIds[Math.min(1, compIds.length - 1)],
          }));
        }
      })
      .catch((e) => setContentErr(String(e)));
  }, []);

  // Run the requested battles.
  const runBattles = (): void => {
    if (!content) return;
    setRunning(true);
    setBattles([]);
    setFrame(0);
    setSelectedBattle(0);
    setPlaying(false);
    // Defer to next frame so the "running…" UI can render.
    requestAnimationFrame(() => {
      const out: ViewerBattle[] = [];
      const t0 = performance.now();
      for (let i = 0; i < opts.count; i++) {
        out.push(runBattle(content, opts.compA, opts.compB, opts.startSeed + i, opts.ticks));
      }
      const elapsed = performance.now() - t0;
      // Tag elapsed for the HUD.
      console.log(`[viewer] ran ${opts.count} battles in ${elapsed.toFixed(0)}ms`);
      setBattles(out);
      setRunning(false);
    });
  };

  const currentBattle = battles[selectedBattle];

  // Playback timer.
  useEffect(() => {
    if (!playing || !currentBattle) return;
    const id = window.setInterval(() => {
      setFrame((f) => {
        const next = f + 1;
        if (next >= currentBattle.frames.length) {
          setPlaying(false);
          return f;
        }
        return next;
      });
    }, Math.max(1, 1000 / (15 * speed)));
    return () => window.clearInterval(id);
  }, [playing, speed, currentBattle]);

  // Render to canvas whenever inputs change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (mode === "heatmap" && battles.length > 0) {
      drawHeatmap(ctx, battles);
    } else if (currentBattle) {
      const f = currentBattle.frames[Math.min(frame, currentBattle.frames.length - 1)];
      drawFrame(ctx, f);
    } else {
      ctx.fillStyle = "#161616";
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      ctx.fillStyle = "#666";
      ctx.font = "14px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText("(no battles yet — pick comps and click Run)", CANVAS_W * 0.5, CANVAS_H * 0.5);
    }
  }, [currentBattle, frame, mode, battles]);

  const winnerText = useMemo(() => {
    if (!currentBattle) return "";
    if (currentBattle.winner === 0) return "A wins";
    if (currentBattle.winner === 1) return "B wins";
    return "draw";
  }, [currentBattle]);

  if (contentErr) return <div className="empty">content load failed: {contentErr}</div>;
  if (!content) return <div className="empty">loading content…</div>;

  return (
    <div className="battle-viewer">
      <div className="bv-controls">
        <label>
          A
          <select value={opts.compA} onChange={(e) => setOpts({ ...opts, compA: e.target.value })}>
            {comps.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label>
          B
          <select value={opts.compB} onChange={(e) => setOpts({ ...opts, compB: e.target.value })}>
            {comps.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label>
          seed
          <input type="number" value={opts.startSeed} onChange={(e) => setOpts({ ...opts, startSeed: Number(e.target.value) })} style={{ width: 100 }} />
        </label>
        <label>
          count
          <input type="number" min={1} max={50} value={opts.count} onChange={(e) => setOpts({ ...opts, count: Math.max(1, Math.min(50, Number(e.target.value))) })} style={{ width: 60 }} />
        </label>
        <label>
          ticks
          <input type="number" min={100} max={5000} value={opts.ticks} onChange={(e) => setOpts({ ...opts, ticks: Number(e.target.value) })} style={{ width: 80 }} />
        </label>
        <button onClick={runBattles} disabled={running} className="bv-run">
          {running ? "running…" : "run"}
        </button>
      </div>

      <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} className="bv-canvas" />

      <div className="bv-controls">
        <button onClick={() => setMode(mode === "single" ? "heatmap" : "single")}>
          {mode === "single" ? "→ heatmap" : "→ single"}
        </button>
        {mode === "single" && battles.length > 0 && (
          <>
            <label>
              battle
              <select value={selectedBattle} onChange={(e) => { setSelectedBattle(Number(e.target.value)); setFrame(0); setPlaying(false); }}>
                {battles.map((b, i) => (
                  <option key={i} value={i}>
                    #{i} seed {b.seed} → {b.winner === 0 ? "A" : b.winner === 1 ? "B" : "draw"} ({b.reason}, t{b.finalTick})
                  </option>
                ))}
              </select>
            </label>
            <button onClick={() => setPlaying(!playing)}>{playing ? "⏸" : "▶"}</button>
            <button onClick={() => { setFrame(0); setPlaying(false); }}>⏮</button>
            <label>
              speed
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                <option value={0.5}>0.5×</option>
                <option value={1}>1×</option>
                <option value={2}>2×</option>
                <option value={4}>4×</option>
                <option value={8}>8×</option>
                <option value={16}>16×</option>
              </select>
            </label>
            <input
              type="range"
              min={0}
              max={Math.max(0, (currentBattle?.frames.length ?? 1) - 1)}
              value={frame}
              onChange={(e) => { setFrame(Number(e.target.value)); setPlaying(false); }}
              style={{ flex: 1 }}
            />
            <span className="bv-frame-label">
              {frame} / {(currentBattle?.frames.length ?? 1) - 1}  ·  {winnerText}
            </span>
          </>
        )}
      </div>

      {battles.length > 0 && mode === "single" && (
        <div className="bv-summary">
          {battles.map((b, i) => (
            <div key={i} className={`bv-tile ${i === selectedBattle ? "selected" : ""}`} onClick={() => { setSelectedBattle(i); setFrame(0); setPlaying(false); }}>
              <div className="bv-tile-seed">seed {b.seed}</div>
              <div className={`bv-tile-winner bv-winner-${b.winner}`}>
                {b.winner === 0 ? "A" : b.winner === 1 ? "B" : "—"}
              </div>
              <div className="bv-tile-reason">{b.reason} t{b.finalTick}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
