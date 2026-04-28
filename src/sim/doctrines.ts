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
  // ---- per-doctrine stat scalars (applied at spawn to a rac whose
  // doctrineIdx matches the index named here). HP and damage are the
  // primary balance levers; speed is secondary. The autotuner can
  // shift entire doctrines up/down without touching individual unit
  // cards. Indexed by doctrine id.
  phalanxHpMul: 1.0,
  phalanxDamageMul: 1.0,
  phalanxSpeedMul: 1.0,
  /** Phalanx contact-mode support bonus magnitude (was hard-coded
   *  in the formation override). 0 = no rear-rank protection. */
  phalanxSupportMax: 0.55,
  /** Phalanx contact-mode speed multiplier (locked-shield slowdown). */
  phalanxContactSpeed: 0.2,

  fireTeamHpMul: 1.0,
  fireTeamDamageMul: 1.0,
  fireTeamSpeedMul: 1.0,

  modernPatrolHpMul: 1.0,
  modernPatrolDamageMul: 1.0,
  modernPatrolSpeedMul: 1.0,

  fanaticHpMul: 1.0,
  fanaticDamageMul: 1.0,
  fanaticSpeedMul: 1.0,

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

  // ---- Cavalry swarm avoidance. ----
  // Cavalry should route AROUND dense clusters, not plow through.
  // Sample total density at a point lookahead meters ahead of the
  // cavalry along its seek direction; if density exceeds threshold,
  // apply a perpendicular deflection toward the lighter side.
  // Per-rac (cavalry-role only); other roles ignore.
  cavalrySwarmAvoidK: 9.0,
  cavalrySwarmAvoidLookahead: 14.0,
  cavalrySwarmAvoidThreshold: 0.8,

  // ---- Global spawn-rate multiplier. ----
  // Multiplies every bin's spawn burst. 1 = default; 2 = "battle of
  // marathon" mode. Affects both initial belch and respawns. The
  // sim's MAX_RACS cap is 1024 so 2x on a 4-bin side is safely
  // within bounds (worst-case 4 × 10 × 2 × 4 sides = 320 << 1024).
  globalSpawnBurstMul: 1.0,

  // ---- Phalanx anti-cavalry recoil. ----
  // When a cavalry rac attacks a phalanx-doctrine unit that's in
  // formation contact mode (locked-shields), this fraction of the
  // damage rebounds onto the attacker. Models pikes/braced shields
  // impaling the charge. 1.0 = full mirror; values >1 mean the
  // recoil exceeds the dealt damage (very anti-cav).
  phalanxAntiCavRecoil: 1.0,

  // ---- Phalanx shield-vs-projectile reduction. ----
  // A phalanx-doctrine unit in contact mode reduces incoming
  // PROJECTILE damage (arrows) by this fraction. Models the
  // shield wall raised against missile fire — the second half of
  // why phalanxes were tactically strong. Without this, fire-team's
  // archers melt phalanx from range and recoil never fires (cavalry
  // is cleanup, not the killer).
  phalanxShieldVsProjectile: 0.6,

  // ---- Bin shield from living defenders (side-total). ----
  // Bins take reduced damage scaled by how many friendly raccoons
  // are still alive on the bin's side. Once an army is wiped, its
  // bins fall fast. Stops fire-team's "dance through the army to
  // kill the bin" cheese: you have to attrit the defenders first.
  /** Max damage reduction at full defender support (0 = disabled). */
  binShieldMax: 0.85,
  /** Number of side-alive raccoons for full shield. */
  binShieldFullAt: 30,
  /** Reserved for future hybrid (proximity × side-total) shield model. */
  binShieldRadius: 12,
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

export type SplitAxisId = "none" | "lateral" | "front-rear" | "perpendicular" | "random";

export interface DoctrineDef {
  id: DoctrineId;
  /** Sub-team size for rhythm-based movement strategies. 99 = one
   *  team per burst (no sub-grouping). */
  teamSize: number;
  movement: MovementId;
  contact: ContactId;
  reinforce: ReinforceId;
  lastStand: LastStandId;
  /** Maximum group size before the formation splits. Captures
   *  doctrine identity in numbers — phalanxes are big blocks
   *  (~64), fire teams are small (~12), skirmishers are tiny (~6).
   *  When a group's count exceeds this, the boid pipeline bisects
   *  it along splitAxis. */
  maxFormationSize: number;
  /** Where to bisect when splitting. "lateral" = left/right halves
   *  (perpendicular to the group's seek direction). "front-rear" =
   *  front/back along the seek axis. "perpendicular" = perpendicular
   *  to the enemy axis (cardinal +x). "random" = id-hash. "none" =
   *  formation never splits. */
  splitAxis: SplitAxisId;
  /** When true, followers in contact mode (any enemy within
   *  CONTACT_RADIUS) drop the leader-pull and act independently with
   *  full boid forces. Skirmishers / fire-teams use this — once the
   *  shooting starts they break formation and do their own thing.
   *  Phalanx / line / fanatic stay disciplined under fire. */
  independentInContact: boolean;
  /** Optional override on the role's tier sizes — [squad, platoon,
   *  company, battalion]. Phalanx is a *bigger cohesive unit* than
   *  generic infantry: a Greek hoplite block of ~48 fights as one
   *  squad, not as 4 squads of 12. When undefined, fall back to
   *  ROLE_TIER_SIZES[role]. */
  tierSizes?: readonly [number, number, number, number];
  /** Standing order — what this raccoon DOES by default. Not a
   *  player input; it's a property of the unit's temperament.
   *
   *  - "hold":     stay put until an enemy is in attack range,
   *                then engage. Garrison, anchor.
   *  - "slow":     march at 50% speed. Maintains formation under
   *                pressure (phalanx shield wall behavior).
   *  - "advance":  default — march toward target at full speed.
   *  - "charge":   eager engage at 1.5× attack range; skips FLANK
   *                detour and plows in. Fanatics, berserkers.
   *  - "skirmish": prefer KITE when in kite range; back-pedal at
   *                contact instead of engaging. */
  standingOrder: StandingOrderId;
}

export type StandingOrderId = "hold" | "slow" | "advance" | "charge" | "skirmish";

/** Map StandingOrderId → small int for per-rac Uint8 storage. */
export const STANDING_ORDER_TO_IDX: Record<StandingOrderId, number> = {
  hold: 0,
  slow: 1,
  advance: 2,
  charge: 3,
  skirmish: 4,
};
export const STANDING_ORDER_IDX_HOLD = 0;
export const STANDING_ORDER_IDX_SLOW = 1;
export const STANDING_ORDER_IDX_ADVANCE = 2;
export const STANDING_ORDER_IDX_CHARGE = 3;
export const STANDING_ORDER_IDX_SKIRMISH = 4;

/** Role-tier sizes — how many racs make up each level of the unit
 *  hierarchy: [squad, platoon, company, battalion]. The leader of each
 *  tier is a single rac promoted from its members; higher tiers are
 *  units-of-units (a platoon is 3 squad-leaders, etc).
 *
 *  Per-role differences match the design brief: tanks are rare and
 *  elite (1/4/12/36); archers and cavalry are mid-density (8/24/72/288);
 *  infantry are the bulk (12/36/108/648).
 *
 *  v0 only consumes the squad size (tier 0). Platoon and beyond are
 *  reserved for the next slice. */
export const ROLE_TIER_SIZES: Record<import("./content.js").RoleId, readonly [number, number, number, number]> = {
  // Tank tier 0 = 4 so tanks form a small line abreast (one squad =
  // one rank of 4 tanks with a leader-driven slot-direct formation).
  // Solo tanks looked like wandering individuals; 4-tank squads form
  // a recognizable line that anchors a position.
  tank: [4, 12, 36, 108],
  archer: [8, 24, 72, 288],
  // Cavalry squad = 16 — a substantial mounted unit (a "troop" /
  // "ile" historically). Big enough to feel like a charge, small
  // enough to be agile.
  cavalry: [16, 48, 144, 432],
  infantry: [12, 36, 108, 648],
};

/** Convenience: squad size (tier 0) for a (role, doctrine). Doctrine
 *  override wins when present — phalanx infantry is a 48-rac block,
 *  not a 12-rac line. */
export function squadSizeFor(role: import("./content.js").RoleId, doctrine?: DoctrineDef): number {
  return doctrine?.tierSizes?.[0] ?? ROLE_TIER_SIZES[role][0];
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
    maxFormationSize: 32,
    splitAxis: "lateral",
    independentInContact: false,
    standingOrder: "advance",
  },
  // 1 — Suburban+Barbarians: tight wall, hold ground, fight to death.
  // Big block formation; splits along depth (front/back ranks).
  // Phalanx is a *single cohesive block* of ~48 (vs the 12-rac default
  // infantry squad). Historically a Greek hoplite phalanx fought as
  // one unit eight ranks deep — modeling that as a single squad keeps
  // the shield-wall mechanic intact (no boid forces ripping the line
  // into 4 sub-squads).
  {
    id: "phalanx",
    teamSize: 99,
    movement: "steady-advance",
    contact: "hold-and-fight",
    reinforce: "ignore",
    lastStand: "fight-on",
    maxFormationSize: 64,
    splitAxis: "front-rear",
    independentInContact: false, // shield wall holds at all costs
    tierSizes: [48, 144, 432, 1296],
    standingOrder: "slow", // shield wall maintains formation under pressure
  },
  // 2 — City+Lockpickers / Coastal+Lockpickers: bounding overwatch.
  // Real fire teams are 4-12 strong; we cap at 12.
  {
    id: "fire-team",
    teamSize: 4,
    movement: "bounding-overwatch",
    contact: "hold-and-fight",
    reinforce: "rush-to-engaged",
    lastStand: "rally-cluster",
    maxFormationSize: 12,
    splitAxis: "lateral",
    independentInContact: true, // fight in pairs, individual decisions
    standingOrder: "advance",
  },
  // 3 — Park+Tinkerers: sprint-halt, harass. Tiny groups by design.
  {
    id: "skirmisher",
    teamSize: 2,
    movement: "sprint-halt",
    contact: "harass-disengage",
    reinforce: "flank-engaged",
    lastStand: "rout-to-bin",
    maxFormationSize: 6,
    splitAxis: "random",
    independentInContact: true, // skirmishers ALWAYS act on their own once shooting starts
    standingOrder: "skirmish", // kite eagerly, back-pedal at contact
  },
  // 4 — City+Farmers / Coastal+Farmers: wide line.
  {
    id: "line",
    teamSize: 99,
    movement: "steady-advance",
    contact: "hold-and-fight",
    reinforce: "rush-to-engaged",
    lastStand: "rally-cluster",
    maxFormationSize: 40,
    splitAxis: "lateral",
    independentInContact: false,
    standingOrder: "advance",
  },
  // 5 — Roaming patrol that swarms first contact.
  {
    id: "modern-patrol",
    teamSize: 4,
    movement: "roam",
    contact: "hold-and-fight",
    reinforce: "rush-to-engaged",
    lastStand: "rout-to-bin",
    maxFormationSize: 16,
    splitAxis: "front-rear",
    independentInContact: true,
    standingOrder: "advance",
  },
  // 6 — Fanatic: never breaks, dies advancing. No formation discipline.
  {
    id: "fanatic",
    teamSize: 99,
    movement: "steady-advance",
    contact: "hold-and-fight",
    reinforce: "rush-to-engaged",
    lastStand: "death-rage",
    maxFormationSize: 30,
    splitAxis: "none",
    independentInContact: true, // dies advancing as a wave of individuals
    standingOrder: "charge", // berserker — engage hard, never retreat
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
