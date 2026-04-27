/**
 * Stuck/oscillation detection.
 *
 * Long-standing pathology: under various boid + formation + doctrine
 * combinations, individual racs can end up "vibrating" — bouncing
 * around in a small area without making net progress, even when
 * they have a clear distant target. This is hard to spot in a battle
 * log (the unit IS moving every tick) but easy to spot from a path
 * trace: high path length, low displacement.
 *
 * For each formation we run a short march scenario (one bin's worth
 * of units, dummy enemy at a distance), trace each rac's positions
 * tick-by-tick, and assert that no unit oscillates significantly.
 *
 *   path_length = sum of |dx,dy| between consecutive ticks
 *   displacement = |final − initial|
 *   ratio = displacement / path_length  ∈ (0, 1]
 *
 * 1.0 = perfectly straight march. 0.0 = pure oscillation. We require
 * each unit's ratio > MIN_RATIO when its path length exceeds
 * MIN_PATH_LENGTH (so genuinely-idle units don't false-positive).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CURIOSITY_TO_IDX,
  ENV_TO_IDX,
  ROLE_TO_IDX,
  type ContentBundle,
  type UnitDef,
} from "../../src/sim/content.js";
import {
  DEFAULT_FORMATION_BY_ROLE,
  FORMATIONS,
  FORMATION_TO_IDX,
  type FormationId,
} from "../../src/sim/formations.js";
import {
  DOCTRINE_TO_IDX,
  doctrineFor,
  teamSizeFor,
} from "../../src/sim/doctrines.js";
import { TARGET_KIND_RAC, type BattleState } from "../../src/sim/state.js";
import { tick } from "../../src/sim/index.js";
import { addRac, emptyState, makeBundle, makeLogger, makeUnit } from "../helpers/builders.js";

/** Run a one-bin-worth-of-units formation against a dummy enemy at
 *  given distance, for `ticks`. Returns each alive rac's path. */
function tracePaths(
  state: BattleState,
  content: ContentBundle,
  ticks: number,
): { positions: Array<Array<[number, number]>>; ids: number[] } {
  const log = makeLogger(state);
  const positions: Array<Array<[number, number]>> = [];
  const ids: number[] = [];
  for (let i = 0; i < state.rac.count; i++) {
    if (!state.rac.alive[i]) continue;
    if (state.rac.owner[i] !== 0) continue; // only our side
    positions.push([[state.rac.x[i], state.rac.y[i]]]);
    ids.push(state.rac.id[i]);
  }
  for (let t = 0; t < ticks; t++) {
    state.tick = t + 1;
    tick(state, content, log);
    for (let p = 0; p < ids.length; p++) {
      const id = ids[p];
      const row = state.racRowById.get(id);
      if (row === undefined || !state.rac.alive[row]) {
        positions[p].push(positions[p][positions[p].length - 1]);
        continue;
      }
      positions[p].push([state.rac.x[row], state.rac.y[row]]);
    }
  }
  return { positions, ids };
}

interface OscReport {
  unitIdx: number;
  pathLength: number;
  displacement: number;
  ratio: number;
}

function computeOscillation(positions: Array<[number, number]>): OscReport {
  let pathLength = 0;
  for (let i = 1; i < positions.length; i++) {
    const dx = positions[i][0] - positions[i - 1][0];
    const dy = positions[i][1] - positions[i - 1][1];
    pathLength += Math.hypot(dx, dy);
  }
  const dx = positions[positions.length - 1][0] - positions[0][0];
  const dy = positions[positions.length - 1][1] - positions[0][1];
  const displacement = Math.hypot(dx, dy);
  const ratio = pathLength > 0 ? displacement / pathLength : 1;
  return { unitIdx: -1, pathLength, displacement, ratio };
}

const MIN_RATIO = 0.4;
const MIN_PATH_FOR_CHECK = 6.0; // m — units that barely moved are not "stuck", they're just idle

interface StuckScenario {
  name: string;
  unitFactory: () => UnitDef;
  /** Formation override; if null, use the role's default. */
  formationId: FormationId | null;
  ticks: number;
  /** Distance from spawned units to dummy target (positive x = toward enemy). */
  targetDistance: number;
}

function buildScenarios(): StuckScenario[] {
  return [
    {
      name: "infantry-line march",
      unitFactory: () =>
        makeUnit({
          id: "inf",
          role: "infantry",
          environment: "city",
          curiosity: "farmers",
          stats: { hp: 60, damage: 8, attack_rate: 1, range: 1, speed: 8, armor: 0 },
        }),
      formationId: "infantry-line",
      ticks: 45,
      targetDistance: 60,
    },
    {
      name: "infantry-phalanx march",
      unitFactory: () =>
        makeUnit({
          id: "inf",
          role: "infantry",
          environment: "suburban",
          curiosity: "barbarians",
          stats: { hp: 60, damage: 8, attack_rate: 1, range: 1, speed: 8, armor: 0 },
        }),
      formationId: "infantry-phalanx",
      ticks: 45,
      targetDistance: 60,
    },
    {
      name: "tank-line march",
      unitFactory: () =>
        makeUnit({
          id: "tank",
          role: "tank",
          environment: "suburban",
          curiosity: "barbarians",
          stats: { hp: 200, damage: 12, attack_rate: 1, range: 1.5, speed: 6, armor: 2 },
        }),
      formationId: "tank-line",
      ticks: 45,
      targetDistance: 60,
    },
    {
      name: "cavalry-loose-deuce charge",
      unitFactory: () =>
        makeUnit({
          id: "cav",
          role: "cavalry",
          environment: "city",
          curiosity: "farmers",
          stats: { hp: 80, damage: 10, attack_rate: 1, range: 1, speed: 14, armor: 0 },
        }),
      formationId: "cavalry-loose-deuce",
      ticks: 30,
      targetDistance: 60,
    },
    {
      name: "cavalry-lone-gunmen charge",
      unitFactory: () =>
        makeUnit({
          id: "cav",
          role: "cavalry",
          environment: "park",
          curiosity: "lockpickers",
          stats: { hp: 80, damage: 10, attack_rate: 1, range: 1, speed: 14, armor: 0 },
        }),
      formationId: "cavalry-lone-gunmen",
      ticks: 30,
      targetDistance: 60,
    },
    {
      name: "archer-two-line approach (target far enough to advance)",
      unitFactory: () =>
        makeUnit({
          id: "arc",
          role: "archer",
          environment: "city",
          curiosity: "farmers",
          stats: { hp: 35, damage: 9, attack_rate: 1, range: 35, speed: 8, armor: 0 },
        }),
      formationId: "archer-two-line",
      ticks: 45,
      targetDistance: 100, // far enough that they advance toward kite range
    },
  ];
}

describe("stuck detection: no oscillation under formation + doctrine", () => {
  for (const sc of buildScenarios()) {
    it(sc.name, () => {
      const unit = sc.unitFactory();
      // Dummy target unit (immortal, infinite HP).
      const dummy = makeUnit({
        id: "dummy",
        role: "tank",
        stats: { hp: 1, damage: 1, attack_rate: 1, range: 1, speed: 0, armor: 0 },
      });
      const content = makeBundle({ units: [unit, dummy] });
      const state = emptyState({ seed: 42, bounds: { w: 200, h: 200 } });
      // Resolve formation index.
      const fid = sc.formationId ?? DEFAULT_FORMATION_BY_ROLE[unit.role];
      const fIdx = FORMATION_TO_IDX[fid];
      const def = FORMATIONS[fIdx];
      const burst = unit.bin.spawn_burst ?? [2, 5, 5, 10][ROLE_TO_IDX[unit.role]];
      // Doctrine + team
      const docId = doctrineFor(unit.environment, unit.curiosity);
      const docIdx = DOCTRINE_TO_IDX[docId];
      const teamSize = teamSizeFor(docIdx);
      // Place units in formation arrangement on the LEFT (-x), target on the RIGHT (+x)
      // so they advance toward +x. forward = +1 means enemy is to +x.
      const baseX = -sc.targetDistance / 2;
      void ENV_TO_IDX;
      void CURIOSITY_TO_IDX;
      for (let k = 0; k < burst; k++) {
        const off = def.arrange({ burstIdx: k, burstSize: burst, forward: 1 });
        const slot = addRac(state, content, {
          unitId: unit.id,
          owner: 0,
          x: baseX + off.dx,
          y: off.dy,
        });
        state.rac.formationIdx[slot] = fIdx;
        state.rac.doctrineIdx[slot] = docIdx;
        state.rac.teamId[slot] = Math.floor(k / teamSize);
      }
      // Static dummy target on the +x side.
      const dRow = addRac(state, content, {
        unitId: "dummy",
        owner: 1,
        x: sc.targetDistance / 2,
        y: 0,
      });
      state.rac.hp[dRow] = 1e9;
      state.rac.hpMax[dRow] = 1e9;
      // All our units target the dummy.
      const dummyId = state.rac.id[dRow];
      for (let i = 0; i < state.rac.count; i++) {
        if (i === dRow) continue;
        state.rac.targetId[i] = dummyId;
        state.rac.targetKind[i] = TARGET_KIND_RAC;
      }
      // Run + trace
      const { positions } = tracePaths(state, content, sc.ticks);
      // Check oscillation per unit
      const failures: string[] = [];
      for (let p = 0; p < positions.length; p++) {
        const r = computeOscillation(positions[p]);
        // Only flag oscillation when path length is non-trivial.
        // Idle units (path < MIN_PATH_FOR_CHECK) don't count as stuck.
        if (r.pathLength < MIN_PATH_FOR_CHECK) continue;
        if (r.ratio < MIN_RATIO) {
          failures.push(
            `unit ${p}: pathLen=${r.pathLength.toFixed(1)} disp=${r.displacement.toFixed(1)} ratio=${r.ratio.toFixed(2)}`,
          );
        }
      }
      assert.equal(
        failures.length,
        0,
        `${failures.length}/${positions.length} units oscillating in ${sc.name}:\n  ${failures.slice(0, 5).join("\n  ")}`,
      );
    });
  }
});
