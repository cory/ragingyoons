/**
 * Worker-side battle runner.
 *
 * Listens for `BatchJob` messages from the parent thread; runs each
 * battle and posts a `BatchOutcome` back. Content is loaded once at
 * worker init (~50 ms one-time cost amortized over hundreds of
 * battles).
 *
 * Messages (parent → worker):
 *   { kind: "init"   }                   — confirms ready
 *   { kind: "run", jobs: BattleJob[] }   — runs the jobs sequentially
 *   { kind: "stop" }                     — exits
 *
 * Messages (worker → parent):
 *   { kind: "ready" }
 *   { kind: "outcome", outcome: BattleOutcome }
 *   { kind: "done", count: number }
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadContentFromFs } from "../../src/sim/load-fs.js";
import { MemoryLogger } from "../../src/sim/log.js";
import { resolveTimeout, setupBattle, tick, type BattleConfig, type ContentBundle } from "../../src/sim/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Use child_process IPC (process.send) since fork() in
// parallel-batch.ts is the spawn path. process.send is set when the
// process was forked with stdio: [...,"ipc"].
function postMessage(msg: unknown): void {
  if (process.send) process.send(msg);
}
const onMessage = (handler: (m: { kind: string; jobs?: BattleJob[] }) => void): void => {
  process.on("message", handler as never);
};

export interface BattleJob {
  battleId: string;
  seed: number;
  compA: string;
  compB: string;
  ticks: number;
  boundsW: number;
  boundsH: number;
  disableSynergies: boolean;
}

export interface BattleOutcome {
  battleId: string;
  compA: string;
  compB: string;
  seed: number;
  winner: -1 | 0 | 1;
  reason: string;
  finalTick: number;
  binsAliveA: number;
  binsAliveB: number;
  racsAliveA: number;
  racsAliveB: number;
}

if (!process.send) {
  throw new Error("battle-worker must be spawned via child_process.fork (no IPC channel)");
}

let content: ContentBundle | null = null;

async function init(): Promise<void> {
  content = await loadContentFromFs({ repoRoot: REPO_ROOT });
  postMessage({ kind: "ready" });
}

function runJob(job: BattleJob): BattleOutcome {
  if (!content) throw new Error("content not loaded");
  const cfg: BattleConfig = {
    seed: job.seed,
    battleId: job.battleId,
    compA: job.compA,
    compB: job.compB,
    bounds: { w: job.boundsW, h: job.boundsH },
    verbosity: "events",
    disableSynergies: job.disableSynergies,
  };
  const log = new MemoryLogger({
    battle_id: cfg.battleId,
    seed: cfg.seed,
    service_version: "worker",
    content_version: content.version,
  });
  const state = setupBattle(content, cfg);
  log.setTickReader(() => state.tick);
  log.drain();
  for (let t = 0; t < job.ticks; t++) {
    tick(state, content, log);
    log.drain();
    if (state.winner !== -1 || state.endReason !== null) break;
  }
  if (state.winner === -1 && state.endReason === null) resolveTimeout(state);
  let racsA = 0,
    racsB = 0,
    binsA = 0,
    binsB = 0;
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
  return {
    battleId: cfg.battleId,
    compA: cfg.compA,
    compB: cfg.compB,
    seed: cfg.seed,
    winner: state.winner,
    reason: state.endReason ?? "unresolved",
    finalTick: state.tick,
    binsAliveA: binsA,
    binsAliveB: binsB,
    racsAliveA: racsA,
    racsAliveB: racsB,
  };
}

onMessage(async (msg) => {
  try {
    if (msg.kind === "init") {
      await init();
    } else if (msg.kind === "run") {
      const jobs = msg.jobs ?? [];
      for (const job of jobs) {
        const outcome = runJob(job);
        postMessage({ kind: "outcome", outcome });
      }
      postMessage({ kind: "done", count: jobs.length });
    } else if (msg.kind === "stop") {
      process.exit(0);
    }
  } catch (e) {
    postMessage({ kind: "error", error: String(e instanceof Error ? e.stack : e) });
  }
});
