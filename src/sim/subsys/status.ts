/**
 * Status subsystem.
 *
 * Per-tick: ticks DoT damage on every status'd raccoon, decrements
 * remaining durations, emits `status_expire` when a status drops off.
 *
 * Apply path: rage attacks (and eventually some basic attacks) call
 * `applyStatusToRac` to add a fresh status instance to the target.
 * Stack rule from the StatusDef governs:
 *   - "refresh": re-apply resets duration on the existing instance
 *   - "stack":   adds another independent instance (DoTs that stack)
 *   - "ignore":  no-op if already present
 *
 * Stat-modifier integration (slow, attack-rate debuffs, etc.) is NOT
 * yet wired into boids/combat — for v0a these effects are observable
 * in logs but don't yet bend behavior. Followup: an effective-stats
 * pass that boids/combat read from.
 */

import type { ContentBundle, StatusDef } from "../content.js";
import type { Logger } from "../log.js";
import { SECONDS_PER_TICK, type BattleState } from "../state.js";
import { applyRacDamage, markRacDead } from "./combat.js";
import { synergyModsFor } from "./synergy.js";

/** Add or refresh a status on a raccoon. Returns whether anything changed. */
export function applyStatusToRac(
  state: BattleState,
  content: ContentBundle,
  log: Logger,
  tgtRow: number,
  statusId: string,
  srcRacId: number,
): boolean {
  if (!state.rac.alive[tgtRow]) return false;
  const sdef = content.statuses.get(statusId);
  if (!sdef) return false;

  const list = state.rac.statuses[tgtRow];
  const existing = list.find((s) => s.id === statusId);

  let stackMode: "fresh" | "refresh" | "stack" | "ignored" = "fresh";

  if (existing) {
    if (sdef.stack === "ignore") return false;
    if (sdef.stack === "refresh") {
      existing.remaining = sdef.duration;
      existing.src = srcRacId;
      stackMode = "refresh";
    } else if (sdef.stack === "stack") {
      list.push({
        id: statusId,
        remaining: sdef.duration,
        src: srcRacId,
        nextTickIn: sdef.tick_rate ?? 0,
      });
      stackMode = "stack";
    }
  } else {
    list.push({
      id: statusId,
      remaining: sdef.duration,
      src: srcRacId,
      nextTickIn: sdef.tick_rate ?? 0,
    });
    stackMode = "fresh";
  }
  // Mark for stat recompute next status tick.
  state.rac.statsDirty[tgtRow] = 1;

  log.emit("status_apply", {
    tgt_id: state.rac.id[tgtRow],
    tgt_kind: "rac",
    tgt_owner: state.rac.owner[tgtRow],
    status_id: statusId,
    status_kind: sdef.kind,
    duration: sdef.duration,
    magnitude: sdef.magnitude,
    src_rac: srcRacId,
    stack: stackMode,
  });
  return true;
}

export function statusTick(state: BattleState, content: ContentBundle, log: Logger): void {
  const dt = SECONDS_PER_TICK;
  const n = state.rac.count;
  for (let i = 0; i < n; i++) {
    if (!state.rac.alive[i]) continue;

    const list = state.rac.statuses[i];

    // 1. DoT ticks + duration decrement + expire emission.
    if (list.length > 0) {
      const survived: typeof list = [];
      for (const s of list) {
        const sdef = content.statuses.get(s.id);
        if (!sdef) continue;

        if (sdef.kind === "dot" && sdef.tick_rate && sdef.tick_rate > 0) {
          s.nextTickIn -= dt;
          while (s.nextTickIn <= 0 && state.rac.alive[i]) {
            s.nextTickIn += sdef.tick_rate;
            const dmg = Math.max(0, -sdef.magnitude);
            if (dmg > 0) {
              // DoT damage attributes back to the status's original
              // applier so death's last_hit_by points at a real
              // raccoon. If the applier has since died, fall back to
              // -1 (rare; the next tick's status will still be
              // attributed correctly until the corpse retires).
              const srcRow = s.src >= 0 ? findSrcRow(state, s.src) : -1;
              applyRacDamage(state, content, log, srcRow, i, dmg, null, "dot", s.id);
              if (!state.rac.alive[i]) break;
            }
          }
        }

        s.remaining -= dt;
        if (s.remaining > 0 && state.rac.alive[i]) {
          survived.push(s);
        } else {
          log.emit("status_expire", {
            tgt_id: state.rac.id[i],
            tgt_kind: "rac",
            status_id: s.id,
            status_kind: sdef.kind,
          });
          // Status expiry alters effective stats — dirty.
          state.rac.statsDirty[i] = 1;
        }
      }
      state.rac.statuses[i] = survived;
    }

    // 2. Recompute effective stats only when something dirty (status
    //    applied/expired this tick, synergy threshold flipped on this
    //    side, or rac just spawned). Most ticks, no rac is dirty,
    //    which makes status the cheapest subsystem.
    if (state.rac.alive[i] && state.rac.statsDirty[i]) {
      recomputeEffectiveStats(state, content, i);
      state.rac.statsDirty[i] = 0;
    }
  }
  void markRacDead;
}

/** Read all active statuses on a raccoon and write the effective-stat
 *  fields that boids/combat consume. Magnitudes are read as multiplicative
 *  multipliers: `magnitude = -0.30` → effective = base × 0.70. The
 *  `damage_taken` modifier uses `(1 + magnitude)` directly (positive
 *  magnitude makes you take more damage). */
function recomputeEffectiveStats(
  state: BattleState,
  content: ContentBundle,
  racRow: number,
): void {
  const unit = content.units.get(state.unitIdTable[state.rac.unitIdIdx[racRow]]);
  if (!unit) return;

  // Start at 1× (or 0 for additive armor); fold in status mods, then
  // synergy mods. Both are multiplicative for now; the order doesn't
  // matter under multiplication.
  let speedMul = 1;
  let damageMul = 1;
  let rangeMul = 1;
  let attackRateMul = 1;
  let hpMul = 1;
  let armorAdd = 0;
  let damageTakenMul = 1;

  // Status mods.
  for (const s of state.rac.statuses[racRow]) {
    const sdef = content.statuses.get(s.id);
    if (!sdef) continue;
    const m = sdef.magnitude;
    switch (sdef.modifies) {
      case "speed":
        speedMul *= 1 + m;
        break;
      case "damage":
        damageMul *= 1 + m;
        break;
      case "range":
        rangeMul *= 1 + m;
        break;
      case "attack_rate":
        attackRateMul *= 1 + m;
        break;
      case "damage_taken":
        damageTakenMul *= 1 + m;
        break;
    }
  }

  // Synergy mods (active per side).
  const syn = synergyModsFor(state, racRow);
  speedMul *= syn.speedMul;
  damageMul *= syn.damageMul;
  rangeMul *= syn.rangeMul;
  attackRateMul *= syn.attackRateMul;
  hpMul *= syn.hpMul;
  armorAdd += syn.armorAdd;

  // Fold tactic speedMul in here so effSpeed is the single source of
  // truth for max velocity (boids reads it directly, no extra muls).
  const profile = state.tacticPerSide[state.rac.owner[racRow]][state.rac.role[racRow]];
  state.rac.effSpeed[racRow] = Math.max(0, unit.stats.speed * speedMul * profile.speedMul);
  state.rac.effDamage[racRow] = Math.max(0, unit.stats.damage * damageMul);
  state.rac.effRange[racRow] = Math.max(0, unit.stats.range * rangeMul);
  state.rac.effAttackRate[racRow] = Math.max(0.01, unit.stats.attack_rate * attackRateMul);
  state.rac.effArmor[racRow] = Math.max(0, unit.stats.armor + armorAdd);
  state.rac.dmgTakenMul[racRow] = Math.max(0, damageTakenMul);
  // hpMul is applied AT SPAWN ONLY (see spawn.ts). Recomputing max HP
  // mid-battle would require careful handling of "current HP > new max"
  // cases (when synergy drops on bin death). v0a: HP at spawn is sticky.
  void hpMul;
}

/** Linear-scan rac id → row lookup for status source attribution.
 *  Allows scanning dead rows (alive=0) so DoTs cast by a now-dead
 *  raccoon still carry that raccoon's id as last_hit_by. */
function findSrcRow(state: BattleState, id: number): number {
  for (let i = 0; i < state.rac.count; i++) {
    if (state.rac.id[i] === id) return i;
  }
  return -1;
}

export type { StatusDef };
