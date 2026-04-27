/**
 * Doctrine-balance autotuner.
 *
 * Random-local-search over DOCTRINE_KNOBS. Each iteration:
 *   1. Pick one random knob and perturb it by ±10–25%
 *   2. Run the comp matrix (k×k, N seeds each) under that knob set
 *   3. Compute loss = sum of squared distances from balance targets
 *   4. Accept if loss improves (greedy hill-climb)
 *
 * Loss components:
 *   - Mirror penalty: each (D, D) winrate should be 50%. Sum (w − 0.5)².
 *   - Domination penalty: no doctrine's average cross-winrate should
 *     exceed 0.5 + DOMINANCE_BAND. Squared excess.
 *   - Floor penalty: no doctrine should average below 0.5 − DOMINANCE_BAND.
 *   - Variance bonus: cross-matchups close to 50% are uninteresting.
 *     Reward spread (some 30%/70% matchups) — small term.
 *
 * Streams iteration records to lab/autotune/<timestamp>/iterations.ndjson
 * so the designer's tune page can poll and visualize evolution.
 *
 * CLI:
 *   npm run sim:autotune -- --duration 300 --workers 4 --seeds 20 \
 *     --comps doc-phalanx,doc-fire-team,doc-modern-patrol,doc-fanatic
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runParallel } from "./parallel-batch.js";
import type { BattleJob } from "./battle-worker.js";
import type { DoctrineKnobs } from "../../src/sim/doctrines.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Default starting knob values (must match DOCTRINE_KNOBS defaults).
const INITIAL_KNOBS: DoctrineKnobs = {
  fireTeamPeriod: 30,
  fireTeamCoverStart: 0.5,
  fireTeamCoverEnd: 0.83,
  fireTeamAdvanceSeek: 1.4,
  fireTeamRejoinSpeed: 0.5,
  skirmisherPeriod: 22,
  skirmisherSprintEnd: 0.65,
  skirmisherHaltEnd: 0.9,
  skirmisherSeekMul: 1.5,
  rushToEngagedSeek: 1.6,
  flankEngagedSeek: 1.4,
  lastStandHpFrac: 0.3,
  routVulnerability: 1.4,
  rallyVulnerability: 1.2,
  deathRageDmgRed: 0.7,
  deathRageSeek: 2.0,
  deathRageSpeed: 1.3,
};

interface KnobBound {
  min: number;
  max: number;
  /** Step size for perturbation (proportional to range). */
  step: number;
}

/** Per-knob bounds and search step. Tightly clamped on either end so
 *  a runaway perturbation can't break the sim. Step is a fraction of
 *  the knob's natural range. */
const BOUNDS: Record<keyof DoctrineKnobs, KnobBound> = {
  fireTeamPeriod: { min: 12, max: 60, step: 4 },
  fireTeamCoverStart: { min: 0.2, max: 0.7, step: 0.05 },
  fireTeamCoverEnd: { min: 0.55, max: 0.95, step: 0.05 },
  fireTeamAdvanceSeek: { min: 0.8, max: 2.5, step: 0.15 },
  fireTeamRejoinSpeed: { min: 0.1, max: 1.0, step: 0.1 },
  skirmisherPeriod: { min: 10, max: 50, step: 4 },
  skirmisherSprintEnd: { min: 0.3, max: 0.85, step: 0.05 },
  skirmisherHaltEnd: { min: 0.7, max: 0.98, step: 0.04 },
  skirmisherSeekMul: { min: 0.8, max: 2.5, step: 0.15 },
  rushToEngagedSeek: { min: 0.8, max: 2.5, step: 0.15 },
  flankEngagedSeek: { min: 0.6, max: 2.2, step: 0.15 },
  lastStandHpFrac: { min: 0.1, max: 0.5, step: 0.05 },
  routVulnerability: { min: 1.0, max: 2.0, step: 0.1 },
  rallyVulnerability: { min: 1.0, max: 1.6, step: 0.1 },
  deathRageDmgRed: { min: 0.4, max: 1.0, step: 0.05 },
  deathRageSeek: { min: 1.0, max: 3.0, step: 0.15 },
  deathRageSpeed: { min: 0.8, max: 1.8, step: 0.1 },
};

const KNOB_KEYS = Object.keys(BOUNDS) as Array<keyof DoctrineKnobs>;

interface IterationRecord {
  iter: number;
  wallTimeS: number;
  knobs: DoctrineKnobs;
  matrix: Record<string, Record<string, number>>;
  loss: number;
  accepted: boolean;
  bestLoss: number;
}

interface CLIArgs {
  duration: number;
  workers: number;
  seeds: number;
  ticks: number;
  comps: string[];
}

function parseArgs(argv: string[]): CLIArgs {
  const out: CLIArgs = {
    duration: 300,
    workers: 4,
    seeds: 20,
    ticks: 1500,
    comps: ["doc-phalanx", "doc-fire-team", "doc-modern-patrol", "doc-fanatic"],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--duration") {
      out.duration = Number(v);
      i++;
    } else if (a === "--workers") {
      out.workers = Number(v);
      i++;
    } else if (a === "--seeds") {
      out.seeds = Number(v);
      i++;
    } else if (a === "--ticks") {
      out.ticks = Number(v);
      i++;
    } else if (a === "--comps") {
      out.comps = String(v).split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    }
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function perturb(base: DoctrineKnobs, rng: () => number): DoctrineKnobs {
  const out = { ...base };
  // Pick one or two random knobs to perturb (more changes = bigger
  // step in parameter space; biased toward small steps so the
  // search stays local).
  const nChanges = rng() < 0.7 ? 1 : 2;
  for (let i = 0; i < nChanges; i++) {
    const key = KNOB_KEYS[Math.floor(rng() * KNOB_KEYS.length)];
    const b = BOUNDS[key];
    const cur = out[key];
    const sign = rng() < 0.5 ? -1 : 1;
    const mag = (1 + Math.floor(rng() * 2)) * b.step; // 1 or 2 steps
    out[key] = clamp(cur + sign * mag, b.min, b.max);
  }
  return out;
}

interface MatrixCounts {
  cell: Map<string, Map<string, { aWins: number; bWins: number; total: number }>>;
}

function emptyMatrix(comps: string[]): MatrixCounts {
  const m: MatrixCounts = { cell: new Map() };
  for (const a of comps) {
    m.cell.set(a, new Map());
    for (const b of comps) m.cell.get(a)!.set(b, { aWins: 0, bWins: 0, total: 0 });
  }
  return m;
}

function matrixWinrates(comps: string[], m: MatrixCounts): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const a of comps) {
    out[a] = {};
    for (const b of comps) {
      const c = m.cell.get(a)!.get(b)!;
      out[a][b] = c.total > 0 ? c.aWins / c.total : 0.5;
    }
  }
  return out;
}

const DOMINANCE_BAND = 0.18; // doctrines should average within 50% ± 18% across crosses

function computeLoss(comps: string[], wr: Record<string, Record<string, number>>): number {
  let loss = 0;
  // 1. Mirror penalty: each (d, d) should be 50%.
  for (const d of comps) {
    const w = wr[d][d];
    loss += (w - 0.5) ** 2 * 1.5; // weight mirrors slightly higher
  }
  // 2. Per-doctrine average cross-winrate should be near 50%.
  // Penalize squared distance from the band [0.5 - BAND, 0.5 + BAND].
  for (const d of comps) {
    let sum = 0;
    let n = 0;
    for (const e of comps) {
      if (e === d) continue;
      sum += wr[d][e];
      n++;
    }
    const avg = n > 0 ? sum / n : 0.5;
    const dist = Math.max(0, Math.abs(avg - 0.5) - DOMINANCE_BAND);
    loss += dist ** 2 * 4; // big penalty for dominant or floor-tier doctrines
  }
  // 3. Variance bonus: subtract small term for cross-matchup spread
  // (some 30/70 matchups make the meta interesting). Negative loss
  // contribution = bonus.
  let crossVar = 0;
  let crossN = 0;
  for (const a of comps) {
    for (const b of comps) {
      if (a === b) continue;
      crossVar += (wr[a][b] - 0.5) ** 2;
      crossN++;
    }
  }
  const avgVar = crossN > 0 ? crossVar / crossN : 0;
  loss -= avgVar * 0.3; // mild bonus for spread; capped by other terms
  return loss;
}

function makeRng(seed: number): () => number {
  let s = (seed | 0) >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function evaluate(
  comps: string[],
  knobs: DoctrineKnobs,
  args: CLIArgs,
  startSeed: number,
): Promise<{ wr: Record<string, Record<string, number>>; battles: number }> {
  const jobs: BattleJob[] = [];
  for (const a of comps) {
    for (const b of comps) {
      for (let s = 0; s < args.seeds; s++) {
        jobs.push({
          battleId: `auto-${a}-${b}-${startSeed + s}`,
          seed: startSeed + s,
          compA: a,
          compB: b,
          ticks: args.ticks,
          boundsW: 100,
          boundsH: 100,
          disableSynergies: true,
          doctrineKnobs: knobs,
        });
      }
    }
  }
  const m = emptyMatrix(comps);
  await runParallel({
    jobs,
    workers: args.workers,
    onOutcome: (o) => {
      const c = m.cell.get(o.compA)!.get(o.compB)!;
      if (o.winner === 0) c.aWins++;
      else if (o.winner === 1) c.bWins++;
      c.total++;
    },
  });
  return { wr: matrixWinrates(comps, m), battles: jobs.length };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(REPO_ROOT, "lab", "autotune", stamp);
  await fs.mkdir(outDir, { recursive: true });
  const ndjsonPath = path.join(outDir, "iterations.ndjson");
  const latestPath = path.join(REPO_ROOT, "lab", "autotune", "latest.ndjson");
  await fs.mkdir(path.dirname(latestPath), { recursive: true });
  // Truncate latest pointer so the UI sees fresh data.
  await fs.writeFile(latestPath, "");

  process.stdout.write(`[autotune] dir: ${path.relative(REPO_ROOT, outDir)}\n`);
  process.stdout.write(`[autotune] comps: ${args.comps.join(", ")}\n`);
  process.stdout.write(`[autotune] duration: ${args.duration}s   seeds/cell: ${args.seeds}   workers: ${args.workers}\n\n`);

  const t0 = Date.now();
  const rng = makeRng(0xc0ffee);
  let bestKnobs = { ...INITIAL_KNOBS };
  let bestLoss = Infinity;
  let totalBattles = 0;

  // Initial evaluation
  const { wr: initialWr, battles: initialBattles } = await evaluate(args.comps, bestKnobs, args, 1);
  totalBattles += initialBattles;
  bestLoss = computeLoss(args.comps, initialWr);
  let iter = 0;
  await appendIter(ndjsonPath, latestPath, {
    iter,
    wallTimeS: (Date.now() - t0) / 1000,
    knobs: bestKnobs,
    matrix: initialWr,
    loss: bestLoss,
    accepted: true,
    bestLoss,
  });
  process.stdout.write(`iter ${iter}  loss ${bestLoss.toFixed(3)}  (initial)\n`);

  while ((Date.now() - t0) / 1000 < args.duration) {
    iter++;
    const candidate = perturb(bestKnobs, rng);
    const startSeed = 1 + iter * args.seeds;
    const { wr, battles } = await evaluate(args.comps, candidate, args, startSeed);
    totalBattles += battles;
    const loss = computeLoss(args.comps, wr);
    const accepted = loss < bestLoss;
    if (accepted) {
      bestLoss = loss;
      bestKnobs = candidate;
    }
    const wallTimeS = (Date.now() - t0) / 1000;
    await appendIter(ndjsonPath, latestPath, {
      iter,
      wallTimeS,
      knobs: candidate,
      matrix: wr,
      loss,
      accepted,
      bestLoss,
    });
    const flag = accepted ? "✓" : " ";
    process.stdout.write(
      `iter ${iter}  ${flag}  loss ${loss.toFixed(3)}  best ${bestLoss.toFixed(3)}  ` +
        `bps ${(totalBattles / wallTimeS).toFixed(1)}  t ${wallTimeS.toFixed(0)}s\n`,
    );
  }

  // Print final winner matrix
  const { wr: finalWr } = await evaluate(args.comps, bestKnobs, args, 99999);
  process.stdout.write("\n[autotune] best knobs:\n");
  for (const [k, v] of Object.entries(bestKnobs)) {
    process.stdout.write(`  ${k}: ${v}\n`);
  }
  process.stdout.write("\n[autotune] best matrix:\n");
  for (const a of args.comps) {
    const row = args.comps.map((b) => `${(finalWr[a][b] * 100).toFixed(0)}%`).join(" ");
    process.stdout.write(`  ${a.padEnd(20)} ${row}\n`);
  }
  process.stdout.write(`\n[autotune] total battles: ${totalBattles}  iters: ${iter}\n`);
  process.stdout.write(`[autotune] log: ${path.relative(REPO_ROOT, ndjsonPath)}\n`);
  // Write best knobs as a separate file for easy scripting.
  await fs.writeFile(path.join(outDir, "best.json"), JSON.stringify({ bestLoss, knobs: bestKnobs, matrix: finalWr }, null, 2));
  process.exit(0);
}

async function appendIter(ndjsonPath: string, latestPath: string, rec: IterationRecord): Promise<void> {
  const line = JSON.stringify(rec) + "\n";
  await fs.appendFile(ndjsonPath, line);
  await fs.appendFile(latestPath, line);
}

main().catch((e) => {
  process.stderr.write(`[autotune] failed: ${String(e?.stack ?? e)}\n`);
  process.exit(1);
});
