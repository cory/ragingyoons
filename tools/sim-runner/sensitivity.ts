/**
 * Stat sensitivity harness — perturb a single unit's stat across a
 * range of multipliers, run N battles per value, plot winrate response.
 *
 * Identifies which dials actually move the needle for a given matchup.
 * If you scale Shadow's damage from 0.5× to 1.5× and the winrate
 * barely moves, damage isn't the bottleneck (try HP or speed).
 *
 * Usage:
 *   tsx tools/sim-runner/sensitivity.ts \
 *     --comp-a test-park-snipe --comp-b test-suburban-wall \
 *     --unit park-lockpicker-cavalry-shadow \
 *     --stat damage \
 *     --multipliers 0.5,0.75,1.0,1.25,1.5 \
 *     --seeds 20 --ticks 1000
 */

import { execSync } from "node:child_process";
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
  type UnitDef,
} from "../../src/sim/index.js";
import { loadContentFromFs } from "../../src/sim/load-fs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

type StatField = "hp" | "damage" | "attack_rate" | "range" | "speed" | "armor";

interface Args {
  compA: string;
  compB: string;
  unit: string;
  stat: StatField;
  multipliers: number[];
  seeds: number;
  ticks: number;
  startSeed: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    compA: "test-park-snipe",
    compB: "test-suburban-wall",
    unit: "park-lockpicker-cavalry-shadow",
    stat: "damage",
    multipliers: [0.5, 0.75, 1.0, 1.25, 1.5],
    seeds: 20,
    ticks: 1000,
    startSeed: 0xc0ffee,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--comp-a") (out.compA = String(v)), i++;
    else if (a === "--comp-b") (out.compB = String(v)), i++;
    else if (a === "--unit") (out.unit = String(v)), i++;
    else if (a === "--stat") (out.stat = v as StatField), i++;
    else if (a === "--multipliers") {
      out.multipliers = String(v).split(",").map((s) => Number(s.trim()));
      i++;
    } else if (a === "--seeds") (out.seeds = Number(v)), i++;
    else if (a === "--ticks") (out.ticks = Number(v)), i++;
    else if (a === "--seed") (out.startSeed = Number(v)), i++;
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

/** Deep-clone the unit's stats and override one field. Returns a fresh
 *  ContentBundle that shares everything else with the original (Maps
 *  are reference-shared except for `units` which gets its own copy). */
function bundleWithStatOverride(
  base: ContentBundle,
  unitId: string,
  stat: StatField,
  mul: number,
): ContentBundle {
  const u = base.units.get(unitId);
  if (!u) throw new Error(`unknown unit ${unitId}`);
  const newU: UnitDef = {
    ...u,
    stats: { ...u.stats, [stat]: u.stats[stat] * mul },
  };
  const newUnits = new Map(base.units);
  newUnits.set(unitId, newU);
  return { ...base, units: newUnits };
}

async function runOne(
  content: ContentBundle,
  compA: string,
  compB: string,
  seed: number,
  ticks: number,
): Promise<-1 | 0 | 1> {
  const battleId = uuidv4();
  const cfg: BattleConfig = {
    seed,
    battleId,
    compA,
    compB,
    bounds: { w: 100, h: 100 },
    verbosity: "events",
  };
  const log = new MemoryLogger({
    battle_id: battleId,
    seed,
    service_version: gitHash("src/sim"),
    content_version: content.version,
  });
  const state = setupBattle(content, cfg);
  log.setTickReader(() => state.tick);
  log.emit("battle_start", { comp_a: compA, comp_b: compB, bounds_w: 100, bounds_h: 100 });
  logSetupEvents(state, log);
  for (let i = 0; i < ticks; i++) {
    tick(state, content, log);
    if (state.winner !== -1 || state.endReason !== null) break;
  }
  if (state.winner === -1 && state.endReason === null) resolveTimeout(state);
  return state.winner;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseContent = await loadContentFromFs({ repoRoot: REPO_ROOT });
  const baseUnit = baseContent.units.get(args.unit);
  if (!baseUnit) throw new Error(`unknown unit "${args.unit}"`);
  const baseStat = baseUnit.stats[args.stat];

  process.stdout.write(
    `[sens] comp ${args.compA} vs ${args.compB}\n` +
      `[sens] unit ${args.unit}, stat ${args.stat} (base=${baseStat})\n` +
      `[sens] multipliers: ${args.multipliers.join(", ")}\n` +
      `[sens] seeds=${args.seeds}, ticks=${args.ticks}\n\n`,
  );

  interface Row {
    mul: number;
    value: number;
    aWins: number;
    bWins: number;
    draws: number;
  }
  const rows: Row[] = [];

  const t0 = Date.now();
  for (const mul of args.multipliers) {
    const content = bundleWithStatOverride(baseContent, args.unit, args.stat, mul);
    let aWins = 0;
    let bWins = 0;
    let draws = 0;
    for (let s = 0; s < args.seeds; s++) {
      const seed = args.startSeed + s;
      const w = await runOne(content, args.compA, args.compB, seed, args.ticks);
      if (w === 0) aWins++;
      else if (w === 1) bWins++;
      else draws++;
    }
    rows.push({ mul, value: baseStat * mul, aWins, bWins, draws });
  }
  const elapsedMs = Date.now() - t0;

  // Render
  process.stdout.write(`mul    value     A-wins  B-wins  draws  A-rate\n`);
  process.stdout.write(`-----  --------  ------  ------  -----  ------\n`);
  for (const r of rows) {
    const decisive = r.aWins + r.bWins;
    const rate = decisive > 0 ? (r.aWins / decisive) * 100 : 0;
    const rateStr = decisive > 0 ? `${rate.toFixed(0)}%` : "—";
    process.stdout.write(
      `${r.mul.toFixed(2).padStart(5)}  ${r.value.toFixed(2).padStart(8)}  ${String(r.aWins).padStart(6)}  ${String(r.bWins).padStart(6)}  ${String(r.draws).padStart(5)}  ${rateStr.padStart(6)}\n`,
    );
  }

  // Sensitivity score: change in A-rate per unit change in multiplier.
  let sens = 0;
  if (rows.length >= 2) {
    const first = rows[0];
    const last = rows[rows.length - 1];
    const firstRate = first.aWins / Math.max(1, first.aWins + first.bWins);
    const lastRate = last.aWins / Math.max(1, last.aWins + last.bWins);
    const dMul = last.mul - first.mul;
    sens = dMul !== 0 ? (lastRate - firstRate) / dMul : 0;
  }
  process.stdout.write(
    `\n[sens] A-rate sensitivity to ${args.stat}: ${(sens * 100).toFixed(1)}% per 1.0× change\n`,
  );
  process.stdout.write(
    `[sens] ${rows.length * args.seeds} battles in ${(elapsedMs / 1000).toFixed(2)}s\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`[sens] failed: ${String(e?.stack ?? e)}\n`);
  process.exit(1);
});
