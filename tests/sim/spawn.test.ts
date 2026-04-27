/**
 * Spawn subsystem: garrison fill + per-slot respawn + bin death stops spawning.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { spawnTick, freeRacSlot, RESPAWN_SECONDS, panicSpeedMul } from "../../src/sim/subsys/spawn.js";
import { synergyTick } from "../../src/sim/subsys/synergy.js";
import { TICK_RATE_HZ } from "../../src/sim/state.js";
import { addBin, emptyState, eventsFrom, eventsOf, makeBundle, makeLogger, makeUnit } from "../helpers/builders.js";

describe("spawn", () => {
  it("fills garrison_cap × spawn_burst on the first tick (default infantry burst=10)", () => {
    const unit = makeUnit({
      id: "u1",
      role: "infantry",
      bin: { hp: 100, garrison_cap: 4, spawn_cadence: "garrison-respawn" },
    });
    const content = makeBundle({ units: [unit] });
    const state = emptyState();
    addBin(state, content, { unitId: "u1", owner: 0 });

    const log = makeLogger(state);
    state.tick = 1;
    synergyTick(state, content, log);
    spawnTick(state, content, log);

    // 4 slots × 10 infantry per burst = 40 raccoons
    assert.equal(state.rac.count, 40);
    const events = eventsFrom(log);
    assert.equal(eventsOf(events, "rac_spawn").length, 40);
  });

  it("explicit spawn_burst overrides the role default", () => {
    const unit = makeUnit({
      id: "u1",
      role: "tank",
      bin: { hp: 100, garrison_cap: 2, spawn_cadence: "garrison-respawn", spawn_burst: 7 },
    });
    const content = makeBundle({ units: [unit] });
    const state = emptyState();
    addBin(state, content, { unitId: "u1", owner: 0 });
    const log = makeLogger(state);
    state.tick = 1;
    synergyTick(state, content, log);
    spawnTick(state, content, log);
    assert.equal(state.rac.count, 14, "2 slots × spawn_burst=7 = 14");
  });

  it("does not exceed garrison cap × burst on repeat spawn ticks", () => {
    const unit = makeUnit({
      id: "u1",
      role: "tank",
      bin: { hp: 100, garrison_cap: 3, spawn_cadence: "garrison-respawn" },
    });
    const content = makeBundle({ units: [unit] });
    const state = emptyState();
    addBin(state, content, { unitId: "u1", owner: 0 });
    const log = makeLogger(state);

    for (let t = 1; t <= 50; t++) {
      state.tick = t;
      synergyTick(state, content, log);
      spawnTick(state, content, log);
    }
    // Tank burst = 2 → 3 slots × 2 = 6 alive
    assert.equal(state.rac.count, 6);
  });

  it("respawns whole burst after all members of a slot die", () => {
    const unit = makeUnit({
      id: "u1",
      role: "tank", // burst=2
      bin: { hp: 100, garrison_cap: 1, spawn_cadence: "garrison-respawn" },
    });
    const content = makeBundle({ units: [unit] });
    const state = emptyState();
    addBin(state, content, { unitId: "u1", owner: 0 });
    const log = makeLogger(state);

    state.tick = 1;
    synergyTick(state, content, log);
    spawnTick(state, content, log);
    assert.equal(state.rac.count, 2, "1 slot × burst 2 = 2 racs");
    eventsFrom(log);

    // Kill one — slot still has 1 alive, no respawn yet.
    state.rac.alive[0] = 0;
    freeRacSlot(state, 0);
    state.tick = 2;
    spawnTick(state, content, log);
    assert.equal(state.rac.count, 2, "still 2 rows; one alive still occupies slot");

    // Kill the second — now the slot frees and starts respawn timer.
    state.rac.alive[1] = 0;
    freeRacSlot(state, 1);
    eventsFrom(log);

    const ticksToWait = Math.ceil(RESPAWN_SECONDS * TICK_RATE_HZ) - 1;
    for (let i = 0; i < ticksToWait; i++) {
      state.tick = 3 + i;
      spawnTick(state, content, log);
    }
    assert.equal(eventsOf(eventsFrom(log), "rac_spawn").length, 0, "no respawn before cooldown");

    state.tick += 1;
    spawnTick(state, content, log);
    // Whole burst respawns at once.
    assert.equal(eventsOf(eventsFrom(log), "rac_spawn").length, 2, "full burst respawns");
  });

  it("dead bin does not spawn", () => {
    const unit = makeUnit({ id: "u1", bin: { hp: 100, garrison_cap: 4, spawn_cadence: "garrison-respawn" } });
    const content = makeBundle({ units: [unit] });
    const state = emptyState();
    const binSlot = addBin(state, content, { unitId: "u1", owner: 0 });
    state.bin.alive[binSlot] = 0; // mark dead before any tick
    const log = makeLogger(state);

    for (let t = 1; t <= 10; t++) {
      state.tick = t;
      spawnTick(state, content, log);
    }
    assert.equal(state.rac.count, 0);
  });

  it("panic curve: 1× at full HP, max× at 0 HP, 1.75× at 50% (default max=4)", () => {
    assert.equal(panicSpeedMul(1, 4), 1);
    assert.equal(panicSpeedMul(0, 4), 4);
    assert.ok(Math.abs(panicSpeedMul(0.5, 4) - 1.75) < 1e-9);
    // Cubic-style (squared loss) means the curve is below linear in the
    // middle: at 50% HP it's 1.75×, not 2.5×.
    assert.ok(panicSpeedMul(0.5, 4) < 2.5);
  });

  it("wounded bin respawns visibly faster than a full-HP bin", () => {
    const unit = makeUnit({
      id: "u",
      bin: { hp: 100, garrison_cap: 1, spawn_cadence: "garrison-respawn" },
    });
    const content = makeBundle({ units: [unit] });
    const state = emptyState();
    const fullBin = addBin(state, content, { unitId: "u", owner: 0, x: -5 });
    const woundedBin = addBin(state, content, { unitId: "u", owner: 1, x: 5 });
    // Hurt the wounded bin AFTER addBin so hpMax stays at unit.bin.hp=100
    // and hp drops to 10 → hpFrac 0.10 → panicSpeedMul ≈ 3.43×.
    state.bin.hp[woundedBin] = 10;
    // Mark slot 0 of each bin as just-died so respawn timer starts.
    state.bin.slotRespawnT[fullBin * 8 + 0] = RESPAWN_SECONDS;
    state.bin.slotRespawnT[woundedBin * 8 + 0] = RESPAWN_SECONDS;
    state.bin.slotOccupant[fullBin * 8 + 0] = -1;
    state.bin.slotOccupant[woundedBin * 8 + 0] = -1;

    const log = makeLogger(state);
    // Wounded bin at 10/100 HP → panicSpeedMul ≈ 1 + 0.81×3 = 3.43×
    // → effective respawn ≈ 3.0 / 3.43 ≈ 0.87s ≈ 14 ticks.
    // Full-HP bin at 1× → ~45 ticks.
    const TICKS = 20;
    for (let t = 1; t <= TICKS; t++) {
      state.tick = t;
      spawnTick(state, content, log);
    }
    assert.ok(state.bin.slotOccupant[woundedBin * 8 + 0] >= 0, "wounded slot should be filled");
    assert.equal(state.bin.slotOccupant[fullBin * 8 + 0], -1, "full-HP slot should NOT be filled yet");
  });

  it("two bins fill independently", () => {
    const unit = makeUnit({
      id: "u1",
      role: "tank", // burst=2
      bin: { hp: 100, garrison_cap: 3, spawn_cadence: "garrison-respawn" },
    });
    const content = makeBundle({ units: [unit] });
    const state = emptyState();
    addBin(state, content, { unitId: "u1", owner: 0, x: -5 });
    addBin(state, content, { unitId: "u1", owner: 1, x: 5 });
    const log = makeLogger(state);

    state.tick = 1;
    synergyTick(state, content, log);
    spawnTick(state, content, log);
    // Each bin: 3 slots × 2 burst = 6. Two bins = 12 total.
    assert.equal(state.rac.count, 12);
    const owner0 = Array.from(state.rac.owner.slice(0, 12)).filter((o) => o === 0).length;
    assert.equal(owner0, 6);
    assert.equal(12 - owner0, 6);
  });
});
