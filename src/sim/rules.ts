/**
 * Archetype traits and faction relations driving the boids flock.
 */

export interface BoidTraits {
  maxSpeed: number;       // m/s
  minSpeed: number;       // m/s — boid never freezes
  /** Maximum self-directed velocity change per second (m/s²). The
   *  accumulated boids force is clamped to this magnitude before being
   *  integrated, capping how snappy a unit can pivot. Position-level
   *  effects (collisions) bypass this. */
  maxAccel: number;
  /** Maximum yaw rate (rad/s) — caps how fast the displayed heading can
   *  rotate toward the velocity vector. Decouples direction from raw
   *  velocity so brief separation impulses don't spin the body. */
  maxYawRate: number;
  alignRadius: number;    // m — match heading with same-archetype neighbors
  cohereRadius: number;   // m — pull toward same-archetype center of mass
  separateRadius: number; // m — personal-space radius (per-pair effective
                          //   threshold = max of the two boids' radii so
                          //   bigger units enforce spacing on smaller ones).
  chaseRadius: number;    // m — pursue/flee faction targets
  alignWeight: number;
  cohereWeight: number;
  separateWeight: number;
  chaseWeight: number;
  gait: "walk" | "run" | "shuffle";
}

const ARCH: Record<string, BoidTraits> = {
  Warden: {
    maxSpeed: 1.4, minSpeed: 0.6, maxAccel: 4, maxYawRate: 2.5,
    alignRadius: 4, cohereRadius: 6, separateRadius: 0.55, chaseRadius: 0,
    alignWeight: 0.6, cohereWeight: 0.5, separateWeight: 1.8, chaseWeight: 0,
    gait: "walk",
  },
  Striker: {
    maxSpeed: 3.5, minSpeed: 1.5, maxAccel: 14, maxYawRate: 4.5,
    alignRadius: 3, cohereRadius: 4, separateRadius: 0.4, chaseRadius: 10,
    alignWeight: 0.8, cohereWeight: 0.3, separateWeight: 1.4, chaseWeight: 2.0,
    gait: "run",
  },
  Caster: {
    maxSpeed: 2.0, minSpeed: 0.8, maxAccel: 8, maxYawRate: 3.0,
    alignRadius: 3, cohereRadius: 3, separateRadius: 0.7, chaseRadius: 6,
    alignWeight: 0.4, cohereWeight: 0.2, separateWeight: 2.0, chaseWeight: 0.8,
    gait: "walk",
  },
  Beast: {
    maxSpeed: 2.6, minSpeed: 1.0, maxAccel: 10, maxYawRate: 4.0,
    alignRadius: 2.5, cohereRadius: 3.5, separateRadius: 0.45, chaseRadius: 8,
    alignWeight: 0.7, cohereWeight: 0.6, separateWeight: 1.4, chaseWeight: 1.4,
    gait: "run",
  },
  Construct: {
    maxSpeed: 0.7, minSpeed: 0.2, maxAccel: 2, maxYawRate: 1.2,
    alignRadius: 5, cohereRadius: 5, separateRadius: 0.6, chaseRadius: 0,
    alignWeight: 0.4, cohereWeight: 0.3, separateWeight: 1.2, chaseWeight: 0,
    gait: "shuffle",
  },
  Specter: {
    maxSpeed: 2.8, minSpeed: 1.2, maxAccel: 16, maxYawRate: 5.0,
    alignRadius: 2, cohereRadius: 2, separateRadius: 0.3, chaseRadius: 12,
    alignWeight: 0.3, cohereWeight: 0.2, separateWeight: 0.6, chaseWeight: 1.6,
    gait: "run",
  },
};

export function traitsFor(archetype: string): BoidTraits {
  return ARCH[archetype] ?? ARCH.Warden;
}

/**
 * Faction relations: a > 0 means a pursues b; a < 0 means a flees b.
 * Asymmetric — `void` chases everyone, `bone` flees `ember` regardless
 * of whether ember is currently pursuing.
 */

/** Stable integer id per faction; used as index into the relation matrix. */
export const FACTION_IDS: Record<string, number> = {
  ember:    0,
  azure:    1,
  jade:     2,
  amethyst: 3,
  bone:     4,
  void:     5,
};
const NUM_FACTIONS = 6;

/** Flat row-major 6×6 matrix of relation weights. Indexed by faction id. */
export const FACTION_REL_MATRIX = (() => {
  const m = new Float32Array(NUM_FACTIONS * NUM_FACTIONS);
  const set = (a: string, b: string, v: number): void => {
    m[FACTION_IDS[a] * NUM_FACTIONS + FACTION_IDS[b]] = v;
  };
  set("ember", "bone", 1.0);
  set("ember", "jade", 0.5);
  set("jade", "ember", -1.0);
  set("bone", "ember", -1.0);
  set("bone", "void", -1.0);
  set("void", "ember", 1.0);
  set("void", "azure", 1.0);
  set("void", "jade", 1.0);
  set("void", "amethyst", 1.0);
  set("void", "bone", 1.0);
  set("amethyst", "void", -1.0);
  set("azure", "void", -1.0);
  return m;
})();

export function factionRelation(a: string, b: string): number {
  const ai = FACTION_IDS[a];
  const bi = FACTION_IDS[b];
  if (ai === undefined || bi === undefined) return 0;
  return FACTION_REL_MATRIX[ai * NUM_FACTIONS + bi];
}

/** Hot-path lookup using pre-resolved integer faction ids. */
export function factionRelationById(ai: number, bi: number): number {
  return FACTION_REL_MATRIX[ai * NUM_FACTIONS + bi];
}

export const FACTION_STRIDE = NUM_FACTIONS;
