/**
 * Rage attack shape geometry — verify that target collection respects
 * cone arcs, line widths, single-target picking, and aura no-damage.
 *
 * The shape logic is private inside rage.ts; we test it via the
 * effect on rage_fire events emitted when fireRage runs. Setup: place
 * the firer with a known facing, surround it with enemies in known
 * positions, max out the rage meter so fireRage triggers, run rageTick,
 * and inspect targets_rac in the emitted event.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rageTick } from "../../src/sim/subsys/rage.js";
import {
  addRac,
  emptyState,
  eventsFrom,
  eventsOf,
  makeBundle,
  makeLogger,
  makeUnit,
} from "../helpers/builders.js";

function targetsFromFire(events: Record<string, unknown>[]): Set<number> {
  const fires = eventsOf(events, "rage_fire");
  if (fires.length === 0) return new Set();
  return new Set((fires[0].targets_rac as number[]) ?? []);
}

describe("rage shape: single-target", () => {
  it("hits only the nearest enemy in radius", () => {
    const u = makeUnit({
      id: "u",
      stats: { hp: 50, damage: 0, attack_rate: 1, range: 1, speed: 0, armor: 0 },
      rage: { capacity: 1, attack: { shape: "single-target", damage: 25, range: 5 } },
    });
    const content = makeBundle({ units: [u] });
    const state = emptyState();
    const src = addRac(state, content, { unitId: "u", owner: 0, x: 0, y: 0, rage: 1 });
    state.rac.facing[src] = 0;
    const e1 = addRac(state, content, { unitId: "u", owner: 1, x: 1, y: 0 }); // closer
    const e2 = addRac(state, content, { unitId: "u", owner: 1, x: 4, y: 0 });
    const log = makeLogger(state);
    rageTick(state, content, log);
    const targets = targetsFromFire(eventsFrom(log));
    assert.equal(targets.size, 1, "exactly one target");
    assert.ok(targets.has(state.rac.id[e1]), "should target the closer enemy");
    assert.ok(!targets.has(state.rac.id[e2]), "should not target the farther enemy");
  });
});

describe("rage shape: cone", () => {
  it("hits enemies in front (within 60°), skips ones behind", () => {
    const u = makeUnit({
      id: "u",
      rage: { capacity: 1, attack: { shape: "cone", damage: 30, range: 5 } },
    });
    const content = makeBundle({ units: [u] });
    const state = emptyState();
    const src = addRac(state, content, { unitId: "u", owner: 0, x: 0, y: 0, rage: 1 });
    state.rac.facing[src] = 0; // +X direction
    // In cone (right in front)
    const front = addRac(state, content, { unitId: "u", owner: 1, x: 3, y: 0 });
    // Just inside cone (~25°)
    const frontish = addRac(state, content, { unitId: "u", owner: 1, x: 3, y: 1.4 });
    // Outside cone (~45°) — should be skipped
    const side = addRac(state, content, { unitId: "u", owner: 1, x: 2, y: 2 });
    // Behind (180°)
    const behind = addRac(state, content, { unitId: "u", owner: 1, x: -3, y: 0 });
    const log = makeLogger(state);
    rageTick(state, content, log);
    const targets = targetsFromFire(eventsFrom(log));
    assert.ok(targets.has(state.rac.id[front]), "front in cone");
    assert.ok(targets.has(state.rac.id[frontish]), "frontish in cone");
    assert.ok(!targets.has(state.rac.id[side]), "side OUT of cone");
    assert.ok(!targets.has(state.rac.id[behind]), "behind OUT of cone");
  });
});

describe("rage shape: line", () => {
  it("pierces enemies along facing line, skips those off-axis or behind", () => {
    const u = makeUnit({
      id: "u",
      rage: { capacity: 1, attack: { shape: "piercing-line", damage: 20, range: 5 } },
    });
    const content = makeBundle({ units: [u] });
    const state = emptyState();
    const src = addRac(state, content, { unitId: "u", owner: 0, x: 0, y: 0, rage: 1 });
    state.rac.facing[src] = 0; // +X direction
    const onLineNear = addRac(state, content, { unitId: "u", owner: 1, x: 1, y: 0 });
    const onLineFar = addRac(state, content, { unitId: "u", owner: 1, x: 4, y: 0 });
    const slightlyOff = addRac(state, content, { unitId: "u", owner: 1, x: 3, y: 0.5 }); // within 0.6m offset
    const wayOff = addRac(state, content, { unitId: "u", owner: 1, x: 3, y: 2 });
    const behind = addRac(state, content, { unitId: "u", owner: 1, x: -1, y: 0 });
    const log = makeLogger(state);
    rageTick(state, content, log);
    const targets = targetsFromFire(eventsFrom(log));
    assert.ok(targets.has(state.rac.id[onLineNear]), "near on-line");
    assert.ok(targets.has(state.rac.id[onLineFar]), "far on-line");
    assert.ok(targets.has(state.rac.id[slightlyOff]), "within line half-width");
    assert.ok(!targets.has(state.rac.id[wayOff]), "outside line half-width");
    assert.ok(!targets.has(state.rac.id[behind]), "behind facing");
  });
});

describe("rage shape: aura", () => {
  it("emits rage_fire but applies no enemy damage", () => {
    const u = makeUnit({
      id: "u",
      rage: { capacity: 1, attack: { shape: "aura", damage: 999, range: 5 } },
    });
    const content = makeBundle({ units: [u] });
    const state = emptyState();
    const src = addRac(state, content, { unitId: "u", owner: 0, x: 0, y: 0, rage: 1 });
    void src;
    addRac(state, content, { unitId: "u", owner: 1, x: 1, y: 0 });
    const log = makeLogger(state);
    rageTick(state, content, log);
    const events = eventsFrom(log);
    const fires = eventsOf(events, "rage_fire");
    assert.equal(fires.length, 1, "rage_fire still emits");
    assert.equal((fires[0].targets_rac as unknown[]).length, 0, "no rac targets");
    const dmg = eventsOf(events, "damage_apply");
    assert.equal(dmg.length, 0, "no damage emitted");
  });
});

describe("rage shape: AOE-circle (default / pulse / etc.)", () => {
  it("pulse hits all enemies in radius regardless of facing", () => {
    const u = makeUnit({
      id: "u",
      rage: { capacity: 1, attack: { shape: "pulse", damage: 25, range: 4 } },
    });
    const content = makeBundle({ units: [u] });
    const state = emptyState();
    const src = addRac(state, content, { unitId: "u", owner: 0, x: 0, y: 0, rage: 1 });
    state.rac.facing[src] = 0;
    const front = addRac(state, content, { unitId: "u", owner: 1, x: 2, y: 0 });
    const side = addRac(state, content, { unitId: "u", owner: 1, x: 0, y: 3 });
    const behind = addRac(state, content, { unitId: "u", owner: 1, x: -3, y: 0 });
    const outside = addRac(state, content, { unitId: "u", owner: 1, x: 5, y: 0 });
    const log = makeLogger(state);
    rageTick(state, content, log);
    const targets = targetsFromFire(eventsFrom(log));
    assert.ok(targets.has(state.rac.id[front]));
    assert.ok(targets.has(state.rac.id[side]));
    assert.ok(targets.has(state.rac.id[behind]));
    assert.ok(!targets.has(state.rac.id[outside]));
  });
});
