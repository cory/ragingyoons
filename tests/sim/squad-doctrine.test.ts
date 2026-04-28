/**
 * Doctrine tier-size override pathway: a phalanx-doctrine unit
 * (suburban + barbarians infantry) should spawn as ONE big cohesive
 * 48-rac squad in setupShapeBattle, not as four 12-rac sub-squads.
 *
 * Regression: when DoctrineDef.tierSizes was added, only setupShapeBattle
 * was wired. This pins that the wiring is live so future refactors of
 * `squadSizeFor` or the spawn loop don't silently fall back to role
 * defaults.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { setupShapeBattle } from "../../src/sim/state.js";
import { DOCTRINES, doctrineFor, squadSizeFor } from "../../src/sim/doctrines.js";
import { makeBundle, makeUnit } from "../helpers/builders.js";

describe("squad sizing: doctrine override beats role default", () => {
  it("phalanx (suburban+barbarians) infantry gets squadSize=48, not 12", () => {
    const phalanx = DOCTRINES.find((d) => d.id === "phalanx")!;
    assert.equal(squadSizeFor("infantry", phalanx), 48);
    // sanity: doctrineFor maps suburban+barbarians → phalanx.
    assert.equal(doctrineFor("suburban", "barbarians"), "phalanx");
  });

  it("setupShapeBattle on a phalanx unit spawns one 48-rac squad, not four 12-rac squads", () => {
    const fence = makeUnit({
      id: "fence",
      role: "infantry",
      environment: "suburban",
      curiosity: "barbarians",
      stats: { hp: 50, damage: 5, attack_rate: 1, range: 1, speed: 2, armor: 0 },
    });
    const dummy = makeUnit({ id: "dummy", role: "infantry" });
    const content = makeBundle({ units: [fence, dummy] });
    const state = setupShapeBattle(content, {
      seed: 1,
      battleId: "t",
      bounds: { w: 200, h: 100 },
      unitId: "fence",
      count: 48,
      enemyBinUnitId: "dummy",
      // Lab default platoon size is small (20) — auto-bump should
      // raise it to squadSize=48 so we get one cohesive block.
      maxPlatoonSize: 20,
    });
    // Count distinct squads among alive racs.
    const squadIds = new Set<number>();
    for (let i = 0; i < state.rac.count; i++) {
      if (!state.rac.alive[i]) continue;
      squadIds.add(state.rac.squadId[i]);
    }
    assert.equal(squadIds.size, 1, `expected 1 squad of 48, got ${squadIds.size}`);
    assert.equal(state.rac.count, 48);
  });

  it("default-doctrine infantry gets role-default squadSize=12", () => {
    const u = makeUnit({
      id: "u",
      role: "infantry",
      // city + barbarians → no DOCTRINE_BY_ENV_CUR entry → "default"
      environment: "city",
      curiosity: "barbarians",
    });
    const dummy = makeUnit({ id: "dummy", role: "infantry" });
    const content = makeBundle({ units: [u, dummy] });
    const state = setupShapeBattle(content, {
      seed: 1,
      battleId: "t",
      bounds: { w: 200, h: 100 },
      unitId: "u",
      count: 24,
      enemyBinUnitId: "dummy",
      maxPlatoonSize: 50,
    });
    const squadIds = new Set<number>();
    for (let i = 0; i < state.rac.count; i++) {
      if (!state.rac.alive[i]) continue;
      squadIds.add(state.rac.squadId[i]);
    }
    assert.equal(squadIds.size, 2, `expected 2 squads of 12, got ${squadIds.size}`);
  });
});
