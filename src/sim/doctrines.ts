/**
 * Doctrines — per-faction tactical patterns layered ABOVE formations.
 *
 * Formations are about spawn arrangement and per-rac coefficient
 * overrides ("phalanx is 4×3 grid, tight cohesion"). Doctrines are
 * about the *behavior pattern through time* — how a pack of units
 * moves and fights as a coordinated whole.
 *
 * Examples (drawn from real military tactics):
 *
 *   - PHALANX (Greek/Macedonian): one solid block, slow grinding
 *     advance. The doctrine is "don't break ranks." Already covered
 *     mechanically by the phalanx formation's contact mode; the
 *     doctrine adds no further movement modulation.
 *
 *   - FIRE TEAM (modern small-unit, e.g., US Army squad split into
 *     two fire teams of 4): bounding overwatch. Half the team
 *     advances while the other half holds position to cover. Then
 *     they swap. Movement alternates in 2-second-ish cycles.
 *
 *   - SKIRMISHER (light infantry, partisan, light cavalry): rush
 *     forward in short bursts (~3s), halt to fire/observe (~1s),
 *     relocate. Never engages continuously. Stays loose.
 *
 *   - LINE (Napoleonic / disciplined musketry): wide line, rapid
 *     uniform advance, alignment-locked. Looks like infantry-line
 *     formation but with stronger same-direction pull.
 *
 * Doctrines are assigned by (environment, curiosity) — e.g.,
 * Suburban+Barbarians = phalanx, City+Lockpickers = fire-team,
 * Park+Tinkerers = skirmisher, Coastal+Farmers = line. Other
 * combinations get the "default" doctrine (no time-pattern
 * modulation).
 *
 * Implementation: per-rac doctrineIdx + teamId stamped at spawn.
 * Boids reads them each tick to compute a seek/cohesion multiplier
 * that captures the doctrine's rhythm. Other subsystems may also
 * key off doctrineIdx for things like attack-rate boost during a
 * cover phase (future work).
 */

import type { EnvId, CuriosityId } from "./content.js";

export type DoctrineId = "default" | "phalanx" | "fire-team" | "skirmisher" | "line";

export const DOCTRINES: readonly DoctrineId[] = ["default", "phalanx", "fire-team", "skirmisher", "line"];

export const DOCTRINE_TO_IDX: Record<DoctrineId, number> = (() => {
  const m: Partial<Record<DoctrineId, number>> = {};
  DOCTRINES.forEach((d, i) => { m[d] = i; });
  return m as Record<DoctrineId, number>;
})();

/** Per-(env, cur) faction doctrine. Combinations not listed here
 *  default to "default" (no special pattern). */
export const DOCTRINE_BY_ENV_CUR: Record<EnvId, Partial<Record<CuriosityId, DoctrineId>>> = {
  city: { lockpickers: "fire-team", farmers: "line" },
  suburban: { barbarians: "phalanx" },
  park: { tinkerers: "skirmisher" },
  coastal: { farmers: "line", lockpickers: "fire-team" },
};

export function doctrineFor(env: EnvId, cur: CuriosityId): DoctrineId {
  return DOCTRINE_BY_ENV_CUR[env]?.[cur] ?? "default";
}

/** Sub-team size per doctrine. Teams within a bin's burst get distinct
 *  teamIds (0..N-1) and get out-of-phase rhythm cycles, so half-the-
 *  squad-advances-while-half-covers emerges naturally without per-
 *  team coordination. */
export const DOCTRINE_TEAM_SIZE: Record<DoctrineId, number> = {
  default: 99, // one team per burst
  phalanx: 99,
  "fire-team": 4,
  skirmisher: 2,
  line: 99,
};

/** Tick-cycle period of the doctrine's rhythm. 0 = no rhythm
 *  (steady), >0 = phase repeats every N ticks. At 15Hz, 30 = 2s,
 *  45 = 3s, etc. */
export const DOCTRINE_PERIOD: Record<DoctrineId, number> = {
  default: 0,
  phalanx: 0,
  "fire-team": 30, // 2s bounding cycle
  skirmisher: 22,  // ~1.5s burst+halt
  line: 0,
};

/** Per-doctrine, per-team-and-tick movement modulation.
 *
 *  - seekKMul scales target intent strength (direction weight).
 *  - cohesionKMul scales the pack-pull force.
 *  - speedMul HARD-caps maxV so a unit in "cover/halt" phase actually
 *    stops moving. Without this, the always-maxV velocity model
 *    keeps units at full speed even with reduced seek (any non-zero
 *    intent above the commit threshold produces full-speed motion).
 */
export function doctrineMovementMod(
  doctrineIdx: number,
  teamId: number,
  tick: number,
): { seekKMul: number; cohesionKMul: number; speedMul: number } {
  const id = DOCTRINES[doctrineIdx];
  const period = DOCTRINE_PERIOD[id];
  if (period === 0) return { seekKMul: 1.0, cohesionKMul: 1.0, speedMul: 1.0 };

  // Phase offset per team so adjacent teams are out of sync. With a
  // 30-tick period and 7-tick offset, teams 0,1,2,3 are at phases
  // 0, 7, 14, 21 — covering all four quarters of the cycle, so at
  // any moment SOMEONE is advancing and someone else is covering.
  const teamOffset = teamId * 7;
  const phase = (tick + teamOffset) % period;
  const phaseFrac = phase / period; // [0, 1)

  if (id === "fire-team") {
    // 0-50%: advance (sprint forward at full speed)
    // 50-83%: cover (halt completely, suppress with attacks only)
    // 83-100%: rejoin (light jog to regroup with cover team)
    if (phaseFrac < 0.5) return { seekKMul: 1.4, cohesionKMul: 0.8, speedMul: 1.0 };
    if (phaseFrac < 0.83) return { seekKMul: 0.0, cohesionKMul: 1.0, speedMul: 0.0 };
    return { seekKMul: 0.6, cohesionKMul: 1.5, speedMul: 0.5 };
  }
  if (id === "skirmisher") {
    // 0-65%: sprint forward
    // 65-90%: halt (fire / observe)
    // 90-100%: relocate (sideways/quick reposition)
    if (phaseFrac < 0.65) return { seekKMul: 1.5, cohesionKMul: 0.5, speedMul: 1.0 };
    if (phaseFrac < 0.9) return { seekKMul: 0.0, cohesionKMul: 0.5, speedMul: 0.0 };
    return { seekKMul: 0.7, cohesionKMul: 0.5, speedMul: 0.7 };
  }
  return { seekKMul: 1.0, cohesionKMul: 1.0, speedMul: 1.0 };
}
