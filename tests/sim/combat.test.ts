/**
 * Combat: damage math + armor floor + dmgTakenMul + death handling +
 * range gating + cooldown obeyed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyRacDamage, combatTick, gainRage, markRacDead } from "../../src/sim/subsys/combat.js";
import { TARGET_KIND_RAC } from "../../src/sim/state.js";
import {
  addRac,
  emptyState,
  eventsFrom,
  eventsOf,
  makeBundle,
  makeLogger,
  makeUnit,
} from "../helpers/builders.js";

describe("combat", () => {
  it("damage = max(1, dmgRaw - armor) * dmgTakenMul", () => {
    const tgt = makeUnit({ id: "tgt", stats: { hp: 100, damage: 0, attack_rate: 1, range: 1, speed: 1, armor: 5 } });
    const src = makeUnit({ id: "src" });
    const content = makeBundle({ units: [tgt, src] });
    const state = emptyState();
    const sRow = addRac(state, content, { unitId: "src", owner: 0 });
    const tRow = addRac(state, content, { unitId: "tgt", owner: 1 });
    state.rac.effArmor[tRow] = 5;
    const log = makeLogger(state);

    applyRacDamage(state, content, log, sRow, tRow, 12);
    const events = eventsFrom(log);
    const dmg = eventsOf(events, "damage_apply")[0];
    assert.equal(dmg.dmg_raw, 12);
    assert.equal(dmg.armor, 5);
    assert.equal(dmg.dmg_after_armor, 7); // 12 - 5
    assert.equal(state.rac.hp[tRow], 93);
  });

  it("armor floor: minimum 1 damage even when armor exceeds raw", () => {
    const tgt = makeUnit({ id: "tgt", stats: { hp: 100, damage: 0, attack_rate: 1, range: 1, speed: 1, armor: 50 } });
    const src = makeUnit({ id: "src" });
    const content = makeBundle({ units: [tgt, src] });
    const state = emptyState();
    const sRow = addRac(state, content, { unitId: "src", owner: 0 });
    const tRow = addRac(state, content, { unitId: "tgt", owner: 1 });
    state.rac.effArmor[tRow] = 50;
    const log = makeLogger(state);

    applyRacDamage(state, content, log, sRow, tRow, 5);
    const dmg = eventsOf(eventsFrom(log), "damage_apply")[0];
    assert.equal(dmg.dmg_after_armor, 1, "MIN_DAMAGE floor of 1");
    assert.equal(state.rac.hp[tRow], 99);
  });

  it("dmgTakenMul amplifies/reduces damage taken", () => {
    const tgt = makeUnit({ id: "tgt", stats: { hp: 100, damage: 0, attack_rate: 1, range: 1, speed: 1, armor: 0 } });
    const src = makeUnit({ id: "src" });
    const content = makeBundle({ units: [tgt, src] });
    const state = emptyState();
    const sRow = addRac(state, content, { unitId: "src", owner: 0 });
    const tRow = addRac(state, content, { unitId: "tgt", owner: 1 });
    state.rac.dmgTakenMul[tRow] = 1.25; // lonely-style
    const log = makeLogger(state);

    applyRacDamage(state, content, log, sRow, tRow, 10);
    const dmg = eventsOf(eventsFrom(log), "damage_apply")[0];
    assert.equal(dmg.dmg_after_armor, 12.5);
  });

  it("HP ≤ 0 marks dead and emits rac_death", () => {
    const tgt = makeUnit({ id: "tgt", stats: { hp: 5, damage: 0, attack_rate: 1, range: 1, speed: 1, armor: 0 } });
    const src = makeUnit({ id: "src" });
    const content = makeBundle({ units: [tgt, src] });
    const state = emptyState();
    const sRow = addRac(state, content, { unitId: "src", owner: 0 });
    const tRow = addRac(state, content, { unitId: "tgt", owner: 1 });
    const log = makeLogger(state);

    applyRacDamage(state, content, log, sRow, tRow, 10);
    assert.equal(state.rac.alive[tRow], 0);
    const deaths = eventsOf(eventsFrom(log), "rac_death");
    assert.equal(deaths.length, 1);
    assert.equal(deaths[0].rac_id, state.rac.id[tRow]);
    assert.equal(deaths[0].last_hit_by, state.rac.id[sRow]);
  });

  it("combat fires only when target in range", () => {
    // Asymmetric ranges: attacker has range=2, dummy has range=0 so the
    // dummy never counter-attacks regardless of distance. Lets us count
    // attacker's swings cleanly.
    const attacker = makeUnit({
      id: "atk",
      stats: { hp: 50, damage: 10, attack_rate: 1, range: 2, speed: 0, armor: 0 },
    });
    const dummy = makeUnit({
      id: "dummy",
      stats: { hp: 1000, damage: 0, attack_rate: 1, range: 0, speed: 0, armor: 0 },
    });
    const content = makeBundle({ units: [attacker, dummy] });

    // Out of range: 5m apart, attacker range 2.
    {
      const state = emptyState();
      addRac(state, content, { unitId: "atk", owner: 0, x: 0, y: 0 });
      addRac(state, content, { unitId: "dummy", owner: 1, x: 5, y: 0 });
      const log = makeLogger(state);
      combatTick(state, content, log);
      assert.equal(eventsOf(eventsFrom(log), "rac_attack").length, 0, "no attack out of range");
    }
    // In range: 1m apart.
    {
      const state = emptyState();
      addRac(state, content, { unitId: "atk", owner: 0, x: 0, y: 0 });
      addRac(state, content, { unitId: "dummy", owner: 1, x: 1, y: 0 });
      const log = makeLogger(state);
      combatTick(state, content, log);
      assert.equal(eventsOf(eventsFrom(log), "rac_attack").length, 1, "one attack in range");
    }
  });

  it("attack cooldown prevents back-to-back fires", () => {
    // Attacker has range=5 and fires; the dummy target has range=0 so
    // it never counter-attacks (otherwise the count would include the
    // target's swing back).
    const attacker = makeUnit({
      id: "atk",
      stats: { hp: 50, damage: 10, attack_rate: 1, range: 5, speed: 0, armor: 0 },
    });
    const dummy = makeUnit({
      id: "dummy",
      stats: { hp: 1000, damage: 0, attack_rate: 1, range: 0, speed: 0, armor: 0 },
    });
    const content = makeBundle({ units: [attacker, dummy] });
    const state = emptyState();
    const a = addRac(state, content, { unitId: "atk", owner: 0, x: 0, y: 0 });
    addRac(state, content, { unitId: "dummy", owner: 1, x: 1, y: 0 });
    state.rac.targetKind[a] = TARGET_KIND_RAC;
    state.rac.targetId[a] = state.rac.id[1];
    const log = makeLogger(state);

    for (let t = 1; t <= 10; t++) {
      state.tick = t;
      combatTick(state, content, log);
    }
    // attack_rate=1 → cooldown 1s = 15 ticks. In 10 ticks we should
    // see exactly 1 attack (the first one); cooldown blocks the rest.
    const attacks = eventsOf(eventsFrom(log), "rac_attack");
    assert.equal(attacks.length, 1, `expected 1 attack, got ${attacks.length}`);
  });

  it("gainRage clamps to capacity", () => {
    const u = makeUnit({ id: "u", rage: { capacity: 50, attack: { shape: "single-target", damage: 0, range: 0 } } });
    const content = makeBundle({ units: [u] });
    const state = emptyState();
    const r = addRac(state, content, { unitId: "u", owner: 0 });
    gainRage(state, r, 30);
    assert.equal(state.rac.rage[r], 30);
    gainRage(state, r, 30);
    assert.equal(state.rac.rage[r], 50);
    gainRage(state, r, 100);
    assert.equal(state.rac.rage[r], 50);
  });

  it("markRacDead is idempotent", () => {
    const u = makeUnit({ id: "u" });
    const content = makeBundle({ units: [u] });
    const state = emptyState();
    const r = addRac(state, content, { unitId: "u", owner: 0 });
    const log = makeLogger(state);
    markRacDead(state, content, log, r, -1);
    markRacDead(state, content, log, r, -1);
    const deaths = eventsOf(eventsFrom(log), "rac_death");
    assert.equal(deaths.length, 1, "double-death should not double-emit");
  });
});
