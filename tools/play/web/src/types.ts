export type EnvId = "city" | "suburban" | "park" | "coastal";
export type CurId = "lockpickers" | "tinkerers" | "farmers" | "barbarians";
export type RoleId = "tank" | "infantry" | "archer" | "cavalry";
export type TraitKind = "env" | "cur" | "role";

export interface EnvDef {
  name: string;
  short: string;
  desc: string;
  synergy: string;
  color: string;
  glyph: string;
}

export interface CurDef {
  name: string;
  item: string;
  synergy: string;
  color: string;
  glyph: string;
}

export interface RoleDef {
  name: string;
  shape: string;
  rage: string;
  color: string;
  glyph: string;
}

export interface Archetype {
  id: string;
  name: string;
  env: EnvId;
  cur: CurId;
  role: RoleId;
  tier: number;
  hp: number;
  atk: number;
  rage: number;
}

export interface BoardUnit {
  uid: string;
  archetype: string;
  q: number;
  r: number;
  level: number;
  items: string[];
  hpPct?: number;
  ragePct?: number;
}

export interface BenchUnit {
  uid: string;
  archetype: string;
  level: number;
}

export interface Player {
  id: string;
  name: string;
  hp: number;
  trash: number;
  level: number;
  streak: string;
  env: EnvId;
  cur: CurId;
  alive: boolean;
  rank: number;
}

export interface ShopOffer {
  archetype: string;
  cost: number;
}

export interface ItemDef {
  name: string;
  glyph: string;
  desc: string;
}

export interface TraitCounts {
  env: Partial<Record<EnvId, number>>;
  cur: Partial<Record<CurId, number>>;
  role: Partial<Record<RoleId, number>>;
}

export type Screen = "home" | "lobby" | "pregame" | "battle" | "results" | "progression";
export type BattlePhase = "planning" | "combat";
