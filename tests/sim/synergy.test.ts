/**
 * Synergy: per-side bin counts, threshold transitions, mod composition.
 *
 * Hardcoded mods covered: Park-2 speed, Coastal-2 range,
 * Barbarians-2 HP, Barbarians-3 armor.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { synergyModsFor, synergyTick } from "../../src/sim/subsys/synergy.js";
import { addBin, addRac, emptyState, eventsFrom, eventsOf, makeBundle, makeLogger, makeUnit } from "../helpers/builders.js";

describe("synergy", () => {
  it("Park-2 (≥2 Park bins on side) grants +20% speed to Park raccoons on that side", () => {
    const parkUnit = makeUnit({ id: "park-u", environment: "park", curiosity: "lockpickers" });
    const content = makeBundle({ units: [parkUnit] });
    const state = emptyState();
    addBin(state, content, { unitId: "park-u", owner: 0 });
    addBin(state, content, { unitId: "park-u", owner: 0 });
    const racRow = addRac(state, content, { unitId: "park-u", owner: 0 });
    const log = makeLogger(state);

    state.tick = 1;
    synergyTick(state, content, log);
    const mods = synergyModsFor(state, racRow);
    assert.ok(Math.abs(mods.speedMul - 1.20) < 1e-5);
  });

  it("Park-2 does NOT grant speed to non-Park raccoons", () => {
    const parkUnit = makeUnit({ id: "park-u", environment: "park", curiosity: "lockpickers" });
    const cityUnit = makeUnit({ id: "city-u", environment: "city", curiosity: "farmers" });
    const content = makeBundle({ units: [parkUnit, cityUnit] });
    const state = emptyState();
    addBin(state, content, { unitId: "park-u", owner: 0 });
    addBin(state, content, { unitId: "park-u", owner: 0 });
    const racRow = addRac(state, content, { unitId: "city-u", owner: 0 });
    const log = makeLogger(state);

    state.tick = 1;
    synergyTick(state, content, log);
    const mods = synergyModsFor(state, racRow);
    assert.equal(mods.speedMul, 1.0, "non-Park rac should not get Park speed mul");
  });

  it("Coastal-2 grants +25% range to Coastal raccoons", () => {
    const u = makeUnit({ id: "u", environment: "coastal", curiosity: "tinkerers" });
    const content = makeBundle({ units: [u] });
    const state = emptyState();
    addBin(state, content, { unitId: "u", owner: 0 });
    addBin(state, content, { unitId: "u", owner: 0 });
    const racRow = addRac(state, content, { unitId: "u", owner: 0 });
    const log = makeLogger(state);

    state.tick = 1;
    synergyTick(state, content, log);
    const mods = synergyModsFor(state, racRow);
    assert.ok(Math.abs(mods.rangeMul - 1.25) < 1e-5);
  });

  it("Barbarians-2 grants +20% HP, Barbarians-3 adds +2 armor (cumulative)", () => {
    const u = makeUnit({ id: "u", environment: "city", curiosity: "barbarians" });
    const content = makeBundle({ units: [u] });
    const state = emptyState();
    addBin(state, content, { unitId: "u", owner: 0 });
    addBin(state, content, { unitId: "u", owner: 0 });
    const racRow = addRac(state, content, { unitId: "u", owner: 0 });
    const log = makeLogger(state);

    state.tick = 1;
    synergyTick(state, content, log);
    let mods = synergyModsFor(state, racRow);
    assert.ok(Math.abs(mods.hpMul - 1.20) < 1e-5);
    assert.equal(mods.armorAdd, 0, "Barbarians-3 not yet active at 2 bins");

    // Add a third bin → Barbarians-3.
    addBin(state, content, { unitId: "u", owner: 0 });
    state.tick = 2;
    synergyTick(state, content, log);
    mods = synergyModsFor(state, racRow);
    assert.ok(Math.abs(mods.hpMul - 1.20) < 1e-5, "Barbarians-2 still on");
    assert.equal(mods.armorAdd, 2, "Barbarians-3 adds +2 armor");
  });

  it("threshold transitions emit synergy_active on/off events", () => {
    const u = makeUnit({ id: "u", environment: "park", curiosity: "lockpickers" });
    const content = makeBundle({ units: [u] });
    const state = emptyState();
    const b1 = addBin(state, content, { unitId: "u", owner: 0 });
    const b2 = addBin(state, content, { unitId: "u", owner: 0 });
    addRac(state, content, { unitId: "u", owner: 0 });
    const log = makeLogger(state);

    state.tick = 1;
    synergyTick(state, content, log);
    let events = eventsOf(eventsFrom(log), "synergy_active");
    const onEvents = events.filter((e) => e.state === "on");
    assert.ok(onEvents.length > 0, "Park-2 should fire as on");

    // Kill one bin → drop below threshold → emit "off".
    state.bin.alive[b1] = 0;
    state.tick = 2;
    synergyTick(state, content, log);
    events = eventsOf(eventsFrom(log), "synergy_active");
    const offEvents = events.filter((e) => e.state === "off");
    assert.ok(offEvents.length > 0, "Park-2 should fire as off when dropping below threshold");

    // Sanity reference; the second bin is still in counts.
    void b2;
  });

  it("counts are per-side: side 1's bins do NOT activate side 0's synergies", () => {
    const u = makeUnit({ id: "u", environment: "park", curiosity: "lockpickers" });
    const content = makeBundle({ units: [u] });
    const state = emptyState();
    addBin(state, content, { unitId: "u", owner: 1 }); // enemy bins
    addBin(state, content, { unitId: "u", owner: 1 });
    const racRow = addRac(state, content, { unitId: "u", owner: 0 });
    const log = makeLogger(state);

    state.tick = 1;
    synergyTick(state, content, log);
    const mods = synergyModsFor(state, racRow);
    assert.equal(mods.speedMul, 1.0, "side 0 rac shouldn't get Park-2 from side 1's bins");
  });
});
