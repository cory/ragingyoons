/**
 * Doctrines as compositions of phase strategies.
 *
 * A doctrine is no longer a single rhythm — it's four orthogonal
 * decisions, each independently testable:
 *
 *   1. MOVEMENT   — how to traverse the field while not engaged
 *                   (steady advance, bounding, sprint-halt, roam)
 *   2. CONTACT    — what to do when an enemy is within attack range
 *                   (hold ground, kite, harass-and-disengage)
 *   3. REINFORCE  — what to do when an ALLY is engaged but I'm not
 *                   (ignore, rush to the fight, flank, mass-where-
 *                   winning)
 *   4. LAST-STAND — what to do when local cohesion / HP collapses
 *                   (fight on, rout to bin, rally to cluster, rage)
 *
 * Why this split: real battles aren't won by attrition with a fixed
 * behavior pattern. Units transition between phases based on context —
 * approach, engage, swarm to where it matters, then either commit or
 * break. Each phase has a small registry of strategies; doctrines
 * pick a strategy per phase. Adding a new behavior is a few lines in
 * one file plus a row in DOCTRINES.
 *
 * Phase selection per rac per tick (priority — later overrides
 * earlier):
 *   movement  (always — base layer)
 *   reinforce (if no enemy in range AND any ally is in contact)
 *   contact   (if any enemy is in attack range)
 *   last-stand (if HP < 30%)
 *
 * Each strategy is a pure function (ctx) → PhaseMod. Mods are
 * applied to formation profile coefficients (seek, cohesion, speed)
 * and may override seek direction (for retreat or rush-to-fight).
 *
 * The lab can test any strategy in isolation: place a rac with a
 * known doctrine, expose the relevant phase trigger (e.g., low HP
 * triggers last-stand), run a few ticks, assert the resulting
 * behavior.
 */

import type { EnvId, CuriosityId } from "./content.js";
import type { BattleState } from "./state.js";
import type { BoidFields } from "./fields.js";
import { sampleField } from "./fields.js";

// ---------- TUNABLE KNOBS ----------
// Module-level mutable values that strategies read at runtime. The
// autotuner overwrites these between battles to search the design
// space; outside the autotuner they hold their default values.
//
// Why mutable (vs threading through BattleConfig): the autotuner
// drives many short battles per evaluation across multiple worker
// processes. Each worker is its own process, so module mutation is
// process-local and safe. Per-battle knob overrides live in
// BattleJob.doctrineKnobs, applied inside the worker before
// setupBattle.
export const DOCTRINE_KNOBS = {
  /** fire-team bounding period in ticks. */
  fireTeamPeriod: 30,
  /** fire-team advance phase fraction (0..coverStart = sprint). */
  fireTeamCoverStart: 0.5,
  /** fire-team cover phase end (coverStart..coverEnd = halt). */
  fireTeamCoverEnd: 0.83,
  /** fire-team advance phase seek multiplier. */
  fireTeamAdvanceSeek: 1.4,
  /** fire-team rejoin phase speed multiplier (post-cover regroup). */
  fireTeamRejoinSpeed: 0.5,

  /** skirmisher cycle period (ticks). */
  skirmisherPeriod: 22,
  /** skirmisher sprint phase end (0..sprintEnd = sprint). */
  skirmisherSprintEnd: 0.65,
  /** skirmisher halt phase end (sprintEnd..haltEnd = halt). */
  skirmisherHaltEnd: 0.9,
  /** skirmisher sprint seek multiplier. */
  skirmisherSeekMul: 1.5,

  /** Reinforce strategy: rush-to-engaged seek strength. */
  rushToEngagedSeek: 1.6,
  /** Reinforce strategy: flank-engaged seek strength. */
  flankEngagedSeek: 1.4,

  /** Last-stand HP-fraction threshold (below this triggers
   *  last-stand phase). */
  lastStandHpFrac: 0.3,
  /** rout-to-bin damage taken multiplier (>1 = vulnerable while fleeing). */
  routVulnerability: 1.4,
  /** rally-cluster damage taken multiplier. */
  rallyVulnerability: 1.2,
  /** death-rage damage taken multiplier (<1 = berserk). */
  deathRageDmgRed: 0.7,
  /** death-rage seek multiplier. */
  deathRageSeek: 2.0,
  /** death-rage speed multiplier. */
  deathRageSpeed: 1.3,
};

export type DoctrineKnobs = typeof DOCTRINE_KNOBS;

// ---------- mod returned by each strategy ----------

export interface PhaseMod {
  /** Multiply maxV. 0 = halt. */
  speedMul: number;
  /** Multiply target seek intent. */
  seekKMul: number;
  /** Multiply pack cohesion intent. */
  cohesionKMul: number;
  /** If set, override seek direction (e.g., retreat to bin, swarm to
   *  fight). World-space (dx, dy); will be normalized by caller. */
  seekDirOverride?: { dx: number; dy: number };
  /** Multiplicative damage-taken modifier. >1 = vulnerable
   *  (e.g., routing units take more), <1 = bonus (e.g., last-stand
   *  rage shrugs off hits). Applied via state.rac.surroundedDamageMul
   *  pathway since combat already reads that. */
  damageTakenMul: number;
}

const NEUTRAL: PhaseMod = {
  speedMul: 1,
  seekKMul: 1,
  cohesionKMul: 1,
  damageTakenMul: 1,
};

// ---------- context handed to every strategy ----------

export interface PhaseCtx {
  state: BattleState;
  fields: BoidFields;
  /** Row index of the rac whose mod we're computing. */
  i: number;
  /** This rac's owner (0 or 1). */
  myOwner: 0 | 1;
  myX: number;
  myY: number;
  /** Sub-team within the bin's burst (for rhythm phases). */
  teamId: number;
  /** Current sim tick (for time-cycle rhythms). */
  tick: number;
}

// ---------- MOVEMENT strategies ----------

export type MovementId = "steady-advance" | "bounding-overwatch" | "sprint-halt" | "roam";

const movementSteady = (_c: PhaseCtx): PhaseMod => NEUTRAL;

const movementBounding = (c: PhaseCtx): PhaseMod => {
  const period = DOCTRINE_KNOBS.fireTeamPeriod;
  const phase = (c.tick + c.teamId * 7) % period;
  const phaseFrac = phase / period;
  if (phaseFrac < DOCTRINE_KNOBS.fireTeamCoverStart) {
    return { ...NEUTRAL, seekKMul: DOCTRINE_KNOBS.fireTeamAdvanceSeek, cohesionKMul: 0.8 };
  }
  if (phaseFrac < DOCTRINE_KNOBS.fireTeamCoverEnd) {
    return { ...NEUTRAL, speedMul: 0, seekKMul: 0 };
  }
  return { ...NEUTRAL, speedMul: DOCTRINE_KNOBS.fireTeamRejoinSpeed, seekKMul: 0.6, cohesionKMul: 1.5 };
};

const movementSprintHalt = (c: PhaseCtx): PhaseMod => {
  const period = DOCTRINE_KNOBS.skirmisherPeriod;
  const phase = (c.tick + c.teamId * 5) % period;
  const phaseFrac = phase / period;
  if (phaseFrac < DOCTRINE_KNOBS.skirmisherSprintEnd) {
    return { ...NEUTRAL, seekKMul: DOCTRINE_KNOBS.skirmisherSeekMul, cohesionKMul: 0.5 };
  }
  if (phaseFrac < DOCTRINE_KNOBS.skirmisherHaltEnd) {
    return { ...NEUTRAL, speedMul: 0, seekKMul: 0 };
  }
  return { ...NEUTRAL, speedMul: 0.7, seekKMul: 0.7, cohesionKMul: 0.5 };
};

const movementRoam = (c: PhaseCtx): PhaseMod => {
  // Wander with a weak forward bias. Stride angle drifts on a slow
  // sin cycle, so the rac threads laterally as it advances. Useful
  // for "patrol" doctrines that find the enemy by spreading out.
  void c;
  // Lateral perturbation handled via flank bias already; here we
  // just slow the seek slightly so cohesion pulls them through wide
  // patrol arcs instead of straight lines.
  return { ...NEUTRAL, seekKMul: 0.7, cohesionKMul: 0.5 };
};

const MOVEMENT_FNS: Record<MovementId, (c: PhaseCtx) => PhaseMod> = {
  "steady-advance": movementSteady,
  "bounding-overwatch": movementBounding,
  "sprint-halt": movementSprintHalt,
  roam: movementRoam,
};

// ---------- CONTACT strategies ----------

export type ContactId = "hold-and-fight" | "kite-back" | "harass-disengage";

const contactHold = (_c: PhaseCtx): PhaseMod => ({ ...NEUTRAL, speedMul: 0.1, seekKMul: 0 });

const contactKite = (c: PhaseCtx): PhaseMod => {
  // Kite is mostly handled in boids.ts via the archer kite mechanic
  // already. Here we just slightly slow the unit so it doesn't
  // overcommit when in contact.
  void c;
  return { ...NEUTRAL, speedMul: 0.7 };
};

const contactHarass = (c: PhaseCtx): PhaseMod => {
  // Brief engagement, then back away. Toggle on a 20-tick cycle:
  // half the cycle attack, half retreat.
  const phase = (c.tick + c.teamId * 5) % 20;
  if (phase < 10) return { ...NEUTRAL, speedMul: 0.1, seekKMul: 0 }; // engage
  // Retreat: push away from the enemy (reverse seek direction
  // computed in boids; here we just slow forward intent so retreat
  // bias dominates).
  return { ...NEUTRAL, speedMul: 0.9, seekKMul: -0.5, cohesionKMul: 0.5 };
};

const CONTACT_FNS: Record<ContactId, (c: PhaseCtx) => PhaseMod> = {
  "hold-and-fight": contactHold,
  "kite-back": contactKite,
  "harass-disengage": contactHarass,
};

// ---------- REINFORCE strategies ----------

export type ReinforceId = "ignore" | "rush-to-engaged" | "flank-engaged";

const reinforceIgnore = (_c: PhaseCtx): PhaseMod => NEUTRAL;

const reinforceRush = (c: PhaseCtx): PhaseMod => {
  // Bias seek toward the local "fight density" — where same-side
  // units are dense AND enemies are nearby. Sample friendly density
  // and enemy density at points in front of the rac; pick the
  // direction with the strongest combined gradient.
  const myF = c.fields.sideDensity[c.myOwner];
  const enemyF = c.fields.sideDensity[1 - c.myOwner];
  const R = 12;
  // Sample 4 cardinal points; "fight" score = min(myDensity, enemyDensity).
  // Higher fight score = more contested = where the action is.
  const dN = Math.min(sampleField(c.fields, myF, c.myX, c.myY + R), sampleField(c.fields, enemyF, c.myX, c.myY + R));
  const dS = Math.min(sampleField(c.fields, myF, c.myX, c.myY - R), sampleField(c.fields, enemyF, c.myX, c.myY - R));
  const dE = Math.min(sampleField(c.fields, myF, c.myX + R, c.myY), sampleField(c.fields, enemyF, c.myX + R, c.myY));
  const dW = Math.min(sampleField(c.fields, myF, c.myX - R, c.myY), sampleField(c.fields, enemyF, c.myX - R, c.myY));
  // Direction toward highest-fight-score cell.
  const dirX = dE - dW;
  const dirY = dN - dS;
  const len = Math.hypot(dirX, dirY);
  if (len < 0.01) return NEUTRAL;
  return {
    ...NEUTRAL,
    seekKMul: DOCTRINE_KNOBS.rushToEngagedSeek,
    seekDirOverride: { dx: dirX / len, dy: dirY / len },
  };
};

const reinforceFlank = (c: PhaseCtx): PhaseMod => {
  // Like rush-to-engaged but offset by 90° (lateral approach).
  const myF = c.fields.sideDensity[c.myOwner];
  const enemyF = c.fields.sideDensity[1 - c.myOwner];
  const R = 12;
  const dE = Math.min(sampleField(c.fields, myF, c.myX + R, c.myY), sampleField(c.fields, enemyF, c.myX + R, c.myY));
  const dW = Math.min(sampleField(c.fields, myF, c.myX - R, c.myY), sampleField(c.fields, enemyF, c.myX - R, c.myY));
  const dN = Math.min(sampleField(c.fields, myF, c.myX, c.myY + R), sampleField(c.fields, enemyF, c.myX, c.myY + R));
  const dS = Math.min(sampleField(c.fields, myF, c.myX, c.myY - R), sampleField(c.fields, enemyF, c.myX, c.myY - R));
  // Find target direction (toward the fight).
  const tx = dE - dW;
  const ty = dN - dS;
  const len = Math.hypot(tx, ty);
  if (len < 0.01) return NEUTRAL;
  // Rotate 90° (sign by team id parity so left/right flank split).
  const sign = c.teamId % 2 === 0 ? 1 : -1;
  return {
    ...NEUTRAL,
    seekKMul: DOCTRINE_KNOBS.flankEngagedSeek,
    seekDirOverride: { dx: -ty / len * sign, dy: tx / len * sign },
  };
};

const REINFORCE_FNS: Record<ReinforceId, (c: PhaseCtx) => PhaseMod> = {
  ignore: reinforceIgnore,
  "rush-to-engaged": reinforceRush,
  "flank-engaged": reinforceFlank,
};

// ---------- LAST-STAND strategies ----------

export type LastStandId = "fight-on" | "rout-to-bin" | "rally-cluster" | "death-rage";

const lastStandFightOn = (_c: PhaseCtx): PhaseMod => NEUTRAL;

const lastStandRoutToBin = (c: PhaseCtx): PhaseMod => {
  // Retreat to source bin if alive, else to any friendly bin.
  const srcBinId = c.state.rac.sourceBinId[c.i];
  let bx = 0;
  let by = 0;
  let found = false;
  if (srcBinId >= 0) {
    const row = c.state.binRowById.get(srcBinId);
    if (row !== undefined && c.state.bin.alive[row]) {
      bx = c.state.bin.x[row];
      by = c.state.bin.y[row];
      found = true;
    }
  }
  if (!found) {
    // Fall back to any alive friendly bin.
    for (let k = 0; k < c.state.bin.count; k++) {
      if (!c.state.bin.alive[k]) continue;
      if (c.state.bin.owner[k] !== c.myOwner) continue;
      bx = c.state.bin.x[k];
      by = c.state.bin.y[k];
      found = true;
      break;
    }
  }
  if (!found) return NEUTRAL;
  const dx = bx - c.myX;
  const dy = by - c.myY;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return { ...NEUTRAL, speedMul: 0.3 }; // arrived; cower
  return {
    ...NEUTRAL,
    speedMul: 1.0,
    seekKMul: 2.0,
    cohesionKMul: 0,
    seekDirOverride: { dx: dx / len, dy: dy / len },
    damageTakenMul: DOCTRINE_KNOBS.routVulnerability,
  };
};

const lastStandRallyCluster = (c: PhaseCtx): PhaseMod => {
  // Retreat toward densest friendly cluster. Sample the friendly
  // density at 4 cardinal points; pick the highest as rally point.
  const myF = c.fields.sideDensity[c.myOwner];
  const R = 16;
  const dN = sampleField(c.fields, myF, c.myX, c.myY + R);
  const dS = sampleField(c.fields, myF, c.myX, c.myY - R);
  const dE = sampleField(c.fields, myF, c.myX + R, c.myY);
  const dW = sampleField(c.fields, myF, c.myX - R, c.myY);
  const dirX = dE - dW;
  const dirY = dN - dS;
  const len = Math.hypot(dirX, dirY);
  if (len < 0.01) return { ...NEUTRAL, speedMul: 0.5 };
  return {
    ...NEUTRAL,
    speedMul: 1.0,
    seekKMul: 1.8,
    cohesionKMul: 2.0,
    seekDirOverride: { dx: dirX / len, dy: dirY / len },
    damageTakenMul: DOCTRINE_KNOBS.rallyVulnerability,
  };
};

const lastStandDeathRage = (_c: PhaseCtx): PhaseMod => ({
  // No retreat — full forward commit, accept incoming damage.
  speedMul: DOCTRINE_KNOBS.deathRageSpeed,
  seekKMul: DOCTRINE_KNOBS.deathRageSeek,
  cohesionKMul: 0.5,
  damageTakenMul: DOCTRINE_KNOBS.deathRageDmgRed,
});

const LAST_STAND_FNS: Record<LastStandId, (c: PhaseCtx) => PhaseMod> = {
  "fight-on": lastStandFightOn,
  "rout-to-bin": lastStandRoutToBin,
  "rally-cluster": lastStandRallyCluster,
  "death-rage": lastStandDeathRage,
};

// ---------- DOCTRINE = composition of 4 phase strategies ----------

export type DoctrineId =
  | "default"
  | "phalanx"
  | "fire-team"
  | "skirmisher"
  | "line"
  | "modern-patrol"
  | "fanatic";

export interface DoctrineDef {
  id: DoctrineId;
  /** Sub-team size for rhythm-based movement strategies. 99 = one
   *  team per burst (no sub-grouping). */
  teamSize: number;
  movement: MovementId;
  contact: ContactId;
  reinforce: ReinforceId;
  lastStand: LastStandId;
}

export const DOCTRINES: readonly DoctrineDef[] = [
  // 0 — generic baseline
  {
    id: "default",
    teamSize: 99,
    movement: "steady-advance",
    contact: "hold-and-fight",
    reinforce: "ignore",
    lastStand: "fight-on",
  },
  // 1 — Suburban+Barbarians: tight wall, hold ground, fight to death
  {
    id: "phalanx",
    teamSize: 99,
    movement: "steady-advance",
    contact: "hold-and-fight",
    reinforce: "ignore",
    lastStand: "fight-on",
  },
  // 2 — City+Lockpickers / Coastal+Lockpickers: bounding overwatch,
  // rush to where the action is, rally cluster when losing
  {
    id: "fire-team",
    teamSize: 4,
    movement: "bounding-overwatch",
    contact: "hold-and-fight",
    reinforce: "rush-to-engaged",
    lastStand: "rally-cluster",
  },
  // 3 — Park+Tinkerers: sprint-halt, harass-and-disengage, flank when
  // ally engaged, rout when losing
  {
    id: "skirmisher",
    teamSize: 2,
    movement: "sprint-halt",
    contact: "harass-disengage",
    reinforce: "flank-engaged",
    lastStand: "rout-to-bin",
  },
  // 4 — City+Farmers / Coastal+Farmers: wide line, hold-and-fight,
  // mass to engaged ally, rally cluster
  {
    id: "line",
    teamSize: 99,
    movement: "steady-advance",
    contact: "hold-and-fight",
    reinforce: "rush-to-engaged",
    lastStand: "rally-cluster",
  },
  // 5 — Roaming patrol that swarms first contact (the user's
  // canonical example: roam loose, mass to first engaged ally,
  // rout if losing fast)
  {
    id: "modern-patrol",
    teamSize: 4,
    movement: "roam",
    contact: "hold-and-fight",
    reinforce: "rush-to-engaged",
    lastStand: "rout-to-bin",
  },
  // 6 — Fanatic: never breaks, dies advancing
  {
    id: "fanatic",
    teamSize: 99,
    movement: "steady-advance",
    contact: "hold-and-fight",
    reinforce: "rush-to-engaged",
    lastStand: "death-rage",
  },
];

export const DOCTRINE_TO_IDX: Record<DoctrineId, number> = (() => {
  const m: Partial<Record<DoctrineId, number>> = {};
  DOCTRINES.forEach((d, i) => { m[d.id] = i; });
  return m as Record<DoctrineId, number>;
})();

/** Per-(env, cur) faction doctrine. Combinations not listed default
 *  to "default" (no special pattern). */
export const DOCTRINE_BY_ENV_CUR: Record<EnvId, Partial<Record<CuriosityId, DoctrineId>>> = {
  city: { lockpickers: "fire-team", farmers: "line" },
  suburban: { barbarians: "phalanx" },
  park: { tinkerers: "skirmisher", lockpickers: "modern-patrol" },
  coastal: { farmers: "line", lockpickers: "fire-team", barbarians: "fanatic" },
};

export function doctrineFor(env: EnvId, cur: CuriosityId): DoctrineId {
  return DOCTRINE_BY_ENV_CUR[env]?.[cur] ?? "default";
}

// ---------- per-tick phase selection + mod composition ----------

/** Choose which phase applies and run its strategy.
 *
 *  Phase priority (highest wins): last-stand > contact > reinforce >
 *  movement.
 *
 *  - last-stand fires when HP < 30%
 *  - contact fires when caller passed inAttackRange=true (the rac is
 *    within actual effRange of a target — it's swinging, not just
 *    closing). Decoupled from state.rac.contact[i] (which is the
 *    8m FORMATION trigger for synaspismos tightening).
 *  - reinforce fires when an ally on this side is fighting nearby
 *    (enemy density present in the surroundings) AND we're not yet
 *    in attack range
 *  - movement is the default base layer
 */
export function computeDoctrineMod(c: PhaseCtx & { inAttackRange: boolean }): PhaseMod {
  const doctrineIdx = c.state.rac.doctrineIdx[c.i];
  const def = DOCTRINES[doctrineIdx] ?? DOCTRINES[0];

  // Last-stand check
  const hpFrac = c.state.rac.hpMax[c.i] > 0 ? c.state.rac.hp[c.i] / c.state.rac.hpMax[c.i] : 1;
  if (hpFrac < DOCTRINE_KNOBS.lastStandHpFrac) return LAST_STAND_FNS[def.lastStand](c);

  // Contact check — must be within actual attack range, not just
  // the 8m formation-contact zone.
  if (c.inAttackRange) return CONTACT_FNS[def.contact](c);

  // Reinforce check: enemy density in the area beyond my immediate
  // attack range → an ally somewhere is fighting them.
  const REINFORCE_RADIUS = 18;
  const enemyF = c.fields.sideDensity[1 - c.myOwner];
  const enemyHere = sampleField(c.fields, enemyF, c.myX, c.myY)
    + sampleField(c.fields, enemyF, c.myX + REINFORCE_RADIUS, c.myY)
    + sampleField(c.fields, enemyF, c.myX - REINFORCE_RADIUS, c.myY)
    + sampleField(c.fields, enemyF, c.myX, c.myY + REINFORCE_RADIUS)
    + sampleField(c.fields, enemyF, c.myX, c.myY - REINFORCE_RADIUS);
  if (enemyHere > 0.4) return REINFORCE_FNS[def.reinforce](c);

  // Default: movement phase
  return MOVEMENT_FNS[def.movement](c);
}

/** Sub-team size lookup, used by spawn.ts to assign teamId. */
export function teamSizeFor(doctrineIdx: number): number {
  const d = DOCTRINES[doctrineIdx];
  return d ? d.teamSize : 99;
}
