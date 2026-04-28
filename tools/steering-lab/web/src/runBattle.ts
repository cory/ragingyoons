/**
 * Single-cell battle runner for the steering-lab. Builds a synthetic
 * shape battle (N friendly racs vs one punching-bag bin), runs it tick
 * by tick, and on every tick captures both a snapshot of positions and
 * the per-rac per-component force vectors that boids computed.
 *
 * The captures are kept frame-by-frame so the scrubber can show debug
 * arrows for any historical tick — not just the live tick. That costs
 * memory (12 floats × N racs × ticks) but the lab is a debug tool;
 * "don't worry about performance" per the user's brief.
 */

import {
  setupShapeBattle,
  tick,
  MemoryLogger,
  TICK_RATE_HZ,
  type ShapeBattleConfig,
} from "@sim/index.js";
import type { ContentBundle } from "@sim/content.js";
import type { ForceFlag } from "@sim/state.js";
import { FORCE_FLOATS_PER_RAC, MAX_RACS } from "@sim/state.js";
import type { FormationId } from "@sim/formations.js";

export type ForceFlagMap = Partial<Record<ForceFlag, boolean>>;

export interface LabRunConfig {
  seed: number;
  unitId: string;
  count: number;
  formationId?: FormationId;
  enemyBinUnitId: string;
  ticks: number;
  /** Per-force gates. Missing flag = enabled. */
  flags: ForceFlagMap;
  /** Bounds (meters). Lab keeps it small for tight visuals. */
  bounds: { w: number; h: number };
}

export interface RacFrame {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  alive: 0 | 1;
  groupId: number;
  doctrineIdx: number;
  contact: 0 | 1;
  slotDx: number;
  slotDy: number;
  /** Per-component forces captured by boidsTick (12 floats). */
  forces: Float32Array;
}

export interface BinFrame {
  id: number;
  x: number;
  y: number;
  hp: number;
  hpMax: number;
  alive: 0 | 1;
}

export interface LabFrame {
  tick: number;
  racs: RacFrame[];
  bins: BinFrame[];
}

export interface LabRunResult {
  frames: LabFrame[];
  /** True target as understood at end-of-run (for overlay drawing). */
  bounds: { w: number; h: number };
}

export function runLabBattle(content: ContentBundle, cfg: LabRunConfig): LabRunResult {
  const battleCfg: ShapeBattleConfig = {
    seed: cfg.seed,
    battleId: `lab-${cfg.seed}`,
    bounds: cfg.bounds,
    unitId: cfg.unitId,
    count: cfg.count,
    formationId: cfg.formationId,
    enemyBinUnitId: cfg.enemyBinUnitId,
    disableSynergies: true,
  };
  const state = setupShapeBattle(content, battleCfg);
  state.forceFlags = cfg.flags;
  // Allocate the debug capture buffer once; boidsTick fills it each tick.
  const dbg = new Float32Array(MAX_RACS * FORCE_FLOATS_PER_RAC);
  state._debugForces = dbg;

  const log = new MemoryLogger({
    battle_id: battleCfg.battleId,
    seed: cfg.seed,
    service_version: "lab",
    content_version: content.version,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  log.setTickReader(() => state.tick);

  const frames: LabFrame[] = [];
  // Capture tick 0 (pre-tick state)
  frames.push(snapshotFrame(state, dbg));

  for (let t = 0; t < cfg.ticks; t++) {
    state.tick = t + 1;
    tick(state, content, log);
    frames.push(snapshotFrame(state, dbg));
    if (state.winner !== -1) break;
  }
  return { frames, bounds: cfg.bounds };
}

function snapshotFrame(state: ReturnType<typeof setupShapeBattle>, dbg: Float32Array): LabFrame {
  const racs: RacFrame[] = [];
  for (let i = 0; i < state.rac.count; i++) {
    const f = new Float32Array(FORCE_FLOATS_PER_RAC);
    f.set(dbg.subarray(i * FORCE_FLOATS_PER_RAC, (i + 1) * FORCE_FLOATS_PER_RAC));
    racs.push({
      id: state.rac.id[i],
      x: state.rac.x[i],
      y: state.rac.y[i],
      vx: state.rac.vx[i],
      vy: state.rac.vy[i],
      alive: state.rac.alive[i] as 0 | 1,
      groupId: state.rac.groupId[i],
      doctrineIdx: state.rac.doctrineIdx[i],
      contact: state.rac.contact[i] as 0 | 1,
      slotDx: state.rac.slotDx[i],
      slotDy: state.rac.slotDy[i],
      forces: f,
    });
  }
  const bins: BinFrame[] = [];
  for (let i = 0; i < state.bin.count; i++) {
    bins.push({
      id: state.bin.id[i],
      x: state.bin.x[i],
      y: state.bin.y[i],
      hp: state.bin.hp[i],
      hpMax: state.bin.hpMax[i],
      alive: state.bin.alive[i] as 0 | 1,
    });
  }
  return { tick: state.tick, racs, bins };
}

export const SECONDS_PER_TICK = 1 / TICK_RATE_HZ;
