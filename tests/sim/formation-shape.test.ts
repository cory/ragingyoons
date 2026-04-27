/**
 * Formation shape preservation under march.
 *
 * Regression: when cohesion was switched from field-based to per-group
 * centroid, every rac in a wide line pulled toward the line's center,
 * collapsing the line into a tight clump within seconds. The fix is
 * per-rac slot offsets — each rac knows its slot in formation space and
 * cohesion pulls it toward (groupCentroid + slot), so the formation
 * holds shape on the march.
 *
 * This test plants 10 infantry in a 14m-wide line (1.4m pitch, the
 * infantry-line pitch), gives them all a single far enemy as target,
 * and runs the sim. After many ticks the line should still be wide —
 * within an order of magnitude of the spawn width — not collapsed to a
 * point.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { tick } from "../../src/sim/index.js";
import { FORMATION_TO_IDX } from "../../src/sim/formations.js";
import { TARGET_KIND_RAC } from "../../src/sim/state.js";
import { addRac, emptyState, makeBundle, makeLogger, makeUnit } from "../helpers/builders.js";

describe("formation shape preservation (regression: line doesn't collapse)", () => {
  it("a 10-wide infantry line stays wide while marching", () => {
    const inf = makeUnit({
      id: "inf",
      role: "infantry",
      // Slow marchers so they don't reach the target in 30 ticks.
      stats: { hp: 50, damage: 5, attack_rate: 1, range: 1, speed: 1.5, armor: 0 },
    });
    const dummy = makeUnit({
      id: "dummy",
      role: "infantry",
      stats: { hp: 1e9, damage: 0, attack_rate: 0, range: 0, speed: 0, armor: 0 },
    });
    const content = makeBundle({ units: [inf, dummy] });
    const state = emptyState({ bounds: { w: 200, h: 100 } });

    // Plant 10 racs in a 14m-wide line at x=-50, perpendicular to march.
    const N = 10;
    const PITCH = 1.4;
    const groupId = state.nextGroupId++;
    const fIdx = FORMATION_TO_IDX["infantry-line"];
    const rows: number[] = [];
    for (let k = 0; k < N; k++) {
      const dy = (k - (N - 1) * 0.5) * PITCH;
      const r = addRac(state, content, {
        unitId: "inf",
        owner: 0,
        x: -50,
        y: dy,
        slotDx: 0, // line is perpendicular to forward → slotDx = 0
        slotDy: dy, // slot = world-y at spawn (centroid is at y=0)
      });
      state.rac.formationIdx[r] = fIdx;
      state.rac.groupId[r] = groupId;
      rows.push(r);
    }

    // One static dummy enemy at +x to give the line a march direction.
    const dRow = addRac(state, content, {
      unitId: "dummy",
      owner: 1,
      x: 50,
      y: 0,
    });
    const dummyId = state.rac.id[dRow];
    for (const r of rows) {
      state.rac.targetId[r] = dummyId;
      state.rac.targetKind[r] = TARGET_KIND_RAC;
    }

    const log = makeLogger(state);
    const initialWidth = (N - 1) * PITCH; // 12.6m

    for (let t = 0; t < 60; t++) {
      state.tick = t + 1;
      tick(state, content, log);
    }

    // After 4 seconds (60 ticks @ 15Hz), measure the y-spread of the
    // line. Bare-centroid cohesion collapses it to ~0; slot-aware
    // cohesion holds it within a small fraction of the spawn width.
    let minY = Infinity, maxY = -Infinity;
    for (const r of rows) {
      if (!state.rac.alive[r]) continue;
      if (state.rac.y[r] < minY) minY = state.rac.y[r];
      if (state.rac.y[r] > maxY) maxY = state.rac.y[r];
    }
    const finalWidth = maxY - minY;
    // We allow some compression (close-range anti-overlap pulls them
    // tighter than the design pitch) but require at least HALF the
    // spawn width — that's the bar between "still a line" and "blob".
    assert.ok(
      finalWidth > initialWidth * 0.5,
      `line collapsed: spawn width ${initialWidth.toFixed(2)}m, final ${finalWidth.toFixed(2)}m`,
    );
  });
});
