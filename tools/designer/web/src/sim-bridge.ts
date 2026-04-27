/**
 * Browser-side bridge to the sim module.
 *
 * Fetches /api/cards (the designer's API serving raw YAML-fronted
 * markdown frontmatter as JSON), then constructs a typed
 * ContentBundle the same shape the Node-side `loadContentFromFs`
 * produces. Validation here is intentionally light — we trust the
 * card store; structural problems show up at sim-run time.
 *
 * This module is the ONLY place the browser deals with content
 * conversion. Everything else uses ContentBundle directly.
 */

import type {
  CompDef,
  ContentBundle,
  CuriosityDef,
  CuriosityId,
  EnvDef,
  EnvId,
  RoleDef,
  RoleId,
  StatusDef,
  UnitDef,
} from "@sim/content.js";
import { CURIOSITIES, ENVS, ROLES } from "@sim/content.js";

interface ApiCard {
  id: string;
  type: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

interface ApiCards {
  units: ApiCard[];
  environments: ApiCard[];
  curiosities: ApiCard[];
  roles: ApiCard[];
  synergies: ApiCard[];
  comps: ApiCard[];
  statuses: ApiCard[];
}

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asNumber = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

export async function loadContentFromApi(): Promise<ContentBundle> {
  const r = await fetch("/api/cards");
  if (!r.ok) throw new Error(`fetch /api/cards: ${r.status}`);
  const cards = (await r.json()) as ApiCards;

  const statuses = new Map<string, StatusDef>();
  for (const c of cards.statuses ?? []) {
    const fm = c.frontmatter;
    const id = asString(fm.id) ?? c.id;
    const kind = asString(fm.kind) as StatusDef["kind"] | undefined;
    if (!kind || !["buff", "debuff", "dot", "control"].includes(kind))
      throw new Error(`status ${id}: bad kind`);
    statuses.set(id, {
      id,
      name: asString(fm.name) ?? id,
      owner_env: asString(fm.owner_env) as EnvId | undefined,
      kind,
      modifies: asString(fm.modifies) ?? "",
      magnitude: asNumber(fm.magnitude) ?? 0,
      duration: asNumber(fm.duration) ?? 0,
      tick_rate: asNumber(fm.tick_rate),
      stack: (asString(fm.stack) as StatusDef["stack"]) ?? "refresh",
      condition: asString(fm.condition),
    });
  }

  const environments = new Map<EnvId, EnvDef>();
  for (const c of cards.environments ?? []) {
    const fm = c.frontmatter;
    const id = asString(fm.id) as EnvId | undefined;
    if (!id || !ENVS.includes(id)) throw new Error(`env: bad id ${String(fm.id)}`);
    const synergies = Array.isArray(fm.synergies) ? (fm.synergies as Array<{ threshold?: number; effect?: string }>) : [];
    environments.set(id, {
      id,
      name: asString(fm.name) ?? id,
      color: asString(fm.color) ?? "",
      vibe: asString(fm.vibe) ?? "",
      synergy_theme: asString(fm.synergy_theme) ?? "",
      cost_distribution: asString(fm.cost_distribution),
      applies: Array.isArray(fm.applies) ? (fm.applies as string[]) : undefined,
      synergies: synergies.map((s) => ({
        threshold: Number(s.threshold ?? 0),
        effect: String(s.effect ?? ""),
      })),
    });
  }

  const curiosities = new Map<CuriosityId, CuriosityDef>();
  for (const c of cards.curiosities ?? []) {
    const fm = c.frontmatter;
    const id = asString(fm.id) as CuriosityId | undefined;
    if (!id || !CURIOSITIES.includes(id)) throw new Error(`cur: bad id ${String(fm.id)}`);
    const synergies = Array.isArray(fm.synergies) ? (fm.synergies as Array<{ threshold?: number; effect?: string }>) : [];
    curiosities.set(id, {
      id,
      name: asString(fm.name) ?? id,
      item: asString(fm.item) ?? "none",
      particle: asString(fm.particle),
      synergy_theme: asString(fm.synergy_theme) ?? "",
      synergies: synergies.map((s) => ({
        threshold: Number(s.threshold ?? 0),
        effect: String(s.effect ?? ""),
      })),
    });
  }

  const roles = new Map<RoleId, RoleDef>();
  for (const c of cards.roles ?? []) {
    const fm = c.frontmatter;
    const id = asString(fm.id) as RoleId | undefined;
    if (!id || !ROLES.includes(id)) throw new Error(`role: bad id ${String(fm.id)}`);
    roles.set(id, {
      id,
      name: asString(fm.name) ?? id,
      shape: asString(fm.shape) ?? "",
      behavior: (fm.behavior as Record<string, unknown>) ?? {},
      rage_gain: asString(fm.rage_gain) ?? "",
    });
  }

  const units = new Map<string, UnitDef>();
  for (const c of cards.units ?? []) {
    const fm = c.frontmatter;
    const id = asString(fm.id) ?? c.id;
    const role = asString(fm.role) as RoleId | undefined;
    const env = asString(fm.environment) as EnvId | undefined;
    const cur = asString(fm.curiosity) as CuriosityId | undefined;
    if (!role || !ROLES.includes(role)) throw new Error(`unit ${id}: bad role`);
    if (!env || !ENVS.includes(env)) throw new Error(`unit ${id}: bad env`);
    if (!cur || !CURIOSITIES.includes(cur)) throw new Error(`unit ${id}: bad cur`);
    const stats = (fm.stats as Record<string, number>) ?? {};
    const bin = (fm.bin as Record<string, unknown>) ?? {};
    const rage = (fm.rage as Record<string, unknown>) ?? {};
    const attack = (rage.attack as Record<string, unknown>) ?? {};
    const apply = Array.isArray(attack.apply) ? (attack.apply as string[]) : undefined;
    units.set(id, {
      id,
      name: asString(fm.name) ?? id,
      role,
      environment: env,
      curiosity: cur,
      cost: Number(fm.cost ?? 1),
      stats: {
        hp: Number(stats.hp ?? 0),
        damage: Number(stats.damage ?? 0),
        attack_rate: Number(stats.attack_rate ?? 1),
        range: Number(stats.range ?? 0),
        speed: Number(stats.speed ?? 0),
        armor: Number(stats.armor ?? 0),
      },
      bin: {
        hp: Number(bin.hp ?? 0),
        garrison_cap: Number(bin.garrison_cap ?? 1),
        spawn_cadence: (asString(bin.spawn_cadence) as UnitDef["bin"]["spawn_cadence"]) ?? "garrison-respawn",
        panic_spawn_max_mul: asNumber(bin.panic_spawn_max_mul),
        formation: asString(bin.formation) as UnitDef["bin"]["formation"] | undefined,
      },
      rage: {
        capacity: Number(rage.capacity ?? 50),
        attack: {
          shape: asString(attack.shape) ?? "single-target",
          damage: Number(attack.damage ?? 0),
          range: Number(attack.range ?? 0),
          notes: asString(attack.notes),
          apply,
        },
      },
    });
  }

  const comps = new Map<string, CompDef>();
  for (const c of cards.comps ?? []) {
    const fm = c.frontmatter;
    const id = asString(fm.id) ?? c.id;
    const bins = Array.isArray(fm.bins) ? (fm.bins as Array<{ id: string; count: number }>) : [];
    comps.set(id, {
      id,
      name: asString(fm.name) ?? id,
      bins: bins.map((b) => ({ id: String(b.id), count: Number(b.count ?? 1) })),
    });
  }

  return {
    version: "browser",
    units,
    statuses,
    environments,
    curiosities,
    roles,
    comps,
  };
}

export interface ViewerAttack {
  srcX: number;
  srcY: number;
  tgtX: number;
  tgtY: number;
  /** "rac" or "bin" — controls line color (warmer for bin attacks). */
  tgtKind: "rac" | "bin";
}

/** A live in-flight projectile (arrow). Used by the viewer to draw a
 *  short streak in the direction of travel. Owner is the SHOOTER's
 *  side so we can tint the streak. */
export interface ViewerProjectile {
  x: number;
  y: number;
  vx: number;
  vy: number;
  owner: 0 | 1;
}

/** Compact per-tick snapshot used by the viewer. Wide enough to drive
 *  shape-by-role rendering, HP bars, and curiosity / env labels. */
export interface ViewerFrame {
  tick: number;
  bins: Array<{
    id: number;
    owner: 0 | 1;
    x: number;
    y: number;
    hp: number;
    hpMax: number;
    alive: 0 | 1;
    envIdx: number;
    curIdx: number;
  }>;
  racs: Array<{
    id: number;
    owner: 0 | 1;
    x: number;
    y: number;
    hp: number;
    hpMax: number;
    alive: 0 | 1;
    role: number;
    envIdx: number;
    curIdx: number;
    /** 0=default, 1=phalanx, 2=fire-team, 3=skirmisher, 4=line — see
     *  src/sim/doctrines.ts. Drives an outline color on the rac so
     *  doctrine choice is visible in the viewer. */
    doctrineIdx: number;
    /** Sub-team within the bin's burst. Doctrines partition the
     *  burst (fire-team=4 per team, skirmisher=2). Different teams
     *  get different shading so bounding-overwatch alternation is
     *  visually obvious. */
    teamId: number;
    /** 1 if this rac is in contact mode (any enemy nearby) — drives
     *  formation tightening (synaspismos). Visualized with a dark
     *  ring around the unit. */
    contact: 0 | 1;
    /** Group id (formation cohesion bucket). Two racs with same gid
     *  cohere together. Splits assign new gids when a group exceeds
     *  its doctrine's maxFormationSize. Viewer color-tints by gid
     *  hash so splits are visually obvious. */
    groupId: number;
  }>;
  /** Per-tick attack lines emitted this tick. Empty when no attacks fired. */
  attacks: ViewerAttack[];
  /** Live projectiles at end of this tick. Drawn as short streaks. */
  projs: ViewerProjectile[];
}

export interface ViewerBattle {
  seed: number;
  frames: ViewerFrame[];
  winner: -1 | 0 | 1;
  reason: string;
  finalTick: number;
}
