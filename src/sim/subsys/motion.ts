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
const CONTACT_R = 8.0;
const CONTACT_R2 = CONTACT_R * CONTACT_R;
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
function findFriendlyBin(state: BattleState, i: number): number {
  const myOwner = state.rac.owner[i];
  const myX = state.rac.x[i];
  const myY = state.rac.y[i];
  // Prefer the rac's source bin if it's still alive — that's our
  // home base. Otherwise fall back to nearest alive friendly bin.
  const srcBinId = state.rac.sourceBinId[i];
  if (srcBinId >= 0) {
    const row = state.binRowById.get(srcBinId);
    if (row !== undefined && state.bin.alive[row] && state.bin.owner[row] === myOwner) {
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
  // FLANK this tick read inFlank=0. Cheap fill — only when capture
  // is enabled.
  if (state._debugFlank) state._debugFlank.fill(0);

  for (let i = 0; i < state.rac.count; i++) {
    if (!state.rac.alive[i]) continue;
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
    const leaderRow = isLeader ? -1 : findRacRowById(state, myLeaderId);
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
        const rallyLeader = findRallyLeader(state, i);
        next = rallyLeader >= 0 ? BEHAVIOR_RALLY : BEHAVIOR_ROUT;
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

    if (behavior === BEHAVIOR_RALLY) {
      // Rally: head toward nearest friendly leader; fall back to
      // friendly bin so a broken rac with no leader nearby still has
      // somewhere to go (defend the line). Morale recovers in
      // moraleTick while rallying.
      const leaderRallyRow = findRallyLeader(state, i);
      let aimX = myX, aimY = myY, hasAim = false;
      if (leaderRallyRow >= 0) {
        aimX = state.rac.x[leaderRallyRow];
        aimY = state.rac.y[leaderRallyRow];
        hasAim = true;
      } else {
        const binRow = findFriendlyBin(state, i);
        if (binRow >= 0) {
          aimX = state.bin.x[binRow];
          aimY = state.bin.y[binRow];
          hasAim = true;
        }
      }
      if (hasAim) {
        const dx = aimX - myX;
        const dy = aimY - myY;
        const d = Math.hypot(dx, dy);
        if (d > 1e-3) {
          desiredVx = (dx / d) * maxV;
          desiredVy = (dy / d) * maxV;
        }
      }
    } else if (behavior === BEHAVIOR_FLANK) {
      // Cavalry flank: locate the LINE (highest-density spot along
      // the seek path), measure the gradient AT the line (perpendicular
      // to the line direction), probe laterally from the line position
      // until density drops below the edge threshold, then aim cavalry
      // at the edge. Probing from the line — not from cavalry — means
      // the search returns the same answer whether cavalry is 30m
      // away or 1m away, which is the right invariant.
      const enemyCh = state.rac.owner[i] === 0 ? 1 : 0;
      const dbg = state._debugFlank;
      const dbgBase = dbg ? i * FLANK_DEBUG_FLOATS_PER_RAC : -1;
      if (dbg && dbgBase >= 0) {
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
      if (dbg && dbgBase >= 0) {
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
          if (dbg && dbgBase >= 0 && k <= 8) {
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
        if (dbg && dbgBase >= 0) {
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
        if (dbg && dbgBase >= 0) {
          dbg[dbgBase + FLANK_DEBUG_OFFSET.aimX] = tgtX;
          dbg[dbgBase + FLANK_DEBUG_OFFSET.aimY] = tgtY;
          dbg[dbgBase + FLANK_DEBUG_OFFSET.edgeStep] = -1;
        }
        desiredVx = ((tgtX - myX) / distToTarget) * maxV;
        desiredVy = ((tgtY - myY) / distToTarget) * maxV;
      }
    } else if (behavior === BEHAVIOR_KITE) {
      // Archer kite: maintain preferred distance from target. Outside
      // band → walk toward (close to attack range). Inside band →
      // back-pedal (open distance). In band → settle (vel = 0). The
      // deadband stops the archer from oscillating across the boundary
      // every tick.
      if (tgtFound) {
        const kiteFrac = profile.archerKiteFraction || 0.7;
        const preferred = state.rac.effRange[i] * kiteFrac;
        const d = distToTarget;
        if (d > 1e-3) {
          const ux = (tgtX - myX) / d;
          const uy = (tgtY - myY) / d;
          if (d > preferred * (1 + KITE_DEADBAND)) {
            // too far → close
            desiredVx = ux * maxV;
            desiredVy = uy * maxV;
          } else if (d < preferred * (1 - KITE_DEADBAND)) {
            // too close → back-pedal slightly faster than march
            desiredVx = -ux * maxV;
            desiredVy = -uy * maxV;
          }
          // else: in band, hold (desired = 0). Combat fires when the
          // attack cooldown allows.
        }
      }
    } else if (behavior === BEHAVIOR_ROUT) {
      // Retreat priority cascade:
      //   1. Friendly bin → run TO the bin and defend it.
      //   2. Friendly squad leader anywhere → rally on the leader.
      //   3. Flee nearest enemy with corner-avoidance bias.
      // Without (2) a routed rac with no living bin would flee into
      // a corner and get cornered. The leader fallback gives the
      // squad a rally point even after the bin's gone.
      const binRow = findFriendlyBin(state, i);
      let aimX = 0, aimY = 0, hasAim = false;
      if (binRow >= 0) {
        aimX = state.bin.x[binRow];
        aimY = state.bin.y[binRow];
        hasAim = true;
      } else {
        // Find any friendly squad leader. Radius set to span the full
        // map diagonal so we still cross the map to rally if needed —
        // grid scan just prunes empty cells along the way.
        let bestRow = -1;
        let bestD2 = Number.POSITIVE_INFINITY;
        const myOwn = state.rac.owner[i];
        const rallySearchR = Math.hypot(state.bounds.w, state.bounds.h);
        const considerLeader = (j: number) => {
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
          forEachNear(grid, myX, myY, rallySearchR, considerLeader);
        } else {
          for (let j = 0; j < state.rac.count; j++) considerLeader(j);
        }
        if (bestRow >= 0) {
          aimX = state.rac.x[bestRow];
          aimY = state.rac.y[bestRow];
          hasAim = true;
        }
      }

      let fx = 0, fy = 0;
      if (hasAim) {
        fx = aimX - myX;
        fy = aimY - myY;
      } else {
        // No bin, no leader — flee nearest enemy.
        let nearestRow = -1;
        let nearestD2 = Number.POSITIVE_INFINITY;
        if (grid) {
          forEachNear(grid, myX, myY, 30, (j) => {
            if (j === i) return;
            if (!state.rac.alive[j]) return;
            if (state.rac.owner[j] === state.rac.owner[i]) return;
            const dx = state.rac.x[j] - myX;
            const dy = state.rac.y[j] - myY;
            const d2 = dx * dx + dy * dy;
            if (d2 < nearestD2) {
              nearestD2 = d2;
              nearestRow = j;
            }
          });
        }
        const fleeFromX = nearestRow >= 0 ? state.rac.x[nearestRow] : tgtFound ? tgtX : myX;
        const fleeFromY = nearestRow >= 0 ? state.rac.y[nearestRow] : tgtFound ? tgtY : myY;
        fx = myX - fleeFromX;
        fy = myY - fleeFromY;
      }

      // Corner-avoidance: as we approach a wall, blend the flee
      // direction toward field-center so racs don't pin themselves
      // in a corner. Bias scales 0..1 with proximity to bounds —
      // 0 inside the central 60% of the field, 1 right at the edge.
      const wallSlackX = 0.6;
      const wallSlackY = 0.6;
      const overX = Math.max(0, Math.abs(myX) / halfW - wallSlackX) / (1 - wallSlackX);
      const overY = Math.max(0, Math.abs(myY) / halfH - wallSlackY) / (1 - wallSlackY);
      const wallBias = Math.min(0.8, Math.max(overX, overY));
      if (wallBias > 0) {
        // Direction toward center.
        const cx = -myX;
        const cy = -myY;
        const cl = Math.hypot(cx, cy);
        if (cl > 1e-3) {
          const fl = Math.hypot(fx, fy);
          if (fl > 1e-3) {
            const fux = fx / fl;
            const fuy = fy / fl;
            const cux = cx / cl;
            const cuy = cy / cl;
            fx = fux * (1 - wallBias) + cux * wallBias;
            fy = fuy * (1 - wallBias) + cuy * wallBias;
          } else {
            fx = cx / cl;
            fy = cy / cl;
          }
        }
      }

      const fl = Math.hypot(fx, fy);
      if (fl > 1e-3) {
        const speed = maxV * ROUT_SPEED_MUL;
        desiredVx = (fx / fl) * speed;
        desiredVy = (fy / fl) * speed;
      }
    } else if (behavior === BEHAVIOR_ENGAGE) {
      if (tgtFound) {
        if (role === ROLE_CAVALRY) {
          // Cavalry OVERRUN — aim PAST the target so they charge
          // through. Pack of cavalry chasing the same enemy gets
          // herd-intercept: each rac picks a different lookahead
          // time on the target's velocity, spreading the pack
          // across intercept points instead of all crashing the
          // same spot. Senior (lowest-id) attackers tend toward the
          // current position; juniors aim further ahead.
          const tid = state.rac.targetId[i];
          const tkindLocal = state.rac.targetKind[i];
          const tRow =
            tkindLocal === TARGET_KIND_RAC
              ? findRacRowById(state, tid)
              : tkindLocal === TARGET_KIND_BIN
                ? findBinRowById(state, tid)
                : -1;
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
      if (usesFormation && !isLeader && leaderAlive) {
        const lx = state.rac.x[leaderRow];
        const ly = state.rac.y[leaderRow];
        const lvx = state.rac.vx[leaderRow];
        const lvy = state.rac.vy[leaderRow];
        // Wheel: slot offsets are stored in formation-local frame
        // (forward = leader's spawn facing). Rotate by the delta
        // between the leader's CURRENT facing and the squad's spawn
        // facing so the formation pivots with the leader. Side 0
        // spawned facing 0 (+x), side 1 facing π (-x); we recover
        // the spawn facing from the leader's owner.
        const spawnFacing =
          state.rac.owner[leaderRow] === 0 ? 0 : Math.PI;
        const dFace = state.rac.facing[leaderRow] - spawnFacing;
        const cF = Math.cos(dFace);
        const sF = Math.sin(dFace);
        const sdx0 = state.rac.slotDx[i];
        const sdy0 = state.rac.slotDy[i];
        const rdx = sdx0 * cF - sdy0 * sF;
        const rdy = sdx0 * sF + sdy0 * cF;
        const sX = lx + lvx * dt + rdx;
        const sY = ly + lvy * dt + rdy;
        const dx = sX - myX;
        const dy = sY - myY;
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
        const dx = tgtX - myX;
        const dy = tgtY - myY;
        const d = distToTarget;
        if (d > 1e-3) {
          desiredVx = (dx / d) * marchMaxV;
          desiredVy = (dy / d) * marchMaxV;
        }
      }
    }

    // ----- Guards: close-range + cross-unit repulsion -----
    // Nudges are velocity contributions (m/s), summed with the
    // behavior's desired velocity. The post-sum cap at maxV decides
    // who wins when behavior + guards conflict — at high overlap the
    // close-range nudge dominates because CLOSE_K (10 m/s/m of
    // overlap) saturates the cap; far apart, behavior dominates and
    // the nudge is a small correction.
    let nudgeVx = 0;
    let nudgeVy = 0;
    let contact = 0;
    let supportFriends = 0;
    if (grid) {
      const myOwner = state.rac.owner[i];
      const mySquadId = state.rac.squadId[i];
      const SCAN_R = Math.max(CLOSE_R, CROSS_UNIT_R, CONTACT_R);
      forEachNear(grid, myX, myY, SCAN_R, (j) => {
        if (j === i) return;
        if (!state.rac.alive[j]) return;
        const dx = myX - state.rac.x[j];
        const dy = myY - state.rac.y[j];
        const d2 = dx * dx + dy * dy;
        if (d2 < CONTACT_R2 && state.rac.owner[j] !== myOwner) {
          contact = 1;
        }
        if (d2 < CONTACT_R2 && state.rac.owner[j] === myOwner) {
          supportFriends += 1;
        }
        if (d2 < CLOSE_R2) {
          if (d2 < 1e-6) {
            const h = ((state.rac.id[i] * 31 + state.rac.id[j]) >>> 0) / 4294967296;
            const ang = h * Math.PI * 2;
            nudgeVx += Math.cos(ang) * CLOSE_K;
            nudgeVy += Math.sin(ang) * CLOSE_K;
            return;
          }
          const d = Math.sqrt(d2);
          const w = ((CLOSE_R - d) / CLOSE_R) * CLOSE_K;
          nudgeVx += (dx / d) * w;
          nudgeVy += (dy / d) * w;
          return;
        }
        if (
          d2 < CROSS_UNIT_R2 &&
          state.rac.owner[j] === myOwner &&
          state.rac.squadId[j] !== mySquadId
        ) {
          const d = Math.sqrt(d2);
          const w = ((CROSS_UNIT_R - d) / CROSS_UNIT_R) * CROSS_UNIT_K;
          nudgeVx += (dx / d) * w;
          nudgeVy += (dy / d) * w;
        }
      });
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
      const myCh = state.rac.owner[i] === 0 ? 0 : 1;
      const friendlyDens = sampleField(fields, fields.sideDensity[myCh], myX, myY);
      const supportFrac = Math.min(1, friendlyDens / supportFullAt);
      dmgMul *= 1 - supportMax * supportFrac;
    }
    void supportFriends; // currently unused (we use the density field) but kept for future
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
    const maxAccel = MAX_ACCEL_BY_ROLE[role] ?? Infinity;
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
    state.rac.prevFacing[i] = state.rac.facing[i];
    if (newVx * newVx + newVy * newVy > 1e-6) {
      state.rac.facing[i] = Math.atan2(newVy, newVx);
    }

    // inFormation flag: infantry / tank follower at slot, not broken.
    // Read by combat for the frontal damage/defense bonus. Independent
    // of behavior — if you're at your slot, you're in formation, even
    // if you're currently in engage state.
    let inFormation = 0;
    if (
      (role === ROLE_INFANTRY || role === ROLE_TANK) &&
      !isLeader &&
      leaderAlive &&
      !broken
    ) {
      const lx = state.rac.x[leaderRow];
      const ly = state.rac.y[leaderRow];
      // Same wheel rotation as in MARCH slot-direct above.
      const spawnFacing =
        state.rac.owner[leaderRow] === 0 ? 0 : Math.PI;
      const dFace = state.rac.facing[leaderRow] - spawnFacing;
      const cF = Math.cos(dFace);
      const sF = Math.sin(dFace);
      const sdx0 = state.rac.slotDx[i];
      const sdy0 = state.rac.slotDy[i];
      const rdx = sdx0 * cF - sdy0 * sF;
      const rdy = sdx0 * sF + sdy0 * cF;
      const sX = lx + rdx;
      const sY = ly + rdy;
      if (Math.hypot(sX - state.rac.x[i], sY - state.rac.y[i]) < IN_FORMATION_R) {
        inFormation = 1;
      }
    }
    state.rac.inFormation[i] = inFormation;
  }
}
