/**
 * Test builders for unit-testing sim subsystems in isolation.
 *
 * These build a minimal `BattleState` and `ContentBundle` without
 * touching the filesystem. Tests should compose these helpers, not
 * recreate them inline (so the structural shape stays in one place).
 */

import {
  CURIOSITY_TO_IDX,
  ENV_TO_IDX,
  ROLE_TO_IDX,
  type ContentBundle,
  type CuriosityId,
  type EnvId,
  type RoleId,
  type StatusDef,
  type UnitDef,
} from "../../src/sim/content.js";
import { MemoryLogger, type Logger } from "../../src/sim/log.js";
import { makeRng } from "../../src/sim/rng.js";
import {
  MAX_ATKS,
  MAX_BINS,
  MAX_GARRISON_SLOTS,
  MAX_RACS,
  composeFormationProfiles,
  emptyAtks,
  emptyBins,
  emptyRacs,
  type BattleState,
  type Owner,
} from "../../src/sim/state.js";
import { composeTactics } from "../../src/sim/tactics.js";

export function makeUnit(opts: Partial<UnitDef> & { id: string }): UnitDef {
  return {
    id: opts.id,
    name: opts.name ?? opts.id,
    role: opts.role ?? "infantry",
    environment: opts.environment ?? "city",
    curiosity: opts.curiosity ?? "farmers",
    cost: opts.cost ?? 1,
    stats: {
      hp: 50,
      damage: 10,
      attack_rate: 1.0,
      range: 1.0,
      speed: 2.0,
      armor: 0,
      ...opts.stats,
    },
    bin: {
      hp: 100,
      garrison_cap: 4,
      spawn_cadence: "garrison-respawn",
      ...opts.bin,
    },
    rage: opts.rage ?? {
      capacity: 50,
      attack: { shape: "single-target", damage: 25, range: 2 },
    },
  };
}

export function makeStatus(opts: Partial<StatusDef> & { id: string }): StatusDef {
  return {
    id: opts.id,
    name: opts.name ?? opts.id,
    kind: opts.kind ?? "debuff",
    modifies: opts.modifies ?? "speed",
    magnitude: opts.magnitude ?? -0.30,
    duration: opts.duration ?? 3.0,
    stack: opts.stack ?? "refresh",
    tick_rate: opts.tick_rate,
    condition: opts.condition,
    owner_env: opts.owner_env,
  };
}

export function makeBundle(opts: {
  units?: UnitDef[];
  statuses?: StatusDef[];
}): ContentBundle {
  const units = new Map<string, UnitDef>();
  for (const u of opts.units ?? []) units.set(u.id, u);
  const statuses = new Map<string, StatusDef>();
  for (const s of opts.statuses ?? []) statuses.set(s.id, s);
  return {
    version: "test",
    units,
    statuses,
    environments: new Map(),
    curiosities: new Map(),
    roles: new Map(),
    comps: new Map(),
  };
}

/** Build a fresh, empty BattleState. Add bins / racs via the helpers below. */
export function emptyState(opts: { seed?: number; bounds?: { w: number; h: number } } = {}): BattleState {
  const state: BattleState = {
    tick: 0,
    rng: makeRng(opts.seed ?? 42),
    battleId: "test",
    contentVersion: "test",
    seed: opts.seed ?? 42,
    bounds: opts.bounds ?? { w: 20, h: 12 },
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
  };
  // Build formation-profile lookup; subsystems read from this directly.
  composeFormationProfiles(state);
  return state;
}

function internUnitId(state: BattleState, unitId: string): number {
  let i = state.unitIdTable.indexOf(unitId);
  if (i < 0) {
    i = state.unitIdTable.length;
    state.unitIdTable.push(unitId);
  }
  return i;
}

export function addBin(
  state: BattleState,
  content: ContentBundle,
  opts: { unitId: string; owner: Owner; x?: number; y?: number; hp?: number },
): number {
  const slot = state.bin.count;
  const u = content.units.get(opts.unitId);
  if (!u) throw new Error(`unknown unit ${opts.unitId}`);
  state.bin.id[slot] = state.nextBinId++;
  state.bin.owner[slot] = opts.owner;
  state.bin.unitIdIdx[slot] = internUnitId(state, opts.unitId);
  state.bin.envIdx[slot] = ENV_TO_IDX[u.environment];
  state.bin.curIdx[slot] = CURIOSITY_TO_IDX[u.curiosity];
  state.bin.hp[slot] = opts.hp ?? u.bin.hp;
  state.bin.hpMax[slot] = opts.hp ?? u.bin.hp;
  state.bin.x[slot] = opts.x ?? 0;
  state.bin.y[slot] = opts.y ?? 0;
  state.bin.starTier[slot] = 1;
  state.bin.garrisonCap[slot] = u.bin.garrison_cap;
  for (let s = 0; s < MAX_GARRISON_SLOTS; s++) {
    state.bin.slotRespawnT[slot * MAX_GARRISON_SLOTS + s] = 0;
    state.bin.slotOccupant[slot * MAX_GARRISON_SLOTS + s] = -1;
  }
  state.bin.alive[slot] = 1;
  state.bin.count = slot + 1;
  state.binRowById.set(state.bin.id[slot], slot);
  return slot;
}

export function addRac(
  state: BattleState,
  content: ContentBundle,
  opts: {
    unitId: string;
    owner: Owner;
    x?: number;
    y?: number;
    hp?: number;
    rage?: number;
    sourceBinId?: number;
    slotDx?: number;
    slotDy?: number;
  },
): number {
  const slot = state.rac.count;
  const u = content.units.get(opts.unitId);
  if (!u) throw new Error(`unknown unit ${opts.unitId}`);
  state.rac.id[slot] = state.nextRacId++;
  state.rac.owner[slot] = opts.owner;
  state.rac.sourceBinId[slot] = opts.sourceBinId ?? -1;
  state.rac.sourceSlotIdx[slot] = -1;
  state.rac.unitIdIdx[slot] = internUnitId(state, opts.unitId);
  state.rac.role[slot] = ROLE_TO_IDX[u.role];
  state.rac.env[slot] = ENV_TO_IDX[u.environment];
  state.rac.cur[slot] = CURIOSITY_TO_IDX[u.curiosity];
  state.rac.hp[slot] = opts.hp ?? u.stats.hp;
  state.rac.hpMax[slot] = u.stats.hp;
  state.rac.rage[slot] = opts.rage ?? 0;
  state.rac.rageCap[slot] = u.rage.capacity;
  state.rac.x[slot] = opts.x ?? 0;
  state.rac.y[slot] = opts.y ?? 0;
  state.rac.vx[slot] = 0;
  state.rac.vy[slot] = 0;
  state.rac.facing[slot] = 0;
  state.rac.targetId[slot] = -1;
  state.rac.targetKind[slot] = 0;
  state.rac.attackCooldown[slot] = 0;
  state.rac.statuses[slot] = [];
  state.rac.alive[slot] = 1;
  state.rac.effSpeed[slot] = u.stats.speed;
  state.rac.effDamage[slot] = u.stats.damage;
  state.rac.effRange[slot] = u.stats.range;
  state.rac.effAttackRate[slot] = u.stats.attack_rate;
  state.rac.effArmor[slot] = u.stats.armor;
  state.rac.dmgTakenMul[slot] = 1;
  state.rac.surroundedDamageMul[slot] = 1;
  state.rac.slotDx[slot] = opts.slotDx ?? 0;
  state.rac.slotDy[slot] = opts.slotDy ?? 0;
  state.rac.count = slot + 1;
  state.racRowById.set(state.rac.id[slot], slot);
  return slot;
}

/** A logger that goes to memory (for tests that want to assert on emitted events). */
export function makeLogger(state: BattleState): MemoryLogger {
  const log = new MemoryLogger({
    battle_id: "test",
    seed: state.seed,
    service_version: "test",
    content_version: state.contentVersion,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  log.setTickReader(() => state.tick);
  return log;
}

/** Drain all events from a memory logger, parsed. */
export function eventsFrom(log: MemoryLogger): Record<string, unknown>[] {
  return log
    .drain()
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/** Pull events of a specific kind from drained memory log. */
export function eventsOf(events: Record<string, unknown>[], kind: string): Record<string, unknown>[] {
  return events.filter((e) => e.event_kind === kind);
}

export type { Logger };
