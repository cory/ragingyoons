/**
 * Doctrine-balance autotuner — genetic algorithm.
 *
 * Population of 12 candidate knob-sets (chromosomes). Each generation:
 *   1. Evaluate every individual via parallel comp-matrix battles.
 *   2. Elitism: top 2 survive unchanged.
 *   3. Tournament-2 selection picks parents.
 *   4. Uniform 50/50 crossover per knob.
 *   5. Mutation: each knob ±1-2 step sizes with p=0.15.
 *   6. Replace the rest of the pop with offspring.
 *
 * Why GA over hill-climb: the doctrine knob space has joint-knob
 * effects (a doctrine's HP and damage need to coadapt) and likely
 * multiple local optima (different RPS equilibria). GA's crossover
 * combines knob clusters from successful individuals, and the
 * population preserves diverse strategies rather than committing to
 * one local minimum.
 *
 * Streams iteration NDJSON to lab/autotune/latest.ndjson with a
 * `gen` and `ranking` so the tune UI can show per-generation views.
 *
 * CLI:
 *   npm run sim:autotune -- --duration 300 --workers 4 --seeds 20 \
 *     --pop 12 --comps doc-phalanx,doc-fire-team,doc-modern-patrol,doc-fanatic
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
  phalanxHpMul: 1.0,
  phalanxDamageMul: 1.0,
  phalanxSpeedMul: 1.0,
  phalanxSupportMax: 0.55,
  phalanxContactSpeed: 0.2,
  fireTeamHpMul: 1.0,
  fireTeamDamageMul: 1.0,
  fireTeamSpeedMul: 1.0,
  modernPatrolHpMul: 1.0,
  modernPatrolDamageMul: 1.0,
  modernPatrolSpeedMul: 1.0,
  fanaticHpMul: 1.0,
  fanaticDamageMul: 1.0,
  fanaticSpeedMul: 1.0,
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
  step: number;
}

const BOUNDS: Record<keyof DoctrineKnobs, KnobBound> = {
  // Stat scalars: roughly 0.5–1.5× to allow doubling/halving in steps.
  phalanxHpMul: { min: 0.5, max: 2.0, step: 0.1 },
  phalanxDamageMul: { min: 0.5, max: 2.0, step: 0.1 },
  phalanxSpeedMul: { min: 0.6, max: 1.4, step: 0.05 },
  phalanxSupportMax: { min: 0.0, max: 0.8, step: 0.05 },
  phalanxContactSpeed: { min: 0.0, max: 0.6, step: 0.05 },
  fireTeamHpMul: { min: 0.5, max: 2.0, step: 0.1 },
  fireTeamDamageMul: { min: 0.5, max: 2.0, step: 0.1 },
  fireTeamSpeedMul: { min: 0.6, max: 1.4, step: 0.05 },
  modernPatrolHpMul: { min: 0.5, max: 2.0, step: 0.1 },
  modernPatrolDamageMul: { min: 0.5, max: 2.0, step: 0.1 },
  modernPatrolSpeedMul: { min: 0.6, max: 1.4, step: 0.05 },
  fanaticHpMul: { min: 0.5, max: 2.0, step: 0.1 },
  fanaticDamageMul: { min: 0.5, max: 2.0, step: 0.1 },
  fanaticSpeedMul: { min: 0.6, max: 1.4, step: 0.05 },
  // Rhythm / behavior knobs.
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
  /** Generation index (0 = initial random pop). */
  gen: number;
  /** Within-generation rank (0 = best). */
  rank: number;
  /** Wall-clock seconds since autotune start. */
  wallTimeS: number;
  knobs: DoctrineKnobs;
  matrix: Record<string, Record<string, number>>;
  loss: number;
  /** Best loss seen across all generations and individuals so far. */
  bestLoss: number;
  /** Pop size for this generation (UI uses this to chunk). */
  popSize: number;
}

interface CLIArgs {
  duration: number;
  workers: number;
  seeds: number;
  ticks: number;
  comps: string[];
  pop: number;
}

function parseArgs(argv: string[]): CLIArgs {
  const out: CLIArgs = {
    duration: 300,
    workers: 4,
    seeds: 20,
    ticks: 1500,
    pop: 12,
    comps: ["doc-phalanx", "doc-fire-team", "doc-modern-patrol", "doc-fanatic"],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--duration") { out.duration = Number(v); i++; }
    else if (a === "--workers") { out.workers = Number(v); i++; }
    else if (a === "--seeds") { out.seeds = Number(v); i++; }
    else if (a === "--ticks") { out.ticks = Number(v); i++; }
    else if (a === "--pop") { out.pop = Number(v); i++; }
    else if (a === "--comps") {
      out.comps = String(v).split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    }
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Round v to the nearest multiple of step (so the search lattice
 *  matches the user-meaningful step sizes). */
function snap(v: number, step: number): number {
  return Math.round(v / step) * step;
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

/** Latin hypercube-ish: each knob sampled uniformly within its
 *  bounds, snapped to step. */
function randomKnobs(rng: () => number): DoctrineKnobs {
  const out = { ...INITIAL_KNOBS };
  for (const k of KNOB_KEYS) {
    const b = BOUNDS[k];
    const v = b.min + rng() * (b.max - b.min);
    out[k] = clamp(snap(v, b.step), b.min, b.max);
  }
  return out;
}

/** Uniform 50/50 crossover per knob. */
function crossover(a: DoctrineKnobs, b: DoctrineKnobs, rng: () => number): DoctrineKnobs {
  const out = { ...INITIAL_KNOBS };
  for (const k of KNOB_KEYS) {
    out[k] = rng() < 0.5 ? a[k] : b[k];
  }
  return out;
}

/** Mutation: each knob with p=0.15 gets a ±1-2 step random walk. */
function mutate(k: DoctrineKnobs, rng: () => number, mutationRate = 0.15): DoctrineKnobs {
  const out = { ...k };
  for (const key of KNOB_KEYS) {
    if (rng() >= mutationRate) continue;
    const b = BOUNDS[key];
    const sign = rng() < 0.5 ? -1 : 1;
    const mag = (1 + Math.floor(rng() * 2)) * b.step; // 1 or 2 steps
    out[key] = clamp(snap(out[key] + sign * mag, b.step), b.min, b.max);
  }
  return out;
}

/** Tournament-2 selection: pick 2 random individuals, return the
 *  fitter (lower loss) one. */
function tournament(
  pop: { knobs: DoctrineKnobs; loss: number }[],
  rng: () => number,
): DoctrineKnobs {
  const a = pop[Math.floor(rng() * pop.length)];
  const b = pop[Math.floor(rng() * pop.length)];
  return (a.loss < b.loss ? a : b).knobs;
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

const DOMINANCE_BAND = 0.18;

function computeLoss(comps: string[], wr: Record<string, Record<string, number>>): number {
  let loss = 0;
  // 1. Mirror penalty.
  for (const d of comps) {
    const w = wr[d][d];
    loss += (w - 0.5) ** 2 * 1.5;
  }
  // 2. Per-doctrine avg cross winrate inside band.
  for (const d of comps) {
    let sum = 0, n = 0;
    for (const e of comps) {
      if (e === d) continue;
      sum += wr[d][e]; n++;
    }
    const avg = n > 0 ? sum / n : 0.5;
    const dist = Math.max(0, Math.abs(avg - 0.5) - DOMINANCE_BAND);
    loss += dist ** 2 * 4;
  }
  // 3. Variance bonus (some 30/70 matchups are interesting).
  let crossVar = 0, crossN = 0;
  for (const a of comps) {
    for (const b of comps) {
      if (a === b) continue;
      crossVar += (wr[a][b] - 0.5) ** 2;
      crossN++;
    }
  }
  const avgVar = crossN > 0 ? crossVar / crossN : 0;
  loss -= avgVar * 0.3;
  return loss;
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

async function evaluatePopulation(
  comps: string[],
  pop: { knobs: DoctrineKnobs }[],
  args: CLIArgs,
  baseSeed: number,
): Promise<{ losses: number[]; matrices: Record<string, Record<string, number>>[]; battles: number }> {
  // Build all jobs across the whole population so workers stay
  // saturated. Each individual gets its own seed range.
  const losses: number[] = [];
  const matrices: Record<string, Record<string, number>>[] = [];
  let battles = 0;
  // Run evaluations sequentially per-individual but each evaluation
  // is itself parallel. (Could pack across pop, but seed mixing is
  // simpler this way.)
  for (let i = 0; i < pop.length; i++) {
    const startSeed = baseSeed + i * 1000;
    const { wr, battles: b } = await evaluate(comps, pop[i].knobs, args, startSeed);
    losses.push(computeLoss(comps, wr));
    matrices.push(wr);
    battles += b;
  }
  return { losses, matrices, battles };
}

async function appendIter(ndjsonPath: string, latestPath: string, rec: IterationRecord): Promise<void> {
  const line = JSON.stringify(rec) + "\n";
  await fs.appendFile(ndjsonPath, line);
  await fs.appendFile(latestPath, line);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(REPO_ROOT, "lab", "autotune", stamp);
  await fs.mkdir(outDir, { recursive: true });
  const ndjsonPath = path.join(outDir, "iterations.ndjson");
  const latestPath = path.join(REPO_ROOT, "lab", "autotune", "latest.ndjson");
  await fs.mkdir(path.dirname(latestPath), { recursive: true });
  await fs.writeFile(latestPath, "");

  process.stdout.write(`[autotune-ga] dir: ${path.relative(REPO_ROOT, outDir)}\n`);
  process.stdout.write(`[autotune-ga] comps: ${args.comps.join(", ")}\n`);
  process.stdout.write(`[autotune-ga] pop=${args.pop}  seeds/cell=${args.seeds}  ticks=${args.ticks}  workers=${args.workers}  duration=${args.duration}s\n\n`);

  const t0 = Date.now();
  const rng = makeRng(0xc0ffee);

  // Seed initial population: 1 = INITIAL_KNOBS (anchor at current
  // hand-tuned values), rest = uniform random within bounds.
  const pop: { knobs: DoctrineKnobs; loss: number }[] = [];
  pop.push({ knobs: { ...INITIAL_KNOBS }, loss: Infinity });
  for (let i = 1; i < args.pop; i++) {
    pop.push({ knobs: randomKnobs(rng), loss: Infinity });
  }

  let bestLoss = Infinity;
  let bestKnobs = { ...INITIAL_KNOBS };
  let bestMatrix: Record<string, Record<string, number>> | null = null;
  let totalBattles = 0;
  let gen = 0;

  while (true) {
    const elapsed = (Date.now() - t0) / 1000;
    if (elapsed >= args.duration) break;

    // Evaluate the current population.
    const { losses, matrices, battles } = await evaluatePopulation(
      args.comps, pop, args, 1 + gen * 7919,
    );
    totalBattles += battles;
    for (let i = 0; i < pop.length; i++) pop[i].loss = losses[i];

    // Sort by loss ascending (best first). Carry-over of the order
    // matters for elitism + iter-record `rank`.
    const ranked = pop
      .map((p, i) => ({ p, i }))
      .sort((a, b) => a.p.loss - b.p.loss);

    // Update best-of-run.
    const eliteIdx = ranked[0].i;
    if (pop[eliteIdx].loss < bestLoss) {
      bestLoss = pop[eliteIdx].loss;
      bestKnobs = { ...pop[eliteIdx].knobs };
      bestMatrix = matrices[eliteIdx];
    }

    // Stream every individual of this generation.
    const wallTimeS = (Date.now() - t0) / 1000;
    for (let r = 0; r < ranked.length; r++) {
      const original = ranked[r].i;
      await appendIter(ndjsonPath, latestPath, {
        gen,
        rank: r,
        wallTimeS,
        knobs: pop[original].knobs,
        matrix: matrices[original],
        loss: pop[original].loss,
        bestLoss,
        popSize: pop.length,
      });
    }
    const meanLoss = losses.reduce((a, b) => a + b, 0) / losses.length;
    process.stdout.write(
      `gen ${gen}  best ${ranked[0].p.loss.toFixed(3)}  mean ${meanLoss.toFixed(3)}  worst ${ranked[ranked.length - 1].p.loss.toFixed(3)}  bestEver ${bestLoss.toFixed(3)}  bps ${(totalBattles / wallTimeS).toFixed(1)}  t ${wallTimeS.toFixed(0)}s\n`,
    );

    // Build next generation:
    //   - elites (top 2) carry over
    //   - rest = crossover(tournament, tournament) + mutate
    const nextPop: { knobs: DoctrineKnobs; loss: number }[] = [];
    const ELITES = Math.min(2, pop.length);
    for (let e = 0; e < ELITES; e++) {
      nextPop.push({ knobs: { ...ranked[e].p.knobs }, loss: Infinity });
    }
    while (nextPop.length < args.pop) {
      const p1 = tournament(pop, rng);
      const p2 = tournament(pop, rng);
      const child = mutate(crossover(p1, p2, rng), rng);
      nextPop.push({ knobs: child, loss: Infinity });
    }
    pop.splice(0, pop.length, ...nextPop);
    gen++;
  }

  // Print final winner matrix
  process.stdout.write("\n[autotune-ga] best knobs:\n");
  for (const [k, v] of Object.entries(bestKnobs)) {
    process.stdout.write(`  ${k}: ${typeof v === "number" ? v.toFixed(3) : v}\n`);
  }
  if (bestMatrix) {
    process.stdout.write("\n[autotune-ga] best matrix:\n");
    for (const a of args.comps) {
      const row = args.comps.map((b) => `${(bestMatrix![a][b] * 100).toFixed(0)}%`.padEnd(5)).join(" ");
      process.stdout.write(`  ${a.padEnd(20)} ${row}\n`);
    }
  }
  process.stdout.write(`\n[autotune-ga] total battles: ${totalBattles}  generations: ${gen}\n`);
  process.stdout.write(`[autotune-ga] log: ${path.relative(REPO_ROOT, ndjsonPath)}\n`);
  await fs.writeFile(path.join(outDir, "best.json"), JSON.stringify({ bestLoss, knobs: bestKnobs, matrix: bestMatrix }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[autotune-ga] failed: ${String(e?.stack ?? e)}\n`);
  process.exit(1);
});
