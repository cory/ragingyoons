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
import { ROLE_INFANTRY } from "../content.js";
import { allocBoidFields, buildBoidFields, sampleField } from "../fields.js";
import { forEachNear } from "../grid.js";
import type { Logger } from "../log.js";
import {
  BEHAVIOR_CADENCE_BY_ROLE,
  BEHAVIOR_ENGAGE,
  BEHAVIOR_MARCH,
  BEHAVIOR_ROUT,
  MORALE_BREAK_THRESHOLD,
  MORALE_BREAK_THRESHOLD_BY_ENV,
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

    // ----- Behavior decision (cadence-gated) -----
    if (tickNow >= state.rac.nextDecisionTick[i]) {
      let next = state.rac.behavior[i];
      if (broken) {
        next = BEHAVIOR_ROUT;
      } else if (tgtFound && distToTarget <= state.rac.effRange[i] * ENGAGE_BAND_MUL) {
        next = BEHAVIOR_ENGAGE;
      } else {
        next = BEHAVIOR_MARCH;
      }
      state.rac.behavior[i] = next;
      const cadence = BEHAVIOR_CADENCE_BY_ROLE[role] ?? 8;
      state.rac.nextDecisionTick[i] = tickNow + Math.max(1, cadence);
    }
    const behavior = state.rac.behavior[i];

    // ----- Compute motion intent -----
    let desiredVx = 0;
    let desiredVy = 0;
    const maxV = state.rac.effSpeed[i];

    if (behavior === BEHAVIOR_ROUT) {
      // Flee from nearest enemy. We don't have a precomputed nearest-
      // enemy field on the rac, so use the spatial grid. If no enemy
      // visible, flee away from the current target if known, else hold.
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
      const dx = myX - fleeFromX;
      const dy = myY - fleeFromY;
      const d = Math.hypot(dx, dy);
      if (d > 1e-3) {
        const speed = maxV * ROUT_SPEED_MUL;
        desiredVx = (dx / d) * speed;
        desiredVy = (dy / d) * speed;
      }
    } else if (behavior === BEHAVIOR_ENGAGE) {
      // Hold at attack range. If target is found and we're within
      // effRange, vel = 0. If outside, walk toward target.
      if (tgtFound && distToTarget > state.rac.effRange[i]) {
        const dx = tgtX - myX;
        const dy = tgtY - myY;
        const d = distToTarget;
        if (d > 1e-3) {
          desiredVx = (dx / d) * maxV;
          desiredVy = (dy / d) * maxV;
        }
      }
      // else: hold (desired = 0). Combat applies damage on its own
      // schedule.
    } else {
      // BEHAVIOR_MARCH
      // Infantry follower with a live leader: slot-direct steering.
      // Aim at the predicted (leader.pos + leader.vel × dt + slot) so
      // a moving leader doesn't leave the squad behind.
      const usesFormation = role === ROLE_INFANTRY;
      if (usesFormation && !isLeader && leaderAlive) {
        const lx = state.rac.x[leaderRow];
        const ly = state.rac.y[leaderRow];
        const lvx = state.rac.vx[leaderRow];
        const lvy = state.rac.vy[leaderRow];
        const sX = lx + lvx * dt + state.rac.slotDx[i];
        const sY = ly + lvy * dt + state.rac.slotDy[i];
        const dx = sX - myX;
        const dy = sY - myY;
        const reqSpeed = Math.hypot(dx, dy) / dt;
        if (reqSpeed > maxV) {
          const inv = 1 / Math.hypot(dx, dy);
          desiredVx = dx * inv * maxV;
          desiredVy = dy * inv * maxV;
        } else {
          desiredVx = dx / dt;
          desiredVy = dy / dt;
        }
      } else if (tgtFound) {
        // Leader / non-formation roles: aim at world target.
        const dx = tgtX - myX;
        const dy = tgtY - myY;
        const d = distToTarget;
        if (d > 1e-3) {
          desiredVx = (dx / d) * maxV;
          desiredVy = (dy / d) * maxV;
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
    const profile = state.rac.contact[i]
      ? state.formationContactProfile[state.rac.owner[i]][state.rac.formationIdx[i]]
      : state.formationProfile[state.rac.owner[i]][state.rac.formationIdx[i]];
    const supportMax = profile.supportBonusMax;
    const supportFullAt = profile.supportBonusFullAt;
    let dmgMul = 1;
    if (supportMax > 0 && supportFullAt > 0) {
      const myCh = state.rac.owner[i] === 0 ? 0 : 1;
      const friendlyDens = sampleField(fields, fields.density[myCh], myX, myY);
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

    // inFormation flag: infantry follower at slot, not broken. Read
    // by combat for the frontal damage/defense bonus. Independent of
    // behavior — if you're at your slot, you're in formation, even
    // if you're currently in engage state.
    let inFormation = 0;
    if (
      role === ROLE_INFANTRY &&
      !isLeader &&
      leaderAlive &&
      !broken
    ) {
      const lx = state.rac.x[leaderRow];
      const ly = state.rac.y[leaderRow];
      const sX = lx + state.rac.slotDx[i];
      const sY = ly + state.rac.slotDy[i];
      if (Math.hypot(sX - state.rac.x[i], sY - state.rac.y[i]) < IN_FORMATION_R) {
        inFormation = 1;
      }
    }
    state.rac.inFormation[i] = inFormation;
  }
}
