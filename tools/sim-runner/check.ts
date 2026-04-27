/**
 * sim:check — run N battles with varied seeds + comp pairings, validate
 * each battle's NDJSON log against the active phase's invariant suite.
 *
 * Default phase is "1a" — the no-op tick. As subsystems land, bump the
 * default to "1b" / "1c" / etc. so every check run grows stricter.
 *
 * Usage:
 *   npm run sim:check                    # default: phase 1a, 5 battles
 *   tsx tools/sim-runner/check.ts --phase 1a --count 10
 *   tsx tools/sim-runner/check.ts --comp-a test-city-swarm --comp-b test-suburban-wall
 */

import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  logSetupEvents,
  resolveTimeout,
  setupBattle,
  tick,
  type BattleConfig,
} from "../../src/sim/index.js";
import { loadContentFromFs } from "../../src/sim/load-fs.js";
import { FileLogger, buildLogFilePath } from "../../src/sim/log-fs.js";
import {
  invariantsForPhase,
  runInvariants,
  eventCounts,
  type Phase,
  type CheckContext,
} from "./invariants.js";
import { parseLogFile } from "./log-reader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

interface Args {
  phase: Phase;
  count: number;
  ticks: number;
  compA: string;
  compB: string;
  startSeed: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    phase: "1f",
    count: 5,
    ticks: 600,
    compA: "test-city-swarm",
    compB: "test-suburban-wall",
    startSeed: 0xc0ffee,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--phase") (out.phase = v as Phase), i++;
    else if (a === "--count") (out.count = Number(v)), i++;
    else if (a === "--ticks") (out.ticks = Number(v)), i++;
    else if (a === "--comp-a") (out.compA = v), i++;
    else if (a === "--comp-b") (out.compB = v), i++;
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

async function runOne(
  content: Awaited<ReturnType<typeof loadContentFromFs>>,
  args: Args,
  seed: number,
): Promise<string> {
  const battleId = uuidv4();
  const cfg: BattleConfig = {
    seed,
    battleId,
    compA: args.compA,
    compB: args.compB,
    bounds: { w: 100, h: 100 },
    verbosity: "events",
  };
  const logPath = buildLogFilePath(REPO_ROOT, battleId, seed);
  const log = new FileLogger({
    filePath: logPath,
    battle_id: battleId,
    seed,
    service_version: gitHash("src/sim"),
    content_version: content.version,
  });
  const state = setupBattle(content, cfg);
  log.setTickReader(() => state.tick);
  log.emit("battle_start", {
    comp_a: args.compA,
    comp_b: args.compB,
    bins_a: Array.from({ length: state.bin.count })
      .map((_, i) => i)
      .filter((i) => state.bin.owner[i] === 0)
      .map((i) => state.unitIdTable[state.bin.unitIdIdx[i]]),
    bins_b: Array.from({ length: state.bin.count })
      .map((_, i) => i)
      .filter((i) => state.bin.owner[i] === 1)
      .map((i) => state.unitIdTable[state.bin.unitIdIdx[i]]),
    bounds_w: cfg.bounds.w,
    bounds_h: cfg.bounds.h,
  });
  logSetupEvents(state, log);
  const t0 = Date.now();
  let earlyExit = false;
  for (let i = 0; i < args.ticks; i++) {
    tick(state, content, log);
    if (state.winner !== -1 || state.endReason !== null) {
      earlyExit = true;
      break;
    }
  }
  const elapsedMs = Date.now() - t0;
  void earlyExit;
  log.emit("battle_end", {
    winner: state.winner,
    reason: state.endReason ?? "timeout",
    final_tick: state.tick,
    wallclock_ms: elapsedMs,
    bins_alive_a: countAlive(state.bin.alive, state.bin.owner, state.bin.count, 0),
    bins_alive_b: countAlive(state.bin.alive, state.bin.owner, state.bin.count, 1),
    racs_alive_a: countAlive(state.rac.alive, state.rac.owner, state.rac.count, 0),
    racs_alive_b: countAlive(state.rac.alive, state.rac.owner, state.rac.count, 1),
  });
  await log.flush();
  return logPath;
}

function countAlive(alive: Uint8Array, owner: Uint8Array, count: number, side: number): number {
  let n = 0;
  for (let i = 0; i < count; i++) if (alive[i] && owner[i] === side) n++;
  return n;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.stdout.write(
    `[sim-check] phase=${args.phase} count=${args.count} ticks=${args.ticks} ` +
      `comps=${args.compA} vs ${args.compB} startSeed=0x${args.startSeed.toString(16)}\n`,
  );

  const content = await loadContentFromFs({ repoRoot: REPO_ROOT });
  const invariants = invariantsForPhase(args.phase);
  process.stdout.write(`[sim-check] ${invariants.length} invariants registered for phase ${args.phase}\n\n`);

  const ctx: CheckContext = {
    expectedTicks: args.ticks,
    expectedBinsPerSide: 4,
  };

  let totalChecks = 0;
  let totalFailures = 0;
  const failed: { logPath: string; invariantId: string; violations: string[] }[] = [];

  for (let n = 0; n < args.count; n++) {
    const seed = args.startSeed + n;
    const logPath = await runOne(content, args, seed);
    const log = await parseLogFile(logPath);
    const counts = eventCounts(log);
    const results = runInvariants(log, ctx, invariants);
    const passed = results.filter((r) => r.passed).length;
    const failures = results.filter((r) => !r.passed);
    totalChecks += results.length;
    totalFailures += failures.length;

    const summary = Object.entries(counts)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    process.stdout.write(
      `[sim-check] battle #${n} seed=${seed} pass=${passed}/${results.length} ` +
        `[${path.relative(REPO_ROOT, logPath)}]\n  events: ${summary}\n`,
    );
    for (const f of failures) {
      failed.push({ logPath, invariantId: f.invariantId, violations: f.violations });
      process.stdout.write(`  ✗ ${f.invariantId}: ${f.description}\n`);
      for (const v of f.violations.slice(0, 5)) process.stdout.write(`      ${v}\n`);
      if (f.violations.length > 5) {
        process.stdout.write(`      … +${f.violations.length - 5} more\n`);
      }
    }
  }

  process.stdout.write(`\n[sim-check] ${totalChecks - totalFailures}/${totalChecks} invariants passed across ${args.count} battles\n`);
  if (totalFailures > 0) {
    process.stdout.write(`[sim-check] ${failed.length} failure(s):\n`);
    for (const f of failed) {
      process.stdout.write(`  - ${path.relative(REPO_ROOT, f.logPath)} :: ${f.invariantId}\n`);
    }
    process.exit(1);
  }
  process.stdout.write("[sim-check] ok\n");
}

main().catch((e) => {
  process.stderr.write(`[sim-check] failed: ${String(e?.stack ?? e)}\n`);
  process.exit(1);
});

// keep `fs` import used so isolatedModules-style strict builds don't trip later
void fs;
