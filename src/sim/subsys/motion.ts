/**
 * Combat 2.0 motion: behavior-state-machine steering. Replaces the
 * force pipeline with explicit per-rac behavior states, each producing
 * a single motion intent (a velocity vector). Two global guards modify
 * the intent: close-range anti-overlap, cross-unit repulsion. Position
 * + facing + bounds clamp follow.
 *
 * Slice 1 states:
 *   MARCH   — infantry follower: aim at leader + slot. Else: aim at
 *             world target.
 *   ENGAGE  — close to attack range, then hold (vel ≈ 0). Combat
 *             handles damage.
 *   ROUT    — flee from nearest enemy at ROUT_SPEED_MUL × maxV.
 *
 * Decisions are re-evaluated only when state.tick crosses
 * state.rac.nextDecisionTick[i]. Cadence per role
 * (BEHAVIOR_CADENCE_BY_ROLE) — cavalry re-decides every tick, archers
 * every ~2 s. Between decisions the rac keeps its current behavior.
 *
 * Things this file deliberately does NOT do (vs the old boid pipeline):
 *   - No force composition. Each behavior produces a velocity, not a
 *     force to be summed.
 *   - No alignment / hide-behind / swarm-avoid forces. Future
 *     behaviors (kite, flank, rally) cover those use-cases as states.
 *   - No envelopment slot multiplication. March in slot is a clean
 *     leader-relative intent.
 *   - No catchup speed, no gates, no reshape pauses. Behavior state
 *     IS the gate.
 */

import type { ContentBundle } from "../content.js";
import { ROLE_ARCHER, ROLE_CAVALRY, ROLE_INFANTRY, ROLE_TANK } from "../content.js";
import {
  STANDING_ORDER_IDX_CHARGE,
  STANDING_ORDER_IDX_HOLD,
  STANDING_ORDER_IDX_SKIRMISH,
  STANDING_ORDER_IDX_SLOW,
} from "../doctrines.js";
import { allocBoidFields, buildBoidFields, sampleField } from "../fields.js";
import { forEachNear } from "../grid.js";
import type { Logger } from "../log.js";
import {
  BEHAVIOR_CADENCE_BY_ROLE,
  BEHAVIOR_ENGAGE,
  BEHAVIOR_FLANK,
  BEHAVIOR_KITE,
  BEHAVIOR_MARCH,
  BEHAVIOR_RALLY,
  BEHAVIOR_ROUT,
  FLANK_DEBUG_FLOATS_PER_RAC,
  FLANK_DEBUG_OFFSET,
  MAX_ACCEL_BY_ROLE,
  MORALE_BREAK_THRESHOLD,
  MORALE_BREAK_THRESHOLD_BY_ENV,
  PIN_SPEED_MUL,
  RALLY_RADIUS,
  ROUT_SPEED_MUL,
  SECONDS_PER_TICK,
  TARGET_KIND_BIN,
  TARGET_KIND_RAC,
  type BattleState,
  findBinRowById,
  findRacRowById,
} from "../state.js";

/** Distance from this rac to its leader+slot at which we still
 *  consider it "in formation" for the combat bonus. The march intent
 *  keeps a follower well within this radius under normal conditions;
 *  a rac knocked outside it has lost formation cohesion at that spot
 *  and shouldn't claim the frontal-defense bonus anymore. */
const IN_FORMATION_R = 2.0;
/** If a follower's distance to its slot exceeds this radius, the
 *  formation is "shattered" for that rac and slot-direct steering
 *  shuts off — the rac falls back to independent MARCH/ENGAGE.
 *  Trying to reform after a deep dispersal pulled racs through enemy
 *  lines and re-fed the blob (the user-visible bug: "once a formation
 *  shatters we shouldn't try to reform"). 8 m ≈ 4 body-widths — past
 *  this the slot-as-attractor isn't really part of the formation. */
const FORMATION_SHATTER_R = 8.0;
const FORMATION_SHATTER_R2 = FORMATION_SHATTER_R * FORMATION_SHATTER_R;
/** Max angular rotation rate of a leader's facing (radians per second).
 *  Leader.facing drives the wheel rotation matrix for every follower's
 *  slot offset, so a fast facing change pivots the whole formation —
 *  retargeting to a slightly off-axis enemy was rotating phalanxes
 *  diagonally across the field. ~30°/s feels weighty but still lets
 *  formations turn to face a flank attack inside ~6 s. */
const LEADER_TURN_RATE = Math.PI / 6; // 30°/s
/** Distance a panicked rac flees from its nearest enemy before
 *  arriving and standing still while it recovers morale. Bigger than
 *  any unit's attack range (longest is archer ~10–12 m) so a fleeing
 *  rac actually gets out of harm's way and recovers. */
const FLEE_DIST = 30.0;
/** Radius the panicked rac scans for "nearest enemy". A rac whose
 *  enemies have all moved past this radius is by definition no longer
 *  in trouble; aim falls back to the friendly-bin defense path. */
const FLEE_ENEMY_SCAN_R = 50.0;

/** Arrival deadband for RALLY/ROUT: once a routed/rallying rac is
 *  within this radius of its aim point (leader / friendly bin), it
 *  stops seeking and lets the cross-unit repulsion settle it into
 *  a ring. Without the deadband the seek force at maxV plows every
 *  rac into the same pixel, the gentle ~1 m/s repulsion can't
 *  overcome it, and the squad collapses into a blob.
 *
 *  Per-role: cavalry has the smallest separationRadius (0.6 m) and
 *  highest speed, so a 4 m deadband still packs them tight (the
 *  user's "wounded cavalry clump" report). A wider deadband gives
 *  the cross-unit repulsion enough room to space them naturally. */
const RALLY_ARRIVAL_R_DEFAULT = 4.0;
const RALLY_ARRIVAL_R_CAVALRY = 12.0;
const ROUT_ARRIVAL_R_DEFAULT = 6.0;
const ROUT_ARRIVAL_R_CAVALRY = 14.0;
/** How often to recompute the inFormation flag. Drives a damage
 *  multiplier in combat; combat fires at 1+ Hz so this can be
 *  refreshed every 4 ticks (~165 ms) without missing combat events. */
const IN_FORMATION_CHECK_TICKS = 4;
/** Close-range pairwise anti-overlap radius. Keeps physical bodies
 *  from occupying the same point. Same value as the old boid loop. */
const CLOSE_R = 0.8;
const CLOSE_R2 = CLOSE_R * CLOSE_R;
const CLOSE_K = 10.0;
/** Cross-unit repulsion: same-side, different-squad neighbors push
 *  each other apart so adjacent friendly squads don't merge. */
const CROSS_UNIT_R = 1.5;
const CROSS_UNIT_R2 = CROSS_UNIT_R * CROSS_UNIT_R;
const CROSS_UNIT_K = 3.0;
/** Contact-mode flag radius — any enemy within this m sets contact[i]=1.
 *  Used by combat (phalanx anti-cav recoil, shield-vs-projectile) and
 *  formation-tightening overrides. */
/** Threshold on the SUM of enemy-side density across a 5×5 cell
 *  window (8 m reach with 4 m cells) for "in contact" classification.
 *  Hysteresis: SET threshold to enter contact mode, CLEAR threshold
 *  (lower) to leave. Without hysteresis the flag flickered at the
 *  boundary as enemies drifted around the threshold each tick — the
 *  leader's MARCH halt also flickered, producing a visible wiggle.
 *  Once a rac's contact mode is set, density has to drop well below
 *  the SET threshold before the rac un-engages. */
const CONTACT_DENSITY_SET = 0.5;
const CONTACT_DENSITY_CLEAR = 0.15;
/** Engage band: a rac in engage state holds position when within
 *  effRange. This wider band (effRange × this) is the stop-to-attack
 *  trigger — once you're inside it you're fighting. */
const ENGAGE_BAND_MUL = 1.0;
/** Cavalry overrun distance: in engage, cavalry aims this far PAST
 *  the target so they ride through melee at speed. Combat fires as
 *  they pass; they keep going to the next target instead of stopping. */
const CAVALRY_OVERSHOOT = 8;
/** Archer kite trigger: enter KITE when target distance ≤
 *  effRange × this. Wider than effRange so archers start back-pedaling
 *  while a tank is still closing, not after the tank is already
 *  point-blank. */
const ARCHER_KITE_TRIGGER_MUL = 1.5;
/** Kite deadband — within ±10% of preferred kite distance, the archer
 *  settles instead of jittering across the boundary every tick. */
const KITE_DEADBAND = 0.1;
/** Cavalry flank lookaheads (meters). Multiple distances so a long
 *  approach detects the wall while cavalry still has time to redirect.
 *  Cavalry inertia (blend 0.5) + 4.5 m/s² accel cap means a full-
 *  speed charge needs ~10 m to swap heading; sampling out to 32 m
 *  gives ~3× that headroom. We trigger if ANY probe exceeds the
 *  threshold, which means a thin line shows up at the far probe and
 *  a thick block trips the near probe. */
const FLANK_LOOKAHEADS: readonly number[] = [10, 20, 32];
/** Enemy density threshold (per-side density field) above which any
 *  lookahead probe triggers FLANK. Lower than before so a single
 *  rank of infantry counts as a wall. */
const FLANK_BLOCKED_DENSITY = 0.2;
/** Local-pin threshold: enemy density AT THE CAVALRY POSITION above
 *  which we're already in the brawl. */
const FLANK_PINNED_DENSITY = 0.2;
/** Step size for the density-gradient finite difference (meters).
 *  One cell = 4 m, so half a cell is enough resolution. */
const FLANK_GRAD_H = 2;
/** Edge-finding probe step (meters). Walks perpendicular to the
 *  density gradient in this increment until density drops past the
 *  edge threshold. One field cell = 4 m, so this samples ~one cell
 *  per step. */
const FLANK_PROBE_STEP = 4;
/** Density below which we treat the lateral probe point as PAST the
 *  enemy formation edge. Lower than FLANK_PINNED_DENSITY so we don't
 *  exit FLANK while still partially in the line. */
const FLANK_EDGE_DENSITY = 0.05;
/** Max edge-probe steps. Caps the lateral search so cavalry doesn't
 *  aim 200 m sideways when no edge is found nearby. */
const FLANK_MAX_STEPS = 8;

/** Compute a predicted target position for a chasing rac so multiple
 *  pack-mates aiming at the same target spread across both intercept
 *  TIMES (along the target's velocity) and intercept ANGLES (lateral
 *  offset perpendicular to that velocity). Two independent buckets
 *  drawn from one hash:
 *   - time:   one of HERD_TIME_BUCKETS lookaheads at HERD_TIME_STEP s
 *             apart. Spans 0 → HERD_TIME_BUCKETS × HERD_TIME_STEP s.
 *   - perp:   one of HERD_PERP_BUCKETS lateral offsets, centered on 0.
 *             Spans ±HERD_PERP_RANGE m off the target's velocity axis.
 *  With 8 × 5 = 40 unique combinations, even a 16-rac cavalry squad
 *  hashes to mostly distinct intercept points. Stationary targets
 *  collapse the time component but keep a small lateral spread so
 *  pack-mates surround a still target instead of stacking on it. */
function herdAimPoint(
  state: BattleState,
  attackerId: number,
  targetKind: number,
  targetRow: number,
): { x: number; y: number } {
  if (targetKind === TARGET_KIND_BIN) {
    return { x: state.bin.x[targetRow], y: state.bin.y[targetRow] };
  }
  const tx = state.rac.x[targetRow];
  const ty = state.rac.y[targetRow];
  const tvx = state.rac.vx[targetRow];
  const tvy = state.rac.vy[targetRow];
  const tid = state.rac.id[targetRow];
  const HERD_TIME_BUCKETS = 8;
  const HERD_TIME_STEP = 0.4;
  const HERD_PERP_BUCKETS = 5;
  const HERD_PERP_RANGE = 4;
  const hash = ((attackerId * 2654435761) ^ (tid * 0x9e3779b9)) >>> 0;
  const tBucket = hash % HERD_TIME_BUCKETS;
  const pBucket = (hash >>> 3) % HERD_PERP_BUCKETS;
  const t = tBucket * HERD_TIME_STEP;
  // Center the perp bucket so 0 is no offset, ±extremes spread out.
  const perp = ((pBucket - (HERD_PERP_BUCKETS - 1) * 0.5) /
    ((HERD_PERP_BUCKETS - 1) * 0.5)) * HERD_PERP_RANGE;
  // Perpendicular axis: rotated 90° from target velocity. For a
  // stationary target, fall back to a world-fixed axis so attackers
  // still spread laterally instead of all aiming at the same point.
  const tvSpeed = Math.hypot(tvx, tvy);
  let perpX = 0, perpY = 1;
  if (tvSpeed > 0.1) {
    perpX = -tvy / tvSpeed;
    perpY = tvx / tvSpeed;
  }
  return {
    x: tx + tvx * t + perpX * perp,
    y: ty + tvy * t + perpY * perp,
  };
}

/** Find the nearest alive friendly bin (any range). Returns row
 *  index or -1. Used as a fallback retreat target — broken / rally
 *  racs head back toward their own line instead of fleeing into
 *  empty space. */
/** Nearest alive enemy bin (any range). Used by leader facing — bins
 *  are static so the direction-to-bin barely changes as the squad
 *  marches forward, keeping leader facing stable. Falling back to
 *  per-tick enemy-rac target was producing ever-growing relative
 *  angles as the leader closed in (the diagonal-wheel bug). */
function findNearestEnemyBin(state: BattleState, i: number): number {
  const myOwner = state.rac.owner[i];
  const myX = state.rac.x[i];
  const myY = state.rac.y[i];
  let bestRow = -1;
  let bestD2 = Number.POSITIVE_INFINITY;
  for (let k = 0; k < state.bin.count; k++) {
    if (!state.bin.alive[k]) continue;
    if (state.bin.owner[k] === myOwner) continue;
    const dx = state.bin.x[k] - myX;
    const dy = state.bin.y[k] - myY;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestRow = k;
    }
  }
  return bestRow;
}

function findFriendlyBin(state: BattleState, i: number): number {
  const myOwner = state.rac.owner[i];
  const myX = state.rac.x[i];
  const myY = state.rac.y[i];
  // Prefer the rac's source bin if it's still alive — that's our
  // home base. Otherwise fall back to nearest alive friendly bin.
  const srcBinId = state.rac.sourceBinId[i];
  if (srcBinId >= 0 && srcBinId < state.binRowById.length) {
    const row = state.binRowById[srcBinId];
    if (row >= 0 && state.bin.alive[row] && state.bin.owner[row] === myOwner) {
      return row;
    }
  }
  let bestRow = -1;
  let bestD2 = Number.POSITIVE_INFINITY;
  for (let k = 0; k < state.bin.count; k++) {
    if (!state.bin.alive[k]) continue;
    if (state.bin.owner[k] !== myOwner) continue;
    const dx = state.bin.x[k] - myX;
    const dy = state.bin.y[k] - myY;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestRow = k;
    }
  }
  return bestRow;
}

/** Find the nearest alive ENEMY rac within FLEE_ENEMY_SCAN_R via the
 *  spatial grid. Returns row index or -1. Panicked racs flee from
 *  this rac's position so each broken rac picks its own scatter
 *  direction instead of converging on a shared rally point. */
function findNearestEnemy(state: BattleState, i: number): number {
  const grid = state._racGrid;
  if (!grid) return -1;
  const myOwner = state.rac.owner[i];
  const myX = state.rac.x[i];
  const myY = state.rac.y[i];
  let bestRow = -1;
  let bestD2 = FLEE_ENEMY_SCAN_R * FLEE_ENEMY_SCAN_R;
  forEachNear(grid, myX, myY, FLEE_ENEMY_SCAN_R, (j) => {
    if (j === i) return;
    if (!state.rac.alive[j]) return;
    if (state.rac.owner[j] === myOwner) return;
    const dx = state.rac.x[j] - myX;
    const dy = state.rac.y[j] - myY;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestRow = j;
    }
  });
  return bestRow;
}

/** Find the nearest alive friendly squad-leader anywhere on the map.
 *  Used by ROUT decision when no friendly bin remains — the rac
 *  retreats to whatever leader is left. Returns row or -1. Spatial
 *  grid scan with map-diagonal radius (so we still find leaders far
 *  away, but skip empty cells in between). */
function findRoutLeader(state: BattleState, i: number): number {
  const grid = state._racGrid;
  const myOwn = state.rac.owner[i];
  const myX = state.rac.x[i];
  const myY = state.rac.y[i];
  let bestRow = -1;
  let bestD2 = Number.POSITIVE_INFINITY;
  const consider = (j: number) => {
    if (j === i) return;
    if (!state.rac.alive[j]) return;
    if (state.rac.owner[j] !== myOwn) return;
    if (state.rac.squadLeaderId[j] !== state.rac.id[j]) return;
    const dx = state.rac.x[j] - myX;
    const dy = state.rac.y[j] - myY;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestRow = j;
    }
  };
  if (grid) {
    const r = Math.hypot(state.bounds.w, state.bounds.h);
    forEachNear(grid, myX, myY, r, consider);
  } else {
    for (let j = 0; j < state.rac.count; j++) consider(j);
  }
  return bestRow;
}

/** Find the nearest alive friendly squad-leader within RALLY_RADIUS,
 *  excluding self. Returns row index or -1. Used by the broken
 *  decision branch to choose between RALLY and ROUT. */
function findRallyLeader(state: BattleState, i: number): number {
  const grid = state._racGrid;
  if (!grid) return -1;
  const myOwner = state.rac.owner[i];
  const myRacId = state.rac.id[i];
  const myX = state.rac.x[i];
  const myY = state.rac.y[i];
  let bestRow = -1;
  let bestD2 = RALLY_RADIUS * RALLY_RADIUS;
  forEachNear(grid, myX, myY, RALLY_RADIUS, (j) => {
    if (j === i) return;
    if (!state.rac.alive[j]) return;
    if (state.rac.owner[j] !== myOwner) return;
    // Leader = squadLeaderId === own racId. Excludes followers.
    const leaderId = state.rac.squadLeaderId[j];
    if (leaderId !== state.rac.id[j]) return;
    if (leaderId === myRacId) return; // can't rally on self
    const dx = state.rac.x[j] - myX;
    const dy = state.rac.y[j] - myY;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestRow = j;
    }
  });
  return bestRow;
}

/** Should this cavalry rac flank? Two cases:
 *   1. PINNED: enemy density at cavalry's own position is high — it's
 *      already in the brawl, surrounded by line infantry, and needs
 *      to sweep out laterally rather than push deeper. This is the
 *      case the user reported ("smashes into the line and sticks").
 *   2. PATH BLOCKED: enemy density at lookahead is high while we're
 *      still some distance off — preemptively divert so we don't
 *      stick. Same threshold, just a different probe location.
 *  Either case → FLANK. */
function cavalryShouldFlank(
  state: BattleState,
  i: number,
  tgtX: number,
  tgtY: number,
  distToTarget: number,
): boolean {
  const fields = state._boidFields;
  if (!fields) return false;
  const enemyCh = state.rac.owner[i] === 0 ? 1 : 0;
  const myX = state.rac.x[i];
  const myY = state.rac.y[i];
  const localDens = sampleField(fields, fields.sideDensity[enemyCh], myX, myY);
  if (localDens > FLANK_PINNED_DENSITY) return true;
  if (distToTarget < 1e-3) return false;
  const sx = (tgtX - myX) / distToTarget;
  const sy = (tgtY - myY) / distToTarget;
  // Probe density at multiple distances so a far approach detects the
  // line early enough to redirect against cavalry inertia. Trip on
  // any probe exceeding threshold — first match wins. We keep
  // probing past the target distance because the front-rank target
  // is just one rac; the LINE is the rest of the formation behind it,
  // and we want to flank the line.
  for (const la of FLANK_LOOKAHEADS) {
    const probeX = myX + sx * la;
    const probeY = myY + sy * la;
    const dens = sampleField(fields, fields.sideDensity[enemyCh], probeX, probeY);
    if (dens > FLANK_BLOCKED_DENSITY) return true;
  }
  return false;
}

export function motionTick(state: BattleState, content: ContentBundle, log: Logger): void {
  void content;
  void log;
  const dt = SECONDS_PER_TICK;
  const halfW = state.bounds.w * 0.5;
  const halfH = state.bounds.h * 0.5;
  const tickNow = state.tick;
  const grid = state._racGrid;

  // Boid fields stay around for support-bonus and contact-mode lookups
  // (cheap, single-pass). Steering doesn't read them.
  if (!state._boidFields) {
    state._boidFields = allocBoidFields(state.bounds.w, state.bounds.h);
  }
  const fields = state._boidFields;
  buildBoidFields(state, fields);
  // Lab debug: clear last tick's flank-probe data so racs that exit
  // FLANK this tick read inFlank=0. Only allocated by the lab; in
  // headless sim runs (bench / mass tuning) this is null and we skip.
  const dbg = state._debugFlank ?? null;
  if (dbg) dbg.fill(0);

  // Pre-pass: cache (cos, sin) of each leader's wheel rotation. The
  // wheel rotates slot offsets by (leader.facing - spawnFacing), and
  // every follower of that leader needs the same matrix. Computing
  // once per leader rather than per follower turns 2 × n_followers
  // trig calls per tick into 2 × n_leaders.
  if (!state._leaderRotCos || state._leaderRotCos.length < state.rac.x.length) {
    state._leaderRotCos = new Float32Array(state.rac.x.length);
    state._leaderRotSin = new Float32Array(state.rac.x.length);
    state._leaderPreX = new Float32Array(state.rac.x.length);
    state._leaderPreY = new Float32Array(state.rac.x.length);
    state._leaderPreVx = new Float32Array(state.rac.x.length);
    state._leaderPreVy = new Float32Array(state.rac.x.length);
  }
  const leaderRotCos = state._leaderRotCos;
  const leaderRotSin = state._leaderRotSin!;
  const leaderPreX = state._leaderPreX!;
  const leaderPreY = state._leaderPreY!;
  const leaderRowArr = state.rac.leaderRow;
  // Combined pass: cache leader rotation (cos/sin) for each squad
  // leader, AND resolve every follower's leader row from squadLeaderId
  // → row. Followers in the main loop then read leaderRow[i] directly
  // instead of doing a per-tick findRacRowById Map lookup.
  for (let r = 0; r < state.rac.count; r++) {
    if (!state.rac.alive[r]) continue;
    const myRid = state.rac.id[r];
    const myLid = state.rac.squadLeaderId[r];
    if (myLid === myRid || myLid < 0) {
      // Leader (or unaffiliated). Cache its own rotation for any
      // follower lookups; mark its leaderRow as -1 (intent paths
      // gate on "isLeader" via squadLeaderId, not leaderRow).
      const spawnFacing = state.rac.owner[r] === 0 ? 0 : Math.PI;
      const dFace = state.rac.facing[r] - spawnFacing;
      leaderRotCos[r] = Math.cos(dFace);
      leaderRotSin[r] = Math.sin(dFace);
      leaderPreX[r] = state.rac.x[r];
      leaderPreY[r] = state.rac.y[r];
      leaderRowArr[r] = -1;
    } else {
      // Follower — resolve leader's row once per tick.
      leaderRowArr[r] = findRacRowById(state, myLid);
    }
  }

  for (let i = 0; i < state.rac.count; i++) {
    if (!state.rac.alive[i]) continue;

    // Sub-tick gate: stable racs (in-formation MARCH/ENGAGE follower
    // not broken) skip the full intent + guard pipeline on 3 out of 4
    // ticks, integrating last-tick velocity instead. Updates fire on
    // ticks where ((tick + i) & 3) === 0; lag is ~165 ms per check
    // window, fine for in-formation infantry holding a line. Cuts
    // motion cost ~4× on the stable subset.
    if (state.rac.stable[i] && ((tickNow + i) & 3) !== 0) {
      const myX0 = state.rac.x[i];
      const myY0 = state.rac.y[i];
      const myVx0 = state.rac.vx[i];
      const myVy0 = state.rac.vy[i];
      let nx = myX0 + myVx0 * dt;
      let ny = myY0 + myVy0 * dt;
      if (myX0 <= halfW && nx > halfW) {
        nx = halfW;
        state.rac.vx[i] = 0;
      } else if (myX0 >= -halfW && nx < -halfW) {
        nx = -halfW;
        state.rac.vx[i] = 0;
      }
      if (myY0 <= halfH && ny > halfH) {
        ny = halfH;
        state.rac.vy[i] = 0;
      } else if (myY0 >= -halfH && ny < -halfH) {
        ny = -halfH;
        state.rac.vy[i] = 0;
      }
      state.rac.x[i] = nx;
      state.rac.y[i] = ny;
      // Don't update facing or contact / inFormation / surroundedDamageMul
      // on a skipped tick — they roll over from the last full update.
      continue;
    }

    const role = state.rac.role[i];
    const myX = state.rac.x[i];
    const myY = state.rac.y[i];
    const myVx = state.rac.vx[i];
    const myVy = state.rac.vy[i];

    // Early per-rac context the decision + intent both need.
    const breakT =
      MORALE_BREAK_THRESHOLD_BY_ENV[state.rac.env[i]] ?? MORALE_BREAK_THRESHOLD;
    const broken = state.rac.morale[i] < breakT;
    const myRacId = state.rac.id[i];
    const myLeaderId = state.rac.squadLeaderId[i];
    const isLeader = myLeaderId === myRacId || myLeaderId < 0;
    const leaderRow = isLeader ? -1 : leaderRowArr[i];
    const leaderAlive = leaderRow >= 0;

    // Resolve current target position (used by both decision + intent).
    const tid = state.rac.targetId[i];
    const tkind = state.rac.targetKind[i];
    let tgtX = 0, tgtY = 0, tgtFound = false;
    if (tid >= 0 && tkind === TARGET_KIND_RAC) {
      const tRow = findRacRowById(state, tid);
      if (tRow >= 0) {
        tgtX = state.rac.x[tRow];
        tgtY = state.rac.y[tRow];
        tgtFound = true;
      }
    } else if (tid >= 0 && tkind === TARGET_KIND_BIN) {
      const tRow = findBinRowById(state, tid);
      if (tRow >= 0) {
        tgtX = state.bin.x[tRow];
        tgtY = state.bin.y[tRow];
        tgtFound = true;
      }
    }
    const distToTarget = tgtFound ? Math.hypot(tgtX - myX, tgtY - myY) : Number.POSITIVE_INFINITY;

    // Standing order — modulates the decision below. Stamped at
    // spawn from the rac's doctrine; doesn't change tick-to-tick.
    const order = state.rac.standingOrder[i];

    // ----- Behavior decision (cadence-gated) -----
    if (tickNow >= state.rac.nextDecisionTick[i]) {
      let next = state.rac.behavior[i];
      if (broken) {
        // Panicked scatter: every broken rac flees from its OWN
        // nearest enemy (set in the aim block below), so a hit squad
        // doesn't pile onto a single rally point. Rally-on-leader was
        // tried and produced a blob — too many broken racs converging
        // on the same coordinate. Now they spread apart and recover
        // morale once they're clear of enemy density (moraleTick).
        next = BEHAVIOR_ROUT;
      } else if (
        // CHARGE order skips FLANK detour — fanatics plow in.
        order !== STANDING_ORDER_IDX_CHARGE &&
        role === ROLE_CAVALRY &&
        tgtFound &&
        cavalryShouldFlank(state, i, tgtX, tgtY, distToTarget)
      ) {
        next = BEHAVIOR_FLANK;
      } else if (
        // SKIRMISH order makes ANY rac with a kite range prefer KITE.
        // Default: only archers kite. Skirmishers (incl non-archer
        // skirmisher-doctrine racs) back-pedal at engage range.
        (role === ROLE_ARCHER || order === STANDING_ORDER_IDX_SKIRMISH) &&
        tgtFound &&
        distToTarget <= state.rac.effRange[i] * ARCHER_KITE_TRIGGER_MUL
      ) {
        next = BEHAVIOR_KITE;
      } else if (
        tgtFound &&
        // CHARGE engages at 1.5× attack range — eager. Other orders
        // engage at the standard ENGAGE_BAND_MUL.
        distToTarget <=
          state.rac.effRange[i] *
            (order === STANDING_ORDER_IDX_CHARGE ? 1.5 : ENGAGE_BAND_MUL)
      ) {
        next = BEHAVIOR_ENGAGE;
      } else if (order === STANDING_ORDER_IDX_HOLD) {
        // HOLD: never march toward a distant target. Stay in MARCH
        // state but the intent below produces zero velocity since
        // we're outside engage range.
        next = BEHAVIOR_MARCH;
      } else {
        next = BEHAVIOR_MARCH;
      }
      state.rac.behavior[i] = next;
      // Cadence-gated aim refresh for ROUT: each broken rac picks its
      // OWN flee direction (away from its nearest enemy) and aims at a
      // point FLEE_DIST out along that vector. Per-rac directions =
      // panicked scatter, not a blob. If no enemy is reachable (e.g.
      // ally ROUT after wipe), fall back to nearest friendly bin so
      // they head somewhere useful instead of standing there.
      let aimValid = 0;
      let aimX = 0;
      let aimY = 0;
      if (next === BEHAVIOR_ROUT) {
        const enemyRow = findNearestEnemy(state, i);
        if (enemyRow >= 0) {
          const ex = state.rac.x[enemyRow];
          const ey = state.rac.y[enemyRow];
          const fdx = myX - ex;
          const fdy = myY - ey;
          const fd = Math.hypot(fdx, fdy);
          if (fd > 1e-3) {
            aimX = myX + (fdx / fd) * FLEE_DIST;
            aimY = myY + (fdy / fd) * FLEE_DIST;
            aimValid = 1;
          }
        }
        if (!aimValid) {
          // No nearby enemy to flee from — head to a friendly bin
          // (defensive fallback, e.g. last survivor or post-rout).
          const binRow = findFriendlyBin(state, i);
          if (binRow >= 0) {
            aimX = state.bin.x[binRow];
            aimY = state.bin.y[binRow];
            aimValid = 1;
          }
        }
      }
      state.rac.aimX[i] = aimX;
      state.rac.aimY[i] = aimY;
      state.rac.aimValid[i] = aimValid;
      const cadence = BEHAVIOR_CADENCE_BY_ROLE[role] ?? 8;
      state.rac.nextDecisionTick[i] = tickNow + Math.max(1, cadence);
    }
    const behavior = state.rac.behavior[i];

    // ----- Compute motion intent -----
    // Profile lookup uses the previous tick's contact flag — stale by
    // one tick, but contact only changes when an enemy crosses the 8m
    // boundary, so a frame of lag is fine and avoids the chicken-and-
    // egg with the guard scan that updates contact this tick.
    const profile = state.rac.contact[i]
      ? state.formationContactProfile[state.rac.owner[i]][state.rac.formationIdx[i]]
      : state.formationProfile[state.rac.owner[i]][state.rac.formationIdx[i]];
    let desiredVx = 0;
    let desiredVy = 0;
    // Tank pin: a rac that was hit by a tank in melee in the last
    // ~2 s gets its max speed cut to PIN_SPEED_MUL × normal. The
    // pinned timer is stamped each time a tank lands a basic hit;
    // sustained melee keeps the slowdown active. Cavalry overrun
    // still moves but slower; archers can't kite away from a tank.
    const pinned = state.rac.pinnedUntilTick[i] > tickNow;
    const maxV = state.rac.effSpeed[i] * (pinned ? PIN_SPEED_MUL : 1);

    if (behavior === BEHAVIOR_FLANK) {
      // Cavalry flank: locate the LINE (highest-density spot along
      // the seek path), measure the gradient AT the line (perpendicular
      // to the line direction), probe laterally from the line position
      // until density drops below the edge threshold, then aim cavalry
      // at the edge. Probing from the line — not from cavalry — means
      // the search returns the same answer whether cavalry is 30m
      // away or 1m away, which is the right invariant.
      const enemyCh = state.rac.owner[i] === 0 ? 1 : 0;
      const dbgBase = dbg ? i * FLANK_DEBUG_FLOATS_PER_RAC : -1;
      if (dbg) {
        dbg[dbgBase + FLANK_DEBUG_OFFSET.inFlank] = 1;
      }
      // Step 1: find peak density along seek direction.
      let lineX = myX;
      let lineY = myY;
      let peakDens = 0;
      if (tgtFound && distToTarget > 1e-3) {
        const sx = (tgtX - myX) / distToTarget;
        const sy = (tgtY - myY) / distToTarget;
        for (const la of FLANK_LOOKAHEADS) {
          if (la > distToTarget + 4) break;
          const px = myX + sx * la;
          const py = myY + sy * la;
          const d = sampleField(fields, fields.sideDensity[enemyCh], px, py);
          if (d > peakDens) {
            peakDens = d;
            lineX = px;
            lineY = py;
          }
        }
        // Also check our own position — if pinned, the line is here.
        const localDens = sampleField(fields, fields.sideDensity[enemyCh], myX, myY);
        if (localDens > peakDens) {
          peakDens = localDens;
          lineX = myX;
          lineY = myY;
        }
      }
      // Step 2: gradient at the line position.
      const h = FLANK_GRAD_H;
      const dxDens =
        sampleField(fields, fields.sideDensity[enemyCh], lineX + h, lineY) -
        sampleField(fields, fields.sideDensity[enemyCh], lineX - h, lineY);
      const dyDens =
        sampleField(fields, fields.sideDensity[enemyCh], lineX, lineY + h) -
        sampleField(fields, fields.sideDensity[enemyCh], lineX, lineY - h);
      const gMag = Math.hypot(dxDens, dyDens);
      if (dbg) {
        dbg[dbgBase + FLANK_DEBUG_OFFSET.gradX] = gMag > 0 ? dxDens / gMag : 0;
        dbg[dbgBase + FLANK_DEBUG_OFFSET.gradY] = gMag > 0 ? dyDens / gMag : 0;
      }
      if (gMag > 1e-3) {
        const perpX = -dyDens / gMag;
        const perpY = dxDens / gMag;
        // Forward bias toward target so we sweep to the side closer
        // to the actual flank, not away from the fight.
        let fwdBias = 0;
        if (tgtFound && distToTarget > 1e-3) {
          fwdBias =
            (perpX * (tgtX - myX) + perpY * (tgtY - myY)) / distToTarget;
        }
        const sign = fwdBias >= 0 ? 1 : -1;
        // Step 3: edge-probe FROM THE LINE (not from cavalry).
        let edgeAt = FLANK_PROBE_STEP * FLANK_MAX_STEPS;
        let edgeStep = -1;
        let edgeProbeX = lineX;
        let edgeProbeY = lineY;
        for (let k = 1; k <= FLANK_MAX_STEPS; k++) {
          const probeX = lineX + perpX * sign * k * FLANK_PROBE_STEP;
          const probeY = lineY + perpY * sign * k * FLANK_PROBE_STEP;
          const d = sampleField(fields, fields.sideDensity[enemyCh], probeX, probeY);
          if (dbg && k <= 8) {
            dbg[dbgBase + FLANK_DEBUG_OFFSET.probesXY + (k - 1) * 2 + 0] = probeX;
            dbg[dbgBase + FLANK_DEBUG_OFFSET.probesXY + (k - 1) * 2 + 1] = probeY;
          }
          if (d < FLANK_EDGE_DENSITY) {
            edgeAt = (k + 1) * FLANK_PROBE_STEP;
            edgeStep = k;
            edgeProbeX = probeX;
            edgeProbeY = probeY;
            break;
          }
        }
        // Aim cavalry at a PURELY LATERAL point relative to its
        // CURRENT position — same lateral offset that the line-anchored
        // probe found (edgeAt). Without this the aim point sits AT the
        // line position laterally offset; the vector from a distant
        // cavalry rac to that aim was mostly forward (into the line)
        // with a tiny lateral kick. Anchoring the aim on cavalry's
        // current position turns the steering into a pure perpendicular
        // sweep — cavalry goes sideways until clear of the line, then
        // FLANK exits and MARCH re-engages from the flank.
        const aimX = myX + perpX * sign * edgeAt;
        const aimY = myY + perpY * sign * edgeAt;
        void edgeProbeX;
        void edgeProbeY;
        void lineX;
        void lineY;
        if (dbg) {
          dbg[dbgBase + FLANK_DEBUG_OFFSET.perpX] = perpX * sign;
          dbg[dbgBase + FLANK_DEBUG_OFFSET.perpY] = perpY * sign;
          dbg[dbgBase + FLANK_DEBUG_OFFSET.aimX] = aimX;
          dbg[dbgBase + FLANK_DEBUG_OFFSET.aimY] = aimY;
          dbg[dbgBase + FLANK_DEBUG_OFFSET.edgeStep] = edgeStep;
        }
        const dx = aimX - myX;
        const dy = aimY - myY;
        const d = Math.hypot(dx, dy);
        if (d > 1e-3) {
          desiredVx = (dx / d) * maxV;
          desiredVy = (dy / d) * maxV;
        }
      } else if (tgtFound && distToTarget > 1e-3) {
        if (dbg) {
          dbg[dbgBase + FLANK_DEBUG_OFFSET.aimX] = tgtX;
          dbg[dbgBase + FLANK_DEBUG_OFFSET.aimY] = tgtY;
          dbg[dbgBase + FLANK_DEBUG_OFFSET.edgeStep] = -1;
        }
        desiredVx = ((tgtX - myX) / distToTarget) * maxV;
        desiredVy = ((tgtY - myY) / distToTarget) * maxV;
      }
    } else if (behavior === BEHAVIOR_KITE) {
      // Archer kite: maintain preferred distance from target. Outside
      // band → walk toward (close to attack range, half speed so we
      // don't outrun fleeing prey). Inside band → back-pedal at full
      // speed. In band → settle (vel = 0). The deadband stops the
      // archer from oscillating across the boundary every tick.
      if (tgtFound) {
        const kiteFrac = profile.archerKiteFraction || 0.7;
        const preferred = state.rac.effRange[i] * kiteFrac;
        const d = distToTarget;
        if (d > 1e-3) {
          const ux = (tgtX - myX) / d;
          const uy = (tgtY - myY) / d;
          if (d > preferred * (1 + KITE_DEADBAND)) {
            // too far → close at half speed (full speed plus a faster-
            // moving target lets archers chase enemies across the map).
            desiredVx = ux * maxV * 0.5;
            desiredVy = uy * maxV * 0.5;
          } else if (d < preferred * (1 - KITE_DEADBAND)) {
            // too close → back-pedal at full speed.
            desiredVx = -ux * maxV;
            desiredVy = -uy * maxV;
          }
          // else: in band, hold (desired = 0). Combat fires when the
          // attack cooldown allows.
        }
      }
    } else if (behavior === BEHAVIOR_ROUT) {
      // Panicked flee. Aim point cached on cadence tick = my own
      // position + FLEE_DIST along the away-from-nearest-enemy vector
      // (so each broken rac runs in its own direction). Speed boosted
      // to ROUT_SPEED_MUL × maxV. Corner-avoidance blends the flee
      // direction toward field-center near the bounds so racs don't
      // pin themselves against a wall.
      if (state.rac.aimValid[i]) {
        let fx = state.rac.aimX[i] - myX;
        let fy = state.rac.aimY[i] - myY;
        // Corner-avoidance: blend toward field center near edges.
        const wallSlack = 0.6;
        const overX = Math.max(0, Math.abs(myX) / halfW - wallSlack) / (1 - wallSlack);
        const overY = Math.max(0, Math.abs(myY) / halfH - wallSlack) / (1 - wallSlack);
        const wallBias = Math.min(0.8, Math.max(overX, overY));
        if (wallBias > 0) {
          const cx = -myX;
          const cy = -myY;
          const cl = Math.hypot(cx, cy);
          const fl0 = Math.hypot(fx, fy);
          if (cl > 1e-3 && fl0 > 1e-3) {
            const fux = fx / fl0;
            const fuy = fy / fl0;
            const cux = cx / cl;
            const cuy = cy / cl;
            fx = fux * (1 - wallBias) + cux * wallBias;
            fy = fuy * (1 - wallBias) + cuy * wallBias;
          }
        }
        const fl = Math.hypot(fx, fy);
        // Arrival deadband: once we're past FLEE_DIST from the enemy,
        // we've arrived at the aim point. Stand still (cross-unit
        // repulsion will spread the cluster) while morale recovers.
        const arrR =
          role === ROLE_CAVALRY ? ROUT_ARRIVAL_R_CAVALRY : ROUT_ARRIVAL_R_DEFAULT;
        if (fl > arrR) {
          const speed = maxV * ROUT_SPEED_MUL;
          desiredVx = (fx / fl) * speed;
          desiredVy = (fy / fl) * speed;
        }
      }
    } else if (behavior === BEHAVIOR_ENGAGE) {
      if (tgtFound) {
        const tkindLocal = state.rac.targetKind[i];
        if (role === ROLE_CAVALRY && tkindLocal === TARGET_KIND_RAC) {
          // Cavalry OVERRUN — aim PAST the target so they charge
          // through. Pack of cavalry chasing the same enemy gets
          // herd-intercept: each rac picks a different lookahead
          // time on the target's velocity, spreading the pack
          // across intercept points instead of all crashing the
          // same spot. Senior (lowest-id) attackers tend toward the
          // current position; juniors aim further ahead.
          //
          // Bins are NOT overrun: a bin can't flee, so charging
          // through it just leaves the cavalry on the far side, where
          // they retarget and charge back. Multiple cavalry doing
          // that around a bin = a self-swirl (the user-visible bug).
          // Cavalry-vs-bin uses the standard close-and-attack path
          // below, with the same per-id angular offset so they spread
          // around the bin instead of piling onto its center.
          const tid = state.rac.targetId[i];
          const tRow = findRacRowById(state, tid);
          let pX = tgtX, pY = tgtY;
          if (tRow >= 0) {
            const aim = herdAimPoint(state, myRacId, tkindLocal, tRow);
            pX = aim.x;
            pY = aim.y;
          }
          const d = Math.hypot(pX - myX, pY - myY);
          if (d > 1e-3) {
            const ux = (pX - myX) / d;
            const uy = (pY - myY) / d;
            const aheadX = pX + ux * CAVALRY_OVERSHOOT;
            const aheadY = pY + uy * CAVALRY_OVERSHOOT;
            const ax = aheadX - myX;
            const ay = aheadY - myY;
            const ad = Math.hypot(ax, ay);
            if (ad > 1e-3) {
              desiredVx = (ax / ad) * maxV;
              desiredVy = (ay / ad) * maxV;
            }
          }
        } else if (tkindLocal === TARGET_KIND_BIN) {
          // Engaging a static bin: aim at a per-id angular offset
          // around the bin's perimeter so the squad surrounds it
          // instead of converging on a single point. Each rac stakes
          // out one slot of a ring at ~85% of attack range and holds.
          const ringR = state.rac.effRange[i] * 0.85;
          // Golden-angle distribution from rac id keeps neighbors at
          // visually different angles (same trick as Vogel disc).
          const ang = myRacId * 2.39996323; // ~golden angle in radians
          const aimXBin = tgtX + Math.cos(ang) * ringR;
          const aimYBin = tgtY + Math.sin(ang) * ringR;
          const dxA = aimXBin - myX;
          const dyA = aimYBin - myY;
          const dA = Math.hypot(dxA, dyA);
          if (dA > 1e-3) {
            desiredVx = (dxA / dA) * maxV;
            desiredVy = (dyA / dA) * maxV;
          }
        } else if (distToTarget > state.rac.effRange[i]) {
          // Tank / infantry / archer: walk to attack range, then hold.
          const d = distToTarget;
          if (d > 1e-3) {
            desiredVx = ((tgtX - myX) / d) * maxV;
            desiredVy = ((tgtY - myY) / d) * maxV;
          }
        }
        // else: hold position. Combat applies damage on its schedule.
      }
    } else {
      // BEHAVIOR_MARCH
      // HOLD order: don't march toward a distant target. Followers
      // still slot-correct (leader-pull) so the squad doesn't drift
      // apart, but leaders / lone units stay put.
      // SLOW order: half march speed (phalanx shield wall pace).
      const marchSpeedMul =
        order === STANDING_ORDER_IDX_SLOW ? 0.5 : 1;
      const marchMaxV = maxV * marchSpeedMul;
      // Infantry / tank follower with a live leader: slot-direct
      // steering. Aim at the predicted (leader.pos + leader.vel × dt
      // + slot) so a moving leader doesn't leave the squad behind.
      // Tanks form lateral lines this way; archers + cavalry stay
      // exempt so kite + flank can fire without slot-pull fighting
      // them.
      const usesFormation = role === ROLE_INFANTRY || role === ROLE_TANK;
      // Slot-direct only fires while the rac is reasonably close to
      // its slot. Once it's been knocked far out (combat chaos, blob
      // collapse, retreat path), trying to "reform" creates worse
      // problems — the rac sprints back across the field through
      // enemies, fights the cross-unit repulsion of nearby allies,
      // and the squad ends up worse off than if it just stood and
      // fought independently. Past FORMATION_SHATTER_R the rac falls
      // through to the world-target MARCH path (fight whatever is
      // closest).
      let usingSlotDirect = false;
      let slotSx = 0, slotSy = 0;
      let lvx = 0, lvy = 0;
      if (usesFormation && !isLeader && leaderAlive) {
        // Use the PRE-motion snapshot of leader pos so every follower
        // sees the same leader state regardless of motionTick's
        // shuffled iteration order. Reading state.rac.x[leaderRow]
        // here would race the leader's own integration this tick.
        const lx = leaderPreX[leaderRow];
        const ly = leaderPreY[leaderRow];
        lvx = 0; // velocity term removed — caused a separate race condition; constant ~0.17m lag is invisible.
        lvy = 0;
        const cF = leaderRotCos[leaderRow];
        const sF = leaderRotSin[leaderRow];
        const sdx0 = state.rac.slotDx[i];
        const sdy0 = state.rac.slotDy[i];
        const rdx = sdx0 * cF - sdy0 * sF;
        const rdy = sdx0 * sF + sdy0 * cF;
        const slotX = lx + rdx;
        const slotY = ly + rdy;
        const slotDx = slotX - myX;
        const slotDy = slotY - myY;
        const slotD2 = slotDx * slotDx + slotDy * slotDy;
        if (slotD2 <= FORMATION_SHATTER_R2) {
          slotSx = slotX;
          slotSy = slotY;
          usingSlotDirect = true;
        }
      }
      if (usingSlotDirect) {
        // Aim at slot = leader.pos + rotated-offset. We used to add
        // leader.vel * dt to predict next-tick slot, but motionTick
        // iterates racs in a shuffled per-tick order — when the leader
        // had already integrated this tick the prediction "doubled
        // up" (used post-integration leader pos PLUS one more tick of
        // velocity), so followers landed one tick ahead of slot;
        // when the leader hadn't yet integrated, followers landed
        // exactly at slot. Tick-to-tick the order shuffles, so each
        // follower oscillated between two states — the start-of-
        // round wiggle. Without prediction followers lag the leader
        // by leader.vel * dt = 0.17 m at maxV, which is invisible.
        void lvx;
        void lvy;
        const dx = slotSx - myX;
        const dy = slotSy - myY;
        const reqSpeed = Math.hypot(dx, dy) / dt;
        if (reqSpeed > marchMaxV) {
          const inv = 1 / Math.hypot(dx, dy);
          desiredVx = dx * inv * marchMaxV;
          desiredVy = dy * inv * marchMaxV;
        } else {
          desiredVx = dx / dt;
          desiredVy = dy / dt;
        }
      } else if (tgtFound && order !== STANDING_ORDER_IDX_HOLD) {
        // Leader / non-formation roles: aim at world target unless
        // standing order is HOLD (then sit until enemy comes to us).
        // Archers advance at half speed — they need to walk forward
        // with the army at start of round, but full-speed chase let
        // them outrun friendly infantry and chase fleeing enemies
        // across the map. At 0.5× a faster fleeing target stays out
        // of range and friendlies intercept first.
        //
        // Contact halt: when the rac is in contact (enemy density
        // within ~10 m), MARCH stops pushing forward — the front
        // ranks are about to engage, and we don't want leaders
        // marching their squad straight through the enemy line. This
        // is the squad's collision response: formations meet at the
        // boundary instead of interpenetrating.
        if (state.rac.contact[i] === 0) {
          const archerSlow = role === ROLE_ARCHER ? 0.5 : 1;
          const dx = tgtX - myX;
          const dy = tgtY - myY;
          const d = distToTarget;
          if (d > 1e-3) {
            desiredVx = (dx / d) * marchMaxV * archerSlow;
            desiredVy = (dy / d) * marchMaxV * archerSlow;
          }
        }
      }
    }

    // ----- Guards: short-radius pair-wise repulsion + grid-sample contact -----
    // CONTACT mode is a 5×5 cell-sum of enemy density (8 m reach,
    // matches the old forEachNear scan but O(1) — no closure, no
    // neighbor walk).
    //
    // Repulsion is a per-pair scan at SCAN_R = max(CLOSE_R, CROSS_UNIT_R)
    // = 1.5 m. Density-gradient repulsion was tried here and abandoned:
    // for a marching phalanx, the gradient front-edge → backward force
    // and rear-edge → forward force, which physically stretches the
    // formation each tick and fights the slot-direct steering. The
    // pair-wise scan only fires on actual overlap (CLOSE) or cross-
    // squad proximity (CROSS_UNIT) and leaves in-formation racs alone.
    const myOwner = state.rac.owner[i];
    const enemyCh = (1 - myOwner) as 0 | 1;
    const fCellSize = fields.cellSize;
    const fCols = fields.cols;
    const fRows = fields.rows;
    const fHalfW = fields.halfW;
    const fHalfH = fields.halfH;
    const myCx = Math.max(0, Math.min(fCols - 1, Math.floor((myX + fHalfW) / fCellSize)));
    const myCy = Math.max(0, Math.min(fRows - 1, Math.floor((myY + fHalfH) / fCellSize)));
    const myCellRow = myCy * fCols;
    const enemyDens = fields.sideDensity[enemyCh];
    let enemySum = 0;
    {
      const cx0 = Math.max(0, myCx - 2);
      const cx1 = Math.min(fCols - 1, myCx + 2);
      const cy0 = Math.max(0, myCy - 2);
      const cy1 = Math.min(fRows - 1, myCy + 2);
      for (let cy = cy0; cy <= cy1; cy++) {
        const rowBase = cy * fCols;
        for (let cx = cx0; cx <= cx1; cx++) {
          enemySum += enemyDens[rowBase + cx];
        }
      }
    }
    // Hysteresis on contact: stay in contact mode until density drops
    // well below the SET threshold. Prevents the leader's halt from
    // flickering at the boundary.
    const wasContact = state.rac.contact[i] === 1;
    const contact = wasContact
      ? enemySum > CONTACT_DENSITY_CLEAR ? 1 : 0
      : enemySum > CONTACT_DENSITY_SET ? 1 : 0;
    let nudgeVx = 0;
    let nudgeVy = 0;
    if (grid) {
      // Inlined cell walk for the close-range / cross-unit repulsion
      // scan. The closure form (forEachNear with a callback) was
      // measurable in profiling; inlining lets the JIT keep all the
      // loop locals (myOwner, mySquadId, the nudge accumulators) in
      // registers and eliminates the per-cell function-call overhead.
      const mySquadId = state.rac.squadId[i];
      const myRacIdLocal = state.rac.id[i];
      const SCAN_R = CLOSE_R > CROSS_UNIT_R ? CLOSE_R : CROSS_UNIT_R;
      const gCellSize = grid.cellSize;
      const gCols = grid.cols;
      const gRows = grid.rows;
      const gHalfW = grid.halfW;
      const gHalfH = grid.halfH;
      const gCellStart = grid.cellStart;
      const gEntries = grid.entries;
      const gAcross = Math.ceil(SCAN_R / gCellSize);
      const baseCx = Math.floor((myX + gHalfW) / gCellSize);
      const baseCy = Math.floor((myY + gHalfH) / gCellSize);
      let gMinCx = baseCx - gAcross; if (gMinCx < 0) gMinCx = 0;
      let gMaxCx = baseCx + gAcross; if (gMaxCx >= gCols) gMaxCx = gCols - 1;
      let gMinCy = baseCy - gAcross; if (gMinCy < 0) gMinCy = 0;
      let gMaxCy = baseCy + gAcross; if (gMaxCy >= gRows) gMaxCy = gRows - 1;
      const racX = state.rac.x;
      const racY = state.rac.y;
      const racAlive = state.rac.alive;
      const racOwner = state.rac.owner;
      const racSquadId = state.rac.squadId;
      const racIdArr = state.rac.id;
      for (let cy = gMinCy; cy <= gMaxCy; cy++) {
        for (let cx = gMinCx; cx <= gMaxCx; cx++) {
          const c = cy * gCols + cx;
          const start = gCellStart[c];
          const end = gCellStart[c + 1];
          for (let k = start; k < end; k++) {
            const j = gEntries[k];
            if (j === i) continue;
            if (!racAlive[j]) continue;
            const dx = myX - racX[j];
            const dy = myY - racY[j];
            const d2 = dx * dx + dy * dy;
            if (d2 < CLOSE_R2) {
              if (d2 < 1e-6) {
                const h = ((myRacIdLocal * 31 + racIdArr[j]) >>> 0) / 4294967296;
                const ang = h * Math.PI * 2;
                nudgeVx += Math.cos(ang) * CLOSE_K;
                nudgeVy += Math.sin(ang) * CLOSE_K;
                continue;
              }
              const d = Math.sqrt(d2);
              const w = ((CLOSE_R - d) / CLOSE_R) * CLOSE_K;
              nudgeVx += (dx / d) * w;
              nudgeVy += (dy / d) * w;
              continue;
            }
            if (
              d2 < CROSS_UNIT_R2 &&
              racOwner[j] === myOwner &&
              racSquadId[j] !== mySquadId
            ) {
              // Cross-unit repulsion at 1.5 m, only between DIFFERENT
              // same-side squads — keeps adjacent friendly squads
              // from merging. Same-squad neighbors are spaced by
              // slot-direct steering (or, for non-formation roles,
              // by their own behavior intent — cavalry-on-bin uses a
              // golden-angle ring, broken racs flee in per-rac
              // directions). Applying this force inside the squad
              // pushed edge followers out of slot in tight formations
              // (phalanx pitch = 1.4 m sits exactly inside this
              // radius), so leaders outran their followers.
              const d = Math.sqrt(d2);
              const w = ((CROSS_UNIT_R - d) / CROSS_UNIT_R) * CROSS_UNIT_K;
              nudgeVx += (dx / d) * w;
              nudgeVy += (dy / d) * w;
            }
          }
        }
      }
    }
    state.rac.contact[i] = contact;

    // Support bonus: friendly density at this rac reduces incoming
    // damage. Read here from the field rather than the neighbor count
    // so phalanx rear-rank protection still benefits from rolling
    // density (a tight 6×8 block has ~5+ friends in the kernel).
    // Note: state.rac.contact[i] was just updated by the guard scan
    // above, so this picks up THIS tick's contact mode for the support
    // calculation — different from the motion-intent profile higher
    // up which uses last tick's flag.
    const supportProfile = state.rac.contact[i]
      ? state.formationContactProfile[state.rac.owner[i]][state.rac.formationIdx[i]]
      : state.formationProfile[state.rac.owner[i]][state.rac.formationIdx[i]];
    const supportMax = supportProfile.supportBonusMax;
    const supportFullAt = supportProfile.supportBonusFullAt;
    let dmgMul = 1;
    if (supportMax > 0 && supportFullAt > 0) {
      // Direct cell read of the friendly-side density at my cell.
      // Bilinear interpolation would give a smoother profile but the
      // damage multiplier doesn't need sub-cell precision.
      const friendlyDens = fields.sideDensity[myOwner][myCellRow + myCx];
      const supportFrac = Math.min(1, friendlyDens / supportFullAt);
      dmgMul *= 1 - supportMax * supportFrac;
    }
    state.rac.surroundedDamageMul[i] = dmgMul;

    // ----- Apply velocity -----
    let newVx = desiredVx + nudgeVx;
    let newVy = desiredVy + nudgeVy;

    // Inertia blend (heavy units don't snap-redirect). Tank uses 0.5.
    const blend = profile.inertiaBlend;
    if (blend > 0) {
      newVx = myVx * blend + newVx * (1 - blend);
      newVy = myVy * blend + newVy * (1 - blend);
    }

    // Cap to maxV (rout has its own boosted speed already baked into
    // desired). Don't cap if rout — we already set it past maxV.
    if (behavior !== BEHAVIOR_ROUT) {
      const m = Math.hypot(newVx, newVy);
      if (m > maxV) {
        newVx = (newVx / m) * maxV;
        newVy = (newVy / m) * maxV;
      }
    }
    // Per-role acceleration cap: clamp how much velocity can CHANGE
    // tick-to-tick. Cavalry is the only role with a finite cap so a
    // full-speed charger has real momentum (can't stop on a dime,
    // can't pivot 180°). Other roles use Infinity (no cap).
    //
    // ROUT bypasses the cap — adrenaline. Without this, cavalry that
    // breaks while holding station (e.g. attacking a bin at V=0)
    // takes >1 s to ramp up to flee speed because 8 m/s² × dt is only
    // 0.34 m/s of velocity change per tick, looking like "they just
    // stop" before slowly running.
    const maxAccel =
      behavior === BEHAVIOR_ROUT ? Infinity : MAX_ACCEL_BY_ROLE[role] ?? Infinity;
    if (Number.isFinite(maxAccel)) {
      const dvx = newVx - myVx;
      const dvy = newVy - myVy;
      const dvMag = Math.hypot(dvx, dvy);
      const maxDeltaV = maxAccel * dt;
      if (dvMag > maxDeltaV) {
        newVx = myVx + (dvx / dvMag) * maxDeltaV;
        newVy = myVy + (dvy / dvMag) * maxDeltaV;
      }
    }
    state.rac.vx[i] = newVx;
    state.rac.vy[i] = newVy;

    // Position + bounds clamp (only stop racs that were INSIDE and
    // are about to cross out — off-screen spawn is allowed).
    let nx = myX + newVx * dt;
    let ny = myY + newVy * dt;
    if (myX <= halfW && nx > halfW) {
      nx = halfW;
      state.rac.vx[i] = 0;
    } else if (myX >= -halfW && nx < -halfW) {
      nx = -halfW;
      state.rac.vx[i] = 0;
    }
    if (myY <= halfH && ny > halfH) {
      ny = halfH;
      state.rac.vy[i] = 0;
    } else if (myY >= -halfH && ny < -halfH) {
      ny = -halfH;
      state.rac.vy[i] = 0;
    }
    state.rac.x[i] = nx;
    state.rac.y[i] = ny;

    // Facing follows velocity direction (skip if not moving so we
    // don't reset facing to the +x default every frame an idle rac
    // spends in engage).
    //
    // EXCEPTION: a squad leader with a target faces the target, not
    // its velocity. Leaders' facing drives the wheel rotation for
    // every follower's slot, so a sideways nudge from cross-unit
    // repulsion (especially in melee with desiredV=0) used to rotate
    // the leader's facing → rotate the whole formation → phalanx vs
    // phalanx pivoted into an end-to-end clash. Leaders now face
    // their actual target so the formation stays oriented toward the
    // enemy line.
    state.rac.prevFacing[i] = state.rac.facing[i];
    if (isLeader) {
      // Leader's facing drives the wheel rotation for every follower's
      // slot. We anchor it to the direction-to-nearest-enemy-BIN so
      // the angle stays stable as the squad walks: marching toward a
      // bin moves the leader along the bin direction, so the relative
      // angle barely changes. Anchoring to a per-tick enemy-rac
      // target instead gave ever-growing relative angles as the
      // leader closed (perpendicular offset stays constant while the
      // parallel distance shrinks → arctan blows up), which produced
      // the diagonal-march and end-to-end clash. Falls back to the
      // current target rac if no enemy bins remain (cleanup phase),
      // and to velocity if neither exists.
      let didFace = false;
      const enemyBinRow = findNearestEnemyBin(state, i);
      let fdx = 0, fdy = 0;
      if (enemyBinRow >= 0) {
        fdx = state.bin.x[enemyBinRow] - myX;
        fdy = state.bin.y[enemyBinRow] - myY;
        didFace = fdx * fdx + fdy * fdy > 1e-6;
      } else if (tgtFound) {
        fdx = tgtX - myX;
        fdy = tgtY - myY;
        didFace = fdx * fdx + fdy * fdy > 1e-6;
      }
      if (didFace) {
        const desired = Math.atan2(fdy, fdx);
        let delta = desired - state.rac.facing[i];
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        const cap = LEADER_TURN_RATE * dt;
        if (delta > cap) delta = cap;
        else if (delta < -cap) delta = -cap;
        state.rac.facing[i] = state.rac.facing[i] + delta;
      } else if (newVx * newVx + newVy * newVy > 1e-6) {
        state.rac.facing[i] = Math.atan2(newVy, newVx);
      }
    } else if (newVx * newVx + newVy * newVy > 1e-6) {
      state.rac.facing[i] = Math.atan2(newVy, newVx);
    }

    // inFormation flag: infantry / tank follower at slot, not broken.
    // Read by combat for the frontal damage/defense bonus. Independent
    // of behavior — if you're at your slot, you're in formation, even
    // if you're currently in engage state.
    //
    // Mod-N gate: this drives a damage multiplier that's only meaningful
    // in melee (combat fires at 1+ Hz, far slower than 24-tick sim).
    // Refresh every IN_FORMATION_CHECK_TICKS; off-cadence ticks reuse
    // the cached value. Phase by row so the cost spreads evenly. Tick 1
    // always runs so the first frame has correct inFormation flags.
    if (tickNow === 1 || (tickNow + i) % IN_FORMATION_CHECK_TICKS === 0) {
      let inFormation = 0;
      if (
        (role === ROLE_INFANTRY || role === ROLE_TANK) &&
        !isLeader &&
        leaderAlive &&
        !broken
      ) {
        const lx = state.rac.x[leaderRow];
        const ly = state.rac.y[leaderRow];
        const cF = leaderRotCos[leaderRow];
        const sF = leaderRotSin[leaderRow];
        const sdx0 = state.rac.slotDx[i];
        const sdy0 = state.rac.slotDy[i];
        const rdx = sdx0 * cF - sdy0 * sF;
        const rdy = sdx0 * sF + sdy0 * cF;
        const sX = lx + rdx;
        const sY = ly + rdy;
        const ddx = sX - state.rac.x[i];
        const ddy = sY - state.rac.y[i];
        if (ddx * ddx + ddy * ddy < IN_FORMATION_R * IN_FORMATION_R) {
          inFormation = 1;
        }
      }
      state.rac.inFormation[i] = inFormation;
    }

    // Sub-tick gate: mark this rac stable so the next tick's pipeline
    // can skip it. Two qualifying paths:
    //  (a) MARCH follower at slot, no contact, not broken — happily
    //      following its leader. The skipped tick keeps moving along
    //      with the squad's velocity.
    //  (b) ENGAGE non-cavalry that's holding inside attack range — its
    //      desired velocity is already zero (or near it), and combat
    //      fires on its own cooldown. We don't need motion updates
    //      while it's standing still and swinging.
    // Cavalry never qualifies — it wants every-tick steering for
    // overrun + flank. Leaders never qualify — followers track them.
    // Broken racs don't qualify — they need rally/rout intent.
    // Contact is NOT a disqualifier: a follower at slot inside a melee
    // line can absolutely skip a tick — they've already chosen MARCH /
    // ENGAGE on their cadence, the slot-direct steering is trivially
    // recomputable, and combat fires on its own cooldown. Skipping
    // them gives ~40 ms reaction lag which is fine for tuning runs.
    let isStable = 0;
    if (
      !broken &&
      !isLeader &&
      leaderAlive &&
      (role === ROLE_INFANTRY || role === ROLE_TANK) &&
      state.rac.inFormation[i] === 1 &&
      (behavior === BEHAVIOR_MARCH || behavior === BEHAVIOR_ENGAGE)
    ) {
      isStable = 1;
    }
    state.rac.stable[i] = isStable;
  }
}
