/**
 * ContentBundle — typed shape of every design record consumed by the sim.
 * Pure data; no IO, no parsing. The fs / browser loaders produce this.
 *
 * Cards on disk → typed records here. Cross-ref validation happens in
 * the loader (load-fs.ts), not here.
 */

export type RoleId = "tank" | "archer" | "cavalry" | "infantry";
export type EnvId = "city" | "suburban" | "park" | "coastal";
export type CuriosityId = "lockpickers" | "tinkerers" | "farmers" | "barbarians";

export const ROLES: readonly RoleId[] = ["tank", "archer", "cavalry", "infantry"];
export const ENVS: readonly EnvId[] = ["city", "suburban", "park", "coastal"];
export const CURIOSITIES: readonly CuriosityId[] = [
  "lockpickers",
  "tinkerers",
  "farmers",
  "barbarians",
];

export const ROLE_TO_IDX: Record<RoleId, number> = { tank: 0, archer: 1, cavalry: 2, infantry: 3 };
export const ROLE_TANK = 0;
export const ROLE_ARCHER = 1;
export const ROLE_CAVALRY = 2;
export const ROLE_INFANTRY = 3;
export const ENV_TO_IDX: Record<EnvId, number> = { city: 0, suburban: 1, park: 2, coastal: 3 };
export const CURIOSITY_TO_IDX: Record<CuriosityId, number> = {
  lockpickers: 0,
  tinkerers: 1,
  farmers: 2,
  barbarians: 3,
};

export const CUR_LOCKPICKERS = 0;
export const CUR_TINKERERS = 1;
export const CUR_FARMERS = 2;
export const CUR_BARBARIANS = 3;

export type SpawnCadence = "continuous" | "wave" | "garrison-respawn";

export interface UnitStats {
  hp: number;
  damage: number;
  attack_rate: number;
  range: number;
  speed: number;
  armor: number;
}

export interface BinDef {
  hp: number;
  garrison_cap: number;
  spawn_cadence: SpawnCadence;
  /** Multiplier on respawn-timer rate when bin HP → 0. The effective
   *  rate is `1 + (1 − hpFrac)² × (max − 1)`. So at full HP the timer
   *  runs at 1× (base RESPAWN_SECONDS), at 50% HP ≈ 1.75× faster, at
   *  0% HP at this max. Cubic-ish curve so panic kicks in late but
   *  hard. Defaults to 4 if omitted. */
  panic_spawn_max_mul?: number;
  /** Number of raccoons emitted per slot fill ("belch"). Defaults
   *  to a per-role value: Tank 2, Archer 5, Cavalry 5, Infantry 10. */
  spawn_burst?: number;
  /** Formation id (see src/sim/formations.ts). When omitted, the
   *  unit's role determines a default formation (line for tank/inf,
   *  loose-deuce for cav, two-line for archer). The formation
   *  controls spawn arrangement and tactic-coefficient overrides. */
  formation?: import("./formations.js").FormationId;
}

export interface RageAttackDef {
  shape: string;
  damage: number;
  range: number;
  notes?: string;
  apply?: string[];
}

export interface UnitDef {
  id: string;
  name: string;
  role: RoleId;
  environment: EnvId;
  curiosity: CuriosityId;
  cost: number;
  stats: UnitStats;
  bin: BinDef;
  rage: { capacity: number; attack: RageAttackDef };
}

export type StatusKind = "buff" | "debuff" | "dot" | "control";
export type StatusStack = "refresh" | "stack" | "ignore";

export interface StatusDef {
  id: string;
  name: string;
  owner_env?: EnvId;
  kind: StatusKind;
  modifies: string;
  magnitude: number;
  duration: number;
  tick_rate?: number;
  stack: StatusStack;
  condition?: string;
}

export interface SynergyEffect {
  threshold: number;
  effect: string;
}

export interface EnvDef {
  id: EnvId;
  name: string;
  color: string;
  vibe: string;
  synergy_theme: string;
  cost_distribution?: string;
  applies?: string[];
  synergies: SynergyEffect[];
}

export interface CuriosityDef {
  id: CuriosityId;
  name: string;
  item: string;
  particle?: string;
  synergy_theme: string;
  synergies: SynergyEffect[];
}

export interface RoleDef {
  id: RoleId;
  name: string;
  shape: string;
  behavior: Record<string, unknown>;
  rage_gain: string;
}

export interface CompBinRef {
  id: string; // unit id
  count: number;
}

export interface CompDef {
  id: string;
  name: string;
  bins: CompBinRef[];
}

export interface ContentBundle {
  /** Git hash of cards/ at load time, or "unversioned" if non-git. */
  version: string;
  units: Map<string, UnitDef>;
  statuses: Map<string, StatusDef>;
  environments: Map<EnvId, EnvDef>;
  curiosities: Map<CuriosityId, CuriosityDef>;
  roles: Map<RoleId, RoleDef>;
  comps: Map<string, CompDef>;
}
