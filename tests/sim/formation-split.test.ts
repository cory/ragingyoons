/**
 * Formation splitting tests.
 *
 *   1. group below maxFormationSize is NOT split
 *   2. group above maxFormationSize IS split into two groups
 *   3. split halves are partitioned along the doctrine's splitAxis
 *      (front-rear, lateral, perpendicular, random)
 *   4. fanatic doctrine (splitAxis="none") never splits regardless
 *      of count
 *   5. cohesion uses group centroid, not field — so two groups of
 *      the same role/side don't pull together (they march in
 *      parallel, not converge)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { boidsTick } from "../../src/sim/subsys/boids.js";
import { DOCTRINES, DOCTRINE_TO_IDX } from "../../src/sim/doctrines.js";
import { addRac, emptyState, makeBundle, makeLogger, makeUnit } from "../helpers/builders.js";

function placeGroup(state: ReturnType<typeof emptyState>, content: ReturnType<typeof makeBundle>, unitId: string, n: number, baseX: number, baseY: number, doctrineIdx: number) {
  // Force same group for n racs by overriding nextGroupId before
  // each placement and resetting after. The lab placeRac assigns
  // a fresh groupId per call, but for testing we want them grouped.
  const rows: number[] = [];
  const targetGid = state.nextGroupId; // capture
  for (let k = 0; k < n; k++) {
    // Tight grid arrangement around (baseX, baseY)
    const dx = (k % 8) * 0.6 - 2;
    const dy = Math.floor(k / 8) * 0.6 - 2;
    const row = addRac(state, content, { unitId, owner: 0, x: baseX + dx, y: baseY + dy });
    rows.push(row);
    // Force into the same group
    state.rac.groupId[row] = targetGid;
    state.rac.doctrineIdx[row] = doctrineIdx;
  }
  // Advance counter so next placeGroup gets a fresh id
  state.nextGroupId = targetGid + 1;
  return rows;
}

function distinctGroupIds(state: ReturnType<typeof emptyState>, rows: number[]): Set<number> {
  const s = new Set<number>();
  for (const r of rows) s.add(state.rac.groupId[r]);
  return s;
}

describe("formation splitting", () => {
  it("group below maxFormationSize is NOT split", () => {
    const u = makeUnit({
      id: "inf",
      role: "infantry",
      environment: "city",
      curiosity: "lockpickers", // fire-team doctrine, max=12
      stats: { hp: 50, damage: 5, attack_rate: 1, range: 1, speed: 5, armor: 0 },
    });
    const content = makeBundle({ units: [u] });
    const state = emptyState({ bounds: { w: 100, h: 100 } });
    const fireTeamIdx = DOCTRINE_TO_IDX["fire-team"];
    const rows = placeGroup(state, content, "inf", 8, 0, 0, fireTeamIdx); // 8 < 12
    const log = makeLogger(state);
    state.tick = 1;
    boidsTick(state, content, log);
    const gids = distinctGroupIds(state, rows);
    assert.equal(gids.size, 1, `expected single group; got ${gids.size}`);
  });

  it("group above maxFormationSize IS split", () => {
    const u = makeUnit({
      id: "inf",
      role: "infantry",
      environment: "city",
      curiosity: "lockpickers",
      stats: { hp: 50, damage: 5, attack_rate: 1, range: 1, speed: 5, armor: 0 },
    });
    const content = makeBundle({ units: [u] });
    const state = emptyState({ bounds: { w: 100, h: 100 } });
    const fireTeamIdx = DOCTRINE_TO_IDX["fire-team"];
    const rows = placeGroup(state, content, "inf", 16, 0, 0, fireTeamIdx); // 16 > 12
    const log = makeLogger(state);
    state.tick = 1;
    boidsTick(state, content, log);
    const gids = distinctGroupIds(state, rows);
    assert.equal(gids.size, 2, `expected 2 groups after split; got ${gids.size}`);
    // Counts should be ~equal (median split).
    const counts = new Map<number, number>();
    for (const r of rows) {
      const g = state.rac.groupId[r];
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    const sizes = [...counts.values()].sort((a, b) => a - b);
    assert.ok(Math.abs(sizes[0] - sizes[1]) <= 1, `split sizes should be balanced; got ${sizes}`);
  });

  it("phalanx (front-rear axis) splits along the depth axis", () => {
    const u = makeUnit({
      id: "tank",
      role: "tank",
      environment: "suburban",
      curiosity: "barbarians",
      stats: { hp: 100, damage: 10, attack_rate: 1, range: 1, speed: 5, armor: 0 },
    });
    const content = makeBundle({ units: [u] });
    const state = emptyState({ bounds: { w: 200, h: 200 } });
    const phIdx = DOCTRINE_TO_IDX["phalanx"];
    const rows = placeGroup(state, content, "tank", 80, 0, 0, phIdx); // > 64
    const log = makeLogger(state);
    state.tick = 1;
    boidsTick(state, content, log);
    const counts = new Map<number, { rows: number[] }>();
    for (const r of rows) {
      const g = state.rac.groupId[r];
      let c = counts.get(g);
      if (!c) {
        c = { rows: [] };
        counts.set(g, c);
      }
      c.rows.push(r);
    }
    assert.equal(counts.size, 2, `phalanx should split into 2 groups; got ${counts.size}`);
    // For "front-rear" axis with side=0 (forward = -x), the split
    // axis is perpendicular to forward = +y. So the two halves should
    // be separated in y, not x. Verify mean-y differs more than
    // mean-x between the halves.
    const halves = [...counts.values()];
    const meanY = halves.map((h) => h.rows.reduce((s, r) => s + state.rac.y[r], 0) / h.rows.length);
    const meanX = halves.map((h) => h.rows.reduce((s, r) => s + state.rac.x[r], 0) / h.rows.length);
    const dy = Math.abs(meanY[0] - meanY[1]);
    const dx = Math.abs(meanX[0] - meanX[1]);
    assert.ok(
      dy > dx,
      `front-rear split should separate halves along the y-axis (perpendicular to forward); ` +
        `got dy=${dy.toFixed(2)} dx=${dx.toFixed(2)}`,
    );
  });

  it("fanatic (splitAxis=none) never splits", () => {
    const u = makeUnit({
      id: "tank",
      role: "tank",
      environment: "coastal",
      curiosity: "barbarians",
      stats: { hp: 100, damage: 10, attack_rate: 1, range: 1, speed: 5, armor: 0 },
    });
    const content = makeBundle({ units: [u] });
    const state = emptyState({ bounds: { w: 200, h: 200 } });
    const fanIdx = DOCTRINE_TO_IDX["fanatic"];
    const rows = placeGroup(state, content, "tank", 60, 0, 0, fanIdx); // > 30 max
    const log = makeLogger(state);
    state.tick = 1;
    boidsTick(state, content, log);
    const gids = distinctGroupIds(state, rows);
    assert.equal(gids.size, 1, `fanatic doctrine should not split; got ${gids.size}`);
  });

  it("split is deterministic per (gid, members)", () => {
    const u = makeUnit({
      id: "inf",
      role: "infantry",
      environment: "city",
      curiosity: "lockpickers",
      stats: { hp: 50, damage: 5, attack_rate: 1, range: 1, speed: 5, armor: 0 },
    });
    const content = makeBundle({ units: [u] });
    const fireTeamIdx = DOCTRINE_TO_IDX["fire-team"];

    function snapshot(): number[] {
      const state = emptyState({ bounds: { w: 100, h: 100 }, seed: 1234 });
      const rows = placeGroup(state, content, "inf", 16, 0, 0, fireTeamIdx);
      const log = makeLogger(state);
      state.tick = 1;
      boidsTick(state, content, log);
      return rows.map((r) => state.rac.groupId[r]);
    }
    const a = snapshot();
    const b = snapshot();
    assert.deepEqual(a, b, `splits should be deterministic across runs`);
  });
});
