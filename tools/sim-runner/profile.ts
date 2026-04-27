/**
 * Per-subsystem timing profile. Runs N battles to a fixed tick count
 * with no logging, accumulating ns per subsystem. Output: ms total +
 * % share. Helps decide what to optimize first.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadContentFromFs } from "../../src/sim/load-fs.js";
import { MemoryLogger } from "../../src/sim/log.js";
import { setupBattle, resolveTimeout, type BattleConfig } from "../../src/sim/index.js";
import { buildRacGrid, DEFAULT_CELL_SIZE } from "../../src/sim/grid.js";
import { boidsTick } from "../../src/sim/subsys/boids.js";
import { combatTick } from "../../src/sim/subsys/combat.js";
import { decayTick } from "../../src/sim/subsys/decay.js";
import { projectileTick } from "../../src/sim/subsys/projectile.js";
import { rageTick } from "../../src/sim/subsys/rage.js";
import { spawnTick } from "../../src/sim/subsys/spawn.js";
import { statusTick } from "../../src/sim/subsys/status.js";
import { synergyTick } from "../../src/sim/subsys/synergy.js";
import { targetTick } from "../../src/sim/subsys/target.js";
import { winTick } from "../../src/sim/subsys/win.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

interface Buckets {
  synergy: bigint;
  spawn: bigint;
  target: bigint;
  boids: bigint;
  combat: bigint;
  projectile: bigint;
  status: bigint;
  rage: bigint;
  decay: bigint;
  win: bigint;
  log_emit: bigint;
  total: bigint;
}

const COMP_A = process.argv[2] ?? "test-city-swarm";
const COMP_B = process.argv[3] ?? "test-city-swarm";
const BATTLES = Number(process.argv[4] ?? "10");
const TICKS = Number(process.argv[5] ?? "1500");

async function main() {
  const content = await loadContentFromFs({ repoRoot: REPO_ROOT });
  const buckets: Buckets = {
    synergy: 0n,
    spawn: 0n,
    target: 0n,
    boids: 0n,
    combat: 0n,
    projectile: 0n,
    status: 0n,
    rage: 0n,
    decay: 0n,
    win: 0n,
    log_emit: 0n,
    total: 0n,
  };
  const seedBase = 1234;
  const wallStart = process.hrtime.bigint();
  let totalTicks = 0;
  for (let b = 0; b < BATTLES; b++) {
    const cfg: BattleConfig = {
      seed: seedBase + b,
      battleId: `prof-${b}`,
      compA: COMP_A,
      compB: COMP_B,
      bounds: { w: 100, h: 100 },
      verbosity: "events",
    };
    const log = new MemoryLogger({
      battle_id: cfg.battleId,
      seed: cfg.seed,
      service_version: "prof",
      content_version: content.version,
    });
    const state = setupBattle(content, cfg);
    log.setTickReader(() => state.tick);
    log.drain();
    for (let t = 0; t < TICKS; t++) {
      state.tick += 1;
      const t0 = process.hrtime.bigint();
      synergyTick(state, content, log);
      const t1 = process.hrtime.bigint();
      spawnTick(state, content, log);
      state._racGrid = buildRacGrid(state, DEFAULT_CELL_SIZE);
      const t2 = process.hrtime.bigint();
      targetTick(state, content, log);
      const t3 = process.hrtime.bigint();
      boidsTick(state, content, log);
      const t4 = process.hrtime.bigint();
      combatTick(state, content, log);
      const t5 = process.hrtime.bigint();
      projectileTick(state, content, log);
      const t6 = process.hrtime.bigint();
      statusTick(state, content, log);
      const t7 = process.hrtime.bigint();
      rageTick(state, content, log);
      const t8 = process.hrtime.bigint();
      decayTick(state, content, log);
      const t9 = process.hrtime.bigint();
      winTick(state, content, log);
      const t10 = process.hrtime.bigint();
      log.drain(); // simulate per-tick drain (matches viewer pattern)
      const t11 = process.hrtime.bigint();
      buckets.synergy += t1 - t0;
      buckets.spawn += t2 - t1;
      buckets.target += t3 - t2;
      buckets.boids += t4 - t3;
      buckets.combat += t5 - t4;
      buckets.projectile += t6 - t5;
      buckets.status += t7 - t6;
      buckets.rage += t8 - t7;
      buckets.decay += t9 - t8;
      buckets.win += t10 - t9;
      buckets.log_emit += t11 - t10;
      totalTicks++;
      if (state.winner !== -1 || state.endReason !== null) break;
    }
    if (state.winner === -1 && state.endReason === null) resolveTimeout(state);
  }
  const wallEnd = process.hrtime.bigint();
  buckets.total = wallEnd - wallStart;
  const ms = (n: bigint) => Number(n / 1000n) / 1000;

  process.stdout.write(`profile: ${BATTLES} battles ${COMP_A} vs ${COMP_B}, ${TICKS} max-ticks\n`);
  process.stdout.write(`         actual sim ticks: ${totalTicks}\n`);
  process.stdout.write(`         wallclock: ${ms(buckets.total).toFixed(1)}ms (${(BATTLES / (Number(buckets.total) / 1e9)).toFixed(2)} battles/s)\n\n`);
  const subsysTotal =
    buckets.synergy + buckets.spawn + buckets.target + buckets.boids +
    buckets.combat + buckets.projectile + buckets.status + buckets.rage +
    buckets.decay + buckets.win + buckets.log_emit;

  const rows: [string, bigint][] = [
    ["boids", buckets.boids],
    ["combat", buckets.combat],
    ["projectile", buckets.projectile],
    ["target", buckets.target],
    ["log_emit", buckets.log_emit],
    ["status", buckets.status],
    ["spawn", buckets.spawn],
    ["rage", buckets.rage],
    ["synergy", buckets.synergy],
    ["decay", buckets.decay],
    ["win", buckets.win],
  ];
  rows.sort((a, b) => Number(b[1] - a[1]));

  process.stdout.write(`subsystem    |    ms     |   %\n`);
  process.stdout.write(`-------------+-----------+------\n`);
  for (const [name, val] of rows) {
    const pct = (Number(val) / Number(subsysTotal)) * 100;
    process.stdout.write(`${name.padEnd(13)}| ${ms(val).toFixed(1).padStart(8)}  | ${pct.toFixed(1)}%\n`);
  }
  process.stdout.write(`subsys sum   | ${ms(subsysTotal).toFixed(1).padStart(8)}\n`);
  process.stdout.write(`wallclock    | ${ms(buckets.total).toFixed(1).padStart(8)}  (overhead = wall - sum)\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
