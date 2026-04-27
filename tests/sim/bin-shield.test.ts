/**
 * Bin shield: damage to a bin is reduced by friendly raccoons within
 * binShieldRadius. Tests:
 *   - empty bin (no defenders) → no shield, full damage
 *   - bin with full garrison → near-max reduction
 *   - radius matters: defenders outside the radius don't count
 *   - shield disabled (binShieldMax = 0) → full damage regardless
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyBinDamage } from "../../src/sim/subsys/combat.js";
import { DOCTRINE_KNOBS } from "../../src/sim/doctrines.js";
import { buildRacGrid, DEFAULT_CELL_SIZE } from "../../src/sim/grid.js";
import { addBin, addRac, emptyState, eventsFrom, eventsOf, makeBundle, makeLogger, makeUnit } from "../helpers/builders.js";

function setupShieldFixture(numDefenders: number, defenderDistance: number) {
  const tank = makeUnit({
    id: "tank",
    role: "tank",
    bin: { hp: 1000, garrison_cap: 4, spawn_cadence: "garrison-respawn" },
  });
  const inf = makeUnit({
    id: "inf",
    role: "infantry",
    stats: { hp: 50, damage: 5, attack_rate: 1, range: 1, speed: 5, armor: 0 },
  });
  const content = makeBundle({ units: [tank, inf] });
  const state = emptyState({ bounds: { w: 100, h: 100 } });
  const binSlot = addBin(state, content, { unitId: "tank", owner: 0, x: 0, y: 0 });
  // Place numDefenders friendly racs at defenderDistance from bin.
  for (let i = 0; i < numDefenders; i++) {
    const angle = (i / Math.max(1, numDefenders)) * Math.PI * 2;
    addRac(state, content, {
      unitId: "inf",
      owner: 0,
      x: Math.cos(angle) * defenderDistance,
      y: Math.sin(angle) * defenderDistance,
    });
  }
  // Build the grid so combat.ts's shield-counting forEachNear works.
  state._racGrid = buildRacGrid(state, DEFAULT_CELL_SIZE);
  // Put a phantom attacker rac (not used for damage; just so srcRow != -1).
  const attackerRow = addRac(state, content, { unitId: "inf", owner: 1, x: 50, y: 0 });
  state._racGrid = buildRacGrid(state, DEFAULT_CELL_SIZE);
  return { state, content, binSlot, attackerRow };
}

describe("bin shield", () => {
  it("undefended bin takes full damage", () => {
    const { state, content, binSlot, attackerRow } = setupShieldFixture(0, 0);
    const log = makeLogger(state);
    const hp0 = state.bin.hp[binSlot];
    applyBinDamage(state, content, log, attackerRow, binSlot, 100);
    assert.equal(state.bin.hp[binSlot], hp0 - 100, "full damage with no defenders");
  });

  it("fully-garrisoned bin takes near-max-reduced damage", () => {
    // binShieldFullAt = 30 by default; place 30 defenders close.
    const fullAt = DOCTRINE_KNOBS.binShieldFullAt;
    const max = DOCTRINE_KNOBS.binShieldMax;
    const { state, content, binSlot, attackerRow } = setupShieldFixture(fullAt, 4);
    const log = makeLogger(state);
    const hp0 = state.bin.hp[binSlot];
    applyBinDamage(state, content, log, attackerRow, binSlot, 100);
    const taken = hp0 - state.bin.hp[binSlot];
    const expected = Math.max(1, 100 * (1 - max));
    // Allow some slack for clamp and floats.
    assert.ok(
      Math.abs(taken - expected) < 1,
      `expected ~${expected.toFixed(2)} damage at full shield, got ${taken.toFixed(2)}`,
    );
  });

  it("partial garrison gives partial shield (linear)", () => {
    const fullAt = DOCTRINE_KNOBS.binShieldFullAt;
    const max = DOCTRINE_KNOBS.binShieldMax;
    const halfDefenders = Math.floor(fullAt / 2);
    const { state, content, binSlot, attackerRow } = setupShieldFixture(halfDefenders, 4);
    const log = makeLogger(state);
    const hp0 = state.bin.hp[binSlot];
    applyBinDamage(state, content, log, attackerRow, binSlot, 100);
    const taken = hp0 - state.bin.hp[binSlot];
    // ~50% of full shield — accept a wide tolerance because we always
    // have +1 phantom attacker on the OTHER side which doesn't count
    // for our owner=0 bin.
    const expectedFrac = halfDefenders / fullAt;
    const expected = Math.max(1, 100 * (1 - expectedFrac * max));
    assert.ok(
      Math.abs(taken - expected) < 5,
      `expected ~${expected.toFixed(1)} damage at half shield, got ${taken.toFixed(1)}`,
    );
  });

  it("disabled shield (binShieldMax = 0) → full damage regardless", () => {
    const original = DOCTRINE_KNOBS.binShieldMax;
    DOCTRINE_KNOBS.binShieldMax = 0;
    try {
      const { state, content, binSlot, attackerRow } = setupShieldFixture(50, 4);
      const log = makeLogger(state);
      const hp0 = state.bin.hp[binSlot];
      applyBinDamage(state, content, log, attackerRow, binSlot, 100);
      assert.equal(state.bin.hp[binSlot], hp0 - 100, "shield disabled → full damage");
    } finally {
      DOCTRINE_KNOBS.binShieldMax = original;
    }
  });

  it("damage_apply event records the shield multiplier", () => {
    const { state, content, binSlot, attackerRow } = setupShieldFixture(15, 4);
    const log = makeLogger(state);
    applyBinDamage(state, content, log, attackerRow, binSlot, 100);
    const events = eventsFrom(log);
    const da = eventsOf(events, "damage_apply").filter((e) => e.tgt_kind === "bin")[0];
    assert.ok(da, "damage_apply event emitted");
    assert.ok(typeof da.bin_shield_mul === "number", "bin_shield_mul field present");
    // 15 defenders / 30 fullAt × 0.85 max = ~0.425 reduction → mul ~0.575
    const mul = da.bin_shield_mul as number;
    assert.ok(mul > 0.5 && mul < 0.7, `expected mul ~0.575, got ${mul}`);
  });
});
