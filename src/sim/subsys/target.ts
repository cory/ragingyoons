/**
 * Targeting subsystem.
 *
 * Every TARGET_RETHINK_TICKS ticks, each alive raccoon picks a target.
 * v0a priority:
 *   1. Nearest enemy raccoon, if any are alive.
 *   2. Otherwise nearest enemy bin.
 * Ties broken by lower id (determinism).
 *
 * Logs `rac_target` only when the chosen target actually changes,
 * including when it changes kind (rac → bin or vice versa).
 */

import { CUR_LOCKPICKERS, type ContentBundle } from "../content.js";
import { forEachNear } from "../grid.js";
import type { Logger } from "../log.js";
import {
  MAX_RACS,
  TARGET_KIND_BIN,
  TARGET_KIND_NONE,
  TARGET_KIND_RAC,
  type BattleState,
} from "../state.js";

/** Default cadence; overridable per (side, role) via tactic profile.
 *  We use the tank profile's value as the global tick gate (cheap and
 *  consistent — per-rac cadence would force per-rac timestamp
 *  bookkeeping for marginal benefit). */
export const TARGET_RETHINK_TICKS = 4;

/** Role-affinity matrix: ROLE_AFFINITY[attackerRole][targetRole] is a
 *  preference multiplier on the (1/d²) scoring. Values >1 mean
 *  "prefer this matchup," <1 means "deprioritize." Indexed by
 *  ROLE_TO_IDX (tank=0, archer=1, cavalry=2, infantry=3).
 *
 *  Design read:
 *   - Tank prefers attacking infantry (1.2) and tanks (1.0); cavalry
 *     less because they outpace tanks.
 *   - Archer counter-snipes other archers (1.5), then squishy infantry
 *     (1.2). Doesn't prioritize tanks (low: 0.7).
 *   - Cavalry hunts archers (1.5) and infantry (1.4) — squishy
 *     targets. Tanks deprioritized (0.5) because cavalry isn't built
 *     to grind through armor.
 *   - Infantry frontline-matches tanks (1.2) and other infantry (1.0).
 */
export const ROLE_AFFINITY: number[][] = [
  // attacker:  tank  archer  cav   inf
  /* tank */   [1.0,  1.0,    0.7,  1.2],
  /* archer */ [0.7,  1.5,    1.0,  1.2],
  /* cav */    [0.5,  1.5,    0.8,  1.4],
  /* inf */    [1.2,  1.0,    0.8,  1.0],
];

/** Bonus weight on (1/d²) for low-HP targets — encourages finishing
 *  wounded enemies. score *= (1 + LOW_HP_BONUS × (1 − hpFrac)). */
const LOW_HP_BONUS = 0.5;
/** Target-spread saturation. score /= (1 + this × current_attackers).
 *  Encourages racs to spread across enemies for OUT-OF-RANGE targets
 *  (so the squad doesn't redundantly march on the same enemy while
 *  the next one stands untouched). For IN-RANGE targets the penalty
 *  is skipped — once a unit is within attack range we WANT every
 *  free shooter to dump on it before it can hurt anyone (see
 *  `concentrateInRange` block). */
const TARGET_SATURATION_K = 0.3;
/** DPS scoring weight. Multiplies score by (1 + this × normalizedDPS)
 *  where DPS = effDamage × effAttackRate. Scales the score — a
 *  high-damage enemy is "more important to kill first" than a low-
 *  damage one of the same range. Without normalization the units
 *  vary wildly across the cards (5 dps to 50 dps), so we rough-
 *  normalize to a 0–1 range using DPS_NORM_MAX. */
const DPS_BONUS = 1.0;
const DPS_NORM_MAX = 50;
/** Bin-defense bonus: an enemy within this radius of any FRIENDLY
 *  bin scores as if it were 4× closer (score × DEFENSE_MUL). Lets
 *  cavalry / infantry turn back to defend rather than chase a
 *  distant target while the bin is dying. */
const BIN_DEFENSE_RADIUS = 20;
const BIN_DEFENSE_MUL = 4;
/** Max distance considered when scoring enemy targets. Past this we
 *  drop the target from the search — its score (1/d²) is too low to
 *  beat any closer enemy anyway, and limiting the scan to a spatial-
 *  grid neighborhood is the big perf win on this subsystem. Big
 *  enough to cover the full lab field (120×80) end-to-end. */
const MAX_TARGET_RADIUS = 80;
/** Forward search cone (radians). Targeting first scans only enemies
 *  whose direction from the rac is within this half-angle of the
 *  rac's facing — racs don't need to scope out enemies behind them.
 *  At π/3 (60° half-angle = 120° cone), forward arc covers ~33% of
 *  the disc, so candidate count drops by ~3× in steady combat. If
 *  the cone scan finds nothing the rac falls back to a full-circle
 *  scan ("look around if no targets") so isolated racs can find
 *  enemies regardless of facing. */
const FORWARD_CONE_HALF_ANGLE = Math.PI / 3;
const FORWARD_CONE_COS = Math.cos(FORWARD_CONE_HALF_ANGLE);

export function targetTick(state: BattleState, content: ContentBundle, log: Logger): void {
  void content;
  // Use the most aggressive (lowest) rethink cadence across all
  // profiles; per-rac gating happens inline below via tick % cadence.
  const minCadence = Math.min(
    ...state.tacticPerSide.flat().map((p) => p.targetRethinkTicks),
  );
  // First-call seeding: every rac runs its scoring loop on the very
  // first targetTick so newly-spawned racs pick a target before their
  // first motionTick. Without this, infantry (cadence 20) would have
  // no target until tick 20 and squads spend ~1 second standing still
  // at round start.
  //
  // We use a one-shot flag instead of `state.tick === 1` because
  // state.tick varies by caller — runBattle/bench-shape set it
  // manually AND tick() increments, so subsystems see state.tick=2
  // on their first invocation, not 1. The flag fires reliably on
  // the literal first call regardless of starting tick.
  const isFirstTick = !state._targetTickRanOnce;
  state._targetTickRanOnce = true;
  if (!isFirstTick && state.tick % minCadence !== 0) return;

  const n = state.rac.count;
  const m = state.bin.count;

  // Pre-compute attacker counts so the inner scoring loop can apply
  // a saturation penalty (TARGET_SATURATION_K). Indexed by ROW (not
  // id) so the inner scoring loop reads with `arr[j]` instead of a
  // Map.get hash. One pass; reused for every retargeting rac in
  // this tick.
  if (!state._attackerCountByRow) {
    state._attackerCountByRow = new Int32Array(MAX_RACS);
  }
  const attackerCountByRow = state._attackerCountByRow;
  attackerCountByRow.fill(0);
  for (let j = 0; j < n; j++) {
    if (!state.rac.alive[j]) continue;
    if (state.rac.targetKind[j] !== TARGET_KIND_RAC) continue;
    const tid = state.rac.targetId[j];
    if (tid < 0 || tid >= state.racRowById.length) continue;
    const tRow = state.racRowById[tid];
    if (tRow >= 0) attackerCountByRow[tRow]++;
  }

  // Pre-compute, per side, a 0/1 flag per rac row indicating whether
  // that rac is within BIN_DEFENSE_RADIUS of any bin owned by `side`.
  // Inner scoring then reads `defenseFlag[side*MAX_RACS + j]` — O(1)
  // memory access, no Set hashing per (rac × target) pair.
  if (!state._defenseFlag) {
    state._defenseFlag = new Uint8Array(2 * MAX_RACS);
  }
  const defenseFlag = state._defenseFlag;
  defenseFlag.fill(0);
  const defR2 = BIN_DEFENSE_RADIUS * BIN_DEFENSE_RADIUS;
  for (let k = 0; k < m; k++) {
    if (!state.bin.alive[k]) continue;
    const owner = state.bin.owner[k];
    const enemyOf = (1 - owner) as 0 | 1;
    const bx = state.bin.x[k];
    const by = state.bin.y[k];
    const base = owner * MAX_RACS;
    if (state._racGrid) {
      forEachNear(state._racGrid, bx, by, BIN_DEFENSE_RADIUS, (r) => {
        if (!state.rac.alive[r]) return;
        if (state.rac.owner[r] !== enemyOf) return;
        const dx = state.rac.x[r] - bx;
        const dy = state.rac.y[r] - by;
        if (dx * dx + dy * dy < defR2) defenseFlag[base + r] = 1;
      });
    } else {
      for (let r = 0; r < n; r++) {
        if (!state.rac.alive[r]) continue;
        if (state.rac.owner[r] !== enemyOf) continue;
        const dx = state.rac.x[r] - bx;
        const dy = state.rac.y[r] - by;
        if (dx * dx + dy * dy < defR2) defenseFlag[base + r] = 1;
      }
    }
  }
  // Iterate via the per-tick shuffled permutation so retarget order
  // doesn't systematically favor lower-row (= side-0) racs.
  const order = state._tickIterOrder;
  for (let oi = 0; oi < n; oi++) {
    const i = order ? order[oi] : oi;
    if (!state.rac.alive[i]) continue;
    const myOwner = state.rac.owner[i];
    const myX = state.rac.x[i];
    const myY = state.rac.y[i];
    const isLockpicker = state.rac.cur[i] === CUR_LOCKPICKERS;
    // Per-rac cadence gate (different roles can rethink at different
    // rates). The outer mod ensures we even get here.
    const cadence = state.tacticPerSide[myOwner][state.rac.role[i]].targetRethinkTicks;
    if (!isFirstTick && state.tick % cadence !== 0) continue;

    // Sticky targets: if the current target is still alive and within
    // STICKY_RADIUS, keep it. Skips the scan in the common case.
    //
    // Bin-target stickiness is gated by role:
    //   - Lockpickers prefer bins always; sticky on bin is correct.
    //   - Non-Lockpickers prefer racs over bins (cavalry/inf/archer/
    //     tank). They should NEVER stick on a bin target while enemy
    //     racs may be alive — otherwise during cleanup we lock onto
    //     a bin and ignore the next wave's raccoons. So for non-LP we
    //     only stick on rac targets, forcing a scan every cadence
    //     when current target is a bin.
    const STICKY_RADIUS_RAC = 25; // m
    const STICKY_RADIUS_BIN = 60;
    const curKind = state.rac.targetKind[i];
    const curId = state.rac.targetId[i];
    if (curKind === TARGET_KIND_RAC && curId >= 0 && curId < state.racRowById.length) {
      const curRow = state.racRowById[curId];
      if (curRow >= 0 && state.rac.alive[curRow]) {
        if (state.rac.owner[curRow] !== myOwner) {
          const dx = state.rac.x[curRow] - myX;
          const dy = state.rac.y[curRow] - myY;
          if (dx * dx + dy * dy <= STICKY_RADIUS_RAC * STICKY_RADIUS_RAC) continue;
        }
      }
    } else if (
      curKind === TARGET_KIND_BIN &&
      curId >= 0 &&
      curId < state.binRowById.length &&
      isLockpicker
    ) {
      const curRow = state.binRowById[curId];
      if (curRow >= 0 && state.bin.alive[curRow]) {
        const dx = state.bin.x[curRow] - myX;
        const dy = state.bin.y[curRow] - myY;
        if (dx * dx + dy * dy <= STICKY_RADIUS_BIN * STICKY_RADIUS_BIN) continue;
      }
    }

    // Find best enemy raccoon by SCORE. Score factors:
    //  - 1/d² (closer = better)
    //  - role affinity (counter-picks)
    //  - low-HP finishing bonus
    //  - DPS bonus (high-damage enemies prioritized)
    //  - in-range concentrate (no saturation penalty when the target
    //    is already in our attack range — pile on)
    //  - out-of-range spread (saturation penalty so the squad doesn't
    //    redundantly march on the same enemy)
    //  - bin defense (enemy near any of OUR bins scores ×4)
    const myRole = state.rac.role[i];
    const myEffRange = state.rac.effRange[i];
    const myEffRange2 = myEffRange * myEffRange;
    const affRow = ROLE_AFFINITY[myRole];
    let bestRacId = -1;
    let bestRacScore = -Infinity;
    let bestRacD2 = Infinity;
    const myCurTargetRow =
      curKind === TARGET_KIND_RAC && curId >= 0 && curId < state.racRowById.length
        ? state.racRowById[curId]
        : -1;
    const defenseBase = myOwner * MAX_RACS;
    // Inline cell walk (was forEachNear with a scoreOne closure). The
    // closure-per-call overhead and capture of a dozen locals per
    // inner iteration was measurable in profiling. Hot fields are
    // hoisted to locals so the JIT can keep them in registers.
    const grid = state._racGrid;
    const racX = state.rac.x;
    const racY = state.rac.y;
    const racAlive = state.rac.alive;
    const racOwner = state.rac.owner;
    const racRole = state.rac.role;
    const racHp = state.rac.hp;
    const racHpMax = state.rac.hpMax;
    const racEffDamage = state.rac.effDamage;
    const racEffAttackRate = state.rac.effAttackRate;
    const racIdArr = state.rac.id;
    // Forward 120° cone scan first; if nothing found, fall back to a
    // full-circle scan ("look around if no targets"). Most racs face
    // their fight, so the cone path is the steady-state hot path —
    // ~3× fewer candidates scored vs full-circle.
    const myFacing = state.rac.facing[i];
    const fwdX = Math.cos(myFacing);
    const fwdY = Math.sin(myFacing);
    let coneFwdX = fwdX;
    let coneFwdY = fwdY;
    let coneCosThr = FORWARD_CONE_COS;
    for (let pass = 0; pass < 2; pass++) {
      if (grid) {
        const cellSize = grid.cellSize;
        const cols = grid.cols;
        const rows = grid.rows;
        const halfWg = grid.halfW;
        const halfHg = grid.halfH;
        const cellsAcross = Math.ceil(MAX_TARGET_RADIUS / cellSize);
        const baseCx = Math.floor((myX + halfWg) / cellSize);
        const baseCy = Math.floor((myY + halfHg) / cellSize);
        const minCx = Math.max(0, baseCx - cellsAcross);
        const maxCx = Math.min(cols - 1, baseCx + cellsAcross);
        const minCy = Math.max(0, baseCy - cellsAcross);
        const maxCy = Math.min(rows - 1, baseCy + cellsAcross);
        const cellStart = grid.cellStart;
        const entries = grid.entries;
        for (let cy = minCy; cy <= maxCy; cy++) {
          for (let cx = minCx; cx <= maxCx; cx++) {
            const c = cy * cols + cx;
            const start = cellStart[c];
            const end = cellStart[c + 1];
            for (let k = start; k < end; k++) {
              const j = entries[k];
              if (j === i) continue;
              if (!racAlive[j]) continue;
              if (racOwner[j] === myOwner) continue;
              const dx = racX[j] - myX;
              const dy = racY[j] - myY;
              const d2 = dx * dx + dy * dy;
              if (d2 < 1) continue;
              // Forward-cone gate (cosA ≥ threshold). Skip when
              // threshold ≤ -1 (full-circle fallback).
              if (coneCosThr > -1 && (dx * coneFwdX + dy * coneFwdY) < coneCosThr * Math.sqrt(d2)) {
                continue;
              }
              const tgtRole = racRole[j];
              const affinity = affRow[tgtRole];
              const hpMaxJ = racHpMax[j];
              const hpFrac = hpMaxJ > 0 ? racHp[j] / hpMaxJ : 1;
              const lowHpBoost =
                1 + LOW_HP_BONUS * (1 - (hpFrac < 0 ? 0 : hpFrac > 1 ? 1 : hpFrac));
              const id = racIdArr[j];
              const tgtDps = racEffDamage[j] * racEffAttackRate[j];
              const dpsNorm = tgtDps / DPS_NORM_MAX;
              const dpsBoost = 1 + DPS_BONUS * (dpsNorm > 1 ? 1 : dpsNorm);
              let saturationPenalty = 1;
              if (d2 > myEffRange2) {
                let attackers = attackerCountByRow[j];
                if (j === myCurTargetRow && attackers > 0) attackers -= 1;
                saturationPenalty = 1 / (1 + TARGET_SATURATION_K * attackers);
              }
              const defenseMul = defenseFlag[defenseBase + j] ? BIN_DEFENSE_MUL : 1;
              const score =
                (affinity * lowHpBoost * dpsBoost * saturationPenalty * defenseMul) / d2;
              if (score > bestRacScore || (score === bestRacScore && id < bestRacId)) {
                bestRacScore = score;
                bestRacId = id;
                bestRacD2 = d2;
              }
            }
          }
        }
      } else {
        // Test/no-grid path — scan everything. Same body as above.
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          if (!racAlive[j]) continue;
          if (racOwner[j] === myOwner) continue;
          const dx = racX[j] - myX;
          const dy = racY[j] - myY;
          const d2 = dx * dx + dy * dy;
          if (d2 < 1) continue;
          if (coneCosThr > -1 && (dx * coneFwdX + dy * coneFwdY) < coneCosThr * Math.sqrt(d2)) {
            continue;
          }
          const tgtRole = racRole[j];
          const affinity = affRow[tgtRole];
          const hpMaxJ = racHpMax[j];
          const hpFrac = hpMaxJ > 0 ? racHp[j] / hpMaxJ : 1;
          const lowHpBoost =
            1 + LOW_HP_BONUS * (1 - (hpFrac < 0 ? 0 : hpFrac > 1 ? 1 : hpFrac));
          const id = racIdArr[j];
          const tgtDps = racEffDamage[j] * racEffAttackRate[j];
          const dpsNorm = tgtDps / DPS_NORM_MAX;
          const dpsBoost = 1 + DPS_BONUS * (dpsNorm > 1 ? 1 : dpsNorm);
          let saturationPenalty = 1;
          if (d2 > myEffRange2) {
            let attackers = attackerCountByRow[j];
            if (j === myCurTargetRow && attackers > 0) attackers -= 1;
            saturationPenalty = 1 / (1 + TARGET_SATURATION_K * attackers);
          }
          const defenseMul = defenseFlag[defenseBase + j] ? BIN_DEFENSE_MUL : 1;
          const score =
            (affinity * lowHpBoost * dpsBoost * saturationPenalty * defenseMul) / d2;
          if (score > bestRacScore || (score === bestRacScore && id < bestRacId)) {
            bestRacScore = score;
            bestRacId = id;
            bestRacD2 = d2;
          }
        }
      }
      if (bestRacId >= 0) break; // cone-pass found a target; skip fallback.
      // Fallback: open the cone for the second pass.
      coneCosThr = -2;
      void coneFwdX;
      void coneFwdY;
    }

    // Find nearest enemy bin
    let bestBinId = -1;
    let bestBinD2 = Infinity;
    for (let k = 0; k < m; k++) {
      if (!state.bin.alive[k]) continue;
      if (state.bin.owner[k] === myOwner) continue;
      const dx = state.bin.x[k] - myX;
      const dy = state.bin.y[k] - myY;
      const d2 = dx * dx + dy * dy;
      const id = state.bin.id[k];
      if (d2 < bestBinD2 || (d2 === bestBinD2 && id < bestBinId)) {
        bestBinD2 = d2;
        bestBinId = id;
      }
    }

    let newKind = TARGET_KIND_NONE;
    let newId = -1;
    let newDist = -1;

    // Priority logic:
    //   - Lockpickers: prefer bins always; fall back to rac if no bins
    //     remain on enemy side. (Eventually gated by 2-Lockpicker
    //     synergy threshold; for v0a it's unconditional.)
    //   - Everyone else: prefer rac; fall back to bin when no enemy
    //     racs are alive (cleanup phase).
    if (isLockpicker) {
      if (bestBinId >= 0) {
        newKind = TARGET_KIND_BIN;
        newId = bestBinId;
        newDist = Math.sqrt(bestBinD2);
      } else if (bestRacId >= 0) {
        newKind = TARGET_KIND_RAC;
        newId = bestRacId;
        newDist = Math.sqrt(bestRacD2);
      }
    } else {
      if (bestRacId >= 0) {
        newKind = TARGET_KIND_RAC;
        newId = bestRacId;
        newDist = Math.sqrt(bestRacD2);
      } else if (bestBinId >= 0) {
        newKind = TARGET_KIND_BIN;
        newId = bestBinId;
        newDist = Math.sqrt(bestBinD2);
      }
    }

    const prevKind = state.rac.targetKind[i];
    const prevId = state.rac.targetId[i];
    if (prevKind === newKind && prevId === newId) continue;
    state.rac.targetKind[i] = newKind;
    state.rac.targetId[i] = newId;

    log.emit("rac_target", {
      rac_id: state.rac.id[i],
      owner: myOwner,
      prev_target: prevId,
      prev_kind: kindLabel(prevKind),
      new_target: newId,
      new_kind: kindLabel(newKind),
      distance: newDist,
    });
  }
}

function kindLabel(k: number): string {
  if (k === TARGET_KIND_RAC) return "rac";
  if (k === TARGET_KIND_BIN) return "bin";
  return "none";
}
