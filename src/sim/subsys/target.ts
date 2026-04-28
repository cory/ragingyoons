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

export function targetTick(state: BattleState, content: ContentBundle, log: Logger): void {
  void content;
  // Use the most aggressive (lowest) rethink cadence across all
  // profiles; per-rac gating happens inline below via tick % cadence.
  const minCadence = Math.min(
    ...state.tacticPerSide.flat().map((p) => p.targetRethinkTicks),
  );
  if (state.tick % minCadence !== 0) return;

  const n = state.rac.count;
  const m = state.bin.count;

  // Pre-compute attacker counts so the inner scoring loop can apply
  // a saturation penalty (TARGET_SATURATION_K). One pass; reused for
  // every retargeting rac in this tick.
  const attackerCount = new Map<number, number>();
  for (let j = 0; j < n; j++) {
    if (!state.rac.alive[j]) continue;
    if (state.rac.targetKind[j] !== TARGET_KIND_RAC) continue;
    const tid = state.rac.targetId[j];
    if (tid < 0) continue;
    attackerCount.set(tid, (attackerCount.get(tid) ?? 0) + 1);
  }
  state.attackerCount = attackerCount;

  // Pre-compute the set of enemy rac ROWS that are within
  // BIN_DEFENSE_RADIUS of any friendly bin. Per side. Lifts the
  // O(rac × target × bin) check out of the inner scoring loop —
  // we now look up each candidate target's row in a Set, O(1).
  const defenseSetBySide: [Set<number>, Set<number>] = [new Set(), new Set()];
  const defR2 = BIN_DEFENSE_RADIUS * BIN_DEFENSE_RADIUS;
  for (let k = 0; k < m; k++) {
    if (!state.bin.alive[k]) continue;
    const owner = state.bin.owner[k];
    const enemyOf = (1 - owner) as 0 | 1;
    const bx = state.bin.x[k];
    const by = state.bin.y[k];
    const set = defenseSetBySide[owner];
    if (state._racGrid) {
      forEachNear(state._racGrid, bx, by, BIN_DEFENSE_RADIUS, (r) => {
        if (!state.rac.alive[r]) return;
        if (state.rac.owner[r] !== enemyOf) return;
        const dx = state.rac.x[r] - bx;
        const dy = state.rac.y[r] - by;
        if (dx * dx + dy * dy < defR2) set.add(r);
      });
    } else {
      for (let r = 0; r < n; r++) {
        if (!state.rac.alive[r]) continue;
        if (state.rac.owner[r] !== enemyOf) continue;
        const dx = state.rac.x[r] - bx;
        const dy = state.rac.y[r] - by;
        if (dx * dx + dy * dy < defR2) set.add(r);
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
    if (state.tick % cadence !== 0) continue;

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
    if (curKind === TARGET_KIND_RAC && curId >= 0) {
      const curRow = state.racRowById.get(curId);
      if (curRow !== undefined && state.rac.alive[curRow]) {
        if (state.rac.owner[curRow] !== myOwner) {
          const dx = state.rac.x[curRow] - myX;
          const dy = state.rac.y[curRow] - myY;
          if (dx * dx + dy * dy <= STICKY_RADIUS_RAC * STICKY_RADIUS_RAC) continue;
        }
      }
    } else if (curKind === TARGET_KIND_BIN && curId >= 0 && isLockpicker) {
      const curRow = state.binRowById.get(curId);
      if (curRow !== undefined && state.bin.alive[curRow]) {
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
    const myCurTargetId = curKind === TARGET_KIND_RAC ? curId : -1;
    const myDefenseSet = defenseSetBySide[myOwner];
    const scoreOne = (j: number) => {
      if (j === i) return;
      if (!state.rac.alive[j]) return;
      if (state.rac.owner[j] === myOwner) return;
      const dx = state.rac.x[j] - myX;
      const dy = state.rac.y[j] - myY;
      const d2 = dx * dx + dy * dy;
      if (d2 < 1) return;
      const tgtRole = state.rac.role[j];
      const affinity = affRow[tgtRole];
      const hpFrac = state.rac.hpMax[j] > 0 ? state.rac.hp[j] / state.rac.hpMax[j] : 1;
      const lowHpBoost = 1 + LOW_HP_BONUS * (1 - Math.max(0, Math.min(1, hpFrac)));
      const id = state.rac.id[j];
      const tgtDps = state.rac.effDamage[j] * state.rac.effAttackRate[j];
      const dpsBoost = 1 + DPS_BONUS * Math.min(1, tgtDps / DPS_NORM_MAX);
      const inRange = d2 <= myEffRange2;
      let saturationPenalty = 1;
      if (!inRange) {
        let attackers = attackerCount.get(id) ?? 0;
        if (id === myCurTargetId && attackers > 0) attackers -= 1;
        saturationPenalty = 1 / (1 + TARGET_SATURATION_K * attackers);
      }
      const defenseMul = myDefenseSet.has(j) ? BIN_DEFENSE_MUL : 1;
      const score =
        (affinity * lowHpBoost * dpsBoost * saturationPenalty * defenseMul) / d2;
      if (score > bestRacScore || (score === bestRacScore && id < bestRacId)) {
        bestRacScore = score;
        bestRacId = id;
        bestRacD2 = d2;
      }
    };
    if (state._racGrid) {
      forEachNear(state._racGrid, myX, myY, MAX_TARGET_RADIUS, scoreOne);
    } else {
      for (let j = 0; j < n; j++) scoreOne(j);
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
