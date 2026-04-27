/**
 * Combat — attack + instant-hit damage. Handles both raccoon and bin
 * targets via the `targetKind` field on each raccoon.
 *
 * Death handling:
 *   - rac death: alive=0, free its slot (start respawn).
 *   - bin death: alive=0, mark slot occupants free but bin stays dead;
 *     respawns from a dead bin are skipped by spawn.ts (it checks alive).
 */

import type { ContentBundle, UnitDef } from "../content.js";
import { ROLE_ARCHER, ROLE_CAVALRY, ROLE_TANK } from "../content.js";
import type { Logger } from "../log.js";
import {
  MAX_GARRISON_SLOTS,
  SECONDS_PER_TICK,
  TARGET_KIND_BIN,
  TARGET_KIND_NONE,
  TARGET_KIND_RAC,
  type BattleState,
  findBinRowById,
  findRacRowById,
} from "../state.js";
import { DOCTRINE_KNOBS } from "../doctrines.js";
import { forEachNear } from "../grid.js";
import { freeRacSlot } from "./spawn.js";
import { spawnProjectile } from "./projectile.js";
import { synergyModsFor } from "./synergy.js";

const MIN_DAMAGE = 1;
/** Rage gained by the attacker per landed basic attack (Archer + Cavalry rule). */
const RAGE_PER_ATTACK_LANDED = 5;
/** Rage gained by the target per HP of damage taken (Tank rule). */
const RAGE_PER_DAMAGE_TAKEN = 1;
/** Damage multiplier when attacker is in target's rear arc (>120°
 *  off the target's facing). */
const FLANK_DAMAGE_MUL = 1.4;
/** Half-arc (radians) of the rear-arc cone for flank bonus. 120° / 2
 *  = 60°. We compare against |facing→attacker angle| > π − this. */
const REAR_ARC_HALF = (60 * Math.PI) / 180;
/** If a unit's facing changed by more than this (radians) on the most
 *  recent boids tick, it cannot attack this combat tick — modeling
 *  the swing-around penalty. ~50% of the 90° max-per-tick rotation. */
const TURN_PENALTY_DELTA = (45 * Math.PI) / 180;

/** Shortest-path angular delta in (-π, π]. */
function angDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

export function combatTick(state: BattleState, content: ContentBundle, log: Logger): void {
  const dt = SECONDS_PER_TICK;
  const n = state.rac.count;
  const m = state.bin.count;

  // Iterate via the per-tick shuffled permutation so attack order
  // doesn't always favor low-row (side-0) units.
  const order = state._tickIterOrder;
  for (let oi = 0; oi < n; oi++) {
    const i = order ? order[oi] : oi;
    if (!state.rac.alive[i]) continue;
    if (state.rac.attackCooldown[i] > 0) {
      state.rac.attackCooldown[i] = Math.max(0, state.rac.attackCooldown[i] - dt);
    }
    if (state.rac.attackCooldown[i] > 0) continue;

    // Turning penalty: if I just rotated more than TURN_PENALTY_DELTA
    // in the last boids tick, I'm not stable enough to swing this
    // tick. The cooldown isn't bumped — next tick I can attack again
    // if I've stopped spinning. Models "you can't fight while pivoting
    // your stance."
    const turn = Math.abs(angDelta(state.rac.facing[i], state.rac.prevFacing[i]));
    if (turn > TURN_PENALTY_DELTA) continue;

    const unit = content.units.get(state.unitIdTable[state.rac.unitIdIdx[i]]);
    if (!unit) continue;

    // Attack-target selection is independent of movement target.
    // Pick the closest enemy IN RANGE; prefer raccoons (immediate
    // threats) over bins. This means a Lockpicker walking toward an
    // enemy bin will still swing at any enemy raccoon that comes into
    // melee range, instead of letting itself get pummeled.
    const myX = state.rac.x[i];
    const myY = state.rac.y[i];
    const myOwner = state.rac.owner[i];
    // Read EFFECTIVE range (status-modified) — sandy reduces range.
    const range = state.rac.effRange[i];
    const r2 = range * range;

    let bestRacRow = -1;
    let bestRacD2 = Infinity;

    // Fast path: if target.ts already picked an enemy rac that's alive
    // and within our attack range, use it directly. Skips the full
    // forEachNear scan in the common steady-state case where movement-
    // target == attack-target. Combat still falls back to a fresh
    // scan when the picked target is out of range or dead (e.g.,
    // Lockpicker walking past a closer enemy rac to reach a bin).
    const fastTid = state.rac.targetId[i];
    const fastKind = state.rac.targetKind[i];
    if (fastTid >= 0 && fastKind === TARGET_KIND_RAC) {
      const fastRow = state.racRowById.get(fastTid);
      if (
        fastRow !== undefined &&
        state.rac.alive[fastRow] &&
        state.rac.owner[fastRow] !== myOwner
      ) {
        const dx = state.rac.x[fastRow] - myX;
        const dy = state.rac.y[fastRow] - myY;
        const d2 = dx * dx + dy * dy;
        if (d2 <= r2) {
          bestRacRow = fastRow;
          bestRacD2 = d2;
        }
      }
    }

    if (bestRacRow < 0) {
      if (state._racGrid) {
        forEachNear(state._racGrid, myX, myY, range, (j) => {
          if (j === i) return;
          if (!state.rac.alive[j]) return;
          if (state.rac.owner[j] === myOwner) return;
          const dx = state.rac.x[j] - myX;
          const dy = state.rac.y[j] - myY;
          const d2 = dx * dx + dy * dy;
          if (d2 <= r2 && d2 < bestRacD2) {
            bestRacD2 = d2;
            bestRacRow = j;
          }
        });
      } else {
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
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
      }
    }

    let attackKind: number = TARGET_KIND_NONE;
    let attackRow = -1;
    let attackD = -1;

    if (bestRacRow >= 0) {
      attackKind = TARGET_KIND_RAC;
      attackRow = bestRacRow;
      attackD = Math.sqrt(bestRacD2);
    } else {
      // No rac in range — try bins.
      let bestBinRow = -1;
      let bestBinD2 = Infinity;
      for (let k = 0; k < m; k++) {
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
      if (bestBinRow >= 0) {
        attackKind = TARGET_KIND_BIN;
        attackRow = bestBinRow;
        attackD = Math.sqrt(bestBinD2);
      }
    }

    if (attackKind === TARGET_KIND_NONE) continue;

    // Read EFFECTIVE damage + attack_rate (status-modified). Apply
    // anti-bin damage synergy (Lockpickers-2) ONLY when target is a bin.
    let dmgRaw = state.rac.effDamage[i];
    const isBin = attackKind === TARGET_KIND_BIN;
    if (isBin) {
      const synMods = synergyModsFor(state, i);
      dmgRaw *= synMods.antiBinDamageMul;
    } else {
      // Flank bonus: angle from target's facing to attacker's
      // position. If outside the front 240° arc (i.e., in the rear
      // 120° arc), bump damage. Bins have no facing so this only
      // applies to rac targets.
      const tFacing = state.rac.facing[attackRow];
      const angToAtk = Math.atan2(myY - state.rac.y[attackRow], myX - state.rac.x[attackRow]);
      const off = Math.abs(angDelta(angToAtk, tFacing));
      if (off > Math.PI - REAR_ARC_HALF) {
        dmgRaw *= FLANK_DAMAGE_MUL;
      }
    }
    const tid = isBin ? state.bin.id[attackRow] : state.rac.id[attackRow];

    const srcRole = state.rac.role[i];
    const isArcher = srcRole === ROLE_ARCHER;

    log.emit("rac_attack", {
      rac_id: state.rac.id[i],
      owner: myOwner,
      target_id: tid,
      target_kind: isBin ? "bin" : "rac",
      damage: dmgRaw,
      range: attackD,
      unit_id: unit.id,
      role: unit.role,
      env: unit.environment,
      cur: unit.curiosity,
      delivery: isArcher ? "projectile" : "instant",
    });

    if (isArcher) {
      // Ranged: fire an arrow toward the target's *current* position.
      // The shot can be intercepted by friendlies, miss a moving
      // target, or land — projectile.ts resolves it. Rage-on-landed
      // is granted by projectile.ts on hit, NOT here, since "fired"
      // ≠ "landed".
      const tgtX = isBin ? state.bin.x[attackRow] : state.rac.x[attackRow];
      const tgtY = isBin ? state.bin.y[attackRow] : state.rac.y[attackRow];
      spawnProjectile(state, log, i, myX, myY, tgtX, tgtY, dmgRaw, range);
    } else {
      // Melee: instant resolution.
      if (isBin) {
        applyBinDamage(state, content, log, i, attackRow, dmgRaw);
      } else {
        applyRacDamage(state, content, log, i, attackRow, dmgRaw, unit);
      }
      // Rage gain (Cavalry rule): per attack landed. Archer rage now
      // accrues on proj_hit instead, since fired ≠ landed.
      if (srcRole === ROLE_CAVALRY) {
        gainRage(state, i, RAGE_PER_ATTACK_LANDED);
      }
    }

    state.rac.attackCooldown[i] = 1 / state.rac.effAttackRate[i];
  }
}

/** Bump a raccoon's rage meter, clamped to its capacity. Exported for
 *  use by rage.ts (Infantry adjacency tick). */
export function gainRage(state: BattleState, racRow: number, amount: number): void {
  if (!state.rac.alive[racRow]) return;
  const next = state.rac.rage[racRow] + amount;
  const cap = state.rac.rageCap[racRow];
  state.rac.rage[racRow] = next > cap ? cap : next;
}

/** Apply damage from `srcRow` to raccoon at `tgtRow`. Emits damage_apply
 *  + rac_death (if HP hits 0). Bumps Tank target's rage meter from the
 *  damage taken. Exported so rage.ts can reuse for rage AOE damage. */
export function applyRacDamage(
  state: BattleState,
  content: ContentBundle,
  log: Logger,
  srcRow: number,
  tgtRow: number,
  dmgRaw: number,
  _srcUnit: UnitDef | null,
  source: "basic" | "rage" | "dot" = "basic",
  statusId: string | null = null,
): void {
  const tgtUnit = content.units.get(state.unitIdTable[state.rac.unitIdIdx[tgtRow]]);
  if (!tgtUnit) return;
  // EFFECTIVE armor (post-synergy + post-status). DoT bypasses armor.
  const armor = source === "dot" ? 0 : state.rac.effArmor[tgtRow];
  // Damage-taken multiplier: status mods × surrounded penalty. Both
  // multiply incoming damage (e.g., lonely status +25%, surrounded
  // +15%, both apply at once → ×1.4375 incoming).
  const taken = (state.rac.dmgTakenMul[tgtRow] || 1) * (state.rac.surroundedDamageMul[tgtRow] || 1);
  const dmg = Math.max(MIN_DAMAGE, (dmgRaw - armor) * taken);
  const hpBefore = state.rac.hp[tgtRow];
  const hpAfter = hpBefore - dmg;
  state.rac.hp[tgtRow] = hpAfter;

  const fields: Record<string, unknown> = {
    src_rac: srcRow >= 0 ? state.rac.id[srcRow] : -1,
    src_owner: srcRow >= 0 ? state.rac.owner[srcRow] : -1,
    tgt_kind: "rac",
    tgt_id: state.rac.id[tgtRow],
    tgt_owner: state.rac.owner[tgtRow],
    tgt_unit: tgtUnit.id,
    dmg_raw: dmgRaw,
    dmg_after_armor: dmg,
    armor,
    tgt_hp_before: hpBefore,
    tgt_hp_after: hpAfter,
    source,
  };
  if (statusId) fields.status_id = statusId;
  log.emit("damage_apply", fields);

  // Rage gain: Tank rule = per damage taken.
  if (state.rac.role[tgtRow] === ROLE_TANK && state.rac.alive[tgtRow]) {
    gainRage(state, tgtRow, dmg * RAGE_PER_DAMAGE_TAKEN);
  }

  if (hpAfter <= 0 && state.rac.alive[tgtRow]) {
    markRacDead(state, content, log, tgtRow, srcRow);
  }
}

/** Mark a raccoon dead, free its garrison slot, emit rac_death. Exported
 *  so status.ts's DoT death path uses the same handler. */
export function markRacDead(
  state: BattleState,
  content: ContentBundle,
  log: Logger,
  tgtRow: number,
  killerRow: number,
): void {
  if (!state.rac.alive[tgtRow]) return;
  state.rac.alive[tgtRow] = 0;
  state.rac.hp[tgtRow] = 0;
  freeRacSlot(state, tgtRow);
  const tgtUnit = content.units.get(state.unitIdTable[state.rac.unitIdIdx[tgtRow]]);
  log.emit("rac_death", {
    rac_id: state.rac.id[tgtRow],
    owner: state.rac.owner[tgtRow],
    unit_id: tgtUnit?.id ?? "",
    last_hit_by: killerRow >= 0 ? state.rac.id[killerRow] : -1,
    last_hit_unit:
      killerRow >= 0
        ? content.units.get(state.unitIdTable[state.rac.unitIdIdx[killerRow]])?.id ?? ""
        : "",
    x: state.rac.x[tgtRow],
    y: state.rac.y[tgtRow],
  });
}

/** Compute the bin's defender-shield damage multiplier. The design
 *  intent is "kill the army first, then the bin" — so the shield is
 *  a SIDE-level tally of alive raccoons, not local proximity. As the
 *  bin's army is attrited the shield drops; once they're wiped, bins
 *  fall fast. The local-proximity version didn't do the work because
 *  defenders typically march away from their bin toward the enemy.
 *
 *  binShieldRadius is unused now; kept as a knob the autotuner can
 *  ignore (or repurpose for a future hybrid model). */
function computeBinShieldMul(state: BattleState, binRow: number): number {
  const shieldMax = DOCTRINE_KNOBS.binShieldMax;
  if (shieldMax <= 0) return 1;
  const fullAt = Math.max(1, DOCTRINE_KNOBS.binShieldFullAt);
  const binOwner = state.bin.owner[binRow];
  // Count all alive racs on the same side as the bin.
  let count = 0;
  for (let j = 0; j < state.rac.count; j++) {
    if (!state.rac.alive[j]) continue;
    if (state.rac.owner[j] !== binOwner) continue;
    count++;
  }
  const frac = Math.min(1, count / fullAt);
  return 1 - frac * shieldMax;
}

export function applyBinDamage(
  state: BattleState,
  content: ContentBundle,
  log: Logger,
  srcRow: number,
  tgtBinRow: number,
  dmgRaw: number,
): void {
  // Bins have no armor in v0a — dmg lands raw, then is reduced by
  // the defender-shield multiplier. The shield maps "you can't kill
  // the bin while the army defends it" into an attrition gradient.
  const shieldMul = computeBinShieldMul(state, tgtBinRow);
  const dmg = Math.max(MIN_DAMAGE, dmgRaw * shieldMul);
  const hpBefore = state.bin.hp[tgtBinRow];
  const hpAfter = hpBefore - dmg;
  state.bin.hp[tgtBinRow] = hpAfter;

  log.emit("damage_apply", {
    src_rac: srcRow >= 0 ? state.rac.id[srcRow] : -1,
    src_owner: srcRow >= 0 ? state.rac.owner[srcRow] : -1,
    tgt_kind: "bin",
    tgt_id: state.bin.id[tgtBinRow],
    tgt_owner: state.bin.owner[tgtBinRow],
    tgt_unit: state.unitIdTable[state.bin.unitIdIdx[tgtBinRow]],
    dmg_raw: dmgRaw,
    dmg_after_armor: dmg,
    armor: 0,
    bin_shield_mul: shieldMul,
    tgt_hp_before: hpBefore,
    tgt_hp_after: hpAfter,
  });

  if (hpAfter <= 0 && state.bin.alive[tgtBinRow]) {
    state.bin.alive[tgtBinRow] = 0;
    state.bin.hp[tgtBinRow] = 0;
    state.binRowById.delete(state.bin.id[tgtBinRow]);
    // Mark all garrison slots empty so spawn.ts won't spawn from a dead
    // bin even if their respawn timers happened to expire.
    for (let s = 0; s < MAX_GARRISON_SLOTS; s++) {
      const slotIdx = tgtBinRow * MAX_GARRISON_SLOTS + s;
      state.bin.slotOccupant[slotIdx] = -1;
      state.bin.slotRespawnT[slotIdx] = Number.POSITIVE_INFINITY;
    }
    log.emit("bin_death", {
      bin_id: state.bin.id[tgtBinRow],
      owner: state.bin.owner[tgtBinRow],
      unit_id: state.unitIdTable[state.bin.unitIdIdx[tgtBinRow]],
      last_hit_by: srcRow >= 0 ? state.rac.id[srcRow] : -1,
      last_hit_unit:
        srcRow >= 0
          ? content.units.get(state.unitIdTable[state.rac.unitIdIdx[srcRow]])?.id ?? ""
          : "",
      x: state.bin.x[tgtBinRow],
      y: state.bin.y[tgtBinRow],
    });
  }
}
