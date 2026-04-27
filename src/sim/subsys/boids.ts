/**
 * Field-based boid steering.
 *
 * Per tick:
 *   1. Build boid fields (density, centroid, velocity per side*role).
 *   2. For each rac, sample local field values and combine into a
 *      desired-direction vector. Velocity = desired_direction × maxV.
 *
 * Forces (all combined into a *direction* — magnitude is the maxV cap):
 *   - separation: down-gradient of total density. Smooth: at the
 *     center of a tight cluster the gradient is ~0, so units can
 *     legitimately bunch. Only an asymmetric "edge of crowd" produces
 *     a meaningful push.
 *   - cohesion: toward local same-side same-role centroid. 0 for roles
 *     where cohesion is disabled (cavalry, archer per defaults).
 *   - alignment: toward local average same-side same-role velocity.
 *   - target seek: toward (or away, archer kite) current target.
 *
 * Velocity model: "always travel at maxV in the desired direction." On
 * a 100m field with maxV up to 20 m/s, summing small force vectors and
 * capping to maxV produced sub-walking-speed motion (~25% of intent)
 * because the K coefficients hadn't been rescaled. This model decouples
 * intent direction from intent magnitude — K values become *weights*
 * for blending direction, not target speeds.
 *
 * Cost: O(N) for build + O(N) for sample. No spatial-grid allocations,
 * no closures. Path length per rac is constant ~80 field reads + a
 * handful of trig ops. Scales cleanly to thousands of racs.
 */

import type { ContentBundle } from "../content.js";
import { ROLE_ARCHER, ROLE_CAVALRY } from "../content.js";
import type { Logger } from "../log.js";
import {
  SECONDS_PER_TICK,
  TARGET_KIND_BIN,
  TARGET_KIND_RAC,
  type BattleState,
  findBinRowById,
  findRacRowById,
} from "../state.js";
import { allocBoidFields, buildBoidFields, sampleField } from "../fields.js";
import { computeDoctrineMod } from "../doctrines.js";

/** Step (meters) used for central-difference gradient of the density
 *  field. Smaller = sharper response to local density variation; too
 *  small = numerical noise. ~half a cell is a reasonable default. */
const GRADIENT_STEP = 2.0;

export function boidsTick(state: BattleState, content: ContentBundle, log: Logger): void {
  void log;
  const dt = SECONDS_PER_TICK;
  const n = state.rac.count;
  const halfW = state.bounds.w * 0.5;
  const halfH = state.bounds.h * 0.5;

  // Lazy alloc: fields persist on state.
  if (!state._boidFields) {
    state._boidFields = allocBoidFields(state.bounds.w, state.bounds.h);
  }
  const fields = state._boidFields;
  buildBoidFields(state, fields);

  for (let i = 0; i < n; i++) {
    if (!state.rac.alive[i]) continue;
    const unitId = state.unitIdTable[state.rac.unitIdIdx[i]];
    const unit = content.units.get(unitId);
    if (!unit) continue;
    // Read the rac's effective profile via its formation, switching
    // between MARCH (loose, mobile) and CONTACT (tight, locked-shields)
    // mode based on the contact flag set below from enemy proximity.
    // Formations without a contactOverride have identical profiles
    // for both modes.
    const profile = state.rac.contact[i]
      ? state.formationContactProfile[state.rac.owner[i]][state.rac.formationIdx[i]]
      : state.formationProfile[state.rac.owner[i]][state.rac.formationIdx[i]];
    const myX = state.rac.x[i];
    const myY = state.rac.y[i];
    const myVx = state.rac.vx[i];
    const myVy = state.rac.vy[i];
    const myOwner = state.rac.owner[i];
    const myRole = state.rac.role[i];
    const myCh = myOwner * 4 + myRole;

    // ---- Separation: -gradient of total density. ----
    // We sample density at ±h on each axis and take central differences.
    // Subtracting the unit's own contribution is unnecessary because
    // the symmetric finite-difference cancels self-influence at the
    // sample point; the unit only affects the gradient via off-axis
    // splat which is dominated by neighbors when neighbors are present.
    const densL = sampleField(fields, fields.totalDensity, myX - GRADIENT_STEP, myY);
    const densR = sampleField(fields, fields.totalDensity, myX + GRADIENT_STEP, myY);
    const densD = sampleField(fields, fields.totalDensity, myX, myY - GRADIENT_STEP);
    const densU = sampleField(fields, fields.totalDensity, myX, myY + GRADIENT_STEP);
    const gradX = (densR - densL) / (2 * GRADIENT_STEP);
    const gradY = (densU - densD) / (2 * GRADIENT_STEP);
    const sepK = profile.separationK;
    let sepX = -gradX * sepK;
    let sepY = -gradY * sepK;

    // ---- Doctrine modulation: phase-based behavior. ----
    // Compute "in attack range" = rac's target is alive and within
    // effRange. This drives contact-phase strategies (hold and fight,
    // kite, harass-disengage). The 8m formation-contact flag
    // (state.rac.contact[i]) is separate and drives synaspismos
    // tightening.
    let inAttackRangeForDoctrine = false;
    {
      const myR = state.rac.effRange[i];
      const myR2 = myR * myR;
      const tid = state.rac.targetId[i];
      const tk = state.rac.targetKind[i];
      if (tk === TARGET_KIND_RAC && tid >= 0) {
        const tRow = state.racRowById.get(tid);
        if (tRow !== undefined && state.rac.alive[tRow]) {
          const dx = state.rac.x[tRow] - state.rac.x[i];
          const dy = state.rac.y[tRow] - state.rac.y[i];
          if (dx * dx + dy * dy <= myR2) inAttackRangeForDoctrine = true;
        }
      } else if (tk === TARGET_KIND_BIN && tid >= 0) {
        const tRow = state.binRowById.get(tid);
        if (tRow !== undefined && state.bin.alive[tRow]) {
          const dx = state.bin.x[tRow] - state.rac.x[i];
          const dy = state.bin.y[tRow] - state.rac.y[i];
          if (dx * dx + dy * dy <= myR2) inAttackRangeForDoctrine = true;
        }
      }
    }
    const dMod = computeDoctrineMod({
      state,
      fields,
      i,
      myOwner: state.rac.owner[i] as 0 | 1,
      myX: state.rac.x[i],
      myY: state.rac.y[i],
      teamId: state.rac.teamId[i],
      tick: state.tick,
      inAttackRange: inAttackRangeForDoctrine,
    });

    // ---- Leadership: per-rac boldness in [0,1) from id hash. -------
    // Roughly 20% of units come out highly bold (commit-to-mission),
    // 80% are followers that stick to formation. Without this, a
    // small pack with everyone trying to follow everyone else gets
    // stuck circling the centroid (classic boid pathology). Bold
    // units provide stable intent that the rest can fall in behind.
    // Bias is deterministic per rac id, so seeds remain reproducible.
    const idHash = ((state.rac.id[i] * 2654435761) >>> 0) / 4294967296;
    const bold = idHash; // [0,1)
    const seekKEff = profile.targetSeekK * (1 + bold) * dMod.seekKMul;
    const cohKEff = profile.cohesionK * (1 - bold * 0.8) * dMod.cohesionKMul;
    const alignKEff = profile.alignmentK * (1 - bold * 0.8);

    // ---- Cohesion: toward local same-side same-role centroid. ----
    let cohX = 0;
    let cohY = 0;
    if (cohKEff > 0) {
      const myDens = sampleField(fields, fields.density[myCh], myX, myY);
      if (myDens > 1e-3) {
        const cx = sampleField(fields, fields.centroidNumX[myCh], myX, myY) / myDens;
        const cy = sampleField(fields, fields.centroidNumY[myCh], myX, myY) / myDens;
        const tdx = cx - myX;
        const tdy = cy - myY;
        const td = Math.hypot(tdx, tdy);
        if (td > 1e-3) {
          cohX = (tdx / td) * cohKEff;
          cohY = (tdy / td) * cohKEff;
        }
      }
    }

    // ---- Alignment: toward local same-side same-role average velocity. ----
    let alignX = 0;
    let alignY = 0;
    if (alignKEff > 0) {
      const myDens = sampleField(fields, fields.density[myCh], myX, myY);
      if (myDens > 1e-3) {
        const avgVx = sampleField(fields, fields.velNumX[myCh], myX, myY) / myDens;
        const avgVy = sampleField(fields, fields.velNumY[myCh], myX, myY) / myDens;
        // We use the velocity vector itself as a direction, normalized.
        // The "match average velocity" intent is satisfied by aiming
        // the same way the local crowd is going.
        const len = Math.hypot(avgVx, avgVy);
        if (len > 1e-3) {
          alignX = (avgVx / len) * alignKEff;
          alignY = (avgVy / len) * alignKEff;
        }
      }
    }

    // ---- Target seek (or kite-to-distance for archers). ----
    // Reads BOTH rac and bin targets — without this dispatch, units
    // whose only enemies are bins (all enemy racs dead) end up with
    // tid pointing to a bin id but findRacRowById returns -1 and the
    // unit freezes in place. That was the "vibrating in own territory
    // while enemy bins survive" symptom.
    let seekX = 0;
    let seekY = 0;
    const kiteFrac = profile.archerKiteFraction;
    const tid = state.rac.targetId[i];
    const tkind = state.rac.targetKind[i];
    let tgtX = 0;
    let tgtY = 0;
    let tgtFound = false;
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
    // Stop-in-combat: when an enemy is within our effective attack
    // range, non-cavalry units stand still and let combat.ts swing.
    // Cavalry uniquely keep moving so they can overrun and chase
    // through. Without this rule infantry/tanks vibrate around their
    // target while attacks land randomly — visually messy and design-
    // wrong (a melee unit that's already in range has no reason to
    // keep walking).
    let inCombat = false;
    if (tgtFound && myRole !== ROLE_CAVALRY) {
      const tdx0 = tgtX - myX;
      const tdy0 = tgtY - myY;
      const tdist = Math.hypot(tdx0, tdy0);
      const myRange = state.rac.effRange[i];
      if (tdist <= myRange) inCombat = true;
    }

    // Doctrine seekDirOverride: when set, ignore target seek and use
    // the override direction (retreat to bin, rush to fight, flank).
    if (dMod.seekDirOverride) {
      seekX = dMod.seekDirOverride.dx * seekKEff;
      seekY = dMod.seekDirOverride.dy * seekKEff;
    } else if (tgtFound && !inCombat) {
      const tdx = tgtX - myX;
      const tdy = tgtY - myY;
      const td2 = tdx * tdx + tdy * tdy;
      if (td2 > 1e-6) {
        const td = Math.sqrt(td2);
        if (myRole === ROLE_ARCHER && kiteFrac > 0 && state.rac.effRange[i] > 0) {
          // Deadband around preferred kite distance: ±10%. Inside
          // the band, seek is zero so the archer settles instead of
          // bouncing through the boundary every tick.
          const preferred = state.rac.effRange[i] * kiteFrac;
          let k = 0;
          if (td > preferred * 1.1) k = seekKEff;
          else if (td < preferred * 0.9) k = -seekKEff * 1.2;
          seekX = (tdx / td) * k;
          seekY = (tdy / td) * k;
        } else {
          seekX = (tdx / td) * seekKEff;
          seekY = (tdy / td) * seekKEff;
        }
      }
    }

    // ---- Hide-behind: stay behind friendlies, between me and enemy. ----
    // Sample friendly density at points STANDOFF meters ahead and
    // behind along the enemy direction. The unit is pulled toward the
    // side with more friendlies — naturally backs an archer up when
    // its allies are advancing in front, and pulls it forward when
    // friendlies have moved past it. No effect for hideBehindK = 0
    // (tanks/cavalry/infantry by default).
    let hideX = 0;
    let hideY = 0;
    if (profile.hideBehindK > 0 && tgtFound) {
      const dx0 = tgtX - myX;
      const dy0 = tgtY - myY;
      const len = Math.hypot(dx0, dy0);
      if (len > 1e-3) {
        const ux = dx0 / len;
        const uy = dy0 / len;
        const standoff = profile.hideStandoff;
        const aheadX = myX + ux * standoff;
        const aheadY = myY + uy * standoff;
        const behindX = myX - ux * standoff;
        const behindY = myY - uy * standoff;
        const sideD = fields.sideDensity[myOwner];
        const friendlyAhead = sampleField(fields, sideD, aheadX, aheadY);
        const friendlyBehind = sampleField(fields, sideD, behindX, behindY);
        // Negative gradient along enemy direction = "more friendlies
        // behind than ahead" → push forward into the screen (we're
        // exposed in front because there's nobody between us and the
        // enemy). Wait — that's backwards. Reread: if friendliesAhead
        // > friendliesBehind, my friendlies ARE between me and the
        // enemy → I'm well-positioned, no push. If friendliesAhead <
        // friendliesBehind, friendlies are BEHIND me (I've gotten
        // ahead of them) → push backward toward the friendlies. So
        // force direction is along (behind - ahead) × dir = -dir ×
        // (ahead - behind). Negative gradient → backward push.
        const grad = friendlyAhead - friendlyBehind;
        // grad > 0 → friendlies in front, no force needed
        // grad < 0 → friendlies behind, push backward
        if (grad < 0) {
          const k = profile.hideBehindK;
          hideX = -ux * (-grad) * k;
          hideY = -uy * (-grad) * k;
        }
      }
    }

    // ---- Per-rac angular flank bias to break lockstep. ----
    // Deterministic offset based on rac id and per-role flankBiasK.
    // Cavalry flanks visibly (K=0.4 → ±23°), infantry slightly
    // spreads (0.15), archer/tank mostly straight. Adjacent racs
    // from the same spawn pick different sides of the approach.
    const jitterAngle = Math.sin(state.rac.id[i] * 0.7) * profile.flankBiasK;
    const ca = Math.cos(jitterAngle);
    const sa = Math.sin(jitterAngle);
    let dvx = sepX + cohX + alignX + seekX + hideX;
    let dvy = sepY + cohY + alignY + seekY + hideY;
    const rotX = dvx * ca - dvy * sa;
    const rotY = dvx * sa + dvy * ca;
    dvx = rotX;
    dvy = rotY;

    // ---- Contact mode flag: any enemy within CONTACT_RADIUS ----
    // Drives the march/contact formation switch read at the top of
    // this iteration. Sampled from the per-side enemy density field —
    // cheap and smooth. Threshold tuned so a single nearby enemy
    // triggers contact, not just a distant blob.
    const CONTACT_RADIUS = 8;
    const CONTACT_THRESHOLD = 0.15;
    const enemyDcontact = fields.sideDensity[1 - myOwner];
    const dContact = sampleField(fields, enemyDcontact, myX, myY)
      + sampleField(fields, enemyDcontact, myX + CONTACT_RADIUS, myY)
      + sampleField(fields, enemyDcontact, myX - CONTACT_RADIUS, myY)
      + sampleField(fields, enemyDcontact, myX, myY + CONTACT_RADIUS)
      + sampleField(fields, enemyDcontact, myX, myY - CONTACT_RADIUS);
    state.rac.contact[i] = dContact > CONTACT_THRESHOLD ? 1 : 0;

    // ---- Surrounded check: enemy density in 4 quadrants. ----
    // If enemies are present at non-trivial density in ≥3 cardinal
    // quadrants (N/S/E/W within SURROUND_RADIUS), this unit is being
    // outflanked. Apply movement slow + damage-taken bump for combat.
    // Using the per-side density field: enemies are the OTHER side.
    const SURROUND_RADIUS = 6;
    const SURROUND_THRESHOLD = 0.3;
    const SURROUND_SPEED_MUL = 0.7;
    const SURROUND_DMG_MUL = 1.15;
    const enemyD = fields.sideDensity[1 - myOwner];
    const dN = sampleField(fields, enemyD, myX, myY + SURROUND_RADIUS);
    const dS = sampleField(fields, enemyD, myX, myY - SURROUND_RADIUS);
    const dE = sampleField(fields, enemyD, myX + SURROUND_RADIUS, myY);
    const dW = sampleField(fields, enemyD, myX - SURROUND_RADIUS, myY);
    let qCount = 0;
    if (dN > SURROUND_THRESHOLD) qCount++;
    if (dS > SURROUND_THRESHOLD) qCount++;
    if (dE > SURROUND_THRESHOLD) qCount++;
    if (dW > SURROUND_THRESHOLD) qCount++;
    const surrounded = qCount >= 3;
    // Support bonus: friendly density at this rac's position confers
    // a damage-taken reduction (rear ranks supporting front ranks —
    // the phalanx mechanic). Profile-controlled per role/formation.
    // Combines multiplicatively with surrounded penalty: a phalanx
    // that's surrounded is still tougher than a lone unit surrounded,
    // because rear ranks still help.
    let dmgMul = surrounded ? SURROUND_DMG_MUL : 1;
    if (profile.supportBonusMax > 0) {
      const friendlyHere = sampleField(fields, fields.sideDensity[myOwner], myX, myY);
      const supportFrac = Math.min(1, Math.max(0, friendlyHere / profile.supportBonusFullAt));
      dmgMul *= 1 - profile.supportBonusMax * supportFrac;
    }
    state.rac.surroundedDamageMul[i] = dmgMul;

    // ---- Velocity: maxV when intent is committed, else damp. ----
    // Strong intent (force magnitude above threshold) → travel at
    // maxV in the force direction. Weak intent → blend the (small)
    // direction toward maxV proportionally and bleed off momentum.
    // Without the threshold, an archer in its kite deadband (seek=0,
    // tiny self-overlap density gradient remaining) would still go
    // at full speed in the noise direction. The threshold separates
    // "I want to GO" from "I want to STAY."
    const maxV = state.rac.effSpeed[i] * (surrounded ? SURROUND_SPEED_MUL : 1) * dMod.speedMul;
    const desiredLen = Math.hypot(dvx, dvy);
    const COMMIT_THRESHOLD = 0.5; // intent must exceed this to maxV-go
    let newVx: number;
    let newVy: number;
    if (inCombat) {
      // In melee/at range: hold position. Bleed velocity hard so the
      // unit settles in one or two ticks. Cavalry skips this branch
      // entirely (handled at the inCombat compute site).
      newVx = myVx * 0.2;
      newVy = myVy * 0.2;
    } else if (desiredLen > COMMIT_THRESHOLD) {
      newVx = (dvx / desiredLen) * maxV;
      newVy = (dvy / desiredLen) * maxV;
    } else if (desiredLen > 1e-3) {
      // Soft intent: ramp from "drift" to "go" linearly across the
      // sub-threshold band. Also bleed existing velocity so the unit
      // doesn't accumulate noise into a fast drift.
      const frac = desiredLen / COMMIT_THRESHOLD;
      const intentVx = (dvx / desiredLen) * maxV * frac;
      const intentVy = (dvy / desiredLen) * maxV * frac;
      newVx = intentVx + myVx * 0.5 * (1 - frac);
      newVy = intentVy + myVy * 0.5 * (1 - frac);
    } else {
      // No intent: bleed off existing velocity rather than stop dead.
      newVx = myVx * 0.5;
      newVy = myVy * 0.5;
    }

    // Inertia blend (Tank uses 0.5 for "don't snap" feel).
    const blend = profile.inertiaBlend;
    if (blend > 0) {
      newVx = myVx * blend + newVx * (1 - blend);
      newVy = myVy * blend + newVy * (1 - blend);
    }

    state.rac.vx[i] = newVx;
    state.rac.vy[i] = newVy;

    let nx = myX + newVx * dt;
    let ny = myY + newVy * dt;
    if (nx > halfW) {
      nx = halfW;
      state.rac.vx[i] = 0;
    } else if (nx < -halfW) {
      nx = -halfW;
      state.rac.vx[i] = 0;
    }
    if (ny > halfH) {
      ny = halfH;
      state.rac.vy[i] = 0;
    } else if (ny < -halfH) {
      ny = -halfH;
      state.rac.vy[i] = 0;
    }
    state.rac.x[i] = nx;
    state.rac.y[i] = ny;
    state.rac.prevFacing[i] = state.rac.facing[i];
    if (newVx !== 0 || newVy !== 0) {
      state.rac.facing[i] = Math.atan2(newVy, newVx);
    }
  }
}
