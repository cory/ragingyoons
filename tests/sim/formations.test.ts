/**
 * Formation tests: spawn arrangement and tactic-override application.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FORMATION_BY_ROLE,
  FORMATIONS,
  FORMATION_TO_IDX,
  getFormation,
  isValidFormationId,
} from "../../src/sim/formations.js";

describe("formations: registry", () => {
  it("has at least one formation per role", () => {
    const byRole = new Set(FORMATIONS.map((f) => f.role));
    for (const role of ["tank", "archer", "cavalry", "infantry"] as const) {
      assert.ok(byRole.has(role), `missing formation for role ${role}`);
    }
  });

  it("default formation per role exists in registry", () => {
    for (const role of ["tank", "archer", "cavalry", "infantry"] as const) {
      const fid = DEFAULT_FORMATION_BY_ROLE[role];
      const f = getFormation(fid);
      assert.equal(f.role, role, `default formation ${fid} doesn't match role ${role}`);
    }
  });

  it("FORMATION_TO_IDX is bijective", () => {
    for (let i = 0; i < FORMATIONS.length; i++) {
      assert.equal(FORMATION_TO_IDX[FORMATIONS[i].id], i);
    }
  });

  it("isValidFormationId accepts known ids", () => {
    assert.ok(isValidFormationId("infantry-phalanx"));
    assert.ok(isValidFormationId("cavalry-lone-gunmen"));
    assert.ok(!isValidFormationId("nope"));
  });
});

describe("formations: arrange functions produce sensible shapes", () => {
  it("infantry-line spreads units perpendicular to forward", () => {
    const f = getFormation("infantry-line");
    const positions: Array<[number, number]> = [];
    for (let i = 0; i < 10; i++) {
      const off = f.arrange({ burstIdx: i, burstSize: 10, forward: -1 });
      positions.push([off.dx, off.dy]);
    }
    // dx should all be ~0 (line is purely lateral).
    for (const [dx] of positions) assert.ok(Math.abs(dx) < 0.01, `line shouldn't have dx`);
    // dy should span a range.
    const dys = positions.map(([, dy]) => dy);
    const span = Math.max(...dys) - Math.min(...dys);
    assert.ok(span > 5, `line should span >5m; got ${span.toFixed(1)}`);
  });

  it("infantry-phalanx is tight (low pair distance)", () => {
    const f = getFormation("infantry-phalanx");
    const pos: Array<[number, number]> = [];
    for (let i = 0; i < 10; i++) {
      const off = f.arrange({ burstIdx: i, burstSize: 10, forward: -1 });
      pos.push([off.dx, off.dy]);
    }
    let maxD = 0;
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const dx = pos[i][0] - pos[j][0];
        const dy = pos[i][1] - pos[j][1];
        const d = Math.hypot(dx, dy);
        if (d > maxD) maxD = d;
      }
    }
    assert.ok(maxD < 5, `phalanx should be compact; max pair dist ${maxD.toFixed(1)}`);
  });

  it("cavalry-lone-gunmen is scattered (high pair distance)", () => {
    const f = getFormation("cavalry-lone-gunmen");
    const pos: Array<[number, number]> = [];
    for (let i = 0; i < 5; i++) {
      const off = f.arrange({ burstIdx: i, burstSize: 5, forward: -1 });
      pos.push([off.dx, off.dy]);
    }
    let sum = 0;
    let count = 0;
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        sum += Math.hypot(pos[i][0] - pos[j][0], pos[i][1] - pos[j][1]);
        count += 1;
      }
    }
    const meanPair = sum / count;
    assert.ok(meanPair > 5, `lone gunmen should be spread; mean pair ${meanPair.toFixed(1)}`);
  });

  it("tank-arrowhead places apex toward enemy (forward direction)", () => {
    const f = getFormation("tank-arrowhead");
    const apex = f.arrange({ burstIdx: 0, burstSize: 2, forward: -1 });
    // forward = -1 means enemy is at -x; apex should have dx < 0.
    assert.ok(apex.dx < 0, `arrowhead apex should be forward; got dx=${apex.dx}`);
    const apexFlipped = f.arrange({ burstIdx: 0, burstSize: 2, forward: +1 });
    assert.ok(apexFlipped.dx > 0, `arrowhead apex should mirror; got dx=${apexFlipped.dx}`);
  });
});

describe("formations: tactic overrides", () => {
  it("phalanx is slower than line", () => {
    const line = getFormation("infantry-line");
    const phalanx = getFormation("infantry-phalanx");
    const phSpeed = phalanx.tacticOverride.speedMul ?? 1;
    const lnSpeed = line.tacticOverride.speedMul ?? 1;
    assert.ok(phSpeed < lnSpeed, `phalanx should be slower; phalanx=${phSpeed} line=${lnSpeed}`);
  });

  it("sniper has wider hideStandoff than two-line", () => {
    const sniper = getFormation("archer-sniper");
    const twoLine = getFormation("archer-two-line");
    const sStandoff = sniper.tacticOverride.hideStandoff ?? 0;
    const tStandoff = twoLine.tacticOverride.hideStandoff ?? 0;
    assert.ok(sStandoff > tStandoff, `sniper standoff > two-line; sniper=${sStandoff} two-line=${tStandoff}`);
  });

  it("lone-gunmen has higher seek than loose-deuce", () => {
    const lone = getFormation("cavalry-lone-gunmen");
    const loose = getFormation("cavalry-loose-deuce");
    const lSeek = lone.tacticOverride.targetSeekK ?? 0;
    const dSeek = loose.tacticOverride.targetSeekK ?? 0;
    assert.ok(lSeek > dSeek || dSeek === 0, `lone should commit harder than loose-deuce`);
  });
});
