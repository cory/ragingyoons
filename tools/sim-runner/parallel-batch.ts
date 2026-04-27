/**
 * Parallel batch runner.
 *
 * Spawns N child processes (each loading content once), distributes
 * battles, aggregates outcomes. Same matrix output as batch.ts but
 * runs ~N× faster on N cores. Uses child_process.fork so tsx's TS
 * loader picks up the worker module without manual Worker hooks.
 *
 * CLI:
 *   npm run sim:parallel -- --comps a,b,c --seeds 30 --ticks 1500 \
 *     --workers 4 --no-synergies
 *
 * Library mode (used by autotuner):
 *   import { runParallel } from "./parallel-batch.js";
 *   const outcomes = await runParallel({ jobs, workers });
 */

import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadContentFromFs } from "../../src/sim/load-fs.js";
import type { BattleJob, BattleOutcome } from "./battle-worker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

interface RunOpts {
  jobs: BattleJob[];
  workers: number;
  /** Optional callback fired per outcome — for live progress / autotuner streaming. */
  onOutcome?: (o: BattleOutcome) => void;
}

/** Spawn N workers, distribute jobs, return all outcomes. Resolves
 *  when every job has reported. */
export async function runParallel(opts: RunOpts): Promise<BattleOutcome[]> {
  const { jobs, workers: nWorkers } = opts;
  if (jobs.length === 0) return [];
  const outcomes: BattleOutcome[] = [];

  // Use fork() so tsx's TS-loader hook (already active in the parent
  // because we're running under `tsx`) carries into the children.
  // The worker script is .ts; tsx will resolve and run it.
  const workerScript = path.join(__dirname, "battle-worker.ts");

  const children: ChildProcess[] = [];
  const ready: Promise<void>[] = [];
  for (let i = 0; i < nWorkers; i++) {
    const child = fork(workerScript, [], {
      execArgv: process.execArgv, // inherits tsx loader
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    children.push(child);
    ready.push(
      new Promise<void>((resolve, reject) => {
        const onMsg = (m: { kind: string; error?: string }) => {
          if (m.kind === "ready") {
            child.off("message", onMsg);
            resolve();
          } else if (m.kind === "error") {
            reject(new Error(m.error));
          }
        };
        child.on("message", onMsg);
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code !== 0 && code !== null) reject(new Error(`worker exited ${code}`));
        });
      }),
    );
    child.send({ kind: "init" });
  }
  await Promise.all(ready);

  // Chunk jobs so each child gets a batch (cuts IPC overhead).
  const CHUNK = Math.max(1, Math.ceil(jobs.length / (nWorkers * 8)));
  const chunks: BattleJob[][] = [];
  for (let i = 0; i < jobs.length; i += CHUNK) chunks.push(jobs.slice(i, i + CHUNK));

  let chunkIdx = 0;
  const completion = children.map(
    (child) =>
      new Promise<void>((resolve, reject) => {
        let pending = 0;
        const sendNext = () => {
          if (chunkIdx >= chunks.length) {
            if (pending === 0) {
              child.off("message", onMsg);
              resolve();
            }
            return;
          }
          const chunk = chunks[chunkIdx++];
          pending = chunk.length;
          child.send({ kind: "run", jobs: chunk });
        };
        const onMsg = (m: { kind: string; outcome?: BattleOutcome; count?: number; error?: string }) => {
          if (m.kind === "outcome" && m.outcome) {
            outcomes.push(m.outcome);
            if (opts.onOutcome) opts.onOutcome(m.outcome);
          } else if (m.kind === "done") {
            pending = 0;
            sendNext();
          } else if (m.kind === "error") {
            reject(new Error(m.error));
          }
        };
        child.on("message", onMsg);
        sendNext();
      }),
  );
  await Promise.all(completion);

  for (const child of children) {
    child.send({ kind: "stop" });
  }
  return outcomes;
}

// ---------- CLI mode (matrix battle running) ----------

interface CLIArgs {
  comps: string[];
  seeds: number;
  ticks: number;
  startSeed: number;
  workers: number;
  disableSynergies: boolean;
}

function parseArgs(argv: string[]): CLIArgs {
  const out: CLIArgs = {
    comps: [],
    seeds: 20,
    ticks: 1500,
    startSeed: 0xc0ffee,
    workers: 4,
    disableSynergies: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--comps") {
      out.comps = String(v).split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (a === "--seeds") {
      out.seeds = Number(v);
      i++;
    } else if (a === "--ticks") {
      out.ticks = Number(v);
      i++;
    } else if (a === "--seed") {
      out.startSeed = Number(v);
      i++;
    } else if (a === "--workers") {
      out.workers = Number(v);
      i++;
    } else if (a === "--no-synergies") {
      out.disableSynergies = true;
    }
  }
  return out;
}

interface MatrixCell {
  aWins: number;
  bWins: number;
  draws: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const content = await loadContentFromFs({ repoRoot: REPO_ROOT });
  const allComps = [...content.comps.keys()].sort();
  const comps = args.comps.length === 0 || args.comps[0] === "*" ? allComps : args.comps;

  for (const c of comps) {
    if (!content.comps.has(c)) throw new Error(`unknown comp ${c}`);
  }

  const jobs: BattleJob[] = [];
  for (const a of comps) {
    for (const b of comps) {
      for (let s = 0; s < args.seeds; s++) {
        const seed = args.startSeed + s;
        jobs.push({
          battleId: `${a}__${b}__${seed}`,
          seed,
          compA: a,
          compB: b,
          ticks: args.ticks,
          boundsW: 100,
          boundsH: 100,
          disableSynergies: args.disableSynergies,
        });
      }
    }
  }

  process.stdout.write(
    `[parallel] comps=${comps.length} pairs=${comps.length * comps.length} seeds=${args.seeds} workers=${args.workers} synergies=${args.disableSynergies ? "off" : "on"}\n`,
  );
  process.stdout.write(`[parallel] total battles: ${jobs.length}\n`);

  const t0 = Date.now();
  let done = 0;
  const outcomes = await runParallel({
    jobs,
    workers: args.workers,
    onOutcome: () => {
      done++;
      if (done % 50 === 0) {
        const dt = (Date.now() - t0) / 1000;
        process.stdout.write(`[parallel]   ${done}/${jobs.length}  ${(done / dt).toFixed(1)} b/s\n`);
      }
    },
  });
  const wall = (Date.now() - t0) / 1000;
  process.stdout.write(
    `[parallel] wallclock: ${wall.toFixed(2)}s (${(jobs.length / wall).toFixed(1)} battles/s)\n\n`,
  );

  // Aggregate matrix
  const m = new Map<string, Map<string, MatrixCell>>();
  for (const a of comps) {
    m.set(a, new Map());
    for (const b of comps) m.get(a)!.set(b, { aWins: 0, bWins: 0, draws: 0 });
  }
  for (const o of outcomes) {
    const cell = m.get(o.compA)!.get(o.compB)!;
    if (o.winner === 0) cell.aWins++;
    else if (o.winner === 1) cell.bWins++;
    else cell.draws++;
  }

  // Print matrix
  process.stdout.write("Winrate matrix (cell = compA winrate vs compB):\n\n");
  const colW = Math.max(14, ...comps.map((c) => c.length));
  process.stdout.write("| " + "compA \\ compB".padEnd(colW) + " | " + comps.map((c) => c.padEnd(colW)).join(" | ") + " |\n");
  process.stdout.write("|" + "-".repeat(colW + 2) + "|" + comps.map(() => "-".repeat(colW + 2)).join("|") + "|\n");
  for (const a of comps) {
    const row: string[] = [a.padEnd(colW)];
    for (const b of comps) {
      const cell = m.get(a)!.get(b)!;
      const total = cell.aWins + cell.bWins + cell.draws;
      const pct = total > 0 ? Math.round((cell.aWins / total) * 100) : 0;
      row.push(`${pct}% (${cell.aWins}/${total})`.padEnd(colW));
    }
    process.stdout.write("| " + row.join(" | ") + " |\n");
  }

  // Force exit so any lingering child sockets don't keep us alive.
  process.exit(0);
}

const isMain = process.argv[1] && process.argv[1].endsWith("parallel-batch.ts");
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`[parallel] failed: ${String(e?.stack ?? e)}\n`);
    process.exit(1);
  });
}
