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
import { FLANK_DEBUG_FLOATS_PER_RAC, MAX_RACS, MORALE_BREAK_THRESHOLD, MORALE_BREAK_THRESHOLD_BY_ENV } from "@sim/state.js";
import type { FormationId } from "@sim/formations.js";

export interface LabSideConfig {
  unitId: string;
  count: number;
  formationId?: FormationId;
  maxPlatoonSize?: number;
  platoonStride?: number;
}

export interface LabRunConfig {
  seed: number;
  /** Side 0 (blue). */
  unitId: string;
  count: number;
  formationId?: FormationId;
  /** Punching-bag mode bin (only used when redSide is undefined). */
  enemyBinUnitId: string;
  ticks: number;
  bounds: { w: number; h: number };
  maxPlatoonSize?: number;
  platoonStride?: number;
  breakAtTick?: number;
  /** When set, spawn red side instead of the punching-bag bin. */
  redSide?: LabSideConfig;
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
  squadId: number;
  squadLeaderId: number;
  isLeader: boolean;
  morale: number;
  broken: boolean;
  /** Behavior state — 0=march, 1=engage, 2=rout, 3=kite, 4=flank, 5=rally. */
  behavior: number;
  /** True if this rac is currently pinned by a tank (slowed). */
  pinned: boolean;
  /** This rac's squad's flank/rear threat: 0=none, 1=flank, 2=rear. */
  squadThreat: number;
  /** Standing-order index — 0=hold, 1=slow, 2=advance, 3=charge, 4=skirmish. */
  standingOrder: number;
  /** Per-rac flank debug data (FLANK_DEBUG_FLOATS_PER_RAC floats).
   *  Slot 0 (inFlank) is 1 only when this rac was in BEHAVIOR_FLANK
   *  this tick. The lab reads probe XY pairs + aim point + grad +
   *  perp from this. */
  flankDebug: Float32Array;
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
    maxPlatoonSize: cfg.maxPlatoonSize,
    platoonStride: cfg.platoonStride,
    redSide: cfg.redSide,
  };
  const state = setupShapeBattle(content, battleCfg);
  // Flank-search debug capture (per-rac probe points + aim + grad).
  const flankDbg = new Float32Array(MAX_RACS * FLANK_DEBUG_FLOATS_PER_RAC);
  state._debugFlank = flankDbg;

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
  frames.push(snapshotFrame(state, flankDbg));

  const breakAtTick = cfg.breakAtTick && cfg.breakAtTick > 0 ? cfg.breakAtTick : null;
  for (let t = 0; t < cfg.ticks; t++) {
    state.tick = t + 1;
    tick(state, content, log);
    // Lab-only forced break: at the configured tick, crash every alive
    // rac's morale to 0 so the formation falls apart and the broken-rac
    // boid path engages immediately. Use it to validate the discipline
    // → boids transition without waiting for combat damage.
    if (breakAtTick !== null && state.tick === breakAtTick) {
      for (let i = 0; i < state.rac.count; i++) {
        if (state.rac.alive[i]) state.rac.morale[i] = 0;
      }
    }
    frames.push(snapshotFrame(state, flankDbg));
    if (state.winner !== -1) break;
  }
  return { frames, bounds: cfg.bounds };
}

function snapshotFrame(
  state: ReturnType<typeof setupShapeBattle>,
  flankDbg: Float32Array,
): LabFrame {
  const racs: RacFrame[] = [];
  for (let i = 0; i < state.rac.count; i++) {
    const fl = new Float32Array(FLANK_DEBUG_FLOATS_PER_RAC);
    fl.set(flankDbg.subarray(i * FLANK_DEBUG_FLOATS_PER_RAC, (i + 1) * FLANK_DEBUG_FLOATS_PER_RAC));
    const racId = state.rac.id[i];
    const leaderId = state.rac.squadLeaderId[i];
    racs.push({
      id: racId,
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
      squadId: state.rac.squadId[i],
      squadLeaderId: leaderId,
      isLeader: leaderId === racId || leaderId < 0,
      morale: state.rac.morale[i],
      broken:
        state.rac.morale[i] <
        (MORALE_BREAK_THRESHOLD_BY_ENV[state.rac.env[i]] ?? MORALE_BREAK_THRESHOLD),
      behavior: state.rac.behavior[i],
      pinned: state.rac.pinnedUntilTick[i] > state.tick,
      squadThreat: state.squadFlankThreat?.get(state.rac.squadId[i]) ?? 0,
      standingOrder: state.rac.standingOrder[i],
      flankDebug: fl,
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
