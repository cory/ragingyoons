/**
 * Filesystem loader for `cards/` → ContentBundle.
 *
 * Node-only (uses fs + child_process for git hash). For browser loading,
 * write a sibling `load-json.ts` that takes a pre-built bundle.
 *
 * Validates cross-refs at load time and throws on the first violation —
 * we want loud failure, not silent partial bundles in batch runs.
 */

import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  CURIOSITIES,
  ENVS,
  ROLES,
  type ContentBundle,
  type CompDef,
  type CuriosityDef,
  type CuriosityId,
  type EnvDef,
  type EnvId,
  type RoleDef,
  type RoleId,
  type StatusDef,
  type UnitDef,
} from "./content.js";

interface RawCard {
  fm: Record<string, unknown>;
  body: string;
  filePath: string;
}

async function readCardsIn(dir: string): Promise<RawCard[]> {
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: RawCard[] = [];
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const filePath = path.join(dir, f);
    const raw = await fs.readFile(filePath, "utf8");
    out.push({ ...parseCard(raw), filePath });
  }
  return out;
}

function parseCard(raw: string): { fm: Record<string, unknown>; body: string } {
  if (!raw.startsWith("---\n")) return { fm: {}, body: raw };
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) return { fm: {}, body: raw };
  const fm = (yaml.load(raw.slice(4, end)) as Record<string, unknown>) ?? {};
  return { fm, body: raw.slice(end + 5) };
}

function fail(card: RawCard, msg: string): never {
  throw new Error(`[content] ${path.relative(process.cwd(), card.filePath)}: ${msg}`);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function gitHashOf(dir: string, repoRoot: string): string {
  try {
    const out = execSync(`git -C "${repoRoot}" rev-parse HEAD:"${path.relative(repoRoot, dir)}"`, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.toString("utf8").trim();
  } catch {
    return "unversioned";
  }
}

export interface LoadOpts {
  /** Repo root containing both `cards/` and the .git dir. */
  repoRoot: string;
  /** Cards directory; defaults to `<repoRoot>/cards`. */
  cardsDir?: string;
}

export async function loadContentFromFs(opts: LoadOpts): Promise<ContentBundle> {
  const cardsDir = opts.cardsDir ?? path.join(opts.repoRoot, "cards");
  const version = gitHashOf(cardsDir, opts.repoRoot);

  const [unitCards, statusCards, envCards, curCards, roleCards, compCards] = await Promise.all([
    readCardsIn(path.join(cardsDir, "units")),
    readCardsIn(path.join(cardsDir, "statuses")),
    readCardsIn(path.join(cardsDir, "environments")),
    readCardsIn(path.join(cardsDir, "curiosities")),
    readCardsIn(path.join(cardsDir, "roles")),
    readCardsIn(path.join(cardsDir, "comps")),
  ]);

  const statuses = new Map<string, StatusDef>();
  for (const c of statusCards) {
    const id = asString(c.fm.id);
    if (!id) fail(c, "missing id");
    const kind = asString(c.fm.kind) as StatusDef["kind"] | undefined;
    if (!kind || !["buff", "debuff", "dot", "control"].includes(kind))
      fail(c, `bad or missing kind`);
    statuses.set(id, {
      id,
      name: asString(c.fm.name) ?? id,
      owner_env: asString(c.fm.owner_env) as EnvId | undefined,
      kind,
      modifies: asString(c.fm.modifies) ?? "",
      magnitude: asNumber(c.fm.magnitude) ?? 0,
      duration: asNumber(c.fm.duration) ?? 0,
      tick_rate: asNumber(c.fm.tick_rate),
      stack: (asString(c.fm.stack) as StatusDef["stack"]) ?? "refresh",
      condition: asString(c.fm.condition),
    });
  }

  const environments = new Map<EnvId, EnvDef>();
  for (const c of envCards) {
    const id = asString(c.fm.id) as EnvId | undefined;
    if (!id || !ENVS.includes(id)) fail(c, `bad env id ${String(c.fm.id)}`);
    const synergies = Array.isArray(c.fm.synergies) ? (c.fm.synergies as SynergyEffectRaw[]) : [];
    const applies = Array.isArray(c.fm.applies) ? (c.fm.applies as string[]) : undefined;
    if (applies) {
      for (const s of applies) {
        if (!statuses.has(s)) fail(c, `applies references unknown status "${s}"`);
      }
    }
    environments.set(id, {
      id,
      name: asString(c.fm.name) ?? id,
      color: asString(c.fm.color) ?? "",
      vibe: asString(c.fm.vibe) ?? "",
      synergy_theme: asString(c.fm.synergy_theme) ?? "",
      cost_distribution: asString(c.fm.cost_distribution),
      applies,
      synergies: synergies.map((s) => ({
        threshold: Number(s.threshold ?? 0),
        effect: String(s.effect ?? ""),
      })),
    });
  }

  const curiosities = new Map<CuriosityId, CuriosityDef>();
  for (const c of curCards) {
    const id = asString(c.fm.id) as CuriosityId | undefined;
    if (!id || !CURIOSITIES.includes(id)) fail(c, `bad curiosity id ${String(c.fm.id)}`);
    const synergies = Array.isArray(c.fm.synergies) ? (c.fm.synergies as SynergyEffectRaw[]) : [];
    curiosities.set(id, {
      id,
      name: asString(c.fm.name) ?? id,
      item: asString(c.fm.item) ?? "none",
      particle: asString(c.fm.particle),
      synergy_theme: asString(c.fm.synergy_theme) ?? "",
      synergies: synergies.map((s) => ({
        threshold: Number(s.threshold ?? 0),
        effect: String(s.effect ?? ""),
      })),
    });
  }

  const roles = new Map<RoleId, RoleDef>();
  for (const c of roleCards) {
    const id = asString(c.fm.id) as RoleId | undefined;
    if (!id || !ROLES.includes(id)) fail(c, `bad role id ${String(c.fm.id)}`);
    roles.set(id, {
      id,
      name: asString(c.fm.name) ?? id,
      shape: asString(c.fm.shape) ?? "",
      behavior: (c.fm.behavior as Record<string, unknown>) ?? {},
      rage_gain: asString(c.fm.rage_gain) ?? "",
    });
  }

  const units = new Map<string, UnitDef>();
  for (const c of unitCards) {
    const id = asString(c.fm.id);
    if (!id) fail(c, "missing id");
    const role = asString(c.fm.role) as RoleId | undefined;
    const env = asString(c.fm.environment) as EnvId | undefined;
    const cur = asString(c.fm.curiosity) as CuriosityId | undefined;
    if (!role || !ROLES.includes(role)) fail(c, `bad role "${role}"`);
    if (!env || !ENVS.includes(env)) fail(c, `bad environment "${env}"`);
    if (!cur || !CURIOSITIES.includes(cur)) fail(c, `bad curiosity "${cur}"`);
    const stats = (c.fm.stats as Record<string, number> | undefined) ?? {};
    const bin = (c.fm.bin as Record<string, unknown> | undefined) ?? {};
    const rage = (c.fm.rage as Record<string, unknown> | undefined) ?? {};
    const attack = (rage.attack as Record<string, unknown> | undefined) ?? {};
    const apply = Array.isArray(attack.apply) ? (attack.apply as string[]) : undefined;
    if (apply) {
      for (const s of apply) {
        if (!statuses.has(s)) fail(c, `rage.attack.apply references unknown status "${s}"`);
      }
    }
    units.set(id, {
      id,
      name: asString(c.fm.name) ?? id,
      role,
      environment: env,
      curiosity: cur,
      cost: Number(c.fm.cost ?? 1),
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
        spawn_burst: asNumber(bin.spawn_burst),
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
  for (const c of compCards) {
    const id = asString(c.fm.id);
    if (!id) fail(c, "missing id");
    const bins = Array.isArray(c.fm.bins) ? (c.fm.bins as { id: string; count: number }[]) : [];
    for (const b of bins) {
      if (!units.has(b.id)) fail(c, `comp bin references unknown unit "${b.id}"`);
    }
    comps.set(id, {
      id,
      name: asString(c.fm.name) ?? id,
      bins: bins.map((b) => ({ id: b.id, count: Number(b.count ?? 1) })),
    });
  }

  return { version, units, statuses, environments, curiosities, roles, comps };
}

interface SynergyEffectRaw {
  threshold?: number | string;
  effect?: string;
}
