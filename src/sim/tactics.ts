/**
 * Per-role tactic profiles.
 *
 * Hardcoded constants in subsystems (separation radii, kite fractions,
 * rethink cadence, etc.) used to be fixed scattered numbers. They now
 * live in TacticProfile so behavior can be A/B-tested per side without
 * touching subsystem code: pass `tacticOverrides` in BattleConfig and
 * one side gets a different profile while the other uses defaults.
 *
 * Profiles are composed at setupBattle: defaults per role × per-side
 * override (Partial<TacticProfile>). The composed table is stashed
 * on BattleState as `tacticPerSide[side][role]`.
 *
 * Per-curiosity behavior (e.g., Lockpickers bin-priority, Tinkerers
 * rage augmentation) is NOT in this table — those live in their
 * subsystem hooks. Tactics are role-shaped.
 */

import type { RoleId } from "./content.js";
import { ROLE_TO_IDX } from "./content.js";

export interface TacticProfile {
  // ---- Boid steering ----
  /** Separation push-away radius (meters). */
  separationRadius: number;
  /** Separation force coefficient. */
  separationK: number;
  /** Cohesion radius — pull toward centroid of nearby SAME-ROLE allies
   *  within this radius. 0 disables cohesion. */
  cohesionRadius: number;
  /** Cohesion force coefficient. Infantry uses high cohesion (clump
   *  together = stronger together synergy); Cavalry uses 0 (free
   *  agent); Tank uses low; Archer uses 0 (stay spread for line of
   *  sight). */
  cohesionK: number;
  /** Alignment radius — match velocity with nearby SAME-ROLE allies
   *  within this radius. 0 disables alignment. Produces "moving in
   *  the same direction together" (lines, formations). */
  alignmentRadius: number;
  /** Alignment force coefficient. Infantry forms lines (high), Tank
   *  marches together (medium), Cavalry / Archer skip it. */
  alignmentK: number;
  /** Target-seek force coefficient. */
  targetSeekK: number;
  /** Multiplier on base unit speed when computing the velocity cap.
   *  Tank uses < 1 (heavy → slower); Cavalry > 1 (mounted → faster).
   *  Lets us differentiate role speed without rebaking every unit
   *  card. */
  speedMul: number;

  // ---- Combat ----
  /** When current target is within `attackRange × this`, archer-style
   *  units back-pedal (negative seek). 0 disables kite. */
  archerKiteFraction: number;
  /** 0 = full-speed velocity replace; 1 = preserve previous velocity
   *  (heavy inertia). Tank uses 0.5 by default ("don't snap to new
   *  desired direction sharply"). */
  inertiaBlend: number;

  // ---- Targeting ----
  /** Re-pick target every N ticks. */
  targetRethinkTicks: number;

  // ---- Rage ----
  /** Distance counted as "adjacent" for Infantry rage adjacency rule. */
  adjacentRange: number;
  /** Infantry rule: rage gained per second when adjacent to ≥ 1 ally.
   *  0 disables; non-zero only meaningful for Infantry role. */
  infantryRagePerSec: number;

  // ---- Hide-behind ----
  /** Force coefficient for "stay behind friendlies, between me and the
   *  enemy." 0 disables; tanks/cavalry/infantry default to 0 (front
   *  line); archers use a non-zero value to keep them in the back row.
   *  Sampled as the difference in friendly density at points ahead of
   *  vs. behind the unit along the enemy direction — units are pulled
   *  toward the side with more friendlies. */
  hideBehindK: number;
  /** How far ahead/behind to sample friendly density (meters). About
   *  2× cell size keeps the sample inside one neighbor cell. */
  hideStandoff: number;

  // ---- Flank ----
  /** Per-rac angular offset on seek direction, in radians, scaled by
   *  this. The actual offset is `sin(id * 0.7) * flankBiasK`, so a K
   *  of 0.4 produces ±23° max per rac. Higher K = more visibly
   *  diverging approach paths (cavalry flanks, infantry stays in
   *  rough line). */
  flankBiasK: number;

  // ---- Support bonus ("rear ranks support front ranks") ----
  /** Maximum damage-taken reduction granted by friendly support
   *  density. 0 disables. The Greek phalanx's frontal invulnerability
   *  came from the rear ranks pressing forward and the back-rank
   *  shields lapping over the front; mechanically, friendly density
   *  around a rac reduces the damage it takes. Phalanx infantry
   *  should set this high (~0.4 = 40% reduction at high density);
   *  archers/cavalry don't benefit (they're not a shield wall). */
  supportBonusMax: number;
  /** Friendly density at this rac's position needed to fully realize
   *  supportBonusMax. Below threshold the bonus scales linearly. A
   *  good default is ~5 (a tight cluster of 5+ friendlies). */
  supportBonusFullAt: number;

  // ---- Formation tightness ----
  /** Multiplier on each rac's stored slot offset (set at spawn from
   *  formation.arrange()). Boids cohesion pulls toward
   *  `centroid + slot × slotScale`. Default 1.0 = march at the spawn
   *  pitch. Contact-mode overrides typically drop this below 1 to
   *  visibly tighten the formation when enemies are close (e.g. phalanx
   *  synaspismos: ~0.4 collapses the 1.4 m march pitch toward locked
   *  shields). The close-range pairwise repulsion still imposes a hard
   *  floor (~0.8 m), so very small slotScale won't actually overlap
   *  the racs — it just gets them as tight as the anti-overlap allows. */
  slotScale: number;
}

/** Per-role default profiles. Tweaking these is a global behavior
 *  change; per-battle variation goes through `tacticOverrides`.
 *
 *  K values are *direction blend weights* under the field-based boid
 *  model in subsys/boids.ts: forces are summed and the result is taken
 *  as a unit-direction (always travel at maxV). seekK > sep+coh+align
 *  keeps target intent dominant; sep/coh/align then perturb the path.
 *
 *  separationRadius / cohesionRadius / alignmentRadius are unused by
 *  the field model (they were the old per-pair query radii) but are
 *  preserved on the type for backwards compatibility with tactic
 *  override tests. */
export const DEFAULT_TANK: TacticProfile = {
  separationRadius: 1.2,
  separationK: 1.0,
  cohesionRadius: 3.5,
  cohesionK: 0.5,
  alignmentRadius: 3.5,
  alignmentK: 0.8, // march together
  targetSeekK: 3.0, // commit forward
  speedMul: 0.7, // heavy / slow
  archerKiteFraction: 0,
  inertiaBlend: 0.5,
  targetRethinkTicks: 4,
  adjacentRange: 1.5,
  infantryRagePerSec: 0,
  hideBehindK: 0, // tanks ARE the front
  hideStandoff: 6,
  flankBiasK: 0.05, // tanks march straight
  supportBonusMax: 0.25, // shields up; tanks lean on each other
  supportBonusFullAt: 4,
  slotScale: 1.0,
};

export const DEFAULT_ARCHER: TacticProfile = {
  separationRadius: 1.4,
  separationK: 1.5,
  cohesionRadius: 0,
  cohesionK: 0,
  alignmentRadius: 0,
  alignmentK: 0, // archers stay independent
  targetSeekK: 3.0,
  speedMul: 1.0,
  archerKiteFraction: 0.7,
  inertiaBlend: 0,
  targetRethinkTicks: 4,
  adjacentRange: 1.5,
  infantryRagePerSec: 0,
  hideBehindK: 3.0, // strong preference for back-line behind friendlies
  hideStandoff: 6,
  flankBiasK: 0.05, // archers mostly aim straight at their kited target
  supportBonusMax: 0, // archers don't get rear-rank shields
  supportBonusFullAt: 4,
  slotScale: 1.0,
};

export const DEFAULT_CAVALRY: TacticProfile = {
  separationRadius: 0.6,
  separationK: 0.5,
  cohesionRadius: 0,
  cohesionK: 0,
  alignmentRadius: 0,
  alignmentK: 0, // free agents — commit hard
  targetSeekK: 4.5,
  speedMul: 1.4, // mounted / fast
  archerKiteFraction: 0,
  // Cavalry has heft — they don't snap-redirect. The 0.5 inertia blend
  // gives a wider turning radius so a charge commits to its line for
  // about half a second before pivoting. Without it, the new motion
  // pipeline lets cavalry pirouette every tick and "speed attacks" as
  // an advantage stops mattering. Tanks already use 0.5 for the same
  // reason.
  inertiaBlend: 0.5,
  targetRethinkTicks: 4,
  adjacentRange: 1.5,
  infantryRagePerSec: 0,
  hideBehindK: 0, // commit hard, no hiding
  hideStandoff: 6,
  flankBiasK: 0.4, // cavalry visibly diverges, flanks from sides
  supportBonusMax: 0, // free agents don't pack tight
  supportBonusFullAt: 4,
  slotScale: 1.0,
};

export const DEFAULT_INFANTRY: TacticProfile = {
  separationRadius: 0.8,
  separationK: 0.8,
  cohesionRadius: 4.0,
  cohesionK: 1.2,
  alignmentRadius: 4.0,
  alignmentK: 1.2, // tight lines
  targetSeekK: 2.5,
  speedMul: 1.0,
  archerKiteFraction: 0,
  inertiaBlend: 0,
  targetRethinkTicks: 4,
  adjacentRange: 1.5,
  infantryRagePerSec: 5,
  hideBehindK: 0, // front line with tanks
  hideStandoff: 6,
  flankBiasK: 0.15, // slight spread to break perfect lockstep
  supportBonusMax: 0.35, // strong rear-rank protection — phalanx core
  supportBonusFullAt: 5,
  slotScale: 1.0,
};

export const DEFAULT_PROFILES: TacticProfile[] = [
  DEFAULT_TANK,
  DEFAULT_ARCHER,
  DEFAULT_CAVALRY,
  DEFAULT_INFANTRY,
];

export type TacticOverrideMap = Partial<Record<RoleId, Partial<TacticProfile>>>;

/** Compose per-side profile table by layering overrides on defaults. */
export function composeTactics(
  overridesA?: TacticOverrideMap,
  overridesB?: TacticOverrideMap,
): TacticProfile[][] {
  const compose = (overrides?: TacticOverrideMap): TacticProfile[] => {
    const out: TacticProfile[] = [];
    for (const role of ["tank", "archer", "cavalry", "infantry"] as const) {
      const idx = ROLE_TO_IDX[role];
      out[idx] = { ...DEFAULT_PROFILES[idx], ...(overrides?.[role] ?? {}) };
    }
    return out;
  };
  return [compose(overridesA), compose(overridesB)];
}
