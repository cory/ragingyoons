/**
 * Boid behavior tests.
 *
 * The visual symptoms we're hunting:
 *   - "stuck" units: a unit with no live target sits at zero velocity
 *     instead of drifting to a sensible idle behavior.
 *   - "pops": a single tick produces a 180° velocity flip → visual
 *     teleport at high speed. Caused by sampling self-influence into
 *     a density-gradient force, or by step changes in seek polarity.
 *   - small packs circling: each member chases everyone else's average
 *     velocity, no clear leader → no progress toward target.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { boidsTick } from "../../src/sim/subsys/boids.js";
import { TARGET_KIND_RAC } from "../../src/sim/state.js";
import { addRac, emptyState, makeBundle, makeLogger, makeUnit } from "../helpers/builders.js";

function unit(role: "tank" | "archer" | "cavalry" | "infantry", overrides?: { speed?: number; range?: number; damage?: number }) {
  return makeUnit({
    id: `u-${role}`,
    role,
    stats: {
      hp: 50,
      damage: overrides?.damage ?? 5,
      attack_rate: 1,
      range: overrides?.range ?? 1.5,
      speed: overrides?.speed ?? 8,
      armor: 0,
    },
  });
}

function runBoids(state: ReturnType<typeof emptyState>, content: ReturnType<typeof makeBundle>, ticks: number) {
  const log = makeLogger(state);
  for (let t = 0; t < ticks; t++) {
    state.tick = t + 1;
    boidsTick(state, content, log);
  }
}

describe("boids: lone unit + target", () => {
  it("a lone cavalry with a clear target advances toward it", () => {
    const cav = unit("cavalry", { speed: 14 });
    const tgt = unit("tank");
    const content = makeBundle({ units: [cav, tgt] });
    const state = emptyState({ bounds: { w: 100, h: 100 } });
    const aRow = addRac(state, content, { unitId: cav.id, owner: 0, x: -20, y: 0 });
    const tRow = addRac(state, content, { unitId: tgt.id, owner: 1, x: 20, y: 0 });
    state.rac.targetId[aRow] = state.rac.id[tRow];
    state.rac.targetKind[aRow] = TARGET_KIND_RAC;
    // Track the *minimum* distance reached during the run, since with
    // always-maxV the unit will overshoot a stationary target. The
    // test only cares that it got close, not where it ended.
    let minD = Infinity;
    const log = makeLogger(state);
    for (let t = 0; t < 60; t++) {
      state.tick = t + 1;
      boidsTick(state, content, log);
      const dx = state.rac.x[tRow] - state.rac.x[aRow];
      const dy = state.rac.y[tRow] - state.rac.y[aRow];
      const d = Math.hypot(dx, dy);
      if (d < minD) minD = d;
    }
    assert.ok(minD < 5, `cavalry should pass within 5m of target; got ${minD.toFixed(1)}`);
  });

  it("a lone unit chasing a bin target advances (bin tid path)", () => {
    const cav = unit("cavalry", { speed: 14 });
    const tgt = unit("tank");
    const content = makeBundle({ units: [cav, tgt] });
    const state = emptyState({ bounds: { w: 100, h: 100 } });
    const aRow = addRac(state, content, { unitId: cav.id, owner: 0, x: -20, y: 0 });
    // Add an enemy bin (not via builder helper since addBin builds bin
    // semantics; we set the table directly to target an arbitrary point).
    state.bin.id[0] = 999;
    state.bin.owner[0] = 1;
    state.bin.x[0] = 20;
    state.bin.y[0] = 0;
    state.bin.alive[0] = 1;
    state.bin.count = 1;
    state.binRowById.set(999, 0);
    state.rac.targetId[aRow] = 999;
    state.rac.targetKind[aRow] = 2; // BIN
    const startD = Math.hypot(20 - -20, 0);
    let minD = Infinity;
    const log = makeLogger(state);
    for (let t = 0; t < 60; t++) {
      state.tick = t + 1;
      boidsTick(state, content, log);
      const dx = 20 - state.rac.x[aRow];
      const dy = -state.rac.y[aRow];
      const d = Math.hypot(dx, dy);
      if (d < minD) minD = d;
    }
    assert.ok(minD < startD * 0.3, `cavalry should close on bin; start=${startD} min=${minD.toFixed(1)}`);
  });

  it("a lone unit with no target does not pop or sustain high velocity", () => {
    const inf = unit("infantry", { speed: 8 });
    const content = makeBundle({ units: [inf] });
    const state = emptyState({ bounds: { w: 100, h: 100 } });
    const row = addRac(state, content, { unitId: inf.id, owner: 0, x: 0, y: 0 });
    // No target set.
    runBoids(state, content, 20);
    const v = Math.hypot(state.rac.vx[row], state.rac.vy[row]);
    assert.ok(v < 0.1, `idle unit should bleed velocity to ~0; got ${v.toFixed(2)}`);
    // Position should not have wandered far.
    const d = Math.hypot(state.rac.x[row], state.rac.y[row]);
    assert.ok(d < 1, `idle unit should not wander; drifted ${d.toFixed(2)}m`);
  });
});

describe("boids: stability — no 180° velocity flips between ticks", () => {
  it("velocity direction does not reverse on a single tick for an advancing unit", () => {
    const cav = unit("cavalry", { speed: 14 });
    const tgt = unit("tank");
    const content = makeBundle({ units: [cav, tgt] });
    const state = emptyState({ bounds: { w: 100, h: 100 } });
    const aRow = addRac(state, content, { unitId: cav.id, owner: 0, x: -20, y: 0 });
    const tRow = addRac(state, content, { unitId: tgt.id, owner: 1, x: 20, y: 0 });
    state.rac.targetId[aRow] = state.rac.id[tRow];
    state.rac.targetKind[aRow] = TARGET_KIND_RAC;
    const log = makeLogger(state);
    let prevVx = 0;
    let prevVy = 0;
    for (let t = 0; t < 30; t++) {
      state.tick = t + 1;
      boidsTick(state, content, log);
      const vx = state.rac.vx[aRow];
      const vy = state.rac.vy[aRow];
      const v = Math.hypot(vx, vy);
      const pv = Math.hypot(prevVx, prevVy);
      if (t > 2 && v > 1 && pv > 1) {
        // Cosine of angle between consecutive velocities should be > 0
        // (no >90° turns in a single tick under intent).
        const cos = (vx * prevVx + vy * prevVy) / (v * pv);
        assert.ok(cos > 0, `velocity flipped at tick ${t}: cos=${cos.toFixed(2)}`);
      }
      prevVx = vx;
      prevVy = vy;
    }
  });
});

describe("boids: small pack progresses toward target (leadership emerges)", () => {
  it("a pack of 5 cavalry collectively closes on a target faster than any single one stalls", () => {
    const cav = unit("cavalry", { speed: 14 });
    const tgt = unit("tank");
    const content = makeBundle({ units: [cav, tgt] });
    const state = emptyState({ bounds: { w: 100, h: 100 } });
    const racRows: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = addRac(state, content, { unitId: cav.id, owner: 0, x: -20 + i * 0.5, y: i * 0.5 - 1 });
      racRows.push(r);
    }
    const tRow = addRac(state, content, { unitId: tgt.id, owner: 1, x: 20, y: 0 });
    for (const r of racRows) {
      state.rac.targetId[r] = state.rac.id[tRow];
      state.rac.targetKind[r] = TARGET_KIND_RAC;
    }
    // Centroid distance start vs after 30 ticks.
    const centroid = (rows: number[]) => {
      let sx = 0, sy = 0;
      for (const r of rows) { sx += state.rac.x[r]; sy += state.rac.y[r]; }
      return [sx / rows.length, sy / rows.length] as const;
    };
    const [csx, csy] = centroid(racRows);
    const startD = Math.hypot(state.rac.x[tRow] - csx, state.rac.y[tRow] - csy);
    runBoids(state, content, 30);
    const [cex, cey] = centroid(racRows);
    const endD = Math.hypot(state.rac.x[tRow] - cex, state.rac.y[tRow] - cey);
    assert.ok(
      endD < startD * 0.5,
      `pack should close at least halfway; start=${startD.toFixed(1)} end=${endD.toFixed(1)}`,
    );
  });
});

describe("boids: density gradient does not see self-influence as separation force", () => {
  // A truly lone unit should have ~0 separation force. If self-influence
  // leaks into the density gradient at sample points, a lone unit would
  // feel a fictitious push that produced high idle velocity.
  it("lone unit with no neighbors produces tiny separation force", () => {
    const inf = unit("infantry", { speed: 8 });
    const tgt = unit("tank");
    const content = makeBundle({ units: [inf, tgt] });
    const state = emptyState({ bounds: { w: 100, h: 100 } });
    // Place rac slightly off the cell center to expose any self-bias.
    const row = addRac(state, content, { unitId: inf.id, owner: 0, x: 1.3, y: 0.7 });
    // Give a far target so seek is tiny relative to any self-bias.
    const tRow = addRac(state, content, { unitId: tgt.id, owner: 1, x: 50, y: 0 });
    state.rac.targetId[row] = state.rac.id[tRow];
    state.rac.targetKind[row] = TARGET_KIND_RAC;
    const log = makeLogger(state);
    state.tick = 1;
    boidsTick(state, content, log);
    // Velocity direction should be ~+x (toward target). y-component
    // should be small. If self-influence leaks, y-component will be
    // significant because the splat bilinear is asymmetric in y at
    // y=0.7.
    const vx = state.rac.vx[row];
    const vy = state.rac.vy[row];
    const v = Math.hypot(vx, vy);
    assert.ok(v > 0.5, `should be moving; got ${v}`);
    // Direction should be nearly horizontal toward target.
    const cosToTarget = vx / v;
    assert.ok(
      cosToTarget > 0.9,
      `lone unit's velocity should be toward target; cos=${cosToTarget.toFixed(2)}`,
    );
  });
});

describe("boids: archer kite deadband settles instead of oscillating", () => {
  it("archer at preferred standoff distance does not oscillate ±maxV", () => {
    const archer = unit("archer", { speed: 8, range: 10 });
    const tgt = unit("tank");
    const content = makeBundle({ units: [archer, tgt] });
    const state = emptyState({ bounds: { w: 100, h: 100 } });
    // Archer kiteFraction default = 0.7, so preferred = 7m. Place at
    // exactly 7m from target.
    const aRow = addRac(state, content, { unitId: archer.id, owner: 0, x: 0, y: 0 });
    const tRow = addRac(state, content, { unitId: tgt.id, owner: 1, x: 7, y: 0 });
    state.rac.targetId[aRow] = state.rac.id[tRow];
    state.rac.targetKind[aRow] = TARGET_KIND_RAC;
    const log = makeLogger(state);
    let speedSum = 0;
    for (let t = 0; t < 20; t++) {
      state.tick = t + 1;
      boidsTick(state, content, log);
      speedSum += Math.hypot(state.rac.vx[aRow], state.rac.vy[aRow]);
    }
    const avgSpeed = speedSum / 20;
    // In the old oscillating model, avgSpeed would be ~maxV (8). With
    // deadband, archer settles → avg speed should be much lower.
    assert.ok(avgSpeed < 4, `archer should settle in deadband; avg speed=${avgSpeed.toFixed(2)}`);
  });
});

describe("boids: leadership produces differentiation across pack", () => {
  it("not every unit in a pack has identical velocity (lockstep avoidance)", () => {
    const cav = unit("cavalry", { speed: 14 });
    const tgt = unit("tank");
    const content = makeBundle({ units: [cav, tgt] });
    const state = emptyState({ bounds: { w: 100, h: 100 } });
    const racRows: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = addRac(state, content, { unitId: cav.id, owner: 0, x: -20, y: (i - 2.5) * 0.6 });
      racRows.push(r);
    }
    const tRow = addRac(state, content, { unitId: tgt.id, owner: 1, x: 20, y: 0 });
    for (const r of racRows) {
      state.rac.targetId[r] = state.rac.id[tRow];
      state.rac.targetKind[r] = TARGET_KIND_RAC;
    }
    runBoids(state, content, 5);
    // At least some pair of pack members should have a meaningfully
    // different velocity (id-hash bias should split bold from follower).
    let maxDelta = 0;
    for (let i = 0; i < racRows.length; i++) {
      for (let j = i + 1; j < racRows.length; j++) {
        const dvx = state.rac.vx[racRows[i]] - state.rac.vx[racRows[j]];
        const dvy = state.rac.vy[racRows[i]] - state.rac.vy[racRows[j]];
        const d = Math.hypot(dvx, dvy);
        if (d > maxDelta) maxDelta = d;
      }
    }
    assert.ok(maxDelta > 0.5, `expected per-rac differentiation; max delta=${maxDelta.toFixed(2)}`);
  });
});
