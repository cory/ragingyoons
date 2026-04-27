/**
 * Anti-overlap: with the close-range pairwise separation in
 * boids.ts, no two alive raccoons should occupy the same point or
 * be in extreme overlap (< MIN_SEPARATION) after the system has
 * had a few ticks to settle.
 *
 * Field-based separation operates at 4m cell granularity — sub-cell
 * collisions are invisible to it. The pairwise rule fixes that.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { tick } from "../../src/sim/index.js";
import { addRac, emptyState, makeBundle, makeLogger, makeUnit } from "../helpers/builders.js";

describe("anti-overlap (close-range pairwise separation)", () => {
  it("racs spawned on top of each other separate within a few ticks", () => {
    const inf = makeUnit({
      id: "inf",
      role: "infantry",
      stats: { hp: 50, damage: 5, attack_rate: 1, range: 1, speed: 8, armor: 0 },
    });
    const content = makeBundle({ units: [inf] });
    const state = emptyState({ bounds: { w: 100, h: 100 } });
    // Place 8 racs all at (0, 0) — perfectly stacked.
    const rows: number[] = [];
    for (let k = 0; k < 8; k++) {
      rows.push(addRac(state, content, { unitId: "inf", owner: 0, x: 0, y: 0 }));
    }
    const log = makeLogger(state);
    // Run 20 ticks
    for (let t = 0; t < 20; t++) {
      state.tick = t + 1;
      tick(state, content, log);
    }
    // Compute min pairwise distance among alive racs
    let minD = Infinity;
    for (let a = 0; a < rows.length; a++) {
      for (let b = a + 1; b < rows.length; b++) {
        const ra = rows[a], rb = rows[b];
        if (!state.rac.alive[ra] || !state.rac.alive[rb]) continue;
        const dx = state.rac.x[ra] - state.rac.x[rb];
        const dy = state.rac.y[ra] - state.rac.y[rb];
        const d = Math.hypot(dx, dy);
        if (d < minD) minD = d;
      }
    }
    // After 20 ticks, no two racs should be < 0.5m apart.
    assert.ok(minD > 0.5, `min pairwise distance = ${minD.toFixed(3)}; expected > 0.5m`);
  });

  it("dense cluster with target stays spread without piling on a point", () => {
    const inf = makeUnit({
      id: "inf",
      role: "infantry",
      stats: { hp: 50, damage: 5, attack_rate: 1, range: 1, speed: 8, armor: 0 },
    });
    const dummy = makeUnit({
      id: "dummy",
      role: "tank",
      stats: { hp: 1, damage: 0, attack_rate: 1, range: 1, speed: 0, armor: 0 },
    });
    const content = makeBundle({ units: [inf, dummy] });
    const state = emptyState({ bounds: { w: 100, h: 100 } });
    // 12 racs in a tight 1m cluster
    const rows: number[] = [];
    for (let k = 0; k < 12; k++) {
      const dx = Math.cos(k) * 0.3;
      const dy = Math.sin(k) * 0.3;
      rows.push(addRac(state, content, { unitId: "inf", owner: 0, x: dx, y: dy }));
    }
    // Static dummy 30m away — units will advance toward it.
    const dRow = addRac(state, content, { unitId: "dummy", owner: 1, x: 30, y: 0 });
    state.rac.hp[dRow] = 1e9;
    state.rac.hpMax[dRow] = 1e9;
    const dummyId = state.rac.id[dRow];
    for (let i = 0; i < state.rac.count; i++) {
      if (i === dRow) continue;
      state.rac.targetId[i] = dummyId;
      state.rac.targetKind[i] = 1; // RAC
    }
    const log = makeLogger(state);
    for (let t = 0; t < 30; t++) {
      state.tick = t + 1;
      tick(state, content, log);
    }
    // After 30 ticks (advancing toward dummy), no two infantry should
    // be in extreme overlap.
    let minD = Infinity;
    for (let a = 0; a < rows.length; a++) {
      for (let b = a + 1; b < rows.length; b++) {
        const ra = rows[a], rb = rows[b];
        if (!state.rac.alive[ra] || !state.rac.alive[rb]) continue;
        const dx = state.rac.x[ra] - state.rac.x[rb];
        const dy = state.rac.y[ra] - state.rac.y[rb];
        const d = Math.hypot(dx, dy);
        if (d < minD) minD = d;
      }
    }
    assert.ok(minD > 0.4, `min pairwise distance = ${minD.toFixed(3)}; expected > 0.4m even while advancing`);
  });
});
