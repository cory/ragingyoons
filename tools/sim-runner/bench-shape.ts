/**
 * Quick perf bench for shape battles (the lab pipeline). Spawns 48
 * blue infantry vs 48 red infantry on a 120×80 field with the new
 * motion stack, runs 1500 ticks, prints wall time and ticks/sec. No
 * logging, single-threaded.
 *
 *   npx tsx tools/sim-runner/bench-shape.ts [unitId] [count] [ticks]
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadContentFromFs } from "../../src/sim/load-fs.js";
import { NullLogger } from "../../src/sim/log.js";
import { setupShapeBattle, tick, type ShapeBattleConfig } from "../../src/sim/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

async function main() {
  const content = await loadContentFromFs({ repoRoot: REPO_ROOT });
  const arg2 = process.argv[2];
  const unitId = arg2 && arg2.length > 0 ? arg2 : findFirst(content, "infantry", "phalanx");
  const count = Number(process.argv[3] ?? "48");
  const ticks = Number(process.argv[4] ?? "1000");
  const battles = Number(process.argv[5] ?? "5");

  let totalNs = 0n;
  let totalTicksRun = 0;
  for (let b = 0; b < battles; b++) {
    const cfg: ShapeBattleConfig = {
      seed: 1 + b,
      battleId: `bench-${b}`,
      bounds: { w: 120, h: 80 },
      unitId,
      count,
      enemyBinUnitId: unitId,
      maxPlatoonSize: count,
      platoonStride: 8,
      disableSynergies: true,
      redSide: { unitId, count, maxPlatoonSize: count, platoonStride: 8 },
    };
    const state = setupShapeBattle(content, cfg);
    const log = new NullLogger();
    const start = process.hrtime.bigint();
    let ranTicks = 0;
    for (let t = 0; t < ticks; t++) {
      state.tick = t + 1;
      tick(state, content, log);
      ranTicks++;
      if (state.winner !== -1) break;
    }
    const dur = process.hrtime.bigint() - start;
    totalNs += dur;
    totalTicksRun += ranTicks;
    const ms = Number(dur) / 1e6;
    console.log(
      `b${b}: ${ranTicks} ticks in ${ms.toFixed(1)} ms (${(ranTicks / (ms / 1000)).toFixed(0)} t/s) winner=${state.winner}`,
    );
  }
  const totalMs = Number(totalNs) / 1e6;
  console.log("---");
  console.log(
    `total: ${totalTicksRun} ticks across ${battles} battles in ${totalMs.toFixed(1)} ms (${(totalTicksRun / (totalMs / 1000)).toFixed(0)} t/s avg)`,
  );
}

function findFirst(content: Awaited<ReturnType<typeof loadContentFromFs>>, role: string, doctrineHint: string): string {
  for (const [id, u] of content.units) {
    if (u.role !== role) continue;
    if (u.environment === "suburban" && u.curiosity === "barbarians" && doctrineHint === "phalanx") return id;
  }
  return [...content.units.keys()][0]!;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
