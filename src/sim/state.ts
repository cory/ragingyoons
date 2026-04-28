/**
 * BattleState — typed-array (structure-of-arrays) state for the sim.
 *
 * Determinism contract: state is mutated only inside `tick.ts` and its
 * subsystems. Setup helpers below are also allowed to mutate (they
 * build the initial state). Read access from outside should go through
 * `snapshot()` (added later) for clarity.
 */

import type { ContentBundle, CompDef, UnitDef } from "./content.js";
import {
  CURIOSITY_TO_IDX,
  ENV_TO_IDX,
  ROLE_TO_IDX,
} from "./content.js";
import { type RngState, makeRng, rngFloat } from "./rng.js";
import { applyBinHpSynergies, populateSynergyCounts } from "./subsys/synergy.js";
import { composeTactics, type TacticOverrideMap, type TacticProfile } from "./tactics.js";
import {
  DEFAULT_FORMATION_BY_ROLE,
  FORMATIONS,
  FORMATION_TO_IDX,
  type FormationId,
} from "./formations.js";
import { DOCTRINE_TO_IDX, DOCTRINES, STANDING_ORDER_TO_IDX, doctrineFor, squadSizeFor, teamSizeFor } from "./doctrines.js";

/** Cap on simultaneously-tracked entities. Generous for v0; tighten later. */
export const MAX_BINS = 32;
export const MAX_RACS = 1024;
export const MAX_ATKS = 1024;
/** Garrison slots per bin for the per-slot respawn timer table. */
export const MAX_GARRISON_SLOTS = 8;

export const TICK_RATE_HZ = 15;
export const SECONDS_PER_TICK = 1 / TICK_RATE_HZ;

export type Owner = 0 | 1;

export interface StatusInstance {
  /** Status id. */
  id: string;
  /** Remaining duration in seconds. */
  remaining: number;
  /** Source raccoon id, or -1 if environmental. */
  src: number;
  /** Time until next DoT tick (seconds), if applicable. */
  nextTickIn: number;
}

export interface BattleConfig {
  /** Seed for the RNG. */
  seed: number;
  /** Globally unique id for this battle (for log correlation). */
  battleId: string;
  /** Comp ids for player A and player B. */
  compA: string;
  compB: string;
  /** Battlefield bounds (x, y in meters). */
  bounds: { w: number; h: number };
  /** Logging verbosity (interpreted by the logger). */
  verbosity: "events" | "events+snapshots" | "silent";
  /** Optional per-role tactic overrides per side. Layered over the
   *  defaults in `tactics.ts`. Used by the A/B harness to swap a
   *  role's behavior on one side and measure the winrate delta. */
  tacticsA?: TacticOverrideMap;
  tacticsB?: TacticOverrideMap;
  /** When true, all synergy mods (env-2/3, cur-2/3 bonuses) are
   *  treated as identity — no HP/damage/speed/etc. boosts. Used by
   *  the doctrine autotuner to isolate doctrine balance from content
   *  bonuses. */
  disableSynergies?: boolean;
}

export interface BinTable {
  count: number;
  id: Int32Array;
  owner: Uint8Array;
  unitIdIdx: Int32Array; // index into state.unitIdTable
  /** Cached env / curiosity indices for fast synergy threshold counting. */
  envIdx: Uint8Array;
  curIdx: Uint8Array;
  hp: Float32Array;
  hpMax: Float32Array;
  x: Float32Array;
  y: Float32Array;
  starTier: Uint8Array;
  garrisonCap: Uint8Array;
  /** Slot respawn timers, packed [bin][slot]. -1 = slot empty (spawn now). */
  slotRespawnT: Float32Array;
  /** raccoon id occupying each slot, packed [bin][slot]. -1 = empty. */
  slotOccupant: Int32Array;
  alive: Uint8Array;
}

export interface RacTable {
  count: number;
  id: Int32Array;
  owner: Uint8Array;
  sourceBinId: Int32Array;
  /** Packed bin*MAX_GARRISON_SLOTS+slot, so on death we can mark the
   *  slot empty and start its respawn timer in O(1). */
  sourceSlotIdx: Int32Array;
  unitIdIdx: Int32Array;
  role: Uint8Array;
  env: Uint8Array;
  cur: Uint8Array;
  hp: Float32Array;
  hpMax: Float32Array;
  rage: Float32Array;
  rageCap: Float32Array;
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  facing: Float32Array;
  /** Previous-tick facing — used to detect rapid rotation for the
   *  "no-attack while spinning" rule. Boids writes facing every tick;
   *  before the write, the old value is copied into prevFacing. */
  prevFacing: Float32Array;
  targetId: Int32Array;
  /** 0 = no target, 1 = rac, 2 = bin. Pairs with targetId. */
  targetKind: Uint8Array;
  attackCooldown: Float32Array;
  /** Sparse — most raccoons have empty status list. */
  statuses: StatusInstance[][];
  alive: Uint8Array;
  /** Effective (post-status, post-synergy) stats. Recomputed each tick
   *  by status.ts. Boids reads effSpeed; combat reads effDamage /
   *  effRange / effAttackRate / effArmor; damage application multiplies
   *  incoming damage by dmgTakenMul. HP multiplier is applied at spawn
   *  time (see spawn.ts) since rebasing live max HP mid-battle is
   *  fragile (current HP > new max edge cases). */
  effSpeed: Float32Array;
  effDamage: Float32Array;
  effRange: Float32Array;
  effAttackRate: Float32Array;
  effArmor: Float32Array;
  dmgTakenMul: Float32Array;
  /** Surrounded damage multiplier — set by boidsTick each tick from
   *  positional context (enemies in ≥3 of 4 cardinal quadrants).
   *  Multiplied into incoming damage in combat.applyRacDamage. */
  surroundedDamageMul: Float32Array;
  /** Per-rac dirty flag — set when statuses change or the rac's side
   *  synergy state transitions, cleared after recomputeEffectiveStats.
   *  Lets statusTick skip the recompute for the common case of "no
   *  status applied or expired since last recompute, no synergy
   *  flipped." Saves ~half of statusTick on big battles. */
  statsDirty: Uint8Array;
  /** Index into FORMATIONS (src/sim/formations.ts) of the formation
   *  this rac was spawned under. Boids/combat lookup the formation's
   *  effective TacticProfile via state.formationProfile[owner][i]. */
  formationIdx: Uint8Array;
  /** Group id — racs of the same group cohere together; racs of
   *  different groups don't. Initially each bin's burst is one group;
   *  formation-split logic assigns new groupIds when a group exceeds
   *  the doctrine's maxFormationSize. Allocated from state.nextGroupId. */
  groupId: Uint16Array;
  /** 1 if any enemy is within CONTACT_RADIUS (set by boidsTick per
   *  tick from the spatial grid), else 0. Boids reads this to switch
   *  between formationProfile (march) and formationContactProfile
   *  (locked-shields). The Greek phalanx had distinct loose/dense/
   *  synaspismos modes — this is the v0 binary version. */
  contact: Uint8Array;
  /** Index into DOCTRINES (src/sim/doctrines.ts) — the rac's tactical
   *  pattern (phalanx, fire-team, skirmisher, line, default). Stamped
   *  at spawn from (env, cur). Boids modulates seek/cohesion based
   *  on doctrine rhythm. */
  doctrineIdx: Uint8Array;
  /** Sub-team index within bin's burst (0..N-1). Doctrines split a
   *  burst into teams (fire-team = 4 per team, skirmisher = 2). Teams
   *  get out-of-phase rhythm cycles so the pack appears to bound
   *  forward in alternation without per-team coordination logic. */
  teamId: Uint8Array;
  /** Per-rac slot offset relative to the rac's SQUAD LEADER (formation-
   *  space, with forward already mirrored by side at spawn). Boids
   *  cohesion pulls each follower toward `leaderPos + slot` so the
   *  squad holds its shape relative to its leader rather than to a
   *  drifting centroid. The leader itself has slot = (0, 0). Set once
   *  at spawn from `formation.arrange()`. */
  slotDx: Float32Array;
  slotDy: Float32Array;
  /** Per-rac morale in [0, 1]. Starts at 1.0 at spawn. Drops on damage
   *  taken; below MORALE_BREAK_THRESHOLD the rac is "broken" and falls
   *  back to full boid steering (it's no longer holding formation).
   *  Non-broken followers ignore boid forces entirely and aim straight
   *  at their slot — that's the formation discipline. Broken racs
   *  fight for themselves. v0 only decreases morale; rallying / repair
   *  is a future iteration. */
  morale: Float32Array;
  /** Squad membership. All racs in the same squad cohere around their
   *  leader. v0: assigned at spawn, never re-shuffled. Hierarchy
   *  beyond the squad (platoon, company, battalion) lands in a later
   *  slice. 0 = no squad (sentinel; spawn always assigns a real id). */
  squadId: Uint16Array;
  /** Rac id (NOT row) of this rac's squad leader. Followers point to
   *  their leader; leaders point to themselves. On leader death, the
   *  squad promotes its lowest-id surviving member; every follower's
   *  squadLeaderId gets rewritten to point at the new leader. -1 if
   *  the squad has been wiped. */
  squadLeaderId: Int32Array;
  /** Set by motionTick each tick: 1 if this rac is currently in
   *  formation (non-broken follower with a live leader, close enough
   *  to its slot target). Read by combat for the in-formation frontal
   *  bonus and by moraleTick / lab viz. */
  inFormation: Uint8Array;
  /** Behavior state — what this rac is currently doing. One of
   *  BEHAVIOR_MARCH / BEHAVIOR_ENGAGE / BEHAVIOR_ROUT (slice 1).
   *  Re-evaluated only at `nextDecisionTick`; between decisions the
   *  rac executes the same intent (no per-tick force-shifting). */
  behavior: Uint8Array;
  /** Tick at which this rac will next re-evaluate its behavior. Set
   *  to state.tick + BEHAVIOR_CADENCE_BY_ROLE[role] each time the
   *  rac decides. Lets cavalry react every tick while tanks commit
   *  for ~1 second between decisions. */
  nextDecisionTick: Int32Array;
  /** Tick through which this rac is "pinned" by a tank's melee
   *  attack. Set in combat each time a tank lands a basic hit;
   *  motion multiplies maxV by PIN_SPEED_MUL while state.tick is
   *  ≤ this value. Lets tanks anchor whatever they engage —
   *  cavalry overrun still moves but slowed, infantry can't easily
   *  disengage. 0 = not pinned. */
  pinnedUntilTick: Int32Array;
  /** Standing order — what this rac DOES by default. Stamped at
   *  spawn from the doctrine's standingOrder. Read by motionTick to
   *  modulate behavior decisions (hold doesn't march, charge engages
   *  early, etc.). One of STANDING_ORDER_IDX_*. */
  standingOrder: Uint8Array;
  /** Cached aim point for cadence-gated behaviors (RALLY / ROUT).
   *  Refreshed on the rac's decision tick when its intent depends on
   *  expensive lookups (nearest leader, nearest bin); reused on
   *  intervening ticks so we don't pay the lookup every frame. World
   *  coords. aimValid=0 means "no cached aim, recompute or fall back". */
  aimX: Float32Array;
  aimY: Float32Array;
  aimValid: Uint8Array;
}

/** In-flight ranged projectiles (currently archer arrows). Dumb-fire:
 *  velocity is set at spawn from source→target direction at that
 *  instant. Each tick projectile.ts advances each one and does a
 *  swept-segment hit test against any alive rac (skipping the source)
 *  and any alive bin. First hit (lowest segment-t) takes the damage —
 *  including friendly fire, which is the *point*: a tank in front of an
 *  archer eats the arrow and the archer learns to be in the back row. */
export interface AtkTable {
  count: number;
  id: Int32Array;
  sourceRacId: Int32Array;
  /** Owner of the firing raccoon. Not strictly needed for collision
   *  (friendly fire is on) but kept for o11y attribution after the
   *  source dies. */
  sourceOwner: Uint8Array;
  kindIdx: Uint8Array; // tbd enum
  damage: Float32Array;
  appliesStatusIds: string[][];
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  /** Hit radius for collision (entity radius + projectile radius). */
  radius: Float32Array;
  ttl: Float32Array;
  alive: Uint8Array;
}

export interface BattleState {
  tick: number;
  rng: RngState;
  battleId: string;
  contentVersion: string;
  seed: number;
  bounds: { w: number; h: number };
  /** Side-by-side string interning for unit ids. unitIdIdx fields index here. */
  unitIdTable: string[];
  bin: BinTable;
  rac: RacTable;
  atk: AtkTable;
  /** Monotonic id counters. */
  nextBinId: number;
  nextRacId: number;
  nextAtkId: number;
  /** Monotonic group id counter — incremented at each burst spawn
   *  and at each formation split. */
  nextGroupId: number;
  /** Monotonic squad id counter — incremented for every new squad
   *  assigned at spawn time. v0: never reused. */
  nextSquadId: number;
  winner: -1 | 0 | 1;
  endReason: "last-raccoon" | "all-bins" | "timeout" | "tiebreak" | "draw" | null;
  /** Per-side per-role tactic profile, set at setup. Subsystems read
   *  `tacticPerSide[owner][role]` for behavior knobs (boid weights,
   *  kite distances, target rethink cadence, rage rates). */
  tacticPerSide: TacticProfile[][];
  /** Per-side per-formation effective profile, set at setup. Composed
   *  as: defaults → role override → per-side override → formation
   *  override. Subsystems read `formationProfile[owner][formationIdx]`
   *  to get the live profile for a specific rac. */
  formationProfile: TacticProfile[][];
  /** Per-side per-formation profile applied when the rac is in
   *  contact with enemies (any enemy within CONTACT_RADIUS). For
   *  formations with no contactOverride, this is identical to
   *  formationProfile. Boids switches between them per-rac per-tick
   *  based on state.rac.contact. */
  formationContactProfile: TacticProfile[][];
  /** Synergy scratch state. Populated by synergyTick; read by status
   *  recompute. Typed loosely to avoid a circular import. */
  _synergy?: import("./subsys/synergy.js").SynergyState;
  /** Boid influence fields, lazily allocated on first use of boidsTick.
   *  Reused across ticks (zero+rebuild per tick). */
  _boidFields?: import("./fields.js").BoidFields;
  /** Per-tick rac spatial grid, rebuilt at the top of each tick by
   *  tick.ts. Shared by combat (in-range enemy scan) and target
   *  (nearest enemy). Replaces the O(N²) inner loops those subsystems
   *  used to do. */
  _racGrid?: import("./grid.js").SpatialGrid;
  /** Per-tick shuffled rac iteration order (length = rac.count).
   *  Subsystems that iterate "for each alive rac" should walk this
   *  permutation, not the raw row order, to break iteration-order
   *  side bias (side-0 always-spawns-first means side-0 racs always
   *  have lower row indices, so row-major iteration systematically
   *  favors side-0 in any "first writer wins" tie). Built each tick
   *  from a tick-seeded RNG independent of state.rng → deterministic
   *  per (seed, tick), reproducible across runs. */
  _tickIterOrder?: Int32Array;
  /** id → row index lookup tables. Maintained by spawn/death code paths
   *  so findRacRowById / findBinRowById are O(1) instead of O(N). */
  racRowById: Map<number, number>;
  binRowById: Map<number, number>;
  /** When true, synergyModsFor / synergyBinMods return identity. Set
   *  from BattleConfig.disableSynergies; read by synergy.ts. */
  disableSynergies?: boolean;
  /** Steering-lab: when set, boidsTick gates each force term by these
   *  flags (true = enabled). Missing / undefined = enabled. Lets the
   *  lab toggle individual forces to study their isolated effects. */
  forceFlags?: Partial<Record<ForceFlag, boolean>>;
  /** Steering-lab: when truthy, boidsTick writes per-rac force-component
   *  vectors here at the END of the tick. Layout: 12 floats per rac
   *  (6 components × {x,y}) — see ForceComponent for indices. The
   *  array is sized state.rac.count × 12; subsystems consuming it
   *  index by `racRow * 12 + (component * 2 + axis)`. Set this to a
   *  Float32Array of the right size before running ticks; clear the
   *  field (set undefined) to disable the capture. Captured at end of
   *  tick so visualizing a single tick frame matches what the rac
   *  actually used to move. */
  _debugForces?: Float32Array;
  /** Built each retargeting tick by targetTick: rac ROW → count of
   *  same-tick racs currently aiming at that rac. Read by the
   *  saturation penalty in target scoring so a target with many
   *  attackers gets deprioritized vs a less-saturated one. Reused
   *  buffer; sim resets to 0 at the top of each retargeting pass. */
  _attackerCountByRow?: Int32Array;
  /** Built each retargeting tick by targetTick: 0/1 flag per (side,
   *  row) — 1 if rac at row is within BIN_DEFENSE_RADIUS of any
   *  bin owned by `side`. Read by inner scoring to apply the
   *  bin-defense multiplier. Indexed as side*MAX_RACS + row. */
  _defenseFlag?: Uint8Array;
  /** Built each tick by moraleTick: squadId → flank/rear threat level
   *  (0=none, 1=flank, 2=rear). Used by the lab to surface "this
   *  squad is being outflanked" in the tooltip; the morale penalty
   *  itself is applied per-rac in moraleTick. */
  squadFlankThreat?: Map<number, number>;
  /** Steering-lab: when set, motionTick writes per-rac FLANK probe
   *  data here so the lab can show what the edge-finding search is
   *  actually finding. Layout: FLANK_DEBUG_FLOATS_PER_RAC floats per
   *  rac — see FLANK_DEBUG_OFFSET. Indexed by row × FLANK_DEBUG_FLOATS_PER_RAC. */
  _debugFlank?: Float32Array;
}

/** Per-rac layout for state._debugFlank (steering-lab visualization). */
export const FLANK_DEBUG_FLOATS_PER_RAC = 24;
export const FLANK_DEBUG_OFFSET = {
  /** 1 if this rac was in BEHAVIOR_FLANK this tick, else 0. */
  inFlank: 0,
  /** Which probe step found the edge (1..N), or -1 if no edge in
   *  range. Encoded as a float for typed-array convenience. */
  edgeStep: 1,
  /** World-space aim point chosen by the FLANK intent (where cavalry
   *  is heading). 2 floats. */
  aimX: 2,
  aimY: 3,
  /** Density gradient at the rac (normalized). 2 floats. Zero if
   *  no gradient (we're past the line). */
  gradX: 4,
  gradY: 5,
  /** Chosen perpendicular direction (after sign flip toward target).
   *  2 floats. */
  perpX: 6,
  perpY: 7,
  /** 8 probe points: (x, y) each, in world space. 16 floats. Order
   *  matches probe step 1..8. */
  probesXY: 8,
} as const;

/** Force-flag identifiers — match the boid force-term names. The lab
 *  uses these as both checkbox labels and field keys in forceFlags. */
export type ForceFlag =
  | "separation"
  | "closeRange"
  | "cohesion"
  | "alignment"
  | "seek"
  | "hide"
  | "avoid"
  | "envelopment"
  | "doctrineMod"
  | "slotOffset";

/** Index of each force component in _debugForces. Two floats per
 *  component (x, y). Multiply by 2 to get the float offset within a
 *  rac's 12-float slot. */
export const FORCE_COMPONENT_INDEX = {
  separation: 0,
  cohesion: 1,
  alignment: 2,
  seek: 3,
  hide: 4,
  avoid: 5,
} as const;
export const FORCE_COMPONENT_COUNT = 6;
export const FORCE_FLOATS_PER_RAC = FORCE_COMPONENT_COUNT * 2;

export function emptyBins(): BinTable {
  return {
    count: 0,
    id: new Int32Array(MAX_BINS),
    owner: new Uint8Array(MAX_BINS),
    unitIdIdx: new Int32Array(MAX_BINS),
    envIdx: new Uint8Array(MAX_BINS),
    curIdx: new Uint8Array(MAX_BINS),
    hp: new Float32Array(MAX_BINS),
    hpMax: new Float32Array(MAX_BINS),
    x: new Float32Array(MAX_BINS),
    y: new Float32Array(MAX_BINS),
    starTier: new Uint8Array(MAX_BINS),
    garrisonCap: new Uint8Array(MAX_BINS),
    slotRespawnT: new Float32Array(MAX_BINS * MAX_GARRISON_SLOTS),
    slotOccupant: new Int32Array(MAX_BINS * MAX_GARRISON_SLOTS),
    alive: new Uint8Array(MAX_BINS),
  };
}

export function emptyRacs(): RacTable {
  return {
    count: 0,
    id: new Int32Array(MAX_RACS),
    owner: new Uint8Array(MAX_RACS),
    sourceBinId: new Int32Array(MAX_RACS),
    sourceSlotIdx: new Int32Array(MAX_RACS),
    unitIdIdx: new Int32Array(MAX_RACS),
    role: new Uint8Array(MAX_RACS),
    env: new Uint8Array(MAX_RACS),
    cur: new Uint8Array(MAX_RACS),
    hp: new Float32Array(MAX_RACS),
    hpMax: new Float32Array(MAX_RACS),
    rage: new Float32Array(MAX_RACS),
    rageCap: new Float32Array(MAX_RACS),
    x: new Float32Array(MAX_RACS),
    y: new Float32Array(MAX_RACS),
    vx: new Float32Array(MAX_RACS),
    vy: new Float32Array(MAX_RACS),
    facing: new Float32Array(MAX_RACS),
    prevFacing: new Float32Array(MAX_RACS),
    targetId: new Int32Array(MAX_RACS),
    targetKind: new Uint8Array(MAX_RACS),
    attackCooldown: new Float32Array(MAX_RACS),
    statuses: Array.from({ length: MAX_RACS }, () => []),
    alive: new Uint8Array(MAX_RACS),
    effSpeed: new Float32Array(MAX_RACS),
    effDamage: new Float32Array(MAX_RACS),
    effRange: new Float32Array(MAX_RACS),
    effAttackRate: new Float32Array(MAX_RACS),
    effArmor: new Float32Array(MAX_RACS),
    dmgTakenMul: new Float32Array(MAX_RACS),
    surroundedDamageMul: new Float32Array(MAX_RACS),
    statsDirty: new Uint8Array(MAX_RACS),
    formationIdx: new Uint8Array(MAX_RACS),
    contact: new Uint8Array(MAX_RACS),
    doctrineIdx: new Uint8Array(MAX_RACS),
    teamId: new Uint8Array(MAX_RACS),
    groupId: new Uint16Array(MAX_RACS),
    slotDx: new Float32Array(MAX_RACS),
    slotDy: new Float32Array(MAX_RACS),
    morale: new Float32Array(MAX_RACS),
    squadId: new Uint16Array(MAX_RACS),
    squadLeaderId: new Int32Array(MAX_RACS),
    inFormation: new Uint8Array(MAX_RACS),
    behavior: new Uint8Array(MAX_RACS),
    nextDecisionTick: new Int32Array(MAX_RACS),
    pinnedUntilTick: new Int32Array(MAX_RACS),
    standingOrder: new Uint8Array(MAX_RACS),
    aimX: new Float32Array(MAX_RACS),
    aimY: new Float32Array(MAX_RACS),
    aimValid: new Uint8Array(MAX_RACS),
  };
}

export function emptyAtks(): AtkTable {
  return {
    count: 0,
    id: new Int32Array(MAX_ATKS),
    sourceRacId: new Int32Array(MAX_ATKS),
    sourceOwner: new Uint8Array(MAX_ATKS),
    kindIdx: new Uint8Array(MAX_ATKS),
    damage: new Float32Array(MAX_ATKS),
    appliesStatusIds: Array.from({ length: MAX_ATKS }, () => []),
    x: new Float32Array(MAX_ATKS),
    y: new Float32Array(MAX_ATKS),
    vx: new Float32Array(MAX_ATKS),
    vy: new Float32Array(MAX_ATKS),
    radius: new Float32Array(MAX_ATKS),
    ttl: new Float32Array(MAX_ATKS),
    alive: new Uint8Array(MAX_ATKS),
  };
}

/** v0a slot layout: 2×2 = 4 bins per player, mirrored across the y-axis.
 *  Player 0 at +x, player 1 at -x. */
function placementForOwner(idx: number, owner: Owner, bounds: { w: number; h: number }) {
  const col = idx % 2;
  const row = Math.floor(idx / 2);
  const sign = owner === 0 ? 1 : -1;
  const x = sign * (bounds.w * 0.30 + col * bounds.w * 0.10);
  const y = (row - 0.5) * bounds.h * 0.30;
  return { x, y };
}

/** Synthetic battle config — N units of one type marching to a single
 *  enemy bin. Used by the designer's shape-lab cells in CompareView
 *  to tune formation visuals without the full comp-vs-comp dynamics. */
export interface ShapeBattleSide {
  /** Unit id (env+cur+role-encoded) for the rac type. */
  unitId: string;
  /** Number of racs to spawn for this side. */
  count: number;
  /** Optional formation override; falls back to role default. */
  formationId?: FormationId;
  /** Max racs per platoon. */
  maxPlatoonSize?: number;
  /** Stride along march axis between platoons. */
  platoonStride?: number;
}

export interface ShapeBattleConfig {
  seed: number;
  battleId: string;
  bounds: { w: number; h: number };
  /** Side 0 (blue, friendly). */
  unitId: string;
  count: number;
  formationId?: FormationId;
  maxPlatoonSize?: number;
  platoonStride?: number;
  /** Side 1 mode A — punching-bag: a single immortal bin no racs.
   *  Used for "march and observe" testing. Required if `redSide` is
   *  not set. */
  enemyBinUnitId: string;
  enemyBinHp?: number;
  /** Side 1 mode B — real opposing units. When set, the enemy bin is
   *  STILL placed (so any code that needs an enemy structure works)
   *  but red side ALSO spawns racs that target the blue side. Lets
   *  the lab study two-unit interactions: phalanx vs cavalry, etc. */
  redSide?: ShapeBattleSide;
  disableSynergies?: boolean;
}

/** Spawn one side's racs as a column of platoons of squads, returns
 *  nothing — mutates state. Used by setupShapeBattle for both blue
 *  and red sides; keeps the per-side spawn logic in one place. */
function spawnSideRacs(
  state: BattleState,
  content: ContentBundle,
  side: ShapeBattleSide,
  owner: Owner,
  baseX: number,
  baseY: number,
  forward: number,
  defaultTargetId: number,
  defaultTargetKind: number,
  sourceBinId: number,
): void {
  const unit = content.units.get(side.unitId);
  if (!unit) throw new Error(`unknown unit "${side.unitId}"`);
  const formationId = side.formationId ?? DEFAULT_FORMATION_BY_ROLE[unit.role];
  const formationIdx = FORMATION_TO_IDX[formationId];
  const formation = FORMATIONS[formationIdx];
  const doctrineId = doctrineFor(unit.environment, unit.curiosity);
  const doctrineIdx = DOCTRINE_TO_IDX[doctrineId];
  const teamSize = teamSizeFor(doctrineIdx);
  const profile = state.formationProfile[owner][formationIdx];
  const maxPlatoon = side.maxPlatoonSize && side.maxPlatoonSize > 0 ? side.maxPlatoonSize : side.count;
  const platoonStride = side.platoonStride ?? 6;
  const squadSize = squadSizeFor(unit.role, DOCTRINES[doctrineIdx]);
  const effMaxPlatoon = Math.max(maxPlatoon, squadSize);
  const effPlatoonCount = Math.max(1, Math.ceil(side.count / effMaxPlatoon));
  const squadStrideY = (squadSize + 2) * 1.4;
  let remaining = side.count;
  // Initial facing: side 0 racs face +x (forward=+1), side 1 racs face -x.
  const initialFacing = forward > 0 ? 0 : Math.PI;
  for (let p = 0; p < effPlatoonCount; p++) {
    const thisPlatoonSize = Math.min(effMaxPlatoon, remaining);
    if (thisPlatoonSize <= 0) break;
    remaining -= thisPlatoonSize;
    // Reserves trail BEHIND the front platoon (away from enemy).
    const platoonX = baseX - forward * p * platoonStride;
    const platoonY = baseY;
    const squadCount = Math.max(1, Math.ceil(thisPlatoonSize / squadSize));
    let platoonRemaining = thisPlatoonSize;
    for (let s = 0; s < squadCount; s++) {
      const thisSquadSize = Math.min(squadSize, platoonRemaining);
      if (thisSquadSize <= 0) break;
      platoonRemaining -= thisSquadSize;
      const squadId = state.nextSquadId++;
      const groupId = state.nextGroupId++;
      const sCenterY = platoonY + (s - (squadCount - 1) * 0.5) * squadStrideY;
      const sCenterX = platoonX;
      const leaderBurstIdx = Math.floor(thisSquadSize / 2);
      const leaderOff = formation.arrange({
        burstIdx: leaderBurstIdx,
        burstSize: thisSquadSize,
        forward,
      });
      const squadStartRow = state.rac.count;
      for (let k = 0; k < thisSquadSize; k++) {
        if (state.rac.count >= state.rac.id.length) break;
        const off = formation.arrange({ burstIdx: k, burstSize: thisSquadSize, forward });
        const jx = (rngFloat(state.rng) - 0.5) * 0.2;
        const jy = (rngFloat(state.rng) - 0.5) * 0.2;
        const racRow = state.rac.count;
        const racId = state.nextRacId++;
        state.rac.id[racRow] = racId;
        state.racRowById.set(racId, racRow);
        state.rac.owner[racRow] = owner;
        state.rac.sourceBinId[racRow] = sourceBinId;
        state.rac.sourceSlotIdx[racRow] = -1;
        state.rac.unitIdIdx[racRow] = internUnitId(state, unit.id);
        state.rac.role[racRow] = ROLE_TO_IDX[unit.role];
        state.rac.env[racRow] = ENV_TO_IDX[unit.environment];
        state.rac.cur[racRow] = CURIOSITY_TO_IDX[unit.curiosity];
        state.rac.hp[racRow] = unit.stats.hp;
        state.rac.hpMax[racRow] = unit.stats.hp;
        state.rac.rage[racRow] = 0;
        state.rac.rageCap[racRow] = unit.rage.capacity;
        state.rac.x[racRow] = sCenterX + off.dx + jx;
        state.rac.y[racRow] = sCenterY + off.dy + jy;
        state.rac.vx[racRow] = 0;
        state.rac.vy[racRow] = 0;
        state.rac.facing[racRow] = initialFacing;
        state.rac.prevFacing[racRow] = initialFacing;
        state.rac.targetId[racRow] = defaultTargetId;
        state.rac.targetKind[racRow] = defaultTargetKind;
        state.rac.attackCooldown[racRow] = 0;
        state.rac.statuses[racRow] = [];
        state.rac.alive[racRow] = 1;
        state.rac.effSpeed[racRow] = unit.stats.speed * profile.speedMul;
        state.rac.effDamage[racRow] = unit.stats.damage;
        state.rac.effRange[racRow] = unit.stats.range;
        state.rac.effAttackRate[racRow] = unit.stats.attack_rate;
        state.rac.effArmor[racRow] = unit.stats.armor;
        state.rac.dmgTakenMul[racRow] = 1;
        state.rac.surroundedDamageMul[racRow] = 1;
        state.rac.formationIdx[racRow] = formationIdx;
        state.rac.doctrineIdx[racRow] = doctrineIdx;
        state.rac.teamId[racRow] = Math.floor(k / teamSize);
        state.rac.groupId[racRow] = groupId;
        state.rac.slotDx[racRow] = off.dx - leaderOff.dx;
        state.rac.slotDy[racRow] = off.dy - leaderOff.dy;
        state.rac.morale[racRow] = 1.0;
        state.rac.squadId[racRow] = squadId;
        state.rac.squadLeaderId[racRow] = -1;
        state.rac.standingOrder[racRow] =
          STANDING_ORDER_TO_IDX[DOCTRINES[doctrineIdx].standingOrder];
        state.rac.count = racRow + 1;
      }
      const leaderRow = squadStartRow + leaderBurstIdx;
      if (leaderRow < state.rac.count) {
        const leaderRacId = state.rac.id[leaderRow];
        for (let r = squadStartRow; r < state.rac.count; r++) {
          state.rac.squadLeaderId[r] = leaderRacId;
        }
      }
    }
  }
}

/** Build a state for the shape-lab. Two modes:
 *  - Punching-bag (default): one immortal bin on side 1, blue racs
 *    pre-targeted on it. Used to study formation shape on the march.
 *  - Two-army (`redSide` set): red side spawns racs that face blue,
 *    no bin — both sides target each other via targetTick. Used to
 *    study army-vs-army interactions (phalanx vs cavalry, etc). */
export function setupShapeBattle(content: ContentBundle, cfg: ShapeBattleConfig): BattleState {
  const unit = content.units.get(cfg.unitId);
  if (!unit) throw new Error(`unknown unit "${cfg.unitId}"`);

  const state: BattleState = {
    tick: 0,
    rng: makeRng(cfg.seed),
    battleId: cfg.battleId,
    contentVersion: content.version,
    seed: cfg.seed,
    bounds: cfg.bounds,
    unitIdTable: [],
    bin: emptyBins(),
    rac: emptyRacs(),
    atk: emptyAtks(),
    nextBinId: 1,
    nextRacId: 1,
    nextAtkId: 1,
    nextGroupId: 1,
    nextSquadId: 1,
    winner: -1,
    endReason: null,
    tacticPerSide: composeTactics(),
    formationProfile: [[], []],
    formationContactProfile: [[], []],
    racRowById: new Map(),
    binRowById: new Map(),
    disableSynergies: cfg.disableSynergies ?? false,
  };
  composeFormationProfiles(state);

  const halfW = cfg.bounds.w * 0.5;
  const useTwoArmy = !!cfg.redSide;

  // Helper: place one bin (side 1 = enemy bag in punching mode, or
  // both sides in two-army mode for retreat-and-defend behavior).
  const placeBin = (
    owner: 0 | 1,
    binUnitId: string,
    bx: number,
    by: number,
    hp: number,
  ): number => {
    const u = content.units.get(binUnitId);
    if (!u) throw new Error(`unknown bin unit "${binUnitId}"`);
    const slot = state.bin.count;
    state.bin.id[slot] = state.nextBinId++;
    state.bin.owner[slot] = owner;
    state.bin.unitIdIdx[slot] = internUnitId(state, u.id);
    state.bin.envIdx[slot] = ENV_TO_IDX[u.environment];
    state.bin.curIdx[slot] = CURIOSITY_TO_IDX[u.curiosity];
    state.bin.hp[slot] = hp;
    state.bin.hpMax[slot] = hp;
    state.bin.x[slot] = bx;
    state.bin.y[slot] = by;
    state.bin.starTier[slot] = 1;
    state.bin.garrisonCap[slot] = 0;
    for (let s = 0; s < MAX_GARRISON_SLOTS; s++) {
      state.bin.slotRespawnT[slot * MAX_GARRISON_SLOTS + s] = Number.POSITIVE_INFINITY;
      state.bin.slotOccupant[slot * MAX_GARRISON_SLOTS + s] = -1;
    }
    state.bin.alive[slot] = 1;
    state.bin.count = slot + 1;
    state.binRowById.set(state.bin.id[slot], slot);
    return state.bin.id[slot];
  };

  // Bin placement:
  //  - Punching-bag mode: one immortal bin on side 1 only. Used for
  //    "march and observe" testing; HP defaults to 1e9 so the battle
  //    runs to timeout.
  //  - Two-army mode: a bin BEHIND each side's spawn so racs have
  //    something to retreat to (and defend) and the other side has
  //    something to push toward. Default HP 500 — durable enough that
  //    the battle is won by killing racs first, but the bin can still
  //    fall once a side breaks.
  let blueBinId = -1;
  let redBinId = -1;
  if (!useTwoArmy) {
    redBinId = placeBin(1, cfg.enemyBinUnitId, halfW * 0.6, 0, cfg.enemyBinHp ?? 1e9);
  } else {
    // Place a bin behind each side. Use each side's own unit as the
    // bin unit (so visualization/role makes sense), with default HP
    // for two-army battles.
    const TWO_ARMY_BIN_HP = cfg.enemyBinHp ?? 500;
    blueBinId = placeBin(0, cfg.unitId, -halfW * 0.85, 0, TWO_ARMY_BIN_HP);
    redBinId = placeBin(1, cfg.redSide!.unitId, halfW * 0.85, 0, TWO_ARMY_BIN_HP);
  }

  // Side 0 (blue): forward=+1 (enemy is at +x). In punching-bag mode
  // racs are pre-targeted on the lone enemy bin. In two-army mode the
  // initial target is left as -1; targetTick picks nearest enemy
  // (rac or bin) on its first run.
  spawnSideRacs(
    state,
    content,
    {
      unitId: cfg.unitId,
      count: cfg.count,
      formationId: cfg.formationId,
      maxPlatoonSize: cfg.maxPlatoonSize,
      platoonStride: cfg.platoonStride,
    },
    0,
    -halfW * 0.6,
    0,
    1,
    useTwoArmy ? -1 : redBinId,
    useTwoArmy ? TARGET_KIND_NONE : TARGET_KIND_BIN,
    blueBinId,
  );

  if (cfg.redSide) {
    spawnSideRacs(
      state,
      content,
      cfg.redSide,
      1,
      halfW * 0.6,
      0,
      -1,
      -1,
      TARGET_KIND_NONE,
      redBinId,
    );
  }

  return state;
}

/** Build a battle state from two comp ids. Uses the FIRST four bins listed
 *  in each comp (expanding by `count`), so a comp with [{rabble, 3}] gives
 *  three Rabble bins; we cap at 4 per side. */
export function setupBattle(content: ContentBundle, cfg: BattleConfig): BattleState {
  const compA = content.comps.get(cfg.compA);
  const compB = content.comps.get(cfg.compB);
  if (!compA) throw new Error(`unknown comp "${cfg.compA}"`);
  if (!compB) throw new Error(`unknown comp "${cfg.compB}"`);

  const state: BattleState = {
    tick: 0,
    rng: makeRng(cfg.seed),
    battleId: cfg.battleId,
    contentVersion: content.version,
    seed: cfg.seed,
    bounds: cfg.bounds,
    unitIdTable: [],
    bin: emptyBins(),
    rac: emptyRacs(),
    atk: emptyAtks(),
    nextBinId: 1,
    nextRacId: 1,
    nextAtkId: 1,
    nextGroupId: 1,
    nextSquadId: 1,
    winner: -1,
    endReason: null,
    tacticPerSide: composeTactics(cfg.tacticsA, cfg.tacticsB),
    formationProfile: [[], []],
    formationContactProfile: [[], []],
    racRowById: new Map(),
    binRowById: new Map(),
    disableSynergies: cfg.disableSynergies ?? false,
  };
  // Compose per-formation effective profiles for both sides. Indexed
  // by formation index (FORMATIONS array), one TacticProfile per side
  // per formation.
  composeFormationProfiles(state);

  placeComp(state, content, compA, 0);
  placeComp(state, content, compB, 1);

  // Populate synergy counts and apply bin-side stat mods (Suburban-2
  // bin HP) at setup so the very first damage_apply event sees the
  // correct bin HP. Synchronous import via a top-level statement at
  // file head (see imports above).
  populateSynergyCounts(state);
  applyBinHpSynergies(state);

  return state;
}

/** Compose state.formationProfile[side][formationIdx] AND
 *  state.formationContactProfile[side][formationIdx] from per-side
 *  role profile + each formation's tacticOverride / contactOverride.
 *  Run once at setup so subsystems can do an O(1) lookup per rac.
 *  Exported so tests and the lab can rebuild after constructing
 *  tacticPerSide. */
export function composeFormationProfiles(state: BattleState): void {
  for (let side = 0 as Owner; side < 2; side = (side + 1) as Owner) {
    state.formationProfile[side] = new Array(FORMATIONS.length);
    state.formationContactProfile[side] = new Array(FORMATIONS.length);
    for (let i = 0; i < FORMATIONS.length; i++) {
      const f = FORMATIONS[i];
      const roleIdx = ROLE_TO_IDX[f.role];
      const base = state.tacticPerSide[side][roleIdx];
      const march = { ...base, ...f.tacticOverride };
      state.formationProfile[side][i] = march;
      // Contact mode: layer contactOverride on top of march. If
      // omitted, contact == march (formation has only one mode).
      state.formationContactProfile[side][i] = f.contactOverride
        ? { ...march, ...f.contactOverride }
        : march;
    }
  }
}

function placeComp(state: BattleState, content: ContentBundle, comp: CompDef, owner: Owner): void {
  const bins: { unit: UnitDef }[] = [];
  for (const ref of comp.bins) {
    const u = content.units.get(ref.id);
    if (!u) continue; // already validated at load, defensive
    for (let k = 0; k < ref.count && bins.length < 4; k++) bins.push({ unit: u });
  }
  for (let i = 0; i < bins.length; i++) {
    const u = bins[i].unit;
    const slot = state.bin.count;
    const { x, y } = placementForOwner(i, owner, state.bounds);
    const unitIdIdx = internUnitId(state, u.id);
    state.bin.id[slot] = state.nextBinId++;
    state.bin.owner[slot] = owner;
    state.bin.unitIdIdx[slot] = unitIdIdx;
    state.bin.envIdx[slot] = ENV_TO_IDX[u.environment];
    state.bin.curIdx[slot] = CURIOSITY_TO_IDX[u.curiosity];
    state.bin.hp[slot] = u.bin.hp;
    state.bin.hpMax[slot] = u.bin.hp;
    state.bin.x[slot] = x;
    state.bin.y[slot] = y;
    state.bin.starTier[slot] = 1;
    state.bin.garrisonCap[slot] = Math.min(u.bin.garrison_cap, MAX_GARRISON_SLOTS);
    for (let s = 0; s < MAX_GARRISON_SLOTS; s++) {
      state.bin.slotRespawnT[slot * MAX_GARRISON_SLOTS + s] = 0;
      state.bin.slotOccupant[slot * MAX_GARRISON_SLOTS + s] = -1;
    }
    state.bin.alive[slot] = 1;
    state.bin.count = slot + 1;
    state.binRowById.set(state.bin.id[slot], slot);
    // Pre-mark role/env/cur indices for whatever subsystem wants them later.
    void ROLE_TO_IDX[u.role];
    void ENV_TO_IDX[u.environment];
    void CURIOSITY_TO_IDX[u.curiosity];
  }
}

function internUnitId(state: BattleState, unitId: string): number {
  let idx = state.unitIdTable.indexOf(unitId);
  if (idx < 0) {
    idx = state.unitIdTable.length;
    state.unitIdTable.push(unitId);
  }
  return idx;
}

/** Emit one `bin_spawn` event per bin currently in state. Call once after
 *  `setupBattle` (and after the caller's own `battle_start`) so the log
 *  has a registry of bin ids to attribute later events to. */
export function logSetupEvents(state: BattleState, log: import("./log.js").Logger): void {
  for (let i = 0; i < state.bin.count; i++) {
    log.emit("bin_spawn", {
      bin_id: state.bin.id[i],
      owner: state.bin.owner[i],
      unit_id: state.unitIdTable[state.bin.unitIdIdx[i]],
      hp: state.bin.hp[i],
      x: state.bin.x[i],
      y: state.bin.y[i],
      garrison_cap: state.bin.garrisonCap[i],
      star_tier: state.bin.starTier[i],
    });
  }
}

/** Read-only summary used for tick_summary log events and quick UI checks.
 *
 * Includes spatial aggregates (centroid distance, min enemy pair distance)
 * so o11y can verify "things are moving / engaging" without per-tick
 * position dumps. */
export function summarize(state: BattleState): {
  bins_alive_a: number;
  bins_alive_b: number;
  racs_alive_a: number;
  racs_alive_b: number;
  centroid_dist: number;
  min_enemy_dist: number;
} {
  let ba = 0,
    bb = 0,
    ra = 0,
    rb = 0;
  for (let i = 0; i < state.bin.count; i++) {
    if (!state.bin.alive[i]) continue;
    if (state.bin.owner[i] === 0) ba++;
    else bb++;
  }
  let aSumX = 0,
    aSumY = 0,
    bSumX = 0,
    bSumY = 0;
  for (let i = 0; i < state.rac.count; i++) {
    if (!state.rac.alive[i]) continue;
    if (state.rac.owner[i] === 0) {
      ra++;
      aSumX += state.rac.x[i];
      aSumY += state.rac.y[i];
    } else {
      rb++;
      bSumX += state.rac.x[i];
      bSumY += state.rac.y[i];
    }
  }
  let centroidDist = -1;
  if (ra > 0 && rb > 0) {
    const dx = aSumX / ra - bSumX / rb;
    const dy = aSumY / ra - bSumY / rb;
    centroidDist = Math.hypot(dx, dy);
  }
  let minEnemy = -1;
  if (ra > 0 && rb > 0) {
    let best = Infinity;
    for (let i = 0; i < state.rac.count; i++) {
      if (!state.rac.alive[i] || state.rac.owner[i] !== 0) continue;
      for (let j = 0; j < state.rac.count; j++) {
        if (!state.rac.alive[j] || state.rac.owner[j] !== 1) continue;
        const dx = state.rac.x[i] - state.rac.x[j];
        const dy = state.rac.y[i] - state.rac.y[j];
        const d2 = dx * dx + dy * dy;
        if (d2 < best) best = d2;
      }
    }
    minEnemy = Math.sqrt(best);
  }
  return {
    bins_alive_a: ba,
    bins_alive_b: bb,
    racs_alive_a: ra,
    racs_alive_b: rb,
    centroid_dist: centroidDist,
    min_enemy_dist: minEnemy,
  };
}

/** Returns the row index of an alive raccoon by its id, or -1.
 *  O(1) via state.racRowById; the map is updated on spawn (in
 *  spawn.ts) and on death (in spawn.ts:freeRacSlot / combat.ts:
 *  markRacDead). Falls back to -1 if the id isn't tracked or the row
 *  is no longer alive. */
export function findRacRowById(state: BattleState, id: number): number {
  if (id < 0) return -1;
  const row = state.racRowById.get(id);
  if (row === undefined) return -1;
  if (!state.rac.alive[row]) return -1;
  return row;
}

export function findBinRowById(state: BattleState, id: number): number {
  if (id < 0) return -1;
  const row = state.binRowById.get(id);
  if (row === undefined) return -1;
  if (!state.bin.alive[row]) return -1;
  return row;
}

export const TARGET_KIND_NONE = 0;
export const TARGET_KIND_RAC = 1;
export const TARGET_KIND_BIN = 2;

/** Morale below this fraction → rac is "broken" — drops formation
 *  discipline and switches to full boid steering (everyone-for-itself).
 *  This is the FALLBACK; per-env values below override per-rac. */
export const MORALE_BREAK_THRESHOLD = 0.3;
/** Per-environment break threshold. Discipline is an environmental
 *  trait: city raccoons grew up in tight crowded streets and hold
 *  formation longer; coastal raccoons are independent beach scavengers
 *  who break to lone-wolf mode at the slightest pressure. Values are
 *  *threshold* — lower means harder to break. Indexed by ENV_TO_IDX
 *  ordering (city=0, suburban=1, park=2, coastal=3). */
export const MORALE_BREAK_THRESHOLD_BY_ENV: readonly number[] = [
  0.1, // city: tight discipline
  0.2, // suburban: hold the line (phalanx fits this)
  0.4, // park: tricksters, easier to scatter
  0.5, // coastal: lone rangers, break fast
];
/** Damage → morale loss multiplier. damage / hpMax × this is subtracted
 *  from morale on each damage application. 0.6 means a single hit for
 *  half max HP drops morale by 0.3 — past the default break threshold
 *  in one big blow, but small ticks of damage barely move the needle. */
export const MORALE_DAMAGE_MUL = 0.6;
/** Separation force multiplier for broken racs. In formation, racs
 *  use slot-direct steering and don't feel field separation at all.
 *  Once broken, they switch to full boid forces — and we want them
 *  to actively spread out (panicking troops give each other space)
 *  rather than just clustering with ambient separation. 2.5 is enough
 *  to visibly scatter the unit over a few seconds. */
export const BROKEN_SEP_MUL = 2.5;
/** Per-rac morale shock when a same-side ally dies within
 *  CASUALTY_SHOCK_RADIUS meters. Small enough that one death doesn't
 *  break a held rac but large enough that the third or fourth nearby
 *  death does. Drives the cascade behavior — one broken cell becomes
 *  a section, becomes a flank. */
export const CASUALTY_SHOCK = 0.06;
export const CASUALTY_SHOCK_RADIUS = 5;
/** Routing-ally cascade: held racs near broken same-side racs lose
 *  morale per second. Saturating cap so a swarm of routers doesn't
 *  compound infinitely. Soft floor so routing alone can't push a
 *  steady rac below this — a held rac watching panic flow past it is
 *  shaken but not shattered. Combat damage can still drop it below. */
export const MORALE_ROUTING_RATE = 0.015;
export const MORALE_ROUTING_MAX = 0.05;
export const MORALE_ROUTING_FLOOR = 0.3;
export const MORALE_ROUTING_RADIUS = 10;
/** In-formation combat bonuses. The shield wall multiplies frontal
 *  damage dealt and frontal damage absorbed; flank/rear hits bypass
 *  the defense bonus (no shield over there). Cone is ±60° off facing. */
export const FORMATION_FRONTAL_DAMAGE_MUL = 1.5;
export const FORMATION_FRONTAL_DEFENSE_MUL = 0.6;
export const FORMATION_FRONTAL_HALF_CONE = Math.PI / 3;

/** Behavior states for the motion state machine. Slice 1: march,
 *  engage, rout. Slice 2 adds kite (archer back-pedal). Slice 3 adds
 *  flank (cavalry tangent path around blocked lines). Slice 4 adds
 *  rally (broken-recovering rejoin squad). Stored as Uint8 in
 *  state.rac.behavior. */
export const BEHAVIOR_MARCH = 0;
export const BEHAVIOR_ENGAGE = 1;
export const BEHAVIOR_ROUT = 2;
export const BEHAVIOR_KITE = 3;
export const BEHAVIOR_FLANK = 4;
export const BEHAVIOR_RALLY = 5;

/** How often each role re-evaluates its behavior, in ticks (15 Hz).
 *  Cavalry reacts every frame — they're scout-fast and reroute on
 *  sight. Tanks commit for ~1 s — heavy units don't change their
 *  minds mid-charge. Archers think slowly (~2 s) so they don't
 *  oscillate kite/engage every time the geometry wobbles. Indexed
 *  by ROLE_TO_IDX (tank=0, archer=1, cavalry=2, infantry=3). */
export const BEHAVIOR_CADENCE_BY_ROLE: readonly number[] = [
  15, // tank: ~1.0 s
  30, // archer: ~2.0 s
  1, // cavalry: every tick
  8, // infantry: ~0.5 s
];

/** Multiplier on effSpeed when in BEHAVIOR_ROUT — broken racs flee
 *  faster than their normal march. Tuned so they actually escape
 *  pursuers that share their base speed. */
export const ROUT_SPEED_MUL = 1.5;
/** Rally search radius (meters). A broken rac will head toward the
 *  nearest friendly squad leader within this distance instead of
 *  fleeing — that's a rally. Beyond this they go BEHAVIOR_ROUT and
 *  scatter. */
export const RALLY_RADIUS = 25;
/** Morale gained per second while in BEHAVIOR_RALLY. Slow enough that
 *  rally takes a few seconds (recovery isn't instant), fast enough
 *  that a rallied unit actually rejoins the fight rather than
 *  settling permanently broken near the leader. With break thresh
 *  0.1–0.5, recovery from 0 takes 2–10 s. */
export const RALLY_RECOVERY_RATE = 0.06;

/** Unit-level flank/rear threat. Each tick, every squad checks for
 *  enemies in its leader's flank (60–150° off forward) or rear
 *  (>150°) quadrant within FLANK_THREAT_RADIUS. If detected, every
 *  alive squad member loses morale per second — flank is unsettling,
 *  rear is panic. Models the unit-wide news that "the line is being
 *  rolled up" without the back-rank racs needing direct contact. */
export const FLANK_THREAT_RADIUS = 25;
export const FLANK_THREAT_RATE = 0.04;
export const REAR_THREAT_RATE = 0.08;
/** Half-cone above which we consider the angle "off the front" — racs
 *  facing within ±60° toward an enemy treat them as a frontal threat
 *  (no flank penalty). Same constant as the formation-frontal cone. */
export const FLANK_THREAT_FRONT_CONE = Math.PI / 3;
/** Half-cone above which we consider the angle "in the rear" —
 *  enemies more than 150° off the leader's facing. */
export const FLANK_THREAT_REAR_CONE = (Math.PI * 5) / 6;

/** Tank pin: when a tank lands a basic melee hit, the target gets a
 *  pinned timer of TANK_PIN_DURATION_TICKS ticks during which their
 *  motion speed is multiplied by PIN_SPEED_MUL. The pin refreshes on
 *  each subsequent hit, so a tank in sustained melee keeps the
 *  target anchored for as long as the engagement lasts. Once the
 *  tank disengages (moves away or dies), the timer expires after
 *  ~2 s and the target is free.
 *
 *  Design: tanks become the role that *holds territory*. Cavalry can
 *  overrun (still moving, just slowed) but pays for it; infantry
 *  can't easily walk through a tank line; archers caught in melee
 *  with a tank can't kite away. */
export const TANK_PIN_DURATION_TICKS = 30; // ~2.0 s at 15 Hz
export const PIN_SPEED_MUL = 0.4;

/** Cavalry charge bonus: damage dealt by a cavalry attacker scales
 *  with the attacker's CURRENT speed vs its base. At rest the bonus
 *  is 0 (×1 damage); at full base speed it's CAVALRY_CHARGE_BONUS_MAX
 *  (×2 damage by default). Makes "hit them while moving" the cavalry
 *  identity — a cavalry rac that has stopped is just a slow infantry. */
export const CAVALRY_CHARGE_BONUS_MAX = 1.0;
/** Per-role max acceleration (m/s²). Caps how fast velocity can
 *  change tick-to-tick. Cavalry has a finite cap so a full-speed
 *  charger has real momentum (can't stop on a dime), but at 8 m/s²
 *  a 90° turn from full speed completes in ~0.4 s — visibly committing
 *  to a line without locking heading for too long. Other roles use
 *  Infinity (snap-stop OK) since their motion is already slow.
 *  Indexed by ROLE_TO_IDX (tank=0, archer=1, cavalry=2, infantry=3). */
export const MAX_ACCEL_BY_ROLE: readonly number[] = [
  Infinity, // tank — already slow + 0.5 inertia blend
  Infinity, // archer
  8, // cavalry: ~0.4 s for a 90° pivot at full speed
  Infinity, // infantry
];
