/**
 * Determinism: same seed + same content → byte-identical state arrays
 * at every tick. This is the load-bearing contract for reproducibility,
 * batch testing, and replay. If this test fails, *everything* downstream
 * is suspect (the probe tool, the invariant runner, the upcoming server
 * sim, etc.) — fix here first.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  setupBattle,
  tick,
  type BattleConfig,
} from "../../src/sim/index.js";
import { loadContentFromFs } from "../../src/sim/load-fs.js";
import { makeLogger } from "../helpers/builders.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const TICKS = 200; // ~13s of sim — long enough to exercise spawn / combat / death

function snapshotRac(state: ReturnType<typeof setupBattle>): {
  ids: Int32Array;
  hp: Float32Array;
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  alive: Uint8Array;
  rage: Float32Array;
} {
  // Snapshot only the *populated* prefix to avoid comparing trailing zeros.
  const n = state.rac.count;
  return {
    ids: state.rac.id.slice(0, n),
    hp: state.rac.hp.slice(0, n),
    x: state.rac.x.slice(0, n),
    y: state.rac.y.slice(0, n),
    vx: state.rac.vx.slice(0, n),
    vy: state.rac.vy.slice(0, n),
    alive: state.rac.alive.slice(0, n),
    rage: state.rac.rage.slice(0, n),
  };
}

function snapshotBin(state: ReturnType<typeof setupBattle>) {
  const n = state.bin.count;
  return {
    ids: state.bin.id.slice(0, n),
    hp: state.bin.hp.slice(0, n),
    alive: state.bin.alive.slice(0, n),
  };
}

function arraysEqual<T extends ArrayLike<number>>(
  a: T,
  b: T,
  tag: string,
): void {
  assert.equal(a.length, b.length, `${tag}: length`);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i], b[i], `${tag}: index ${i}: ${a[i]} != ${b[i]}`);
  }
}

describe("sim determinism", () => {
  it("same seed produces identical state at every tick (200 ticks)", async () => {
    const content = await loadContentFromFs({ repoRoot: REPO_ROOT });

    const cfg: BattleConfig = {
      seed: 0xdeadbeef,
      battleId: "determinism-test",
      compA: "test-city-swarm",
      compB: "test-suburban-wall",
      bounds: { w: 100, h: 100 },
      verbosity: "events",
    };

    const s1 = setupBattle(content, cfg);
    const s2 = setupBattle(content, cfg);
    const log1 = makeLogger(s1);
    const log2 = makeLogger(s2);

    for (let t = 0; t < TICKS; t++) {
      tick(s1, content, log1);
      tick(s2, content, log2);

      // Most expensive part: every populated-prefix array element must match.
      const r1 = snapshotRac(s1);
      const r2 = snapshotRac(s2);
      arraysEqual(r1.ids, r2.ids, `tick ${t} rac.id`);
      arraysEqual(r1.hp, r2.hp, `tick ${t} rac.hp`);
      arraysEqual(r1.x, r2.x, `tick ${t} rac.x`);
      arraysEqual(r1.y, r2.y, `tick ${t} rac.y`);
      arraysEqual(r1.vx, r2.vx, `tick ${t} rac.vx`);
      arraysEqual(r1.vy, r2.vy, `tick ${t} rac.vy`);
      arraysEqual(r1.alive, r2.alive, `tick ${t} rac.alive`);
      arraysEqual(r1.rage, r2.rage, `tick ${t} rac.rage`);

      const b1 = snapshotBin(s1);
      const b2 = snapshotBin(s2);
      arraysEqual(b1.ids, b2.ids, `tick ${t} bin.id`);
      arraysEqual(b1.hp, b2.hp, `tick ${t} bin.hp`);
      arraysEqual(b1.alive, b2.alive, `tick ${t} bin.alive`);
    }
  });

  it("different seeds produce different states", async () => {
    const content = await loadContentFromFs({ repoRoot: REPO_ROOT });
    const baseCfg: BattleConfig = {
      seed: 1,
      battleId: "determinism-test-2",
      compA: "test-city-swarm",
      compB: "test-suburban-wall",
      bounds: { w: 100, h: 100 },
      verbosity: "events",
    };
    const s1 = setupBattle(content, baseCfg);
    const s2 = setupBattle(content, { ...baseCfg, seed: 2 });
    const log1 = makeLogger(s1);
    const log2 = makeLogger(s2);
    for (let t = 0; t < 60; t++) {
      tick(s1, content, log1);
      tick(s2, content, log2);
    }
    // After 60 ticks (~ 4s), positions should diverge due to different
    // RNG-driven spawn jitter.
    const n = Math.min(s1.rac.count, s2.rac.count);
    let diff = 0;
    for (let i = 0; i < n; i++) {
      if (s1.rac.x[i] !== s2.rac.x[i] || s1.rac.y[i] !== s2.rac.y[i]) diff++;
    }
    assert.ok(diff > 0, "different seeds produced identical positions");
  });
});
