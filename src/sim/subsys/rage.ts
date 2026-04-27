/**
 * Rage subsystem.
 *
 * Two passes per tick:
 *   1. Infantry adjacency: +rage per second when ≥ 1 ally is within
 *      ADJACENT_RANGE meters.
 *   2. Auto-fire: any raccoon whose meter is ≥ capacity unleashes its
 *      bespoke rage attack (read from its UnitDef.rage.attack), then
 *      the meter resets to zero.
 *
 * Rage attack shapes (target collection geometry):
 *   - single-target / leap        — closest enemy in radius
 *   - cone / cleave               — enemies in 60° arc in front of caster
 *   - line / piercing-line / dash — enemies along caster's facing line,
 *                                   within `radius` ahead, max 0.6m
 *                                   off-axis (the "line width")
 *   - aura                        — no enemy targets (ally buff only).
 *                                   v0a doesn't yet apply ally buffs;
 *                                   the rage_fire event still emits.
 *   - thorns                      — self-only buff (no targets).
 *   - default (pulse / aoe-circle / knockback / arc)
 *                                 — all enemies in radius (AOE-circle)
 *
 * Statuses listed in `attack.apply` get applied to every hit raccoon.
 * Bins don't accept statuses in v0a.
 */

import type { ContentBundle, RageAttackDef } from "../content.js";
import { ROLE_INFANTRY } from "../content.js";
import { forEachNear } from "../grid.js";
import type { Logger } from "../log.js";
import { SECONDS_PER_TICK, type BattleState } from "../state.js";
import { applyBinDamage, applyRacDamage, gainRage } from "./combat.js";
import { applyStatusToRac } from "./status.js";

/** Cone half-angle (60° total = 30° each side). */
const CONE_HALF_ANGLE = Math.PI / 6;
/** Line-attack max perpendicular distance from facing axis. */
const LINE_HALF_WIDTH = 0.6;

export function rageTick(state: BattleState, content: ContentBundle, log: Logger): void {
  const dt = SECONDS_PER_TICK;
  const n = state.rac.count;

  // Infantry adjacency rage. Per-side profile sets the rate + radius.
  // Plain inner loop with early-out is faster than grid here: adj
  // range is tiny (1.5m), neighbors are clumped, the first hit usually
  // wins after a few iterations. Closure overhead of forEachNear lost
  // the race in profiling.
  for (let i = 0; i < n; i++) {
    if (!state.rac.alive[i]) continue;
    if (state.rac.role[i] !== ROLE_INFANTRY) continue;
    const profile = state.tacticPerSide[state.rac.owner[i]][state.rac.role[i]];
    if (profile.infantryRagePerSec <= 0) continue;
    const adj = profile.adjacentRange;
    const adj2 = adj * adj;
    const myX = state.rac.x[i];
    const myY = state.rac.y[i];
    const myOwner = state.rac.owner[i];
    let adjacent = false;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (!state.rac.alive[j]) continue;
      if (state.rac.owner[j] !== myOwner) continue;
      const dx = state.rac.x[j] - myX;
      const dy = state.rac.y[j] - myY;
      if (dx * dx + dy * dy <= adj2) {
        adjacent = true;
        break;
      }
    }
    if (adjacent) gainRage(state, i, profile.infantryRagePerSec * dt);
  }

  // Auto-fire.
  for (let i = 0; i < n; i++) {
    if (!state.rac.alive[i]) continue;
    if (state.rac.rage[i] < state.rac.rageCap[i]) continue;
    fireRage(state, content, log, i);
    state.rac.rage[i] = 0;
  }
}

/** Returns indices of enemy raccoons + enemy bins selected by the
 *  shape's geometry. */
function collectShapeTargets(
  state: BattleState,
  srcRow: number,
  ra: RageAttackDef,
): { racRows: number[]; binRows: number[] } {
  const myX = state.rac.x[srcRow];
  const myY = state.rac.y[srcRow];
  const myOwner = state.rac.owner[srcRow];
  const facing = state.rac.facing[srcRow];
  const radius = ra.range;
  const r2 = radius * radius;
  const shape = ra.shape;

  // Aura / thorns: no enemy targets.
  if (shape === "aura" || shape === "thorns") {
    return { racRows: [], binRows: [] };
  }

  // Single-target / leap: pick the single nearest enemy entity in
  // radius, prefer rac over bin.
  if (shape === "single-target" || shape === "leap") {
    let bestRacRow = -1;
    let bestRacD2 = Infinity;
    for (let j = 0; j < state.rac.count; j++) {
      if (!state.rac.alive[j]) continue;
      if (state.rac.owner[j] === myOwner) continue;
      const dx = state.rac.x[j] - myX;
      const dy = state.rac.y[j] - myY;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2 && d2 < bestRacD2) {
        bestRacD2 = d2;
        bestRacRow = j;
      }
    }
    if (bestRacRow >= 0) return { racRows: [bestRacRow], binRows: [] };
    let bestBinRow = -1;
    let bestBinD2 = Infinity;
    for (let k = 0; k < state.bin.count; k++) {
      if (!state.bin.alive[k]) continue;
      if (state.bin.owner[k] === myOwner) continue;
      const dx = state.bin.x[k] - myX;
      const dy = state.bin.y[k] - myY;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2 && d2 < bestBinD2) {
        bestBinD2 = d2;
        bestBinRow = k;
      }
    }
    return { racRows: [], binRows: bestBinRow >= 0 ? [bestBinRow] : [] };
  }

  // Cone / cleave: 60° arc in front, within radius.
  if (shape === "cone" || shape === "cleave") {
    const fx = Math.cos(facing);
    const fy = Math.sin(facing);
    const racRows: number[] = [];
    const binRows: number[] = [];
    for (let j = 0; j < state.rac.count; j++) {
      if (!state.rac.alive[j]) continue;
      if (state.rac.owner[j] === myOwner) continue;
      const dx = state.rac.x[j] - myX;
      const dy = state.rac.y[j] - myY;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2 || d2 < 1e-10) continue;
      const d = Math.sqrt(d2);
      const dot = (dx * fx + dy * fy) / d;
      if (dot >= Math.cos(CONE_HALF_ANGLE)) racRows.push(j);
    }
    for (let k = 0; k < state.bin.count; k++) {
      if (!state.bin.alive[k]) continue;
      if (state.bin.owner[k] === myOwner) continue;
      const dx = state.bin.x[k] - myX;
      const dy = state.bin.y[k] - myY;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2 || d2 < 1e-10) continue;
      const d = Math.sqrt(d2);
      const dot = (dx * fx + dy * fy) / d;
      if (dot >= Math.cos(CONE_HALF_ANGLE)) binRows.push(k);
    }
    return { racRows, binRows };
  }

  // Line / piercing-line / dash: in front, perpendicular distance ≤
  // LINE_HALF_WIDTH, signed forward distance in [0, radius].
  if (shape === "line" || shape === "piercing-line" || shape === "dash") {
    const fx = Math.cos(facing);
    const fy = Math.sin(facing);
    const racRows: number[] = [];
    const binRows: number[] = [];
    const inLine = (dx: number, dy: number): boolean => {
      const along = dx * fx + dy * fy; // signed forward
      if (along <= 0 || along > radius) return false;
      // perpendicular distance from line
      const px = dx - along * fx;
      const py = dy - along * fy;
      return px * px + py * py <= LINE_HALF_WIDTH * LINE_HALF_WIDTH;
    };
    for (let j = 0; j < state.rac.count; j++) {
      if (!state.rac.alive[j]) continue;
      if (state.rac.owner[j] === myOwner) continue;
      if (inLine(state.rac.x[j] - myX, state.rac.y[j] - myY)) racRows.push(j);
    }
    for (let k = 0; k < state.bin.count; k++) {
      if (!state.bin.alive[k]) continue;
      if (state.bin.owner[k] === myOwner) continue;
      if (inLine(state.bin.x[k] - myX, state.bin.y[k] - myY)) binRows.push(k);
    }
    return { racRows, binRows };
  }

  // Default: AOE-circle (pulse / aoe-circle / knockback / arc / spawn-obstacle / ...).
  const racRows: number[] = [];
  const binRows: number[] = [];
  for (let j = 0; j < state.rac.count; j++) {
    if (!state.rac.alive[j]) continue;
    if (state.rac.owner[j] === myOwner) continue;
    const dx = state.rac.x[j] - myX;
    const dy = state.rac.y[j] - myY;
    if (dx * dx + dy * dy <= r2) racRows.push(j);
  }
  for (let k = 0; k < state.bin.count; k++) {
    if (!state.bin.alive[k]) continue;
    if (state.bin.owner[k] === myOwner) continue;
    const dx = state.bin.x[k] - myX;
    const dy = state.bin.y[k] - myY;
    if (dx * dx + dy * dy <= r2) binRows.push(k);
  }
  return { racRows, binRows };
}

function fireRage(
  state: BattleState,
  content: ContentBundle,
  log: Logger,
  srcRow: number,
): void {
  const unit = content.units.get(state.unitIdTable[state.rac.unitIdIdx[srcRow]]);
  if (!unit) return;
  const ra = unit.rage.attack;
  const { racRows, binRows } = collectShapeTargets(state, srcRow, ra);

  log.emit("rage_fire", {
    rac_id: state.rac.id[srcRow],
    owner: state.rac.owner[srcRow],
    unit_id: unit.id,
    role: unit.role,
    env: unit.environment,
    cur: unit.curiosity,
    shape: ra.shape,
    damage: ra.damage,
    radius: ra.range,
    targets_rac: racRows.map((r) => state.rac.id[r]),
    targets_bin: binRows.map((r) => state.bin.id[r]),
    applies: ra.apply ?? [],
  });

  // No-damage shapes (aura, thorns) emit only the rage_fire event.
  if (ra.shape === "aura" || ra.shape === "thorns") return;

  for (const tRow of racRows) {
    applyRacDamage(state, content, log, srcRow, tRow, ra.damage, unit, "rage");
    if (state.rac.alive[tRow] && ra.apply) {
      for (const sid of ra.apply) {
        applyStatusToRac(state, content, log, tRow, sid, state.rac.id[srcRow]);
      }
    }
  }
  for (const bRow of binRows) {
    applyBinDamage(state, content, log, srcRow, bRow, ra.damage);
  }
}
