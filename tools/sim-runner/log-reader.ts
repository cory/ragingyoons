/**
 * NDJSON log reader. Parses sim event logs into typed records that the
 * invariant suite + future analytics can query.
 *
 * No SQL, no DataFrame layer — keeps the dependency footprint small. If
 * the analytics surface grows, swap in DuckDB-WASM or arrow-js later.
 */

import { promises as fs } from "node:fs";

export const KNOWN_EVENT_KINDS = new Set([
  "battle_start",
  "battle_end",
  "bin_spawn",
  "bin_death",
  "rac_spawn",
  "rac_death",
  "rac_target",
  "rac_attack",
  "damage_apply",
  "status_apply",
  "status_expire",
  "rage_fire",
  "synergy_active",
  "synergy_inactive",
  "tick_summary",
]);

export const REQUIRED_BASE_FIELDS = [
  "ts",
  "tick",
  "schema_version",
  "service_name",
  "service_version",
  "content_version",
  "battle_id",
  "seed",
  "event_kind",
] as const;

export type LogRow = Record<string, unknown> & {
  ts: string;
  tick: number;
  schema_version: number;
  service_name: string;
  service_version: string;
  content_version: string;
  battle_id: string;
  seed: number;
  event_kind: string;
};

export interface ParsedLog {
  /** Path the log was read from. */
  path: string;
  /** All rows in order, as parsed. */
  rows: LogRow[];
  /** Rows grouped by event_kind for cheap lookup. */
  byKind: Map<string, LogRow[]>;
  /** First battle_id seen (will be the only one if invariants hold). */
  battleId: string;
}

export async function parseLogFile(filePath: string): Promise<ParsedLog> {
  const raw = await fs.readFile(filePath, "utf8");
  return parseLogText(filePath, raw);
}

export function parseLogText(filePath: string, raw: string): ParsedLog {
  const rows: LogRow[] = [];
  const byKind = new Map<string, LogRow[]>();
  let battleId = "";

  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new Error(`${filePath}:${i + 1} — invalid JSON: ${String(e)}`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`${filePath}:${i + 1} — row is not an object`);
    }
    const row = parsed as LogRow;
    rows.push(row);
    const kind = String(row.event_kind ?? "");
    let bucket = byKind.get(kind);
    if (!bucket) byKind.set(kind, (bucket = []));
    bucket.push(row);
    if (!battleId && typeof row.battle_id === "string") battleId = row.battle_id;
  }

  return { path: filePath, rows, byKind, battleId };
}
