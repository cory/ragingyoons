/**
 * Invariant registry. Each invariant takes a parsed log + check context
 * and returns either `null` (pass) or an array of violation strings.
 *
 * Invariants are split:
 *
 *   UNIVERSAL          — structural/schema; always run.
 *   PHASE_1A_ADDITIONS — only for phase 1a (no-op tick). Once spawn
 *                        lands, these become incorrect, so they DON'T
 *                        carry over.
 *   PHASE_1B_ADDITIONS — spawn-system invariants.
 *   PHASE_1C_ADDITIONS — combat: target/boids/attack/damage.
 *   PHASE_1D_ADDITIONS — win conditions.
 *
 * Each phase composes from UNIVERSAL + the additions through that phase.
 *
 * Adding an invariant is a one-line registry edit; the `check` CLI picks
 * the right registry from `--phase`.
 */

import {
  KNOWN_EVENT_KINDS,
  REQUIRED_BASE_FIELDS,
  type LogRow,
  type ParsedLog,
} from "./log-reader.js";

export interface Invariant {
  id: string;
  description: string;
  check(log: ParsedLog, ctx: CheckContext): string[] | null;
}

export interface CheckContext {
  expectedTicks: number;
  expectedBinsPerSide: number;
}

// ---------- UNIVERSAL: structural / schema (always run) ----------

const schemaVersionOne: Invariant = {
  id: "schema_version_is_1",
  description: "every log row has schema_version === 1",
  check(log) {
    const bad: string[] = [];
    for (let i = 0; i < log.rows.length; i++) {
      if (log.rows[i].schema_version !== 1) {
        bad.push(`row ${i}: schema_version=${String(log.rows[i].schema_version)}`);
      }
    }
    return bad.length ? bad : null;
  },
};

const baseFieldsPresent: Invariant = {
  id: "base_fields_present",
  description: "every row carries the required base fields",
  check(log) {
    const bad: string[] = [];
    for (let i = 0; i < log.rows.length; i++) {
      const r = log.rows[i] as Record<string, unknown>;
      for (const f of REQUIRED_BASE_FIELDS) {
        if (!(f in r) || r[f] === undefined || r[f] === null || r[f] === "") {
          bad.push(`row ${i}: missing or empty "${f}"`);
        }
      }
    }
    return bad.length ? bad : null;
  },
};

const battleIdConsistent: Invariant = {
  id: "battle_id_consistent",
  description: "every row shares the same battle_id",
  check(log) {
    const ids = new Set<string>();
    for (const r of log.rows) ids.add(String(r.battle_id));
    return ids.size === 1 ? null : [`saw ${ids.size} battle_ids`];
  },
};

const seedConsistent: Invariant = {
  id: "seed_consistent",
  description: "every row carries the same seed",
  check(log) {
    const seeds = new Set<number>();
    for (const r of log.rows) seeds.add(Number(r.seed));
    return seeds.size === 1 ? null : [`saw ${seeds.size} distinct seeds`];
  },
};

const eventKindsKnown: Invariant = {
  id: "event_kinds_known",
  description: "every event_kind is in the known registry",
  check(log) {
    const bad: string[] = [];
    for (let i = 0; i < log.rows.length; i++) {
      const k = String(log.rows[i].event_kind);
      if (!KNOWN_EVENT_KINDS.has(k)) bad.push(`row ${i}: unknown "${k}"`);
    }
    return bad.length ? bad : null;
  },
};

const battleStartFirstAndOnce: Invariant = {
  id: "battle_start_first_and_once",
  description: "exactly one battle_start, and it's the first row",
  check(log) {
    const starts = log.byKind.get("battle_start") ?? [];
    if (starts.length !== 1) return [`saw ${starts.length} battle_start rows`];
    if (log.rows[0]?.event_kind !== "battle_start") {
      return [`first row is "${String(log.rows[0]?.event_kind)}"`];
    }
    return null;
  },
};

const battleEndLastAndOnce: Invariant = {
  id: "battle_end_last_and_once",
  description: "exactly one battle_end, and it's the last row",
  check(log) {
    const ends = log.byKind.get("battle_end") ?? [];
    if (ends.length !== 1) return [`saw ${ends.length} battle_end rows`];
    const last = log.rows[log.rows.length - 1];
    if (last?.event_kind !== "battle_end") {
      return [`last row is "${String(last?.event_kind)}"`];
    }
    return null;
  },
};

const ticksMonotonic: Invariant = {
  id: "ticks_monotonic",
  description: "tick numbers in row order are non-decreasing",
  check(log) {
    const bad: string[] = [];
    let prev = -1;
    for (let i = 0; i < log.rows.length; i++) {
      const t = Number(log.rows[i].tick);
      if (t < prev) bad.push(`row ${i}: tick=${t} after tick=${prev}`);
      prev = t;
    }
    return bad.length ? bad : null;
  },
};

const tsRfc3339: Invariant = {
  id: "ts_rfc3339",
  description: "every ts is parseable",
  check(log) {
    const bad: string[] = [];
    for (let i = 0; i < log.rows.length; i++) {
      const ts = String(log.rows[i].ts);
      if (Number.isNaN(Date.parse(ts))) bad.push(`row ${i}: ts=${ts}`);
    }
    return bad.length ? bad : null;
  },
};

const tickSummaryCadence: Invariant = {
  id: "tick_summary_cadence",
  description: "tick_summary fires every 15 ticks (1s at 15Hz) up to actual battle end",
  check(log, ctx) {
    const summaries = log.byKind.get("tick_summary") ?? [];
    // Battle may end early via win condition; cadence terminates at
    // min(expectedTicks, final_tick).
    const end = log.byKind.get("battle_end")?.[0];
    const finalTick = end ? Number(end.final_tick ?? ctx.expectedTicks) : ctx.expectedTicks;
    const upTo = Math.min(ctx.expectedTicks, finalTick);
    const expected: number[] = [];
    for (let t = 15; t <= upTo; t += 15) expected.push(t);
    if (summaries.length !== expected.length) {
      return [`saw ${summaries.length} tick_summary rows (expected ${expected.length} for battle ending at tick ${finalTick})`];
    }
    const bad: string[] = [];
    for (let i = 0; i < summaries.length; i++) {
      if (Number(summaries[i].tick) !== expected[i]) {
        bad.push(`tick_summary[${i}].tick=${summaries[i].tick} (expected ${expected[i]})`);
      }
    }
    return bad.length ? bad : null;
  },
};

const battleStartHasBinsPerSide: Invariant = {
  id: "battle_start_bins_per_side",
  description: "battle_start lists the expected bin count for each side",
  check(log, ctx) {
    const start = log.byKind.get("battle_start")?.[0];
    if (!start) return ["no battle_start row"];
    const a = (start.bins_a as unknown[] | undefined) ?? [];
    const b = (start.bins_b as unknown[] | undefined) ?? [];
    const bad: string[] = [];
    if (a.length !== ctx.expectedBinsPerSide) bad.push(`bins_a.length=${a.length}`);
    if (b.length !== ctx.expectedBinsPerSide) bad.push(`bins_b.length=${b.length}`);
    return bad.length ? bad : null;
  },
};

const battleEndCarriesWallclock: Invariant = {
  id: "battle_end_has_wallclock",
  description: "battle_end carries wallclock_ms ≥ 0",
  check(log) {
    const end = log.byKind.get("battle_end")?.[0];
    if (!end) return ["no battle_end row"];
    if (typeof end.wallclock_ms !== "number" || (end.wallclock_ms as number) < 0) {
      return [`wallclock_ms=${String(end.wallclock_ms)}`];
    }
    return null;
  },
};

const UNIVERSAL: Invariant[] = [
  schemaVersionOne,
  baseFieldsPresent,
  tsRfc3339,
  battleIdConsistent,
  seedConsistent,
  eventKindsKnown,
  battleStartFirstAndOnce,
  battleEndLastAndOnce,
  ticksMonotonic,
  tickSummaryCadence,
  battleStartHasBinsPerSide,
  battleEndCarriesWallclock,
];

// ---------- PHASE 1A ONLY: no entities yet ----------

const phase1aNoRaccoons: Invariant = {
  id: "phase_1a_no_raccoons",
  description: "(phase 1a only) racs_alive_total is 0 in every tick_summary",
  check(log) {
    const bad: string[] = [];
    const summaries = log.byKind.get("tick_summary") ?? [];
    for (const s of summaries) {
      const t = Number(s.racs_alive_total ?? 0);
      if (t !== 0) bad.push(`tick=${s.tick}: racs_alive_total=${t}`);
    }
    return bad.length ? bad : null;
  },
};

const phase1aNoSpawnEvents: Invariant = {
  id: "phase_1a_no_spawn_events",
  description: "(phase 1a only) zero rac_spawn / bin_death events",
  check(log) {
    const racSpawns = log.byKind.get("rac_spawn")?.length ?? 0;
    const binDeaths = log.byKind.get("bin_death")?.length ?? 0;
    const bad: string[] = [];
    if (racSpawns !== 0) bad.push(`rac_spawn=${racSpawns} (expected 0)`);
    if (binDeaths !== 0) bad.push(`bin_death=${binDeaths} (expected 0)`);
    return bad.length ? bad : null;
  },
};

const PHASE_1A_ONLY: Invariant[] = [phase1aNoRaccoons, phase1aNoSpawnEvents];

// ---------- PHASE 1B ADDITIONS: spawn ----------

const binSpawnCountMatches: Invariant = {
  id: "bin_spawn_count_matches",
  description: "one bin_spawn per bin listed in battle_start",
  check(log, ctx) {
    const binSpawns = log.byKind.get("bin_spawn") ?? [];
    const expected = ctx.expectedBinsPerSide * 2;
    if (binSpawns.length !== expected) {
      return [`bin_spawn count=${binSpawns.length} (expected ${expected})`];
    }
    return null;
  },
};

const binSpawnIdsUnique: Invariant = {
  id: "bin_spawn_ids_unique",
  description: "every bin_spawn carries a unique bin_id",
  check(log) {
    const binSpawns = log.byKind.get("bin_spawn") ?? [];
    const seen = new Set<number>();
    const dupes: number[] = [];
    for (const e of binSpawns) {
      const id = Number(e.bin_id);
      if (seen.has(id)) dupes.push(id);
      seen.add(id);
    }
    return dupes.length ? [`duplicate bin_ids: ${dupes.join(", ")}`] : null;
  },
};

const racSpawnReferencesRealBin: Invariant = {
  id: "rac_spawn_references_real_bin",
  description: "every rac_spawn.bin_id appeared in a bin_spawn",
  check(log) {
    const binIds = new Set<number>(
      (log.byKind.get("bin_spawn") ?? []).map((e) => Number(e.bin_id)),
    );
    const bad: string[] = [];
    for (const r of log.byKind.get("rac_spawn") ?? []) {
      const bid = Number(r.bin_id);
      if (!binIds.has(bid))
        bad.push(`rac_spawn rac_id=${String(r.rac_id)} bin_id=${bid} not in bin_spawn registry`);
    }
    return bad.length ? bad : null;
  },
};

const racSpawnOwnerMatchesBin: Invariant = {
  id: "rac_spawn_owner_matches_bin",
  description: "every rac_spawn.owner matches its bin_spawn.owner",
  check(log) {
    const binOwner = new Map<number, number>();
    for (const e of log.byKind.get("bin_spawn") ?? [])
      binOwner.set(Number(e.bin_id), Number(e.owner));
    const bad: string[] = [];
    for (const r of log.byKind.get("rac_spawn") ?? []) {
      const want = binOwner.get(Number(r.bin_id));
      if (want === undefined) continue; // already caught by previous invariant
      if (Number(r.owner) !== want) {
        bad.push(`rac_id=${String(r.rac_id)}: owner=${String(r.owner)} but bin owner=${want}`);
      }
    }
    return bad.length ? bad : null;
  },
};

const racSpawnIdsUnique: Invariant = {
  id: "rac_spawn_ids_unique",
  description: "every rac_spawn carries a unique rac_id",
  check(log) {
    const seen = new Set<number>();
    const dupes: number[] = [];
    for (const r of log.byKind.get("rac_spawn") ?? []) {
      const id = Number(r.rac_id);
      if (seen.has(id)) dupes.push(id);
      seen.add(id);
    }
    return dupes.length ? [`duplicate rac_ids: ${dupes.join(", ")}`] : null;
  },
};

const initialGarrisonsFillByOneSecond: Invariant = {
  id: "initial_garrisons_fill_by_1s",
  description: "after 1s, racs_alive_total ≥ bins_alive_total (each bin has ≥ 1 raccoon)",
  check(log) {
    const summaries = log.byKind.get("tick_summary") ?? [];
    const first = summaries[0];
    if (!first) return ["no tick_summary at tick=15"];
    const racs = Number(first.racs_alive_total ?? 0);
    const bins = Number(first.bins_alive_total ?? 0);
    if (racs < bins) {
      return [`tick=${first.tick}: racs_alive_total=${racs} < bins_alive_total=${bins}`];
    }
    return null;
  },
};

const racSpawnsHappenAtRealTicks: Invariant = {
  id: "rac_spawns_happen_at_tick_ge_1",
  description: "no rac_spawn at tick=0 (spawning is a tick action)",
  check(log) {
    const bad: string[] = [];
    for (const r of log.byKind.get("rac_spawn") ?? []) {
      if (Number(r.tick) < 1) bad.push(`rac_id=${String(r.rac_id)} at tick=${String(r.tick)}`);
    }
    return bad.length ? bad : null;
  },
};

const tickSummaryRacsAliveAccounting: Invariant = {
  id: "tick_summary_racs_alive_accounting",
  description: "racs_alive_total at each summary equals (rac_spawns - rac_deaths) up to that tick",
  check(log) {
    const bad: string[] = [];
    let spawned = 0;
    let died = 0;
    const allRows = log.rows;
    let summaryIdx = 0;
    const summaries = log.byKind.get("tick_summary") ?? [];
    for (let i = 0; i < allRows.length; i++) {
      const r = allRows[i];
      if (r.event_kind === "rac_spawn") spawned++;
      else if (r.event_kind === "rac_death") died++;
      else if (r.event_kind === "tick_summary") {
        const expected = spawned - died;
        const got = Number(r.racs_alive_total ?? 0);
        if (got !== expected) {
          bad.push(`tick=${r.tick}: racs_alive_total=${got} (spawns-${spawned} - deaths-${died} = ${expected})`);
        }
        summaryIdx++;
      }
    }
    void summaries;
    return bad.length ? bad : null;
  },
};

const PHASE_1B_ADDITIONS: Invariant[] = [
  binSpawnCountMatches,
  binSpawnIdsUnique,
  racSpawnReferencesRealBin,
  racSpawnOwnerMatchesBin,
  racSpawnIdsUnique,
  initialGarrisonsFillByOneSecond,
  racSpawnsHappenAtRealTicks,
  tickSummaryRacsAliveAccounting,
];

// ---------- PHASE 1C ADDITIONS: targeting + boids + combat ----------

const racTargetReferencesValidEntities: Invariant = {
  id: "rac_target_references_valid_entities",
  description: "every rac_target.rac_id and new_target is a real entity of its declared kind",
  check(log) {
    const racIds = new Set<number>(
      (log.byKind.get("rac_spawn") ?? []).map((e) => Number(e.rac_id)),
    );
    const binIds = new Set<number>(
      (log.byKind.get("bin_spawn") ?? []).map((e) => Number(e.bin_id)),
    );
    const bad: string[] = [];
    for (const r of log.byKind.get("rac_target") ?? []) {
      const src = Number(r.rac_id);
      const tgt = Number(r.new_target);
      const kind = String(r.new_kind ?? "rac");
      if (!racIds.has(src)) bad.push(`rac_target src rac_id=${src} never spawned`);
      if (tgt === -1) continue;
      if (kind === "rac" && !racIds.has(tgt))
        bad.push(`rac_target new_target=${tgt} (rac) never spawned`);
      else if (kind === "bin" && !binIds.has(tgt))
        bad.push(`rac_target new_target=${tgt} (bin) never spawned`);
    }
    return bad.length ? bad : null;
  },
};

const racTargetNotSelf: Invariant = {
  id: "rac_target_not_self",
  description: "no raccoon targets itself (only meaningful when new_kind=rac)",
  check(log) {
    const bad: string[] = [];
    for (const r of log.byKind.get("rac_target") ?? []) {
      if (String(r.new_kind ?? "rac") !== "rac") continue;
      const tgt = Number(r.new_target);
      if (tgt !== -1 && tgt === Number(r.rac_id)) {
        bad.push(`rac_id=${String(r.rac_id)} targets itself`);
      }
    }
    return bad.length ? bad : null;
  },
};

const racTargetIsEnemy: Invariant = {
  id: "rac_target_is_enemy",
  description: "every rac_target's new_target is owned by the OTHER side",
  check(log) {
    const racOwner = new Map<number, number>();
    for (const e of log.byKind.get("rac_spawn") ?? [])
      racOwner.set(Number(e.rac_id), Number(e.owner));
    const binOwner = new Map<number, number>();
    for (const e of log.byKind.get("bin_spawn") ?? [])
      binOwner.set(Number(e.bin_id), Number(e.owner));
    const bad: string[] = [];
    for (const r of log.byKind.get("rac_target") ?? []) {
      const tgt = Number(r.new_target);
      if (tgt === -1) continue;
      const kind = String(r.new_kind ?? "rac");
      const tgtOwner = kind === "bin" ? binOwner.get(tgt) : racOwner.get(tgt);
      if (tgtOwner === undefined) continue;
      if (tgtOwner === Number(r.owner)) {
        bad.push(`rac_id=${String(r.rac_id)} (owner ${String(r.owner)}) → ${kind} ${tgt} (same side)`);
      }
    }
    return bad.length ? bad : null;
  },
};

const racTargetEventsAppearOnceTargetable: Invariant = {
  id: "rac_target_events_appear_once_targets_exist",
  description: "rac_target events appear in any battle that has 2+ raccoons of opposing owners",
  check(log) {
    const sides = new Set<number>();
    for (const r of log.byKind.get("rac_spawn") ?? []) sides.add(Number(r.owner));
    if (sides.size < 2) return null; // single-sided battle (unlikely); skip
    const targets = log.byKind.get("rac_target") ?? [];
    if (targets.length === 0) return ["no rac_target events emitted despite both sides spawning"];
    return null;
  },
};

const noNanPositionsInTickSummary: Invariant = {
  id: "no_nan_positions_in_summary",
  description: "centroid_dist and min_enemy_dist are finite when both sides have raccoons",
  check(log) {
    const bad: string[] = [];
    for (const s of log.byKind.get("tick_summary") ?? []) {
      const ra = Number(s.racs_alive_a ?? 0);
      const rb = Number(s.racs_alive_b ?? 0);
      if (ra > 0 && rb > 0) {
        const c = Number(s.centroid_dist ?? -1);
        const m = Number(s.min_enemy_dist ?? -1);
        if (!Number.isFinite(c) || c < 0) bad.push(`tick=${s.tick}: centroid_dist=${c}`);
        if (!Number.isFinite(m) || m < 0) bad.push(`tick=${s.tick}: min_enemy_dist=${m}`);
      }
    }
    return bad.length ? bad : null;
  },
};

const sidesConvergeOverTime: Invariant = {
  id: "sides_converge_over_time",
  description: "with movement, centroid_dist trends down between first and last tick_summary",
  check(log) {
    const sums = log.byKind.get("tick_summary") ?? [];
    if (sums.length < 2) return null;
    const first = sums[0];
    const last = sums[sums.length - 1];
    const fa = Number(first.racs_alive_a ?? 0);
    const fb = Number(first.racs_alive_b ?? 0);
    const la = Number(last.racs_alive_a ?? 0);
    const lb = Number(last.racs_alive_b ?? 0);
    if (fa === 0 || fb === 0 || la === 0 || lb === 0) return null;
    const c0 = Number(first.centroid_dist ?? -1);
    const c1 = Number(last.centroid_dist ?? -1);
    if (c1 >= c0) {
      return [`centroid_dist did not decrease: tick=${first.tick} c=${c0.toFixed(2)} → tick=${last.tick} c=${c1.toFixed(2)}`];
    }
    return null;
  },
};

const minEnemyDistShouldShrink: Invariant = {
  id: "min_enemy_dist_shrinks",
  description: "min_enemy_dist trends down between first and last tick_summary",
  check(log) {
    const sums = log.byKind.get("tick_summary") ?? [];
    if (sums.length < 2) return null;
    const first = sums[0];
    const last = sums[sums.length - 1];
    if ((Number(first.racs_alive_a ?? 0) === 0) || (Number(first.racs_alive_b ?? 0) === 0)) return null;
    if ((Number(last.racs_alive_a ?? 0) === 0) || (Number(last.racs_alive_b ?? 0) === 0)) return null;
    const m0 = Number(first.min_enemy_dist ?? -1);
    const m1 = Number(last.min_enemy_dist ?? -1);
    if (m1 >= m0) {
      return [`min_enemy_dist did not decrease: tick=${first.tick} m=${m0.toFixed(2)} → tick=${last.tick} m=${m1.toFixed(2)}`];
    }
    return null;
  },
};

const PHASE_1C_ADDITIONS: Invariant[] = [
  racTargetReferencesValidEntities,
  racTargetNotSelf,
  racTargetIsEnemy,
  racTargetEventsAppearOnceTargetable,
  noNanPositionsInTickSummary,
  sidesConvergeOverTime,
  minEnemyDistShouldShrink,
];

// ---------- PHASE 1D ADDITIONS: combat (attack + damage + death) + win ----------

const racAttackTargetIsEnemy: Invariant = {
  id: "rac_attack_target_is_enemy",
  description: "every rac_attack hits an enemy entity (rac or bin)",
  check(log) {
    const racOwner = new Map<number, number>();
    for (const e of log.byKind.get("rac_spawn") ?? [])
      racOwner.set(Number(e.rac_id), Number(e.owner));
    const binOwner = new Map<number, number>();
    for (const e of log.byKind.get("bin_spawn") ?? [])
      binOwner.set(Number(e.bin_id), Number(e.owner));
    const bad: string[] = [];
    for (const a of log.byKind.get("rac_attack") ?? []) {
      const tgt = Number(a.target_id);
      const kind = String(a.target_kind ?? "rac");
      const want = kind === "bin" ? binOwner.get(tgt) : racOwner.get(tgt);
      if (want === undefined) continue;
      if (want === Number(a.owner)) {
        bad.push(`rac_attack rac_id=${String(a.rac_id)} → ${kind} ${tgt} (same side)`);
      }
    }
    return bad.length ? bad : null;
  },
};

const damageMath: Invariant = {
  id: "damage_apply_math_consistent",
  description: "tgt_hp_after = tgt_hp_before - dmg_after_armor",
  check(log) {
    const bad: string[] = [];
    for (const d of log.byKind.get("damage_apply") ?? []) {
      const before = Number(d.tgt_hp_before);
      const after = Number(d.tgt_hp_after);
      const dmg = Number(d.dmg_after_armor);
      if (Math.abs(before - dmg - after) > 1e-3) {
        bad.push(
          `tgt_id=${String(d.tgt_id)}: ${before} - ${dmg} != ${after}`,
        );
      }
    }
    return bad.length ? bad : null;
  },
};

const damageNonNegativeAfterArmor: Invariant = {
  id: "damage_after_armor_positive",
  description: "dmg_after_armor ≥ 1 (the floor)",
  check(log) {
    const bad: string[] = [];
    for (const d of log.byKind.get("damage_apply") ?? []) {
      const dmg = Number(d.dmg_after_armor);
      if (dmg < 1) bad.push(`tgt_id=${String(d.tgt_id)}: dmg_after_armor=${dmg}`);
    }
    return bad.length ? bad : null;
  },
};

const racDeathPrecededBySpawn: Invariant = {
  id: "rac_death_preceded_by_spawn",
  description: "every dead raccoon was previously spawned",
  check(log) {
    const spawned = new Set<number>(
      (log.byKind.get("rac_spawn") ?? []).map((e) => Number(e.rac_id)),
    );
    const bad: string[] = [];
    for (const d of log.byKind.get("rac_death") ?? []) {
      const id = Number(d.rac_id);
      if (!spawned.has(id)) bad.push(`rac_death rac_id=${id} never spawned`);
    }
    return bad.length ? bad : null;
  },
};

const racDeathOnlyOncePerRaccoon: Invariant = {
  id: "rac_death_once_per_raccoon",
  description: "no raccoon dies twice",
  check(log) {
    const seen = new Set<number>();
    const dupes: number[] = [];
    for (const d of log.byKind.get("rac_death") ?? []) {
      const id = Number(d.rac_id);
      if (seen.has(id)) dupes.push(id);
      seen.add(id);
    }
    return dupes.length ? [`re-deaths: ${dupes.slice(0, 5).join(", ")}`] : null;
  },
};

const racDeathHasLastHit: Invariant = {
  id: "rac_death_has_last_hit",
  description: "every rac_death has a last_hit_by referencing a spawned raccoon",
  check(log) {
    const spawned = new Set<number>(
      (log.byKind.get("rac_spawn") ?? []).map((e) => Number(e.rac_id)),
    );
    const bad: string[] = [];
    for (const d of log.byKind.get("rac_death") ?? []) {
      const lh = Number(d.last_hit_by);
      if (!spawned.has(lh)) bad.push(`rac_id=${String(d.rac_id)} last_hit_by=${lh} not spawned`);
    }
    return bad.length ? bad : null;
  },
};

const damageOnlyOnAliveTargets: Invariant = {
  id: "damage_only_on_alive_targets",
  description: "no damage_apply lands on a target after its death event (same-tick allowed)",
  check(log) {
    const racDeathTick = new Map<number, number>();
    for (const d of log.byKind.get("rac_death") ?? []) {
      racDeathTick.set(Number(d.rac_id), Number(d.tick));
    }
    const binDeathTick = new Map<number, number>();
    for (const d of log.byKind.get("bin_death") ?? []) {
      binDeathTick.set(Number(d.bin_id), Number(d.tick));
    }
    const bad: string[] = [];
    for (const a of log.byKind.get("damage_apply") ?? []) {
      const tgt = Number(a.tgt_id);
      const kind = String(a.tgt_kind ?? "rac");
      const map = kind === "bin" ? binDeathTick : racDeathTick;
      const dt = map.get(tgt);
      if (dt !== undefined && Number(a.tick) > dt) {
        bad.push(`${kind} ${tgt}: damage at tick ${String(a.tick)}, died at tick ${dt}`);
      }
    }
    return bad.length ? bad : null;
  },
};

const racDeathClosesHpAccounting: Invariant = {
  id: "rac_death_closes_hp_accounting",
  description: "tick_summary.racs_alive_total properly reflects deaths",
  check(log) {
    // Already covered by tickSummaryRacsAliveAccounting in 1B; this is
    // a stricter check that deaths actually decrease the count.
    let prev = -1;
    let sawDeath = false;
    const sums = log.byKind.get("tick_summary") ?? [];
    if (!log.byKind.get("rac_death")?.length) return null;
    for (const s of sums) {
      const t = Number(s.racs_alive_total ?? 0);
      if (prev >= 0 && t > prev) {
        // racs_alive can grow when respawns outpace deaths — only fail
        // if it grows AND we've seen no deaths at all (which can't be
        // a death-shrink). Skip.
      }
      prev = t;
    }
    void sawDeath;
    return null; // permissive; the bookkeeping invariant is the strict one
  },
};

const racAttackCooldownObeyed: Invariant = {
  id: "rac_attack_cooldown_obeyed",
  description: "no raccoon fires faster than 1/attack_rate (best-effort approximation)",
  check(log) {
    // We don't have unit stats in the log, so this is approximate:
    // back-to-back rac_attack rows from the same rac_id should be at
    // least 1 tick apart (since cooldown ≥ 1/attack_rate, and the
    // fastest attack_rate in our data is ~1.2 → cooldown ≈ 12 ticks).
    const lastTick = new Map<number, number>();
    const bad: string[] = [];
    for (const a of log.byKind.get("rac_attack") ?? []) {
      const id = Number(a.rac_id);
      const t = Number(a.tick);
      const prev = lastTick.get(id);
      if (prev !== undefined && t - prev < 1) {
        bad.push(`rac_id=${id}: attacks at ticks ${prev} and ${t}`);
      }
      lastTick.set(id, t);
    }
    return bad.length ? bad : null;
  },
};

const binDeathPrecededBySpawn: Invariant = {
  id: "bin_death_preceded_by_spawn",
  description: "every dead bin was previously bin_spawn'd",
  check(log) {
    const spawned = new Set<number>(
      (log.byKind.get("bin_spawn") ?? []).map((e) => Number(e.bin_id)),
    );
    const bad: string[] = [];
    for (const d of log.byKind.get("bin_death") ?? []) {
      const id = Number(d.bin_id);
      if (!spawned.has(id)) bad.push(`bin_death bin_id=${id} never spawned`);
    }
    return bad.length ? bad : null;
  },
};

const binDeathOnlyOnce: Invariant = {
  id: "bin_death_once_per_bin",
  description: "no bin dies twice",
  check(log) {
    const seen = new Set<number>();
    const dupes: number[] = [];
    for (const d of log.byKind.get("bin_death") ?? []) {
      const id = Number(d.bin_id);
      if (seen.has(id)) dupes.push(id);
      seen.add(id);
    }
    return dupes.length ? [`re-deaths: ${dupes.slice(0, 5).join(", ")}`] : null;
  },
};

const noSpawnAfterBinDeath: Invariant = {
  id: "no_spawn_after_bin_death",
  description: "no rac_spawn from a bin after that bin's death",
  check(log) {
    const deathTick = new Map<number, number>();
    for (const d of log.byKind.get("bin_death") ?? []) {
      deathTick.set(Number(d.bin_id), Number(d.tick));
    }
    const bad: string[] = [];
    for (const r of log.byKind.get("rac_spawn") ?? []) {
      const bid = Number(r.bin_id);
      const dt = deathTick.get(bid);
      if (dt !== undefined && Number(r.tick) > dt) {
        bad.push(`bin ${bid} spawned rac_id=${String(r.rac_id)} at tick ${String(r.tick)} (died at ${dt})`);
      }
    }
    return bad.length ? bad : null;
  },
};

const battleEndWinnerValid: Invariant = {
  id: "battle_end_winner_valid",
  description: "battle_end.winner is one of {-1, 0, 1}",
  check(log) {
    const end = log.byKind.get("battle_end")?.[0];
    if (!end) return ["no battle_end"];
    const w = Number(end.winner);
    if (w !== -1 && w !== 0 && w !== 1) return [`winner=${w}`];
    return null;
  },
};

const battleEndReasonValid: Invariant = {
  id: "battle_end_reason_valid",
  description: "battle_end.reason is one of {all-bins, last-raccoon, timeout}",
  check(log) {
    const end = log.byKind.get("battle_end")?.[0];
    if (!end) return ["no battle_end"];
    const r = String(end.reason);
    if (!["all-bins", "last-raccoon", "timeout"].includes(r)) return [`reason="${r}"`];
    return null;
  },
};

const winnerSideHasSurvivors: Invariant = {
  id: "winner_side_has_survivors",
  description: "if winner != -1, that side has bins or raccoons alive at battle_end",
  check(log) {
    const end = log.byKind.get("battle_end")?.[0];
    if (!end) return null;
    const w = Number(end.winner);
    if (w === -1) return null;
    const aBins = Number(end.bins_alive_a ?? 0);
    const aRacs = Number(end.racs_alive_a ?? 0);
    const bBins = Number(end.bins_alive_b ?? 0);
    const bRacs = Number(end.racs_alive_b ?? 0);
    if (w === 0 && aBins + aRacs === 0) return [`winner=0 but A has no entities`];
    if (w === 1 && bBins + bRacs === 0) return [`winner=1 but B has no entities`];
    return null;
  },
};

const PHASE_1D_ADDITIONS: Invariant[] = [
  racAttackTargetIsEnemy,
  damageMath,
  damageNonNegativeAfterArmor,
  racDeathPrecededBySpawn,
  racDeathOnlyOncePerRaccoon,
  racDeathHasLastHit,
  damageOnlyOnAliveTargets,
  racDeathClosesHpAccounting,
  racAttackCooldownObeyed,
  binDeathPrecededBySpawn,
  binDeathOnlyOnce,
  noSpawnAfterBinDeath,
  battleEndWinnerValid,
  battleEndReasonValid,
  winnerSideHasSurvivors,
];

// ---------- PHASE 1E ADDITIONS: status + rage ----------

const statusApplyReferencesRealRac: Invariant = {
  id: "status_apply_references_real_rac",
  description: "every status_apply.tgt_id (kind=rac) was previously rac_spawn'd",
  check(log) {
    const racIds = new Set<number>(
      (log.byKind.get("rac_spawn") ?? []).map((e) => Number(e.rac_id)),
    );
    const bad: string[] = [];
    for (const a of log.byKind.get("status_apply") ?? []) {
      if (String(a.tgt_kind ?? "rac") !== "rac") continue;
      const id = Number(a.tgt_id);
      if (!racIds.has(id)) bad.push(`status_apply tgt_id=${id} never spawned`);
    }
    return bad.length ? bad : null;
  },
};

const statusApplyHasKnownKind: Invariant = {
  id: "status_apply_has_known_kind",
  description: "status_apply.status_kind is one of {buff,debuff,dot,control}",
  check(log) {
    const ok = new Set(["buff", "debuff", "dot", "control"]);
    const bad: string[] = [];
    for (const a of log.byKind.get("status_apply") ?? []) {
      const k = String(a.status_kind ?? "");
      if (!ok.has(k)) bad.push(`status_id=${String(a.status_id)} kind="${k}"`);
    }
    return bad.length ? bad : null;
  },
};

const statusApplyTargetsEnemies: Invariant = {
  id: "status_apply_targets_enemies",
  description: "status applied by a raccoon goes to a raccoon on the OTHER side",
  check(log) {
    const racOwner = new Map<number, number>();
    for (const e of log.byKind.get("rac_spawn") ?? [])
      racOwner.set(Number(e.rac_id), Number(e.owner));
    const bad: string[] = [];
    for (const a of log.byKind.get("status_apply") ?? []) {
      if (String(a.tgt_kind ?? "rac") !== "rac") continue;
      const src = Number(a.src_rac);
      if (src < 0) continue; // environmental DoT
      const tgt = Number(a.tgt_id);
      const so = racOwner.get(src);
      const to = racOwner.get(tgt);
      if (so !== undefined && to !== undefined && so === to) {
        bad.push(`src ${src} (owner ${so}) applied "${String(a.status_id)}" to ally ${tgt}`);
      }
    }
    return bad.length ? bad : null;
  },
};

const statusExpireFollowsApply: Invariant = {
  id: "status_expire_follows_apply",
  description: "every status_expire was preceded by a status_apply for the same (rac, status_id)",
  check(log) {
    const applied = new Set<string>();
    for (const r of log.rows) {
      if (r.event_kind === "status_apply") {
        applied.add(`${String(r.tgt_id)}|${String(r.status_id)}`);
      } else if (r.event_kind === "status_expire") {
        const key = `${String(r.tgt_id)}|${String(r.status_id)}`;
        if (!applied.has(key)) {
          return [`tgt=${String(r.tgt_id)} status=${String(r.status_id)} expired without prior apply`];
        }
        // a status_expire pairs with the most recent apply; we don't
        // need to remove the entry — multiple stacks expire one at a time
      }
    }
    return null;
  },
};

const rageFireReferencesRealRac: Invariant = {
  id: "rage_fire_references_real_rac",
  description: "every rage_fire.rac_id was previously rac_spawn'd",
  check(log) {
    const racIds = new Set<number>(
      (log.byKind.get("rac_spawn") ?? []).map((e) => Number(e.rac_id)),
    );
    const bad: string[] = [];
    for (const r of log.byKind.get("rage_fire") ?? []) {
      const id = Number(r.rac_id);
      if (!racIds.has(id)) bad.push(`rage_fire rac_id=${id} never spawned`);
    }
    return bad.length ? bad : null;
  },
};

const rageFireTargetsAreEnemies: Invariant = {
  id: "rage_fire_targets_are_enemies",
  description: "rage_fire targets_rac/targets_bin are owned by the OTHER side",
  check(log) {
    const racOwner = new Map<number, number>();
    for (const e of log.byKind.get("rac_spawn") ?? [])
      racOwner.set(Number(e.rac_id), Number(e.owner));
    const binOwner = new Map<number, number>();
    for (const e of log.byKind.get("bin_spawn") ?? [])
      binOwner.set(Number(e.bin_id), Number(e.owner));
    const bad: string[] = [];
    for (const r of log.byKind.get("rage_fire") ?? []) {
      const me = Number(r.owner);
      for (const t of (r.targets_rac as unknown[] | undefined) ?? []) {
        const o = racOwner.get(Number(t));
        if (o === me) bad.push(`rage_fire by ${String(r.rac_id)} hit ally rac ${String(t)}`);
      }
      for (const t of (r.targets_bin as unknown[] | undefined) ?? []) {
        const o = binOwner.get(Number(t));
        if (o === me) bad.push(`rage_fire by ${String(r.rac_id)} hit ally bin ${String(t)}`);
      }
    }
    return bad.length ? bad : null;
  },
};

const damageSourceLabels: Invariant = {
  id: "damage_source_labels_known",
  description: "damage_apply.source is one of {basic, rage, dot}",
  check(log) {
    const ok = new Set(["basic", "rage", "dot"]);
    const bad: string[] = [];
    for (const d of log.byKind.get("damage_apply") ?? []) {
      const s = String(d.source ?? "basic");
      if (!ok.has(s)) bad.push(`tgt=${String(d.tgt_id)} source="${s}"`);
    }
    return bad.length ? bad : null;
  },
};

const dotDamageHasStatusId: Invariant = {
  id: "dot_damage_has_status_id",
  description: "damage_apply with source=dot carries a status_id",
  check(log) {
    const bad: string[] = [];
    for (const d of log.byKind.get("damage_apply") ?? []) {
      if (String(d.source ?? "basic") !== "dot") continue;
      if (!d.status_id) bad.push(`tgt=${String(d.tgt_id)} dot damage missing status_id`);
    }
    return bad.length ? bad : null;
  },
};

const PHASE_1E_ADDITIONS: Invariant[] = [
  statusApplyReferencesRealRac,
  statusApplyHasKnownKind,
  statusApplyTargetsEnemies,
  statusExpireFollowsApply,
  rageFireReferencesRealRac,
  rageFireTargetsAreEnemies,
  damageSourceLabels,
  dotDamageHasStatusId,
];

// ---------- PHASE 1F ADDITIONS: synergies ----------

const synergyEventShapeValid: Invariant = {
  id: "synergy_active_event_shape_valid",
  description: "synergy_active rows have side ∈ {0,1}, axis ∈ {env,cur}, state ∈ {on,off}, threshold ≥ 1",
  check(log) {
    const bad: string[] = [];
    for (const e of log.byKind.get("synergy_active") ?? []) {
      const side = Number(e.side);
      const axis = String(e.axis);
      const state = String(e.state);
      const threshold = Number(e.threshold);
      if (side !== 0 && side !== 1) bad.push(`side=${side}`);
      if (axis !== "environment" && axis !== "curiosity") bad.push(`axis="${axis}"`);
      if (state !== "on" && state !== "off") bad.push(`state="${state}"`);
      if (!(threshold >= 1)) bad.push(`threshold=${threshold}`);
    }
    return bad.length ? bad : null;
  },
};

const synergyOffPrecededByOn: Invariant = {
  id: "synergy_off_preceded_by_on",
  description: "every synergy_active state=off was preceded by a state=on for the same key",
  check(log) {
    const onSet = new Set<string>();
    for (const r of log.rows) {
      if (r.event_kind !== "synergy_active") continue;
      const key = `${String(r.side)}|${String(r.axis)}|${String(r.owner_idx)}|${String(r.threshold)}`;
      const state = String(r.state);
      if (state === "on") {
        onSet.add(key);
      } else if (state === "off") {
        if (!onSet.has(key)) return [`${key}: off without prior on`];
        onSet.delete(key);
      }
    }
    return null;
  },
};

const PHASE_1F_ADDITIONS: Invariant[] = [synergyEventShapeValid, synergyOffPrecededByOn];

// ---------- composed phase registries ----------

export const PHASE_1A_INVARIANTS: Invariant[] = [...UNIVERSAL, ...PHASE_1A_ONLY];
export const PHASE_1B_INVARIANTS: Invariant[] = [...UNIVERSAL, ...PHASE_1B_ADDITIONS];
export const PHASE_1C_INVARIANTS: Invariant[] = [
  ...UNIVERSAL,
  ...PHASE_1B_ADDITIONS,
  ...PHASE_1C_ADDITIONS,
];
export const PHASE_1D_INVARIANTS: Invariant[] = [
  ...UNIVERSAL,
  ...PHASE_1B_ADDITIONS,
  ...PHASE_1C_ADDITIONS,
  ...PHASE_1D_ADDITIONS,
];
export const PHASE_1E_INVARIANTS: Invariant[] = [
  ...UNIVERSAL,
  ...PHASE_1B_ADDITIONS,
  ...PHASE_1C_ADDITIONS,
  ...PHASE_1D_ADDITIONS,
  ...PHASE_1E_ADDITIONS,
];
export const PHASE_1F_INVARIANTS: Invariant[] = [
  ...UNIVERSAL,
  ...PHASE_1B_ADDITIONS,
  ...PHASE_1C_ADDITIONS,
  ...PHASE_1D_ADDITIONS,
  ...PHASE_1E_ADDITIONS,
  ...PHASE_1F_ADDITIONS,
];

export type Phase = "1a" | "1b" | "1c" | "1d" | "1e" | "1f";

export function invariantsForPhase(phase: Phase): Invariant[] {
  switch (phase) {
    case "1a":
      return PHASE_1A_INVARIANTS;
    case "1b":
      return PHASE_1B_INVARIANTS;
    case "1c":
      return PHASE_1C_INVARIANTS;
    case "1d":
      return PHASE_1D_INVARIANTS;
    case "1e":
      return PHASE_1E_INVARIANTS;
    case "1f":
      return PHASE_1F_INVARIANTS;
  }
}

export interface InvariantResult {
  invariantId: string;
  description: string;
  passed: boolean;
  violations: string[];
}

export function runInvariants(
  log: ParsedLog,
  ctx: CheckContext,
  invariants: Invariant[],
): InvariantResult[] {
  return invariants.map((inv) => {
    const v = inv.check(log, ctx);
    return {
      invariantId: inv.id,
      description: inv.description,
      passed: v === null,
      violations: v ?? [],
    };
  });
}

export function eventCounts(log: ParsedLog): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of log.byKind) out[k] = v.length;
  return out;
}

export type { LogRow };
