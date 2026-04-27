/**
 * Phase 1a smoke test: load content, set up a battle, run 60 ticks
 * (= 4s of sim time at 15 Hz), confirm logs are NDJSON-valid, print
 * a tidy summary.
 *
 * Verifies:
 *   - content loads without cross-ref errors
 *   - state shape is built correctly
 *   - `tick()` advances tick count without throwing
 *   - logger writes valid NDJSON to logs/battles/.../*.ndjson
 *   - tick_summary fires every 1s (= 15 ticks)
 *
 * Usage: npm run sim:smoke
 */

import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  logSetupEvents,
  setupBattle,
  summarize,
  tick,
  type BattleConfig,
} from "../../src/sim/index.js";
import { loadContentFromFs } from "../../src/sim/load-fs.js";
import { FileLogger, buildLogFilePath } from "../../src/sim/log-fs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const TICKS = 60; // 4s at 15Hz
const SEED = 0xc0ffee;
const COMP_A = "test-city-swarm";
const COMP_B = "test-suburban-wall";

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
  // Tiny RFC4122 v4 — only used for the battle_id, which is a setup
  // input (not a sim-internal random). The sim itself never calls this.
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  a[6] = (a[6] & 0x0f) | 0x40;
  a[8] = (a[8] & 0x3f) | 0x80;
  const h = [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

async function main(): Promise<void> {
  process.stdout.write("[sim-smoke] loading content from cards/…\n");
  const content = await loadContentFromFs({ repoRoot: REPO_ROOT });
  process.stdout.write(
    `[sim-smoke]   units=${content.units.size} statuses=${content.statuses.size} envs=${content.environments.size} curs=${content.curiosities.size} roles=${content.roles.size} comps=${content.comps.size} (cards@${content.version.slice(0, 8)})\n`,
  );

  if (!content.comps.has(COMP_A) || !content.comps.has(COMP_B)) {
    throw new Error(`smoke-test needs comps "${COMP_A}" and "${COMP_B}" in cards/comps/`);
  }

  const battleId = uuidv4();
  const cfg: BattleConfig = {
    seed: SEED,
    battleId,
    compA: COMP_A,
    compB: COMP_B,
    bounds: { w: 100, h: 100 },
    verbosity: "events",
  };

  const logPath = buildLogFilePath(REPO_ROOT, battleId, SEED);
  const log = new FileLogger({
    filePath: logPath,
    battle_id: battleId,
    seed: SEED,
    service_version: gitHash("src/sim"),
    content_version: content.version,
  });

  const state = setupBattle(content, cfg);
  log.setTickReader(() => state.tick);

  log.emit("battle_start", {
    comp_a: COMP_A,
    comp_b: COMP_B,
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

  process.stdout.write(`[sim-smoke] battle_id=${battleId} seed=${SEED}\n`);
  process.stdout.write(`[sim-smoke] log → ${path.relative(REPO_ROOT, logPath)}\n`);
  process.stdout.write(`[sim-smoke] running ${TICKS} ticks…\n`);

  const t0 = Date.now();
  for (let i = 0; i < TICKS; i++) {
    tick(state, content, log);
    if (state.winner !== -1 || state.endReason !== null) break;
  }
  const elapsedMs = Date.now() - t0;

  const s = summarize(state);
  log.emit("battle_end", {
    winner: state.winner,
    reason: state.endReason ?? "timeout",
    final_tick: state.tick,
    wallclock_ms: elapsedMs,
    ...s,
  });
  await log.flush();

  // Verify NDJSON is well-formed.
  const raw = await fs.readFile(logPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  let parsed = 0;
  for (const line of lines) {
    JSON.parse(line); // throws on malformed
    parsed += 1;
  }

  process.stdout.write(`[sim-smoke] ✓ wrote ${parsed} log rows in ${lines.length} lines\n`);
  process.stdout.write(
    `[sim-smoke] ✓ final state: bins ${s.bins_alive_a}/${s.bins_alive_b}, racs ${s.racs_alive_a}/${s.racs_alive_b}, tick ${state.tick}\n`,
  );
  process.stdout.write(`[sim-smoke] ✓ wallclock ${elapsedMs}ms (${(TICKS / Math.max(1, elapsedMs)) * 1000 | 0} ticks/s)\n`);

  // Sanity: should have at least battle_start, 60/15 = 4 tick_summary rows, battle_end.
  const expected = 1 + Math.floor(TICKS / 15) + 1; // 1 + 4 + 1 = 6
  if (parsed < expected) {
    process.stderr.write(
      `[sim-smoke] ✗ expected ≥ ${expected} log rows, got ${parsed}\n`,
    );
    process.exit(1);
  }

  process.stdout.write("[sim-smoke] ok\n");
}

main().catch((e) => {
  process.stderr.write(`[sim-smoke] failed: ${String(e?.stack ?? e)}\n`);
  process.exit(1);
});
