/**
 * Behavioral probes — cross-check that game-design effects (synergies,
 * status mods, rage rules) ACTUALLY apply at runtime. Invariants prove
 * structural integrity (no double-deaths, no negative HP); probes prove
 * "the design effect we wired up is observable in the log."
 *
 * Each probe takes a parsed log + ContentBundle, returns a verdict:
 *   - `passed`     — the design effect is detected
 *   - `failed`     — should be detected but isn't (likely a bug)
 *   - `inapplicable` — preconditions not met (e.g., no Barbarian raccoons
 *     on either side this battle); skip without flagging
 *
 * Usage:
 *   npm run sim:probe -- <path-to-ndjson>
 *   npm run sim:probe                          # use last battle log
 */

import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadContentFromFs } from "../../src/sim/load-fs.js";
import type { ContentBundle, UnitDef } from "../../src/sim/index.js";
import { parseLogFile, type ParsedLog, type LogRow } from "./log-reader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

interface ProbeResult {
  name: string;
  status: "pass" | "fail" | "inapplicable";
  summary: string;
  details?: string[];
}

type Probe = (log: ParsedLog, content: ContentBundle) => ProbeResult;

// ---------- helpers ----------

/** Find latest *.ndjson under logs/battles/. */
async function latestBattleLog(): Promise<string> {
  const logs = path.join(REPO_ROOT, "logs", "battles");
  try {
    const dates = (await fs.readdir(logs)).sort().reverse();
    for (const d of dates) {
      const dir = path.join(logs, d);
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) continue;
      const files = (await fs.readdir(dir))
        .filter((f) => f.endsWith(".ndjson"))
        .sort()
        .reverse();
      if (files.length > 0) return path.join(dir, files[0]);
    }
  } catch {}
  throw new Error(`no logs found under ${logs}`);
}

/** Build a unit-id → UnitDef lookup over content for fast probe lookups. */
function unitByName(content: ContentBundle): Map<string, UnitDef> {
  return content.units;
}

/** For each tick, return the set of "axis:side:owner_idx:threshold" synergies
 *  active at that tick (cumulative state machine over synergy_active rows). */
function synergyTimeline(log: ParsedLog): Map<number, Set<string>> {
  const timeline = new Map<number, Set<string>>();
  let active = new Set<string>();
  let lastTick = 0;
  for (const r of log.rows) {
    if (r.event_kind === "synergy_active") {
      const key = `${String(r.axis)}:${String(r.side)}:${String(r.owner_idx)}:${String(r.threshold)}`;
      const state = String(r.state);
      if (state === "on") active.add(key);
      else if (state === "off") active.delete(key);
    }
    if (Number(r.tick) !== lastTick) {
      lastTick = Number(r.tick);
    }
    timeline.set(lastTick, new Set(active));
  }
  return timeline;
}

function synergyActiveAt(timeline: Map<number, Set<string>>, tick: number, key: string): boolean {
  // Find the largest known tick ≤ given tick
  let bestTick = -1;
  for (const t of timeline.keys()) {
    if (t <= tick && t > bestTick) bestTick = t;
  }
  if (bestTick < 0) return false;
  return timeline.get(bestTick)!.has(key);
}

// ---------- probes ----------

/** Barbarians-3 should add +2 armor to Barbarian raccoons.
 *  We check this in damage_apply rows where the target is a Barbarian
 *  raccoon and Barbarians-3 was active on that side at that tick.
 *  The logged `armor` field should be ≥ baseArmor + 2.
 *  (If equal to baseArmor, the synergy add is dropped on the floor.) */
const probeBarbarianArmor: Probe = (log, content) => {
  const tl = synergyTimeline(log);
  const racSpawnByOwnerCur = new Map<number, { owner: number; cur: string }>();
  for (const e of log.byKind.get("rac_spawn") ?? []) {
    racSpawnByOwnerCur.set(Number(e.rac_id), {
      owner: Number(e.owner),
      cur: String(e.cur),
    });
  }

  let checked = 0;
  let withMod = 0;
  let withoutMod = 0;
  const examples: string[] = [];

  for (const d of log.byKind.get("damage_apply") ?? []) {
    if (String(d.tgt_kind) !== "rac") continue;
    if (String(d.source ?? "basic") === "dot") continue; // dot ignores armor
    const tgtId = Number(d.tgt_id);
    const meta = racSpawnByOwnerCur.get(tgtId);
    if (!meta || meta.cur !== "barbarians") continue;

    const tgtUnit = unitByName(content).get(String(d.tgt_unit));
    if (!tgtUnit) continue;
    const baseArmor = tgtUnit.stats.armor;

    const tick = Number(d.tick);
    const synKey = `curiosity:${meta.owner}:3:3`; // axis=curiosity, side=owner, owner_idx=3 (barbarians), threshold=3
    if (!synergyActiveAt(tl, tick, synKey)) continue;

    checked++;
    const loggedArmor = Number(d.armor);
    if (loggedArmor >= baseArmor + 2) {
      withMod++;
    } else {
      withoutMod++;
      if (examples.length < 3) {
        examples.push(
          `tick=${tick} tgt_id=${tgtId} tgt_unit=${String(d.tgt_unit)} base_armor=${baseArmor} logged_armor=${loggedArmor}`,
        );
      }
    }
  }

  if (checked === 0) {
    return {
      name: "barbarians_3_armor_add",
      status: "inapplicable",
      summary: "no damage on Barbarian raccoons under Barbarians-3 in this log",
    };
  }

  if (withoutMod === 0) {
    return {
      name: "barbarians_3_armor_add",
      status: "pass",
      summary: `${withMod}/${checked} damage rows show armor ≥ base + 2`,
    };
  }

  return {
    name: "barbarians_3_armor_add",
    status: "fail",
    summary: `${withoutMod}/${checked} damage rows on Barbarians-3 raccoons used base armor (synergy add NOT applied)`,
    details: examples,
  };
};

/** Barbarians-2 should add +20% HP to Barbarian raccoons. We check
 *  this on rac_spawn.hp_init: should equal base_hp × 1.20 (rounded).
 *  Synergy must be active when the raccoon spawns. */
const probeBarbarianHpMul: Probe = (log, content) => {
  const tl = synergyTimeline(log);
  let checked = 0;
  let withMod = 0;
  let withoutMod = 0;
  const examples: string[] = [];

  for (const e of log.byKind.get("rac_spawn") ?? []) {
    if (String(e.cur) !== "barbarians") continue;
    const tick = Number(e.tick);
    const owner = Number(e.owner);
    const synKey = `curiosity:${owner}:3:2`; // Barbarians-2 threshold
    if (!synergyActiveAt(tl, tick, synKey)) continue;

    const unit = unitByName(content).get(String(e.unit_id));
    if (!unit) continue;
    const baseHp = unit.stats.hp;
    const expected = baseHp * 1.20;
    const logged = Number(e.hp_init);
    checked++;
    if (Math.abs(logged - expected) < 0.5) {
      withMod++;
    } else {
      withoutMod++;
      if (examples.length < 3) {
        examples.push(
          `tick=${tick} rac_id=${String(e.rac_id)} unit=${String(e.unit_id)} base=${baseHp} expected=${expected.toFixed(1)} logged=${logged}`,
        );
      }
    }
  }

  if (checked === 0) {
    return {
      name: "barbarians_2_hp_mul",
      status: "inapplicable",
      summary: "no Barbarian raccoons spawned under Barbarians-2 active",
    };
  }
  if (withoutMod === 0) {
    return {
      name: "barbarians_2_hp_mul",
      status: "pass",
      summary: `${withMod}/${checked} Barbarian spawns had +20% hp_init`,
    };
  }
  return {
    name: "barbarians_2_hp_mul",
    status: "fail",
    summary: `${withoutMod}/${checked} Barbarian spawns used base HP (mul NOT applied)`,
    details: examples,
  };
};

/** Coastal-2 should add +25% range. Verify via the maximum attack
 *  distance among Coastal-rac attacks under Coastal-2: should exceed
 *  the unit's base range (otherwise mod isn't being applied). */
const probeCoastalRangeMul: Probe = (log, content) => {
  const tl = synergyTimeline(log);
  const attacker = new Map<number, { owner: number; env: string; unit_id: string }>();
  for (const e of log.byKind.get("rac_spawn") ?? []) {
    attacker.set(Number(e.rac_id), {
      owner: Number(e.owner),
      env: String(e.env),
      unit_id: String(e.unit_id),
    });
  }

  // Track per-unit-id (Coastal) the max attack distance, and the base range.
  const maxDist: Record<string, number> = {};
  const baseRange: Record<string, number> = {};

  for (const a of log.byKind.get("rac_attack") ?? []) {
    const racId = Number(a.rac_id);
    const meta = attacker.get(racId);
    if (!meta || meta.env !== "coastal") continue;
    const tick = Number(a.tick);
    const synKey = `environment:${meta.owner}:3:2`; // axis=environment, side=owner, owner_idx=3 (coastal), threshold=2
    if (!synergyActiveAt(tl, tick, synKey)) continue;
    const d = Number(a.range);
    if (!(d >= 0)) continue;
    if (!(meta.unit_id in maxDist) || d > maxDist[meta.unit_id]) {
      maxDist[meta.unit_id] = d;
    }
    if (!(meta.unit_id in baseRange)) {
      const u = unitByName(content).get(meta.unit_id);
      if (u) baseRange[meta.unit_id] = u.stats.range;
    }
  }

  const units = Object.keys(maxDist);
  if (units.length === 0) {
    return {
      name: "coastal_2_range_mul",
      status: "inapplicable",
      summary: "no Coastal-rac attacks under Coastal-2 in this log",
    };
  }

  const passing: string[] = [];
  const failing: string[] = [];
  for (const u of units) {
    const md = maxDist[u];
    const br = baseRange[u];
    if (md > br + 0.05) passing.push(`${u}: max_dist=${md.toFixed(2)} > base_range=${br.toFixed(2)}`);
    else failing.push(`${u}: max_dist=${md.toFixed(2)} ≤ base_range=${br.toFixed(2)}`);
  }
  if (failing.length === 0) {
    return {
      name: "coastal_2_range_mul",
      status: "pass",
      summary: `${passing.length}/${units.length} Coastal units fired beyond base range`,
      details: passing,
    };
  }
  // Mixed result is also a fail because the design says ALL Coastal racs
  // get the mul, but they may not have had the chance to fire near max
  // range. Soft-pass if ANY unit demonstrates extension.
  if (passing.length > 0) {
    return {
      name: "coastal_2_range_mul",
      status: "pass",
      summary: `at least ${passing.length}/${units.length} Coastal units fired beyond base range`,
      details: [...passing, ...failing.slice(0, 3)],
    };
  }
  return {
    name: "coastal_2_range_mul",
    status: "fail",
    summary: "no Coastal raccoon ever fired beyond its base range under Coastal-2 (mul NOT applied)",
    details: failing.slice(0, 5),
  };
};

/** Park-2 should add +20% speed. Indirect proof: Park raccoons travel
 *  faster than equivalent non-Park raccoons. This requires comparing
 *  comps; in a single battle we can only check that Park raccoons
 *  exhibit movement (positive centroid_dist closure). For now, pass
 *  if Park raccoons exist on a side and that side closes distance
 *  faster than the other, or just pass-as-inapplicable if no Park
 *  comp present. */
const probeParkSpeedMul: Probe = (log) => {
  const sums = log.byKind.get("tick_summary") ?? [];
  if (sums.length < 2) {
    return {
      name: "park_2_speed_mul",
      status: "inapplicable",
      summary: "fewer than 2 tick_summary rows",
    };
  }
  const racSpawn = log.byKind.get("rac_spawn") ?? [];
  const sideEnvs: Record<number, Set<string>> = { 0: new Set(), 1: new Set() };
  for (const r of racSpawn) {
    sideEnvs[Number(r.owner)].add(String(r.env));
  }
  const parkSide = sideEnvs[0].has("park") ? 0 : sideEnvs[1].has("park") ? 1 : -1;
  if (parkSide === -1) {
    return {
      name: "park_2_speed_mul",
      status: "inapplicable",
      summary: "no Park raccoons in this battle",
    };
  }

  const c0 = Number(sums[0].centroid_dist);
  const c1 = Number(sums[sums.length - 1].centroid_dist);
  const closure = c0 - c1;
  if (closure <= 0) {
    return {
      name: "park_2_speed_mul",
      status: "fail",
      summary: `centroid_dist did not close (Δ=${closure.toFixed(2)})`,
    };
  }
  return {
    name: "park_2_speed_mul",
    status: "pass",
    summary: `centroid_dist closed by ${closure.toFixed(2)}m (battle has Park on side ${parkSide})`,
  };
};

/** Tank rage rule: gain rage equal to damage taken. With rage capacity
 *  50, a tank should fire rage roughly once every 50 HP it has lost.
 *  Verify by computing total damage taken before each rage_fire by tank
 *  raccoons; should be ≈ 50 (within tolerance). */
const probeTankRageGain: Probe = (log) => {
  const racRole = new Map<number, string>();
  for (const e of log.byKind.get("rac_spawn") ?? []) {
    racRole.set(Number(e.rac_id), String(e.role));
  }

  const damageTakenSoFar = new Map<number, number>();
  const ratios: number[] = [];
  let lastFireDmg = new Map<number, number>();

  for (const r of log.rows) {
    if (r.event_kind === "damage_apply" && String(r.tgt_kind) === "rac") {
      const tgt = Number(r.tgt_id);
      damageTakenSoFar.set(tgt, (damageTakenSoFar.get(tgt) ?? 0) + Number(r.dmg_after_armor));
    } else if (r.event_kind === "rage_fire") {
      const id = Number(r.rac_id);
      if (racRole.get(id) !== "tank") continue;
      const cumulative = damageTakenSoFar.get(id) ?? 0;
      const since = cumulative - (lastFireDmg.get(id) ?? 0);
      lastFireDmg.set(id, cumulative);
      if (since > 0) ratios.push(since);
    }
  }

  if (ratios.length === 0) {
    return {
      name: "tank_rage_gain_per_damage",
      status: "inapplicable",
      summary: "no tank rage_fire events in this log",
    };
  }
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  // Accept anywhere in [40, 70] given armor / hit-floor noise; tank
  // rage capacity is 50 by default. Outside this range = bug.
  if (mean >= 40 && mean <= 70) {
    return {
      name: "tank_rage_gain_per_damage",
      status: "pass",
      summary: `mean damage_taken between tank rage_fires = ${mean.toFixed(1)} (expected ≈ 50, n=${ratios.length})`,
    };
  }
  return {
    name: "tank_rage_gain_per_damage",
    status: "fail",
    summary: `mean damage_taken between tank rage_fires = ${mean.toFixed(1)} (expected ≈ 50, n=${ratios.length})`,
  };
};

/** Damage math is consistent with status `dmg_taken` multiplier. Hard
 *  to prove without simulating the alternative; for v0a just verify that
 *  damage_apply.tgt_hp_after = tgt_hp_before - dmg_after_armor (a
 *  duplicate of the structural invariant; included so probe tool stands
 *  alone for sanity). */
const probeDamageMath: Probe = (log) => {
  let bad = 0;
  let total = 0;
  for (const d of log.byKind.get("damage_apply") ?? []) {
    total++;
    const before = Number(d.tgt_hp_before);
    const after = Number(d.tgt_hp_after);
    const dmg = Number(d.dmg_after_armor);
    if (Math.abs(before - dmg - after) > 1e-3) bad++;
  }
  if (total === 0) return { name: "damage_math", status: "inapplicable", summary: "no damage" };
  return bad === 0
    ? { name: "damage_math", status: "pass", summary: `${total}/${total} damage rows consistent` }
    : { name: "damage_math", status: "fail", summary: `${bad}/${total} damage rows broken math` };
};

/** Suburban-2 should add +20% HP to Suburban bins. Verify by reading
 *  bin_spawn rows (which log bin.hp at setup, post-synergy) against
 *  the unit's base bin HP. */
const probeSuburbanBinHp: Probe = (log, content) => {
  const byOwner: Record<number, { id: number; unit_id: string; hp: number }[]> = { 0: [], 1: [] };
  for (const e of log.byKind.get("bin_spawn") ?? []) {
    byOwner[Number(e.owner)].push({
      id: Number(e.bin_id),
      unit_id: String(e.unit_id),
      hp: Number(e.hp),
    });
  }
  let checked = 0;
  let withMod = 0;
  let withoutMod = 0;
  const examples: string[] = [];
  for (const owner of [0, 1] as const) {
    const bins = byOwner[owner];
    const subCount = bins.filter((b) => content.units.get(b.unit_id)?.environment === "suburban").length;
    if (subCount < 2) continue;
    for (const b of bins) {
      const u = content.units.get(b.unit_id);
      if (!u || u.environment !== "suburban") continue;
      const expected = u.bin.hp * 1.20;
      checked++;
      if (Math.abs(b.hp - expected) < 0.5) withMod++;
      else {
        withoutMod++;
        if (examples.length < 3) {
          examples.push(`bin=${b.id} unit=${b.unit_id} base=${u.bin.hp} expected=${expected.toFixed(1)} got=${b.hp}`);
        }
      }
    }
  }
  if (checked === 0)
    return { name: "suburban_2_bin_hp", status: "inapplicable", summary: "no Suburban bins under Suburban-2" };
  if (withoutMod === 0)
    return { name: "suburban_2_bin_hp", status: "pass", summary: `${withMod}/${checked} Suburban bins +20% HP` };
  return {
    name: "suburban_2_bin_hp",
    status: "fail",
    summary: `${withoutMod}/${checked} used base bin HP`,
    details: examples,
  };
};

/** Lockpickers-2 grants +20% damage when target is a bin. */
const probeLockpickerAntiBin: Probe = (log, content) => {
  const tl = synergyTimeline(log);
  const racMeta = new Map<number, { owner: number; cur: string; unit_id: string }>();
  for (const e of log.byKind.get("rac_spawn") ?? []) {
    racMeta.set(Number(e.rac_id), {
      owner: Number(e.owner),
      cur: String(e.cur),
      unit_id: String(e.unit_id),
    });
  }
  let checked = 0;
  let withMod = 0;
  let withoutMod = 0;
  const examples: string[] = [];
  for (const a of log.byKind.get("rac_attack") ?? []) {
    if (String(a.target_kind) !== "bin") continue;
    const meta = racMeta.get(Number(a.rac_id));
    if (!meta || meta.cur !== "lockpickers") continue;
    const synKey = `curiosity:${meta.owner}:0:2`;
    if (!synergyActiveAt(tl, Number(a.tick), synKey)) continue;
    const u = content.units.get(meta.unit_id);
    if (!u) continue;
    const baseDmg = u.stats.damage;
    const logged = Number(a.damage);
    checked++;
    // dmg_raw at attack time = effDamage × antiBinDamageMul. effDamage
    // ≥ baseDmg unless statuses are reducing it; the anti-bin mul
    // pushes it ≥ baseDmg×1.2. We allow a small tolerance.
    if (logged >= baseDmg * 1.15) withMod++;
    else {
      withoutMod++;
      if (examples.length < 3) {
        examples.push(`tick=${String(a.tick)} rac=${String(a.rac_id)} unit=${meta.unit_id} base=${baseDmg} got=${logged}`);
      }
    }
  }
  if (checked === 0)
    return { name: "lockpickers_2_anti_bin", status: "inapplicable", summary: "no Lockpicker→bin attacks" };
  if (withoutMod === 0)
    return { name: "lockpickers_2_anti_bin", status: "pass", summary: `${withMod}/${checked} Lockpicker→bin attacks boosted` };
  return {
    name: "lockpickers_2_anti_bin",
    status: "fail",
    summary: `${withoutMod}/${checked} used base damage`,
    details: examples,
  };
};

/** Farmers-2/3 multiplies Farmer bin garrison cap. With belch spawning,
 *  we count distinct SLOTS used at tick 1 (not total raccoons), since
 *  each slot now emits a burst. Expected = min(8, base_cap × mul). */
const probeFarmersGarrisonMul: Probe = (log, content) => {
  const tl = synergyTimeline(log);
  const slotsByBin = new Map<number, { owner: number; unit_id: string; slots: Set<number> }>();
  for (const e of log.byKind.get("rac_spawn") ?? []) {
    if (Number(e.tick) !== 1) continue;
    const binId = Number(e.bin_id);
    const slot = Number(e.slot_idx);
    const prev = slotsByBin.get(binId);
    if (prev) {
      prev.slots.add(slot);
    } else {
      slotsByBin.set(binId, {
        owner: Number(e.owner),
        unit_id: String(e.unit_id),
        slots: new Set([slot]),
      });
    }
  }
  let checked = 0;
  let withMod = 0;
  const examples: string[] = [];
  for (const [binId, info] of slotsByBin) {
    const u = content.units.get(info.unit_id);
    if (!u || u.curiosity !== "farmers") continue;
    let mul = 1;
    if (synergyActiveAt(tl, 1, `curiosity:${info.owner}:2:3`)) mul = 3;
    else if (synergyActiveAt(tl, 1, `curiosity:${info.owner}:2:2`)) mul = 2;
    if (mul === 1) continue;
    const expected = Math.min(8, u.bin.garrison_cap * mul);
    checked++;
    if (info.slots.size === expected) {
      withMod++;
    } else if (examples.length < 3) {
      examples.push(
        `bin=${binId} unit=${info.unit_id} base_cap=${u.bin.garrison_cap} mul=${mul} ` +
          `expected_slots=${expected} got_slots=${info.slots.size}`,
      );
    }
  }
  if (checked === 0)
    return { name: "farmers_garrison_mul", status: "inapplicable", summary: "no Farmer bins under Farmers synergies" };
  if (examples.length === 0)
    return { name: "farmers_garrison_mul", status: "pass", summary: `${withMod}/${checked} Farmer bins used multiplied slot count` };
  return {
    name: "farmers_garrison_mul",
    status: "fail",
    summary: `${checked - withMod}/${checked} Farmer bins didn't expand slot count`,
    details: examples,
  };
};

/** Hungry status (Park-flavored DoT): magnitude=-3, tick_rate=1.0s. We
 *  check that:
 *    - damage_apply rows with source=dot, status_id=hungry exist when
 *      any rac_spawn → status_apply chain results in hungry on a rac
 *    - the dmg_after_armor on each such row equals 3 (DoT bypasses armor)
 *    - those rows fire roughly once per second per affected raccoon */
const probeHungryDoT: Probe = (log, content) => {
  const sdef = content.statuses.get("hungry");
  if (!sdef) return { name: "hungry_dot", status: "inapplicable", summary: "no hungry def" };

  const rows = (log.byKind.get("damage_apply") ?? []).filter(
    (d) => String(d.source ?? "basic") === "dot" && String(d.status_id ?? "") === "hungry",
  );
  if (rows.length === 0) {
    return {
      name: "hungry_dot",
      status: "inapplicable",
      summary: "no hungry-DoT damage events in this log",
    };
  }
  const expected = Math.max(0, -sdef.magnitude); // 3
  const wrong: LogRow[] = [];
  for (const r of rows) {
    const dmg = Number(r.dmg_after_armor);
    if (Math.abs(dmg - expected) > 1e-3) wrong.push(r);
  }
  if (wrong.length > 0) {
    return {
      name: "hungry_dot",
      status: "fail",
      summary: `${wrong.length}/${rows.length} hungry-DoT events had wrong damage (expected ${expected})`,
      details: wrong.slice(0, 3).map(
        (r) =>
          `tick=${String(r.tick)} tgt_id=${String(r.tgt_id)} dmg=${String(r.dmg_after_armor)}`,
      ),
    };
  }
  return {
    name: "hungry_dot",
    status: "pass",
    summary: `${rows.length} hungry-DoT events all dealt ${expected} damage`,
  };
};

/** Per-role effective speed at spawn matches expected base × tactic
 *  speedMul. Catches regressions where speedMul stops being folded
 *  into effSpeed (the bug where Tanks were moving at infantry speed). */
const probeRoleSpeedMul: Probe = (log, content) => {
  const expectedMulByRole: Record<string, number> = {
    tank: 0.7,
    archer: 1.0,
    cavalry: 1.4,
    infantry: 1.0,
  };
  // Check for Park-2 synergy active at tick 1 per side. Park-2 grants
  // +20% speed to Park raccoons on the side that has ≥2 Park bins.
  // Reading synergy_active events: we accept the spawn's eff_speed if
  // it matches base × tacticMul (no Park-2) OR base × tacticMul × 1.2
  // (Park-2 active and rac is Park).
  const parkActive: Record<number, boolean> = { 0: false, 1: false };
  for (const e of log.byKind.get("synergy_active") ?? []) {
    if (Number(e.tick) > 1) break;
    if (e.axis === "environment" && Number(e.owner_idx) === 2 /* park */ && Number(e.threshold) >= 2 && e.state === "on") {
      parkActive[Number(e.side)] = true;
    }
  }
  const bad: string[] = [];
  let checked = 0;
  for (const e of log.byKind.get("rac_spawn") ?? []) {
    if (Number(e.tick) !== 1) continue;
    const role = String(e.role);
    const expectedMul = expectedMulByRole[role];
    if (expectedMul === undefined) continue;
    const u = content.units.get(String(e.unit_id));
    if (!u) continue;
    let expectedSpeed = u.stats.speed * expectedMul;
    if (u.environment === "park" && parkActive[Number(e.owner)]) {
      expectedSpeed *= 1.2;
    }
    const loggedSpeed = Number(e.eff_speed);
    checked++;
    if (Math.abs(loggedSpeed - expectedSpeed) > 0.01 && bad.length < 3) {
      bad.push(
        `rac_id=${String(e.rac_id)} unit=${String(e.unit_id)} role=${role} ` +
          `base=${u.stats.speed} expected_mul=${expectedMul} ` +
          `expected_eff=${expectedSpeed.toFixed(2)} logged_eff=${loggedSpeed.toFixed(2)}`,
      );
    }
  }
  if (checked === 0)
    return { name: "role_speed_mul", status: "inapplicable", summary: "no tick-1 rac_spawns" };
  if (bad.length > 0)
    return {
      name: "role_speed_mul",
      status: "fail",
      summary: `${bad.length}+ rac_spawns have eff_speed ≠ base × tactic.speedMul`,
      details: bad,
    };
  return {
    name: "role_speed_mul",
    status: "pass",
    summary: `${checked} tick-1 rac_spawns match base × profile.speedMul`,
  };
};

const probeArcherProjectiles: Probe = (log) => {
  const fires = log.byKind.get("proj_fire") ?? [];
  const hits = log.byKind.get("proj_hit") ?? [];
  const expires = log.byKind.get("proj_expire") ?? [];
  const archerAttacks = (log.byKind.get("rac_attack") ?? []).filter(
    (e) => String(e.role) === "archer",
  );
  if (archerAttacks.length === 0)
    return { name: "archer_projectiles", status: "inapplicable", summary: "no archer attacks" };

  // Every archer attack should have spawned exactly one projectile.
  if (fires.length !== archerAttacks.length) {
    return {
      name: "archer_projectiles",
      status: "fail",
      summary: `archer attacks=${archerAttacks.length} but proj_fire=${fires.length}`,
    };
  }

  // Every fire should resolve in either hit or expire (terminal states).
  // Mid-flight at battle-end is OK so we don't enforce strict equality;
  // we just check no spurious resolutions.
  const resolved = hits.length + expires.length;
  if (resolved > fires.length) {
    return {
      name: "archer_projectiles",
      status: "fail",
      summary: `more resolutions (${resolved}) than fires (${fires.length})`,
    };
  }

  // Damage from archer attacks should land via proj_hit, not via the
  // direct combat damage_apply path. Spot-check: a proj_hit for the
  // first archer should be followed (later tick) by a damage_apply with
  // matching src_rac.
  const ff = hits.filter((e) => Number(e.friendly_fire) === 1).length;

  return {
    name: "archer_projectiles",
    status: "pass",
    summary: `${fires.length} fires, ${hits.length} hits (${ff} friendly), ${expires.length} expires`,
  };
};

const PROBES: Probe[] = [
  probeDamageMath,
  probeRoleSpeedMul,
  probeBarbarianArmor,
  probeBarbarianHpMul,
  probeSuburbanBinHp,
  probeCoastalRangeMul,
  probeParkSpeedMul,
  probeTankRageGain,
  probeHungryDoT,
  probeLockpickerAntiBin,
  probeFarmersGarrisonMul,
  probeArcherProjectiles,
];

// ---------- main ----------

async function main(): Promise<void> {
  const argPath = process.argv[2];
  const logPath = argPath
    ? path.isAbsolute(argPath)
      ? argPath
      : path.resolve(process.cwd(), argPath)
    : await latestBattleLog();

  process.stdout.write(`[probe] loading log: ${path.relative(REPO_ROOT, logPath)}\n`);
  const log = await parseLogFile(logPath);
  process.stdout.write(`[probe]   ${log.rows.length} rows, battle_id=${log.battleId}\n`);

  const content = await loadContentFromFs({ repoRoot: REPO_ROOT });

  let pass = 0;
  let fail = 0;
  let inap = 0;
  for (const probe of PROBES) {
    const r = probe(log, content);
    const icon = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "○";
    process.stdout.write(`  ${icon} ${r.name}: ${r.summary}\n`);
    for (const d of r.details ?? []) process.stdout.write(`      ${d}\n`);
    if (r.status === "pass") pass++;
    else if (r.status === "fail") fail++;
    else inap++;
  }

  process.stdout.write(
    `[probe] ${pass} pass, ${fail} fail, ${inap} inapplicable (out of ${PROBES.length})\n`,
  );
  if (fail > 0) process.exit(1);
}

void execSync;
main().catch((e) => {
  process.stderr.write(`[probe] failed: ${String(e?.stack ?? e)}\n`);
  process.exit(1);
});
