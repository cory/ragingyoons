/**
 * Batch runner — run M battles for each (compA, compB) pairing across
 * N seeds, aggregate winners + final ticks + timing, output a Markdown
 * winrate matrix and a per-battle NDJSON summary.
 *
 * In-memory logging (MemoryLogger) avoids per-battle disk I/O, which
 * matters at thousands of runs. Per-battle NDJSON gets dropped to
 * `logs/batch/<batch_id>/` if `--write-logs` is passed; otherwise only
 * the summary is persisted.
 *
 * Usage:
 *   npm run sim:batch
 *   npm run sim:batch -- --seeds 50 --comps test-city-swarm,test-park-snipe,test-suburban-wall
 *   npm run sim:batch -- --ticks 2000 --comps "*"          # use all comps
 *   npm run sim:batch -- --write-logs                       # also dump per-battle NDJSON
 */

import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MemoryLogger,
  logSetupEvents,
  resolveTimeout,
  setupBattle,
  tick,
  type BattleConfig,
  type ContentBundle,
} from "../../src/sim/index.js";
import { loadContentFromFs } from "../../src/sim/load-fs.js";
import { FileLogger, buildLogFilePath } from "../../src/sim/log-fs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

interface Args {
  seeds: number;
  ticks: number;
  comps: string[]; // explicit list, or empty for "all"
  startSeed: number;
  writeLogs: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    seeds: 20,
    ticks: 1500,
    comps: [],
    startSeed: 0xc0ffee,
    writeLogs: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--seeds") (out.seeds = Number(v)), i++;
    else if (a === "--ticks") (out.ticks = Number(v)), i++;
    else if (a === "--comps") {
      out.comps = String(v).split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (a === "--seed") (out.startSeed = Number(v)), i++;
    else if (a === "--write-logs") out.writeLogs = true;
  }
  return out;
}

function gitHash(scope: string): string {
  try {
    return execSync(`git -C "${REPO_ROOT}" rev-parse HEAD:"${scope}"`, {
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString("utf8")
      .trim();
  } catch {
    return "unversioned";
  }
}

function uuidv4(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  a[6] = (a[6] & 0x0f) | 0x40;
  a[8] = (a[8] & 0x3f) | 0x80;
  const h = [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

interface BattleOutcome {
  comp_a: string;
  comp_b: string;
  seed: number;
  battle_id: string;
  winner: -1 | 0 | 1;
  reason: string;
  final_tick: number;
  wallclock_ms: number;
  bins_alive_a: number;
  bins_alive_b: number;
  racs_alive_a: number;
  racs_alive_b: number;
  rac_deaths: number;
  bin_deaths: number;
}

async function runOne(
  content: ContentBundle,
  compA: string,
  compB: string,
  seed: number,
  ticks: number,
  batchId: string,
  writeLogs: boolean,
): Promise<BattleOutcome> {
  const battleId = uuidv4();
  const cfg: BattleConfig = {
    seed,
    battleId,
    compA,
    compB,
    bounds: { w: 100, h: 100 },
    verbosity: "events",
  };
  const log = writeLogs
    ? new FileLogger({
        filePath: path.join(REPO_ROOT, "logs", "batch", batchId, `${compA}__vs__${compB}__seed${seed}.ndjson`),
        battle_id: battleId,
        seed,
        service_version: gitHash("src/sim"),
        content_version: content.version,
      })
    : new MemoryLogger({
        battle_id: battleId,
        seed,
        service_version: gitHash("src/sim"),
        content_version: content.version,
      });

  const state = setupBattle(content, cfg);
  log.setTickReader(() => state.tick);
  log.emit("battle_start", { comp_a: compA, comp_b: compB, bounds_w: cfg.bounds.w, bounds_h: cfg.bounds.h });
  logSetupEvents(state, log);

  let racDeaths = 0;
  let binDeaths = 0;

  const t0 = Date.now();
  for (let i = 0; i < ticks; i++) {
    tick(state, content, log);
    if (state.winner !== -1 || state.endReason !== null) break;
  }
  // If the loop exhausted the tick budget without a winner, score it.
  if (state.winner === -1 && state.endReason === null) {
    resolveTimeout(state);
  }
  const elapsedMs = Date.now() - t0;

  // Tally deaths from the in-memory log (cheap; we skip this for
  // FileLogger since we'd have to re-read the file).
  if (log instanceof MemoryLogger) {
    for (const line of log.drain()) {
      if (line.includes('"event_kind":"rac_death"')) racDeaths++;
      else if (line.includes('"event_kind":"bin_death"')) binDeaths++;
    }
  }

  let binsA = 0;
  let binsB = 0;
  let racsA = 0;
  let racsB = 0;
  for (let i = 0; i < state.bin.count; i++) {
    if (!state.bin.alive[i]) continue;
    if (state.bin.owner[i] === 0) binsA++;
    else binsB++;
  }
  for (let i = 0; i < state.rac.count; i++) {
    if (!state.rac.alive[i]) continue;
    if (state.rac.owner[i] === 0) racsA++;
    else racsB++;
  }

  log.emit("battle_end", {
    winner: state.winner,
    reason: state.endReason ?? "timeout",
    final_tick: state.tick,
    wallclock_ms: elapsedMs,
    bins_alive_a: binsA,
    bins_alive_b: binsB,
    racs_alive_a: racsA,
    racs_alive_b: racsB,
  });
  await log.flush();

  return {
    comp_a: compA,
    comp_b: compB,
    seed,
    battle_id: battleId,
    winner: state.winner,
    reason: state.endReason ?? "timeout",
    final_tick: state.tick,
    wallclock_ms: elapsedMs,
    bins_alive_a: binsA,
    bins_alive_b: binsB,
    racs_alive_a: racsA,
    racs_alive_b: racsB,
    rac_deaths: racDeaths,
    bin_deaths: binDeaths,
  };
}

async function writeSummary(batchId: string, rows: BattleOutcome[]): Promise<string> {
  const dir = path.join(REPO_ROOT, "logs", "batch", batchId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "summary.ndjson");
  const ndjson = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await fs.writeFile(file, ndjson, "utf8");
  return file;
}

interface MatrixCell {
  battles: number;
  aWins: number;
  bWins: number;
  draws: number;
  meanFinalTick: number;
  meanWallclockMs: number;
}

function buildMatrix(comps: string[], outcomes: BattleOutcome[]): Map<string, Map<string, MatrixCell>> {
  const m = new Map<string, Map<string, MatrixCell>>();
  for (const a of comps) m.set(a, new Map());
  for (const o of outcomes) {
    const row = m.get(o.comp_a);
    if (!row) continue;
    let cell = row.get(o.comp_b);
    if (!cell) {
      cell = { battles: 0, aWins: 0, bWins: 0, draws: 0, meanFinalTick: 0, meanWallclockMs: 0 };
      row.set(o.comp_b, cell);
    }
    cell.battles += 1;
    if (o.winner === 0) cell.aWins += 1;
    else if (o.winner === 1) cell.bWins += 1;
    else cell.draws += 1;
    cell.meanFinalTick += o.final_tick;
    cell.meanWallclockMs += o.wallclock_ms;
  }
  for (const row of m.values()) {
    for (const cell of row.values()) {
      if (cell.battles > 0) {
        cell.meanFinalTick = Math.round(cell.meanFinalTick / cell.battles);
        cell.meanWallclockMs = Math.round(cell.meanWallclockMs / cell.battles);
      }
    }
  }
  return m;
}

function formatCell(cell: MatrixCell): string {
  if (cell.battles === 0) return "—";
  const wr = cell.aWins / cell.battles;
  const draws = cell.draws > 0 ? `/${cell.draws}d` : "";
  return `${(wr * 100).toFixed(0)}% (${cell.aWins}/${cell.battles}${draws})`;
}

function formatMatrix(comps: string[], m: Map<string, Map<string, MatrixCell>>): string {
  const compShort = (c: string) => c.replace(/^test-/, "").slice(0, 16);
  const hdr = ["compA \\ compB", ...comps.map(compShort)];
  const colWidths = hdr.map((h) => h.length);
  const rows: string[][] = [];
  for (const a of comps) {
    const cells = comps.map((b, i) => {
      const cell = m.get(a)?.get(b);
      const text = cell ? formatCell(cell) : "—";
      colWidths[i + 1] = Math.max(colWidths[i + 1], text.length);
      return text;
    });
    const aText = compShort(a);
    colWidths[0] = Math.max(colWidths[0], aText.length);
    rows.push([aText, ...cells]);
  }
  const pad = (s: string, w: number) => s.padEnd(w);
  const lines: string[] = [];
  lines.push("| " + hdr.map((h, i) => pad(h, colWidths[i])).join(" | ") + " |");
  lines.push("|" + colWidths.map((w) => "-".repeat(w + 2)).join("|") + "|");
  for (const r of rows) lines.push("| " + r.map((c, i) => pad(c, colWidths[i])).join(" | ") + " |");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const content = await loadContentFromFs({ repoRoot: REPO_ROOT });

  let comps = args.comps;
  if (comps.length === 0) {
    // Default: all comp cards we have, sorted.
    comps = [...content.comps.keys()].sort();
  } else if (comps.length === 1 && comps[0] === "*") {
    comps = [...content.comps.keys()].sort();
  }
  // Guard: comps must exist.
  for (const c of comps) {
    if (!content.comps.has(c)) {
      throw new Error(`unknown comp: "${c}". Available: ${[...content.comps.keys()].join(", ")}`);
    }
  }

  const batchId = uuidv4();
  process.stdout.write(
    `[batch] id=${batchId} comps=${comps.length} pairs=${comps.length * comps.length} seeds=${args.seeds} ticks=${args.ticks}\n`,
  );
  process.stdout.write(`[batch] total battles: ${comps.length * comps.length * args.seeds}\n`);

  const outcomes: BattleOutcome[] = [];
  const overallT0 = Date.now();
  let battleN = 0;
  for (const a of comps) {
    for (const b of comps) {
      for (let s = 0; s < args.seeds; s++) {
        const seed = args.startSeed + battleN;
        battleN++;
        const o = await runOne(content, a, b, seed, args.ticks, batchId, args.writeLogs);
        outcomes.push(o);
      }
    }
  }
  const overallMs = Date.now() - overallT0;

  const summaryPath = await writeSummary(batchId, outcomes);
  process.stdout.write(`[batch] summary: ${path.relative(REPO_ROOT, summaryPath)}\n`);
  process.stdout.write(`[batch] wallclock: ${(overallMs / 1000).toFixed(2)}s (${(battleN / (overallMs / 1000)).toFixed(1)} battles/s)\n\n`);

  const matrix = buildMatrix(comps, outcomes);
  process.stdout.write("Winrate matrix (cell = compA's winrate vs compB):\n\n");
  process.stdout.write(formatMatrix(comps, matrix) + "\n\n");

  // High-level stats.
  let aWinsTotal = 0;
  let bWinsTotal = 0;
  let drawsTotal = 0;
  let earlyEnds = 0;
  for (const o of outcomes) {
    if (o.winner === 0) aWinsTotal++;
    else if (o.winner === 1) bWinsTotal++;
    else drawsTotal++;
    if (o.reason !== "timeout") earlyEnds++;
  }
  process.stdout.write(
    `[batch] outcomes: ${aWinsTotal} A-wins, ${bWinsTotal} B-wins, ${drawsTotal} draws/timeouts, ${earlyEnds}/${outcomes.length} ended via win condition\n`,
  );

  // ---------- Mirror fairness check ----------
  // Mirror matchups (comp X vs comp X) should produce ~50/50 winrates
  // across seeds among DECISIVE outcomes. If A consistently wins, the
  // sim has a side-bias bug — most likely an iteration-order asymmetry
  // somewhere (combat / target / boids) where lower-row entities fire
  // first or break ties in their own favor.
  const FAIRNESS_THRESHOLD = 0.15;
  const FAIRNESS_MIN_DECISIVE = 6;
  const fairnessLines: string[] = [];
  let mirrorBiasCount = 0;
  for (const c of comps) {
    const cell = matrix.get(c)?.get(c);
    if (!cell || cell.battles === 0) continue;
    const decisive = cell.aWins + cell.bWins;
    if (decisive < FAIRNESS_MIN_DECISIVE) {
      fairnessLines.push(
        `  ○ ${shortName(c)} vs self: ${cell.aWins}A/${cell.bWins}B/${cell.draws}d (only ${decisive} decisive — need ≥ ${FAIRNESS_MIN_DECISIVE})`,
      );
      continue;
    }
    const aRate = cell.aWins / decisive;
    const dist = Math.abs(aRate - 0.5);
    if (dist > FAIRNESS_THRESHOLD) {
      mirrorBiasCount++;
      fairnessLines.push(
        `  ✗ ${shortName(c)} vs self: ${cell.aWins}A/${cell.bWins}B (A-rate ${(aRate * 100).toFixed(0)}%, BIASED)`,
      );
    } else {
      fairnessLines.push(
        `  ✓ ${shortName(c)} vs self: ${cell.aWins}A/${cell.bWins}B (A-rate ${(aRate * 100).toFixed(0)}%)`,
      );
    }
  }
  process.stdout.write("\nMirror fairness (should be ~50/50 across seeds):\n");
  for (const ln of fairnessLines) process.stdout.write(ln + "\n");
  if (mirrorBiasCount > 0) {
    process.stdout.write(
      `\n[batch] ⚠ ${mirrorBiasCount} mirror matchup(s) show side bias > ±${(FAIRNESS_THRESHOLD * 100).toFixed(0)}%. ` +
        `Likely an iteration-order asymmetry in target / combat / boids.\n`,
    );
  }

  // ---------- Asymmetry hotspots ----------
  // Off-diagonal matchups with extreme winrates (far from 50%) are the
  // design-interesting ones — they encode "comp X hard-counters comp Y."
  interface Hotspot { a: string; b: string; aRate: number; decisive: number; aWins: number; bWins: number }
  const hotspots: Hotspot[] = [];
  for (const a of comps) {
    for (const b of comps) {
      if (a === b) continue;
      const cell = matrix.get(a)?.get(b);
      if (!cell) continue;
      const decisive = cell.aWins + cell.bWins;
      if (decisive < 4) continue;
      hotspots.push({
        a,
        b,
        aRate: cell.aWins / decisive,
        decisive,
        aWins: cell.aWins,
        bWins: cell.bWins,
      });
    }
  }
  hotspots.sort((x, y) => Math.abs(y.aRate - 0.5) - Math.abs(x.aRate - 0.5));
  if (hotspots.length > 0) {
    process.stdout.write("\nAsymmetry hotspots (design-interesting matchups, sorted by |winrate − 50%|):\n");
    for (const h of hotspots.slice(0, 8)) {
      const arrow = h.aRate > 0.5 ? "→" : "←";
      const flavor = h.aRate > 0.5 ? "A favored" : "B favored";
      process.stdout.write(
        `  ${(h.aRate * 100).toFixed(0).padStart(3)}% ${shortName(h.a)} ${arrow} ${shortName(h.b)}  (${h.aWins}-${h.bWins}, ${flavor})\n`,
      );
    }
  }

  if (mirrorBiasCount > 0) {
    process.exit(2);
  }
}

function shortName(c: string): string {
  return c.replace(/^test-/, "");
}

main().catch((e) => {
  process.stderr.write(`[batch] failed: ${String(e?.stack ?? e)}\n`);
  process.exit(1);
});
