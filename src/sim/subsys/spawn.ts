/**
 * Spawn subsystem — garrison-respawn cadence with role-burst.
 *
 * Each bin has `garrison_cap` SLOTS. Each slot, when filled, emits a
 * BURST of raccoons (Tank 2, Archer 5, Cavalry 5, Infantry 10 by
 * default). A slot's `slotOccupant` field stores the COUNT of alive
 * raccoons it spawned; on each rac death the count decrements, and
 * when it hits 0 the slot's respawn timer starts.
 *
 * So a 4-slot Infantry bin produces up to 4 × 10 = 40 alive raccoons.
 * Tank bins are leaner: 2-4 slots × 2 = 4-8.
 *
 * Initial state: every slot is empty (slotOccupant=0) with timer 0,
 * so all garrisons belch on tick 1. When the last raccoon of a slot
 * dies, that slot's timer is set to RESPAWN_SECONDS (modulated by
 * the panic-spawn factor based on bin HP).
 *
 * Determinism: spawn jitter pulls from state.rng, in stable iteration
 * order (bin index ascending, then slot ascending, then burst index).
 */

import {
  CURIOSITY_TO_IDX,
  ENV_TO_IDX,
  ROLE_TO_IDX,
  type ContentBundle,
  type RoleId,
} from "../content.js";
import {
  DEFAULT_FORMATION_BY_ROLE,
  FORMATIONS,
  FORMATION_TO_IDX,
  getFormation,
  isValidFormationId,
} from "../formations.js";
import {
  DOCTRINE_KNOBS,
  DOCTRINE_TO_IDX,
  DOCTRINES,
  STANDING_ORDER_TO_IDX,
  doctrineFor,
  teamSizeFor,
} from "../doctrines.js";
import type { Logger } from "../log.js";
import { rngRange } from "../rng.js";
import {
  MAX_GARRISON_SLOTS,
  SECONDS_PER_TICK,
  setRacRowById,
  type BattleState,
} from "../state.js";
import { synergyBinMods, synergyModsFor } from "./synergy.js";

/** Default per-slot respawn time when a raccoon dies. v0a constant; later
 *  this'll come from each unit's `bin.respawn_seconds`. */
export const RESPAWN_SECONDS = 3.0;

/** Spawn position jitter (meters) around the bin center. With burst
 *  spawning (10 infantry per slot), this needs to be wide enough to
 *  not pile a whole squad into one cell — otherwise separation forces
 *  spike on tick 1 and the squad self-vibrates instead of advancing. */
const SPAWN_JITTER = 2.0;

/** Default panic-spawn max multiplier when a bin's HP hits 0. The
 *  effective rate at hpFrac is `1 + (1 − hpFrac)² × (max − 1)`. So at
 *  full HP the timer ticks at 1× (base RESPAWN_SECONDS); at 50% HP at
 *  ~1.75× of base; at 0% HP at the configured max. */
export const PANIC_DEFAULT_MAX_MUL = 4.0;

/** Helper for tests + probes: return the panic speed multiplier for a
 *  bin at fraction `hpFrac` of its max HP. Pure function. */
export function panicSpeedMul(hpFrac: number, maxMul: number): number {
  const f = Math.max(0, Math.min(1, hpFrac));
  const loss = 1 - f;
  return 1 + loss * loss * (Math.max(1, maxMul) - 1);
}

/** Per-role default burst (raccoons emitted per slot fill). Indexed by
 *  ROLE_TO_IDX values (tank=0, archer=1, cavalry=2, infantry=3). */
export const ROLE_DEFAULT_BURST = [2, 5, 5, 10] as const;

export function spawnTick(state: BattleState, content: ContentBundle, log: Logger): void {
  const dt = SECONDS_PER_TICK;
  for (let bi = 0; bi < state.bin.count; bi++) {
    if (!state.bin.alive[bi]) continue;
    const unitId = state.unitIdTable[state.bin.unitIdIdx[bi]];
    const unit = content.units.get(unitId);
    if (!unit) continue;
    // Effective garrison cap = base × Farmers garrison_mul (capped at
    // MAX_GARRISON_SLOTS). Recomputed every spawn pass so a synergy
    // dropping off (Farmers bin dies → garrison_mul→1) immediately
    // stops new spawns into the extra slots; existing raccoons in
    // those slots fight on but don't respawn after dying.
    const binMods = synergyBinMods(
      state,
      state.bin.owner[bi],
      state.bin.envIdx[bi],
      state.bin.curIdx[bi],
    );
    const baseCap = state.bin.garrisonCap[bi];
    const cap = Math.min(MAX_GARRISON_SLOTS, Math.floor(baseCap * binMods.garrisonMul));
    for (let s = 0; s < cap; s++) {
      const slotIdx = bi * MAX_GARRISON_SLOTS + s;
      // slotOccupant > 0 means raccoons from this slot are still alive.
      if (state.bin.slotOccupant[slotIdx] > 0) continue;
      const remaining = state.bin.slotRespawnT[slotIdx];
      if (remaining > 0) {
        const hpMax = state.bin.hpMax[bi];
        const hpFrac = hpMax > 0 ? state.bin.hp[bi] / hpMax : 1;
        const panicMaxMul = unit.bin.panic_spawn_max_mul ?? PANIC_DEFAULT_MAX_MUL;
        const speedMul = panicSpeedMul(hpFrac, panicMaxMul);
        const next = remaining - dt * speedMul;
        const HALF_TICK = dt * 0.5;
        if (next > HALF_TICK) {
          state.bin.slotRespawnT[slotIdx] = next;
          continue;
        }
        state.bin.slotRespawnT[slotIdx] = 0;
      }

      // Belch: emit BURST raccoons in jittered positions around the bin.
      // The slot's count tracks alive members; the slot doesn't free
      // for respawn until that count hits 0. Global burst multiplier
      // is applied on top — the default is 1.0; 2.0 doubles every
      // bin's army for "big battle" mode.
      const roleIdx = ROLE_TO_IDX[unit.role];
      const baseBurst = unit.bin.spawn_burst ?? ROLE_DEFAULT_BURST[roleIdx];
      const mul = DOCTRINE_KNOBS.globalSpawnBurstMul;
      const burst = Math.max(1, Math.floor(baseBurst * (Number.isFinite(mul) && mul > 0 ? mul : 1)));
      const owner = state.bin.owner[bi];
      // Resolve formation: card override → per-role default. Validate
      // formation matches the unit's role; mismatch falls back to
      // default (and would be caught at content-load time eventually).
      let formationId = unit.bin.formation;
      if (!formationId || !isValidFormationId(formationId)) {
        formationId = DEFAULT_FORMATION_BY_ROLE[unit.role as RoleId];
      }
      const formationDef = getFormation(formationId);
      if (formationDef.role !== unit.role) {
        // Role mismatch — fall back to the role's default formation.
        formationId = DEFAULT_FORMATION_BY_ROLE[unit.role as RoleId];
      }
      const formationIdx = FORMATION_TO_IDX[formationId];
      const formation = FORMATIONS[formationIdx];
      const profile = state.formationProfile[owner][formationIdx];
      // Resolve doctrine from (env, cur). Most env+cur combos default;
      // specific factions get tactical patterns (phalanx, fire-team,
      // skirmisher, line). Sub-team grouping is doctrine-specific.
      const doctrineId = doctrineFor(unit.environment, unit.curiosity);
      const doctrineIdx = DOCTRINE_TO_IDX[doctrineId];
      const teamSize = teamSizeFor(doctrineIdx);
      // Each burst spawn = one fresh group AND one fresh squad. Splits
      // later assign new group ids; respawns from the same slot get a
      // fresh group too, because they're a new tactical unit on the
      // field. Squad partitioning matches groupId for v0 (one bin's
      // burst = one squad); the slice-2 platoon/company hierarchy will
      // attach squad leaders to higher-tier units.
      const groupId = state.nextGroupId++;
      const squadId = state.nextSquadId++;
      const squadStartRow = state.rac.count;
      // Leader = middle rac of the squad (so slot offsets are roughly
      // symmetric around 0). Computed from burst-fixed leader idx;
      // back-filled into squadLeaderId once the leader's racId is
      // known after spawn. (leaderOff is computed below once `forward`
      // is in scope.)
      const leaderBurstIdx = Math.floor(burst / 2);
      // Per-doctrine stat scalars (autotuner balance levers). Default
      // 1.0 = no change. Indexed by doctrine id.
      const docHpMul =
        doctrineId === "phalanx" ? DOCTRINE_KNOBS.phalanxHpMul :
        doctrineId === "fire-team" ? DOCTRINE_KNOBS.fireTeamHpMul :
        doctrineId === "modern-patrol" ? DOCTRINE_KNOBS.modernPatrolHpMul :
        doctrineId === "fanatic" ? DOCTRINE_KNOBS.fanaticHpMul : 1.0;
      const docDamageMul =
        doctrineId === "phalanx" ? DOCTRINE_KNOBS.phalanxDamageMul :
        doctrineId === "fire-team" ? DOCTRINE_KNOBS.fireTeamDamageMul :
        doctrineId === "modern-patrol" ? DOCTRINE_KNOBS.modernPatrolDamageMul :
        doctrineId === "fanatic" ? DOCTRINE_KNOBS.fanaticDamageMul : 1.0;
      const docSpeedMul =
        doctrineId === "phalanx" ? DOCTRINE_KNOBS.phalanxSpeedMul :
        doctrineId === "fire-team" ? DOCTRINE_KNOBS.fireTeamSpeedMul :
        doctrineId === "modern-patrol" ? DOCTRINE_KNOBS.modernPatrolSpeedMul :
        doctrineId === "fanatic" ? DOCTRINE_KNOBS.fanaticSpeedMul : 1.0;
      // Forward direction: side-0 bins are at +x and want enemies at
      // -x, so forward (toward enemy) is -1 along x. side-1 mirrors.
      const forward = owner === 0 ? -1 : 1;
      const leaderOff = formation.arrange({ burstIdx: leaderBurstIdx, burstSize: burst, forward });
      let alive = 0;
      for (let bk = 0; bk < burst; bk++) {
        const racRow = state.rac.count;
        if (racRow >= state.rac.id.length) break;
        const racId = state.nextRacId++;
        // Formation arrangement (deterministic) + small jitter (RNG)
        // so spawns don't pile exactly on top of each other and the
        // density gradient has texture.
        const off = formation.arrange({ burstIdx: bk, burstSize: burst, forward });
        const jx = off.dx + rngRange(state.rng, -SPAWN_JITTER * 0.4, SPAWN_JITTER * 0.4);
        const jy = off.dy + rngRange(state.rng, -SPAWN_JITTER * 0.4, SPAWN_JITTER * 0.4);

        state.rac.id[racRow] = racId;
        setRacRowById(state, racId, racRow);
        state.rac.owner[racRow] = owner;
        state.rac.sourceBinId[racRow] = state.bin.id[bi];
        state.rac.sourceSlotIdx[racRow] = slotIdx;
        state.rac.unitIdIdx[racRow] = state.bin.unitIdIdx[bi];
        state.rac.role[racRow] = roleIdx;
        state.rac.env[racRow] = ENV_TO_IDX[unit.environment];
        state.rac.cur[racRow] = CURIOSITY_TO_IDX[unit.curiosity];
        state.rac.alive[racRow] = 1;
        state.rac.count = racRow + 1;

        // Apply synergy mods that affect at-spawn quantities.
        const syn = synergyModsFor(state, racRow);
        const hpAfterSyn = unit.stats.hp * syn.hpMul * docHpMul;
        state.rac.hp[racRow] = hpAfterSyn;
        state.rac.hpMax[racRow] = hpAfterSyn;
        state.rac.rage[racRow] = 0;
        state.rac.rageCap[racRow] = unit.rage.capacity;
        state.rac.x[racRow] = state.bin.x[bi] + jx;
        state.rac.y[racRow] = state.bin.y[bi] + jy;
        state.rac.vx[racRow] = 0;
        state.rac.vy[racRow] = 0;
        state.rac.facing[racRow] = owner === 0 ? Math.PI : 0;
        state.rac.targetId[racRow] = -1;
        state.rac.attackCooldown[racRow] = 0;
        state.rac.statuses[racRow] = [];
        // Effective stats fold in TACTIC speedMul so eff_speed at
        // rac_spawn IS the truth — no other code applies speedMul
        // downstream.
        state.rac.effSpeed[racRow] = unit.stats.speed * syn.speedMul * profile.speedMul * docSpeedMul;
        state.rac.effDamage[racRow] = unit.stats.damage * syn.damageMul * docDamageMul;
        state.rac.effRange[racRow] = unit.stats.range * syn.rangeMul;
        state.rac.effAttackRate[racRow] = unit.stats.attack_rate * syn.attackRateMul;
        state.rac.effArmor[racRow] = unit.stats.armor + syn.armorAdd;
        state.rac.dmgTakenMul[racRow] = 1;
        state.rac.surroundedDamageMul[racRow] = 1;
        state.rac.formationIdx[racRow] = formationIdx;
        state.rac.doctrineIdx[racRow] = doctrineIdx;
        state.rac.teamId[racRow] = Math.floor(bk / teamSize);
        state.rac.groupId[racRow] = groupId;
        state.rac.squadId[racRow] = squadId;
        // Placeholder leaderId; back-filled below.
        state.rac.squadLeaderId[racRow] = -1;
        // Slot is leader-relative — leader has slot (0,0), followers
        // are offset by their formation pos minus the leader's.
        state.rac.slotDx[racRow] = off.dx - leaderOff.dx;
        state.rac.slotDy[racRow] = off.dy - leaderOff.dy;
        state.rac.morale[racRow] = 1.0;
        state.rac.standingOrder[racRow] =
          STANDING_ORDER_TO_IDX[DOCTRINES[doctrineIdx].standingOrder];
        alive += 1;

        log.emit("rac_spawn", {
          rac_id: racId,
          bin_id: state.bin.id[bi],
          slot_idx: slotIdx,
          burst_index: bk,
          burst_size: burst,
          unit_id: unit.id,
          role: unit.role,
          env: unit.environment,
          cur: unit.curiosity,
          owner,
          hp_base: unit.stats.hp,
          hp_init: hpAfterSyn,
          base_speed: unit.stats.speed,
          tactic_speed_mul: profile.speedMul,
          eff_armor: state.rac.effArmor[racRow],
          eff_speed: state.rac.effSpeed[racRow],
          eff_damage: state.rac.effDamage[racRow],
          eff_range: state.rac.effRange[racRow],
          eff_attack_rate: state.rac.effAttackRate[racRow],
          x: state.rac.x[racRow],
          y: state.rac.y[racRow],
        });
      }
      // Back-fill squadLeaderId for everyone in this burst.
      const leaderAbsRow = squadStartRow + leaderBurstIdx;
      if (leaderAbsRow < state.rac.count) {
        const leaderRacId = state.rac.id[leaderAbsRow];
        for (let r = squadStartRow; r < state.rac.count; r++) {
          state.rac.squadLeaderId[r] = leaderRacId;
        }
      }
      state.bin.slotOccupant[slotIdx] = alive;
    }
  }
}

/** Called by damage.ts (or anywhere a raccoon dies). Decrements the
 *  source slot's alive count; when the count hits 0, the slot's
 *  respawn timer starts so a fresh burst can be emitted. Also evicts
 *  the rac id from the row-lookup map. */
export function freeRacSlot(state: BattleState, racRow: number): void {
  const id = state.rac.id[racRow];
  if (id >= 0 && id < state.racRowById.length) state.racRowById[id] = -1;
  const slotIdx = state.rac.sourceSlotIdx[racRow];
  if (slotIdx < 0) return;
  const next = state.bin.slotOccupant[slotIdx] - 1;
  state.bin.slotOccupant[slotIdx] = next > 0 ? next : 0;
  if (next <= 0) {
    state.bin.slotRespawnT[slotIdx] = RESPAWN_SECONDS;
  }
}
