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
import { NumField } from "./NumField";

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
      doctrineIdx: state.rac.doctrineIdx[i],
      teamId: state.rac.teamId[i],
      contact: state.rac.contact[i] as 0 | 1,
      groupId: state.rac.groupId[i],
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

/** Subtly shift `hex` toward a per-group hue so formation splits
 *  show as adjacent groups in slightly-different colors. Keeps the
 *  side identity (blue/red) dominant — only rotates the secondary
 *  channels. `gh` is a [0,1) hash of the group id. */
function tintByGroup(hex: string, gh: number): string {
  // Parse hex → rgb. Accept #rrggbb only.
  if (hex.length !== 7 || hex[0] !== "#") return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Five group-tint offsets in (R, G, B) — small magnitudes (~12).
  const tints = [
    [12, -8, -4],   // warmer
    [-8, 12, -4],   // greener
    [-4, -4, 12],   // bluer
    [10, 8, -8],    // yellow
    [8, -8, 10],    // magenta
  ];
  const idx = Math.floor(gh * tints.length) % tints.length;
  const t = tints[idx];
  const clamp = (v: number) => Math.max(0, Math.min(255, v | 0));
  const rr = clamp(r + t[0]);
  const gg = clamp(g + t[1]);
  const bb = clamp(b + t[2]);
  return `#${rr.toString(16).padStart(2, "0")}${gg.toString(16).padStart(2, "0")}${bb.toString(16).padStart(2, "0")}`;
}

// doctrine idx → outline color (matches DOCTRINES order in src/sim/doctrines.ts)
// 0=default, 1=phalanx, 2=fire-team, 3=skirmisher, 4=line
const DOCTRINE_RING: Record<number, string> = {
  1: "#d1a05c", // phalanx — bronze
  2: "#5cd1a0", // fire-team — green
  3: "#c05cd1", // skirmisher — purple
  4: "#5cb0d1", // line — cyan
};
const DOCTRINE_LABEL: Record<number, string> = {
  0: "default",
  1: "phalanx",
  2: "fire-team",
  3: "skirmisher",
  4: "line",
};

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
  // Visual encoding choices (kept minimal — image legibility wins
  // over information density):
  //   - role = shape (square/triangle/diamond/circle)
  //   - side = fill color (blue/red)
  //   - team parity = fill saturation (so bounding overwatch shows
  //     as flickering shade alternation between halves of a fire
  //     team — no extra ring)
  //   - contact = single subtle dark dot above the unit (synaspismos
  //     marker); no full outer ring
  //   - doctrine = small ring on a few "leader" units only (every
  //     5th rac), so it's identifiable without coating every unit
  for (const r of frame.racs) {
    const [cx, cy] = worldToCanvas(r.x, r.y);
    const c = SIDE_COLORS[r.owner];
    // Per-team alternate fill shading for non-default doctrines.
    let fill = c.rac;
    if (r.doctrineIdx > 1 && r.teamId % 2 === 1) {
      fill = r.owner === 0 ? "#5a86c0" : "#c05a5a";
    }
    // Group-id hue shift: rotate the fill toward a per-group hue so
    // formation splits appear as color-divergent halves. Subtle —
    // we only nudge toward red/green/yellow/cyan/magenta depending on
    // group hash, not full re-color. Keeps side identity dominant.
    const gh = ((r.groupId * 2654435761) >>> 0) / 4294967296;
    fill = tintByGroup(fill, gh);
    drawRoleShape(ctx, r.role, cx, cy, fill);
    // Doctrine indicator: only on every 5th rac (sparse), small ring.
    if (r.doctrineIdx > 0 && r.id % 5 === 0) {
      ctx.strokeStyle = DOCTRINE_RING[r.doctrineIdx] ?? "transparent";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    // Contact marker: tiny dark dot above the unit, not a full ring.
    if (r.contact) {
      ctx.fillStyle = "#000c";
      ctx.fillRect(cx - 1, cy - 8, 2, 2);
    }
    drawHpBar(ctx, cx, cy, r.hp, r.hpMax, 10);
  }

  // HUD: counts per side + role breakdown + dominant doctrine.
  const counts = {
    0: { T: 0, A: 0, C: 0, I: 0, bins: 0 },
    1: { T: 0, A: 0, C: 0, I: 0, bins: 0 },
  };
  // Doctrine histogram per side; pick the most common as "dominant."
  const doctrineHist: Record<0 | 1, Record<number, number>> = { 0: {}, 1: {} };
  for (const r of frame.racs) {
    const slot = counts[r.owner];
    const k = ROLE_LABEL[r.role] as "T" | "A" | "C" | "I";
    slot[k]++;
    doctrineHist[r.owner][r.doctrineIdx] = (doctrineHist[r.owner][r.doctrineIdx] ?? 0) + 1;
  }
  for (const b of frame.bins) {
    if (b.alive) counts[b.owner].bins++;
  }
  function dominantDoctrine(side: 0 | 1): { idx: number; label: string } {
    const h = doctrineHist[side];
    let best = -1;
    let bestN = -1;
    for (const [k, v] of Object.entries(h)) {
      if (v > bestN) { bestN = v; best = Number(k); }
    }
    return { idx: best, label: DOCTRINE_LABEL[best] ?? "—" };
  }
  const docA = dominantDoctrine(0);
  const docB = dominantDoctrine(1);
  ctx.font = "11px ui-monospace, monospace";
  ctx.textAlign = "left";
  ctx.fillStyle = SIDE_COLORS[0].text;
  ctx.fillText(
    `A  bins ${counts[0].bins}  T${counts[0].T} A${counts[0].A} C${counts[0].C} I${counts[0].I}  ·  ${docA.label}`,
    8, 14,
  );
  ctx.textAlign = "right";
  ctx.fillStyle = SIDE_COLORS[1].text;
  ctx.fillText(
    `${docB.label}  ·  T${counts[1].T} A${counts[1].A} C${counts[1].C} I${counts[1].I}  bins ${counts[1].bins}  B`,
    CANVAS_W - 8, 14,
  );
  ctx.textAlign = "center";
  ctx.fillStyle = "#888";
  ctx.fillText(`tick ${frame.tick}`, CANVAS_W * 0.5, 14);

  // Legend (bottom-left): role shapes.
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

  // Doctrine legend (bottom-right): only show rings for doctrines
  // present this frame, so the legend stays decluttered for vanilla
  // matchups.
  const presentDoctrines = new Set<number>();
  for (const r of frame.racs) if (r.doctrineIdx > 0) presentDoctrines.add(r.doctrineIdx);
  if (presentDoctrines.size > 0) {
    let rx = CANVAS_W - 8;
    ctx.textAlign = "right";
    for (const d of [4, 3, 2, 1]) {
      if (!presentDoctrines.has(d)) continue;
      const label = DOCTRINE_LABEL[d];
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "#aaa";
      ctx.fillText(label, rx, legendY);
      rx -= tw + 5;
      ctx.strokeStyle = DOCTRINE_RING[d] ?? "#888";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(rx, legendY, 5, 0, Math.PI * 2);
      ctx.stroke();
      rx -= 14;
    }
    ctx.lineWidth = 1;
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
          <NumField int value={opts.startSeed} onChange={(n) => setOpts({ ...opts, startSeed: n })} style={{ width: 100 }} />
        </label>
        <label>
          count
          <NumField int min={1} max={50} value={opts.count} onChange={(n) => setOpts({ ...opts, count: n })} style={{ width: 60 }} />
        </label>
        <label>
          ticks
          <NumField int min={100} max={5000} value={opts.ticks} onChange={(n) => setOpts({ ...opts, ticks: n })} style={{ width: 80 }} />
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
