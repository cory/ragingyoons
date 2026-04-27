/**
 * Projectile subsystem: spawn, hit, friendly-fire interception, expire.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ARROW_SPEED,
  projectileTick,
  spawnProjectile,
} from "../../src/sim/subsys/projectile.js";
import { combatTick } from "../../src/sim/subsys/combat.js";
import { addBin, addRac, emptyState, eventsFrom, eventsOf, makeBundle, makeLogger, makeUnit } from "../helpers/builders.js";

describe("projectile", () => {
  it("arrow lands on a target raccoon and applies damage", () => {
    const archer = makeUnit({
      id: "archer",
      role: "archer",
      stats: { hp: 30, damage: 10, attack_rate: 1, range: 30, speed: 5, armor: 0 },
    });
    const tgt = makeUnit({
      id: "tank",
      role: "tank",
      stats: { hp: 50, damage: 5, attack_rate: 1, range: 1, speed: 1, armor: 0 },
    });
    const content = makeBundle({ units: [archer, tgt] });
    const state = emptyState({ bounds: { w: 100, h: 100 } });
    const aRow = addRac(state, content, { unitId: "archer", owner: 0, x: 0, y: 0 });
    const tRow = addRac(state, content, { unitId: "tank", owner: 1, x: 10, y: 0 });
    const log = makeLogger(state);

    spawnProjectile(state, log, aRow, 0, 0, state.rac.x[tRow], state.rac.y[tRow], 10, 30);
    // Run ticks until the arrow resolves. 30 m/s × dt 1/15s = 2 m/tick →
    // 10m / 2 = ~5 ticks. Give it 10 to be safe.
    let hit = false;
    for (let t = 0; t < 10; t++) {
      state.tick = t + 1;
      projectileTick(state, content, log);
      const evs = eventsFrom(log);
      if (eventsOf(evs, "proj_hit").length > 0) {
        hit = true;
        break;
      }
    }
    assert.ok(hit, "arrow should hit the target");
    assert.equal(state.rac.hp[tRow], 40, "target lost 10 HP");
  });

  it("friendly tank in front blocks the arrow", () => {
    const archer = makeUnit({
      id: "a",
      role: "archer",
      stats: { hp: 30, damage: 10, attack_rate: 1, range: 30, speed: 5, armor: 0 },
    });
    const tank = makeUnit({
      id: "tank",
      role: "tank",
      stats: { hp: 50, damage: 5, attack_rate: 1, range: 1, speed: 1, armor: 0 },
    });
    const enemy = makeUnit({
      id: "enemy",
      role: "tank",
      stats: { hp: 50, damage: 5, attack_rate: 1, range: 1, speed: 1, armor: 0 },
    });
    const content = makeBundle({ units: [archer, tank, enemy] });
    const state = emptyState({ bounds: { w: 100, h: 100 } });
    const aRow = addRac(state, content, { unitId: "a", owner: 0, x: 0, y: 0 });
    const tankRow = addRac(state, content, { unitId: "tank", owner: 0, x: 5, y: 0 }); // friendly in front
    const enemyRow = addRac(state, content, { unitId: "enemy", owner: 1, x: 15, y: 0 });
    const log = makeLogger(state);

    spawnProjectile(state, log, aRow, 0, 0, state.rac.x[enemyRow], state.rac.y[enemyRow], 10, 30);
    let resolved = false;
    for (let t = 0; t < 15; t++) {
      state.tick = t + 1;
      projectileTick(state, content, log);
      const evs = eventsFrom(log);
      const hits = eventsOf(evs, "proj_hit");
      if (hits.length > 0) {
        resolved = true;
        assert.equal(hits[0].friendly_fire, 1, "friendly fire flagged");
        assert.equal(hits[0].hit_id, state.rac.id[tankRow], "friendly tank ate it");
        break;
      }
    }
    assert.ok(resolved, "arrow should resolve into the friendly tank");
    assert.equal(state.rac.hp[tankRow], 40, "tank took 10 damage from friendly arrow");
    assert.equal(state.rac.hp[enemyRow], 50, "enemy untouched");
  });

  it("arrow expires when it travels its full range without hitting anything", () => {
    const archer = makeUnit({
      id: "a",
      role: "archer",
      stats: { hp: 30, damage: 10, attack_rate: 1, range: 10, speed: 5, armor: 0 },
    });
    const content = makeBundle({ units: [archer] });
    const state = emptyState({ bounds: { w: 100, h: 100 } });
    const aRow = addRac(state, content, { unitId: "a", owner: 0, x: 0, y: 0 });
    const log = makeLogger(state);
    // Fire into empty space toward (10, 0). No targets exist.
    spawnProjectile(state, log, aRow, 0, 0, 10, 0, 10, 10);
    // Range 10 / arrow speed 30 = 0.333s = 5 ticks at 15 Hz.
    let expired = false;
    for (let t = 0; t < 10; t++) {
      state.tick = t + 1;
      projectileTick(state, content, log);
      const evs = eventsFrom(log);
      if (eventsOf(evs, "proj_expire").length > 0) {
        expired = true;
        break;
      }
    }
    assert.ok(expired, "arrow should expire after traveling its range");
  });

  it("archer firing through combatTick spawns a projectile (not instant damage)", () => {
    const archer = makeUnit({
      id: "a",
      role: "archer",
      stats: { hp: 30, damage: 10, attack_rate: 1, range: 30, speed: 5, armor: 0 },
    });
    const tgt = makeUnit({
      id: "t",
      role: "tank",
      stats: { hp: 100, damage: 5, attack_rate: 1, range: 1, speed: 1, armor: 0 },
    });
    const content = makeBundle({ units: [archer, tgt] });
    const state = emptyState({ bounds: { w: 100, h: 100 } });
    addRac(state, content, { unitId: "a", owner: 0, x: 0, y: 0 });
    const tRow = addRac(state, content, { unitId: "t", owner: 1, x: 10, y: 0 });
    const log = makeLogger(state);

    state.tick = 1;
    combatTick(state, content, log);
    const evs = eventsFrom(log);
    // Combat tick should have produced rac_attack + proj_fire but NOT
    // damage_apply (the arrow hasn't traveled yet).
    assert.equal(eventsOf(evs, "rac_attack").length, 1, "one rac_attack");
    assert.equal(eventsOf(evs, "proj_fire").length, 1, "one proj_fire");
    assert.equal(eventsOf(evs, "damage_apply").length, 0, "no instant damage");
    assert.equal(state.rac.hp[tRow], 100, "target undamaged this tick");
  });

  it("determinism: identical inputs produce identical hit attribution", () => {
    const archer = makeUnit({
      id: "a",
      role: "archer",
      stats: { hp: 30, damage: 10, attack_rate: 1, range: 30, speed: 5, armor: 0 },
    });
    const tgt = makeUnit({
      id: "t",
      role: "tank",
      stats: { hp: 50, damage: 5, attack_rate: 1, range: 1, speed: 1, armor: 0 },
    });
    const content = makeBundle({ units: [archer, tgt] });
    const runOnce = () => {
      const state = emptyState({ bounds: { w: 100, h: 100 } });
      const aRow = addRac(state, content, { unitId: "a", owner: 0, x: 0, y: 0 });
      addRac(state, content, { unitId: "t", owner: 1, x: 10, y: 0 });
      const log = makeLogger(state);
      spawnProjectile(state, log, aRow, 0, 0, 10, 0, 10, 30);
      const events: Record<string, unknown>[] = [];
      for (let t = 0; t < 10; t++) {
        state.tick = t + 1;
        projectileTick(state, content, log);
        events.push(...eventsFrom(log));
      }
      return events;
    };
    const a = runOnce();
    const b = runOnce();
    assert.deepEqual(a, b, "two identical runs produce identical event streams");
  });

  it("arrow speed constant scales travel time correctly", () => {
    // Sanity: spawnProjectile encodes velocity at ARROW_SPEED.
    const archer = makeUnit({
      id: "a",
      role: "archer",
      stats: { hp: 30, damage: 10, attack_rate: 1, range: 30, speed: 5, armor: 0 },
    });
    const content = makeBundle({ units: [archer] });
    const state = emptyState({ bounds: { w: 100, h: 100 } });
    const aRow = addRac(state, content, { unitId: "a", owner: 0, x: 0, y: 0 });
    const log = makeLogger(state);
    spawnProjectile(state, log, aRow, 0, 0, 10, 0, 10, 30);
    const speed = Math.hypot(state.atk.vx[0], state.atk.vy[0]);
    assert.ok(Math.abs(speed - ARROW_SPEED) < 1e-3, `arrow speed = ${speed}, expected ${ARROW_SPEED}`);
  });
});
