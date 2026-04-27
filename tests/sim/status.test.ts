/**
 * Status: apply (refresh / stack / ignore semantics) + DoT ticking +
 * expiry + effective-stat recompute.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyStatusToRac, statusTick } from "../../src/sim/subsys/status.js";
import { synergyTick } from "../../src/sim/subsys/synergy.js";
import {
  addRac,
  emptyState,
  eventsFrom,
  eventsOf,
  makeBundle,
  makeLogger,
  makeStatus,
  makeUnit,
} from "../helpers/builders.js";

describe("status apply semantics", () => {
  it("refresh: re-apply resets duration on existing instance", () => {
    const u = makeUnit({ id: "u" });
    const wet = makeStatus({ id: "wet", kind: "debuff", modifies: "speed", magnitude: -0.30, duration: 2.5, stack: "refresh" });
    const content = makeBundle({ units: [u], statuses: [wet] });
    const state = emptyState();
    const r = addRac(state, content, { unitId: "u", owner: 0 });
    const log = makeLogger(state);

    applyStatusToRac(state, content, log, r, "wet", 100);
    // tick down some duration
    state.rac.statuses[r][0].remaining = 0.5;
    applyStatusToRac(state, content, log, r, "wet", 200);
    assert.equal(state.rac.statuses[r].length, 1, "still one instance");
    assert.equal(state.rac.statuses[r][0].remaining, 2.5, "duration reset");
    assert.equal(state.rac.statuses[r][0].src, 200, "src updated");
  });

  it("stack: re-apply adds an independent instance", () => {
    const u = makeUnit({ id: "u" });
    const hungry = makeStatus({ id: "hungry", kind: "dot", modifies: "hp", magnitude: -3, duration: 5, tick_rate: 1, stack: "stack" });
    const content = makeBundle({ units: [u], statuses: [hungry] });
    const state = emptyState();
    const r = addRac(state, content, { unitId: "u", owner: 0 });
    const log = makeLogger(state);

    applyStatusToRac(state, content, log, r, "hungry", 100);
    applyStatusToRac(state, content, log, r, "hungry", 200);
    applyStatusToRac(state, content, log, r, "hungry", 300);
    assert.equal(state.rac.statuses[r].length, 3, "three independent instances");
  });

  it("ignore: re-apply is a no-op", () => {
    const u = makeUnit({ id: "u" });
    const stunned = makeStatus({ id: "stunned", kind: "control", modifies: "movement_locked", magnitude: 1, duration: 1, stack: "ignore" });
    const content = makeBundle({ units: [u], statuses: [stunned] });
    const state = emptyState();
    const r = addRac(state, content, { unitId: "u", owner: 0 });
    const log = makeLogger(state);

    applyStatusToRac(state, content, log, r, "stunned", 100);
    state.rac.statuses[r][0].remaining = 0.2;
    const before = state.rac.statuses[r][0].remaining;
    applyStatusToRac(state, content, log, r, "stunned", 200);
    assert.equal(state.rac.statuses[r].length, 1);
    assert.equal(state.rac.statuses[r][0].remaining, before, "duration unchanged");
    assert.equal(state.rac.statuses[r][0].src, 100, "original src preserved");
  });

  it("apply on dead raccoon is a no-op", () => {
    const u = makeUnit({ id: "u" });
    const wet = makeStatus({ id: "wet" });
    const content = makeBundle({ units: [u], statuses: [wet] });
    const state = emptyState();
    const r = addRac(state, content, { unitId: "u", owner: 0 });
    state.rac.alive[r] = 0;
    const log = makeLogger(state);

    const ok = applyStatusToRac(state, content, log, r, "wet", -1);
    assert.equal(ok, false);
    assert.equal(state.rac.statuses[r].length, 0);
  });
});

describe("status DoT", () => {
  it("hungry deals magnitude damage at tick_rate", () => {
    const u = makeUnit({ id: "u", stats: { hp: 100, damage: 0, attack_rate: 1, range: 1, speed: 0, armor: 99 } });
    const hungry = makeStatus({ id: "hungry", kind: "dot", modifies: "hp", magnitude: -3, duration: 5, tick_rate: 1, stack: "stack" });
    const content = makeBundle({ units: [u], statuses: [hungry] });
    const state = emptyState();
    const r = addRac(state, content, { unitId: "u", owner: 0 });
    state.rac.effArmor[r] = 99; // would block any non-DoT damage entirely
    const log = makeLogger(state);

    applyStatusToRac(state, content, log, r, "hungry", -1);
    eventsFrom(log); // drain

    const hpStart = state.rac.hp[r];
    // Run 32 ticks (~2.13s sim). hungry has tick_rate=1 + nextTickIn
    // initialized to 1, so first tick at sim_t≈1, second at sim_t≈2.
    // Float drift can push the second past the exact 30-tick mark, so
    // 32 ticks gives a safety margin while keeping the test tight.
    for (let t = 1; t <= 32; t++) {
      state.tick = t;
      statusTick(state, content, log);
    }
    const dotDmg = eventsOf(eventsFrom(log), "damage_apply").filter(
      (e) => String(e.source) === "dot",
    );
    assert.equal(dotDmg.length, 2, `expected 2 DoT ticks in ~2s, got ${dotDmg.length}`);
    for (const d of dotDmg) {
      assert.equal(d.dmg_after_armor, 3, "DoT bypasses armor");
    }
    assert.equal(state.rac.hp[r], hpStart - 6);
  });

  it("status expires after duration; emits status_expire", () => {
    const u = makeUnit({ id: "u" });
    const wet = makeStatus({ id: "wet", duration: 1.0 });
    const content = makeBundle({ units: [u], statuses: [wet] });
    const state = emptyState();
    const r = addRac(state, content, { unitId: "u", owner: 0 });
    const log = makeLogger(state);

    applyStatusToRac(state, content, log, r, "wet", -1);
    eventsFrom(log); // drain

    // Run 16 ticks (1.06s sim) — should expire on or before the last tick.
    for (let t = 1; t <= 16; t++) {
      state.tick = t;
      statusTick(state, content, log);
    }
    const expires = eventsOf(eventsFrom(log), "status_expire");
    assert.equal(expires.length, 1);
    assert.equal(state.rac.statuses[r].length, 0);
  });
});

describe("status effective-stat recompute", () => {
  it("wet (-30% speed) is reflected in effSpeed after recompute tick", () => {
    const u = makeUnit({ id: "u", stats: { hp: 50, damage: 10, attack_rate: 1, range: 1, speed: 4, armor: 0 } });
    const wet = makeStatus({ id: "wet", modifies: "speed", magnitude: -0.30, duration: 5, stack: "refresh" });
    const content = makeBundle({ units: [u], statuses: [wet] });
    const state = emptyState();
    const r = addRac(state, content, { unitId: "u", owner: 0 });
    const log = makeLogger(state);

    applyStatusToRac(state, content, log, r, "wet", -1);
    state.tick = 1;
    synergyTick(state, content, log); // populate _synergy
    statusTick(state, content, log);

    assert.ok(
      Math.abs(state.rac.effSpeed[r] - 4 * 0.7) < 1e-5,
      `effSpeed=${state.rac.effSpeed[r]} expected ~2.8`,
    );
  });

  it("status removed → effSpeed returns to base", () => {
    const u = makeUnit({ id: "u", stats: { hp: 50, damage: 10, attack_rate: 1, range: 1, speed: 4, armor: 0 } });
    // Duration 0.10s → survives the first tick (~0.067s) then expires
    // on the second tick.
    const wet = makeStatus({ id: "wet", modifies: "speed", magnitude: -0.30, duration: 0.10 });
    const content = makeBundle({ units: [u], statuses: [wet] });
    const state = emptyState();
    const r = addRac(state, content, { unitId: "u", owner: 0 });
    const log = makeLogger(state);

    applyStatusToRac(state, content, log, r, "wet", -1);
    state.tick = 1;
    synergyTick(state, content, log);
    statusTick(state, content, log);
    assert.ok(state.rac.effSpeed[r] < 4, `wet active → slower (got ${state.rac.effSpeed[r]})`);

    // Tick again — second decrement of 1/15s puts remaining ≤ 0, expire.
    state.tick = 2;
    statusTick(state, content, log);
    assert.equal(state.rac.statuses[r].length, 0, "status should have expired");
    assert.equal(state.rac.effSpeed[r], 4, "effSpeed back to base");
  });
});
