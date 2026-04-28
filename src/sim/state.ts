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
import { DOCTRINE_TO_IDX, doctrineFor, teamSizeFor } from "./doctrines.js";

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
  /** Per-rac formation slot offset (formation-space, with forward
   *  already mirrored by side at spawn). Boids cohesion pulls each rac
   *  toward `groupCentroid + slot` so the formation holds its shape
   *  instead of collapsing to a single point. Set once at spawn from
   *  `formation.arrange()`. Splits don't recompute slots — a split
   *  group inherits the parent's slot vectors, which is fine since the
   *  centroid moves to the new sub-group's centroid. */
  slotDx: Float32Array;
  slotDy: Float32Array;
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
}

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
export interface ShapeBattleConfig {
  seed: number;
  battleId: string;
  bounds: { w: number; h: number };
  /** Side 0: spawn `count` racs of this unit. */
  unitId: string;
  count: number;
  /** Optional formation override; falls back to role default. */
  formationId?: FormationId;
  /** Side 1: a single bin of this unit (the punching bag). It does
   *  NOT spawn raccoons (garrison_cap is forced to 0 at placement). */
  enemyBinUnitId: string;
  /** Optional HP override for the punching-bag bin (default = card hp). */
  enemyBinHp?: number;
  disableSynergies?: boolean;
}

/** Build a state for the shape-lab: N alive racs of one unit vs a
 *  single enemy bin (no garrison, just sits there as a target). All
 *  racs are pre-targeted on the bin. */
export function setupShapeBattle(content: ContentBundle, cfg: ShapeBattleConfig): BattleState {
  const unit = content.units.get(cfg.unitId);
  if (!unit) throw new Error(`unknown unit "${cfg.unitId}"`);
  const enemyUnit = content.units.get(cfg.enemyBinUnitId);
  if (!enemyUnit) throw new Error(`unknown enemy bin unit "${cfg.enemyBinUnitId}"`);

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

  // Resolve formation + doctrine for the spawned racs.
  const formationId = cfg.formationId ?? DEFAULT_FORMATION_BY_ROLE[unit.role];
  const formationIdx = FORMATION_TO_IDX[formationId];
  const formation = FORMATIONS[formationIdx];
  const doctrineId = doctrineFor(unit.environment, unit.curiosity);
  const doctrineIdx = DOCTRINE_TO_IDX[doctrineId];
  const teamSize = teamSizeFor(doctrineIdx);

  // Place the enemy punching-bag bin on side 1 at +30% of bounds.
  const halfW = cfg.bounds.w * 0.5;
  const binX = halfW * 0.6;
  const binY = 0;
  const binSlot = state.bin.count;
  state.bin.id[binSlot] = state.nextBinId++;
  state.bin.owner[binSlot] = 1;
  state.bin.unitIdIdx[binSlot] = internUnitId(state, enemyUnit.id);
  state.bin.envIdx[binSlot] = ENV_TO_IDX[enemyUnit.environment];
  state.bin.curIdx[binSlot] = CURIOSITY_TO_IDX[enemyUnit.curiosity];
  // Default to a giant finite HP so the battle doesn't end when the
  // racs reach the bin — shape-lab wants to watch the formation hold
  // line of contact, not declare victory. Finite (not Infinity) so the
  // viewer's hp/hpMax healthbar math doesn't NaN. An explicit override
  // wins (use a small number to study kill-the-bin pacing).
  const binHp = cfg.enemyBinHp ?? 1e9;
  state.bin.hp[binSlot] = binHp;
  state.bin.hpMax[binSlot] = binHp;
  state.bin.x[binSlot] = binX;
  state.bin.y[binSlot] = binY;
  state.bin.starTier[binSlot] = 1;
  state.bin.garrisonCap[binSlot] = 0; // <-- key: bin never spawns
  for (let s = 0; s < MAX_GARRISON_SLOTS; s++) {
    state.bin.slotRespawnT[binSlot * MAX_GARRISON_SLOTS + s] = Number.POSITIVE_INFINITY;
    state.bin.slotOccupant[binSlot * MAX_GARRISON_SLOTS + s] = -1;
  }
  state.bin.alive[binSlot] = 1;
  state.bin.count = binSlot + 1;
  state.binRowById.set(state.bin.id[binSlot], binSlot);

  // Place side-0 racs in formation arrangement around (-30% of bounds, 0).
  // Each rac's slot offset is stored on the rac so boids cohesion pulls
  // it back toward (centroid + slot) — that's what holds shape on the
  // march. Small RNG jitter so spawn positions aren't pixel-identical
  // (looks alive even at tick 0 + breaks symmetry that can stall the
  // anti-overlap d=0 path).
  const baseX = -halfW * 0.6;
  const baseY = 0;
  const groupId = state.nextGroupId++;
  const profile = state.formationProfile[0][formationIdx];
  // forward = +1 because the enemy is in +x direction from us.
  const forward = 1;
  for (let k = 0; k < cfg.count; k++) {
    if (state.rac.count >= state.rac.id.length) break;
    const off = formation.arrange({ burstIdx: k, burstSize: cfg.count, forward });
    const jx = (rngFloat(state.rng) - 0.5) * 0.2;
    const jy = (rngFloat(state.rng) - 0.5) * 0.2;
    const racRow = state.rac.count;
    const racId = state.nextRacId++;
    state.rac.id[racRow] = racId;
    state.racRowById.set(racId, racRow);
    state.rac.owner[racRow] = 0;
    state.rac.sourceBinId[racRow] = -1;
    state.rac.sourceSlotIdx[racRow] = -1;
    state.rac.unitIdIdx[racRow] = internUnitId(state, unit.id);
    state.rac.role[racRow] = ROLE_TO_IDX[unit.role];
    state.rac.env[racRow] = ENV_TO_IDX[unit.environment];
    state.rac.cur[racRow] = CURIOSITY_TO_IDX[unit.curiosity];
    state.rac.hp[racRow] = unit.stats.hp;
    state.rac.hpMax[racRow] = unit.stats.hp;
    state.rac.rage[racRow] = 0;
    state.rac.rageCap[racRow] = unit.rage.capacity;
    state.rac.x[racRow] = baseX + off.dx + jx;
    state.rac.y[racRow] = baseY + off.dy + jy;
    state.rac.vx[racRow] = 0;
    state.rac.vy[racRow] = 0;
    state.rac.facing[racRow] = 0; // +x toward enemy
    state.rac.prevFacing[racRow] = 0;
    state.rac.targetId[racRow] = state.bin.id[binSlot];
    state.rac.targetKind[racRow] = TARGET_KIND_BIN;
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
    state.rac.slotDx[racRow] = off.dx;
    state.rac.slotDy[racRow] = off.dy;
    state.rac.count = racRow + 1;
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
