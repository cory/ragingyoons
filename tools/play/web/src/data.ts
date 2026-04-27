// RagingYoons play-client mock data.
// Adapted from the design package: 6 players (not 8), trash currency
// labels (with ¢ glyph), star-tier 1/2/3 stays as `level` on board units.
// When the match server lands these become typed messages off the wire.

import type {
  Archetype,
  BenchUnit,
  BoardUnit,
  CurDef,
  CurId,
  EnvDef,
  EnvId,
  ItemDef,
  Player,
  RoleDef,
  RoleId,
  ShopOffer,
  TraitCounts,
  TraitKind,
} from "./types";

// Three orthogonal axes: environment × curiosity × role
// 4 × 4 × 4 = 64 archetypes

export const ENVIRONMENTS: Record<EnvId, EnvDef> = {
  city:     { name: "CITY",     short: "CTY", desc: "dumpsters, alleys, fire escapes", synergy: "DENSITY / SWARM",     color: "#e7c93a", glyph: "⌬" },
  suburban: { name: "SUBURBAN", short: "SUB", desc: "lawns, garages, kiddie pools",    synergy: "DEFENSE / HOMEFIELD", color: "#7bd96b", glyph: "⌂" },
  park:     { name: "PARK",     short: "PRK", desc: "forests, picnics, ponds",         synergy: "MOBILITY / AMBUSH",   color: "#5fb89b", glyph: "✧" },
  coastal:  { name: "COASTAL",  short: "CST", desc: "piers, boardwalks, bait shops",   synergy: "RANGED / SPLASH",     color: "#5ab0ff", glyph: "≋" },
};

export const CURIOSITIES: Record<CurId, CurDef> = {
  lockpickers: { name: "LOCKPICKERS", item: "STICK",         synergy: "ANTI-BIN / SNEAK",     color: "#cdb892", glyph: "╱" },
  tinkerers:   { name: "TINKERERS",   item: "SPARKY-STICK",  synergy: "RAGE-ATTACK AUGMENT",  color: "#ff7a3a", glyph: "⚡" },
  farmers:     { name: "FARMERS",     item: "PITCHFORK",     synergy: "PRODUCTION",           color: "#bfd95a", glyph: "ψ" },
  barbarians:  { name: "BARBARIANS",  item: "BARE PAWS",     synergy: "TOUGHNESS",            color: "#d94a3a", glyph: "☠" },
};

export const ROLES: Record<RoleId, RoleDef> = {
  tank:     { name: "TANK",     shape: "BIG",        rage: "PER DMG TAKEN",          color: "#a78bfa", glyph: "◼" },
  infantry: { name: "INFANTRY", shape: "THIN+TALL",  rage: "PER SEC ADJ TO ALLIES",  color: "#f0e442", glyph: "▮" },
  archer:   { name: "ARCHER",   shape: "TINY",       rage: "PER ATTACK LANDED",      color: "#ff5e8a", glyph: "◆" },
  cavalry:  { name: "CAVALRY",  shape: "TALL+WIDER", rage: "PER SEC ATTACKING",      color: "#3ad6c0", glyph: "▲" },
};

export const NAMED: Archetype[] = [
  { id: "splinter", name: "SPLINTER", env: "city",     cur: "lockpickers", role: "archer",   tier: 3, hp: 480,  atk: 65,  rage: 78 },
  { id: "kompost",  name: "KOMPOST",  env: "suburban", cur: "farmers",     role: "tank",     tier: 4, hp: 1240, atk: 45,  rage: 30 },
  { id: "glitch",   name: "GLITCH",   env: "city",     cur: "tinkerers",   role: "archer",   tier: 5, hp: 520,  atk: 110, rage: 92 },
  { id: "duster",   name: "DUSTER",   env: "park",     cur: "barbarians",  role: "cavalry",  tier: 3, hp: 780,  atk: 72,  rage: 55 },
  { id: "brine",    name: "BRINE",    env: "coastal",  cur: "lockpickers", role: "archer",   tier: 2, hp: 410,  atk: 58,  rage: 40 },
  { id: "mulch",    name: "MULCH",    env: "suburban", cur: "barbarians",  role: "infantry", tier: 2, hp: 690,  atk: 50,  rage: 60 },
  { id: "gristle",  name: "GRISTLE",  env: "park",     cur: "farmers",     role: "tank",     tier: 4, hp: 1380, atk: 38,  rage: 22 },
  { id: "fester",   name: "FESTER",   env: "city",     cur: "barbarians",  role: "infantry", tier: 1, hp: 540,  atk: 44,  rage: 70 },
  { id: "salt",     name: "SALT",     env: "coastal",  cur: "tinkerers",   role: "cavalry",  tier: 3, hp: 820,  atk: 78,  rage: 50 },
  { id: "bramble",  name: "BRAMBLE",  env: "park",     cur: "lockpickers", role: "cavalry",  tier: 2, hp: 720,  atk: 64,  rage: 45 },
  { id: "kelp",     name: "KELP",     env: "coastal",  cur: "farmers",     role: "tank",     tier: 5, hp: 1520, atk: 42,  rage: 18 },
  { id: "hex",      name: "HEX",      env: "city",     cur: "tinkerers",   role: "infantry", tier: 4, hp: 880,  atk: 68,  rage: 88 },
];

// Initial player board (your team) — coords on a 7×4 hex grid
export const MY_BOARD: BoardUnit[] = [
  { uid: "p1", archetype: "splinter", q: 1, r: 3, level: 2, items: ["spark-coil"] },
  { uid: "p2", archetype: "kompost",  q: 3, r: 3, level: 2, items: ["rusty-can", "fence-plank"] },
  { uid: "p3", archetype: "glitch",   q: 5, r: 3, level: 1, items: [] },
  { uid: "p4", archetype: "mulch",    q: 2, r: 2, level: 1, items: [] },
  { uid: "p5", archetype: "duster",   q: 4, r: 2, level: 2, items: ["bone-shard"] },
  { uid: "p6", archetype: "fester",   q: 0, r: 3, level: 1, items: [] },
];

export const MY_BENCH: BenchUnit[] = [
  { uid: "b1", archetype: "brine",   level: 1 },
  { uid: "b2", archetype: "salt",    level: 1 },
  { uid: "b3", archetype: "gristle", level: 1 },
];

export const ENEMY_BOARD: BoardUnit[] = [
  { uid: "e1", archetype: "kelp",    q: 1, r: 0, level: 2, items: [] },
  { uid: "e2", archetype: "bramble", q: 3, r: 0, level: 1, items: [] },
  { uid: "e3", archetype: "hex",     q: 5, r: 0, level: 3, items: ["spark-coil"] },
  { uid: "e4", archetype: "salt",    q: 2, r: 1, level: 2, items: [] },
  { uid: "e5", archetype: "fester",  q: 4, r: 1, level: 1, items: [] },
];

export const SHOP_LINEUP: ShopOffer[] = [
  { archetype: "fester", cost: 1 },
  { archetype: "mulch",  cost: 2 },
  { archetype: "brine",  cost: 2 },
  { archetype: "duster", cost: 3 },
  { archetype: "salt",   cost: 3 },
];

// 6-player roster (v0 spec). Mock had 8; dropped GREMLIN_99 and lil_paws.
export const PLAYERS: Player[] = [
  { id: "me", name: "YOU",          hp: 76,  trash: 14, level: 6, streak: "W2", env: "city",     cur: "tinkerers",   alive: true, rank: 3 },
  { id: "p2", name: "BINKILLA",     hp: 100, trash: 22, level: 7, streak: "W4", env: "suburban", cur: "farmers",     alive: true, rank: 1 },
  { id: "p3", name: "TRASHKING_42", hp: 88,  trash: 18, level: 6, streak: "W1", env: "coastal",  cur: "lockpickers", alive: true, rank: 2 },
  { id: "p4", name: "SCRUB_LORD",   hp: 64,  trash: 9,  level: 6, streak: "L3", env: "park",     cur: "barbarians",  alive: true, rank: 4 },
  { id: "p5", name: "PUMPKIN.exe",  hp: 42,  trash: 31, level: 5, streak: "L2", env: "city",     cur: "lockpickers", alive: true, rank: 5 },
  { id: "p6", name: "SAUCE_PAW",    hp: 28,  trash: 4,  level: 6, streak: "L1", env: "suburban", cur: "tinkerers",   alive: true, rank: 6 },
];

export const ITEMS: Record<string, ItemDef> = {
  "spark-coil":  { name: "SPARK COIL",  glyph: "⚡", desc: "+30% rage gen" },
  "rusty-can":   { name: "RUSTY CAN",   glyph: "◎", desc: "+200 HP, reflect 8" },
  "fence-plank": { name: "FENCE PLANK", glyph: "╋", desc: "+25 armor" },
  "bone-shard":  { name: "BONE SHARD",  glyph: "◆", desc: "+15% AS, +20 atk" },
  "bait-bucket": { name: "BAIT BUCKET", glyph: "⊙", desc: "Lures, +1 ally adj" },
  "duct-tape":   { name: "DUCT TAPE",   glyph: "◫", desc: "Heal 12% on rage" },
};

const ARCH_BY_ID = new Map(NAMED.map((a) => [a.id, a]));
export function archByid(id: string): Archetype | undefined {
  return ARCH_BY_ID.get(id);
}

export function activeTraits(board: BoardUnit[]): TraitCounts {
  const counts: TraitCounts = { env: {}, cur: {}, role: {} };
  const seen = new Set<string>();
  for (const u of board) {
    const a = archByid(u.archetype);
    if (!a) continue;
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    counts.env[a.env] = (counts.env[a.env] ?? 0) + 1;
    counts.cur[a.cur] = (counts.cur[a.cur] ?? 0) + 1;
    counts.role[a.role] = (counts.role[a.role] ?? 0) + 1;
  }
  return counts;
}

export const TRAIT_BREAKS: Record<TraitKind, number[]> = {
  env: [2, 4, 6],
  cur: [2, 3, 4],
  role: [2, 3, 4],
};

export function tierOf(count: number, kind: TraitKind): number {
  const breaks = TRAIT_BREAKS[kind];
  let t = 0;
  for (const b of breaks) if (count >= b) t++;
  return t;
}
