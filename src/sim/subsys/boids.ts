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
import { forEachNear } from "../grid.js";
import type { Logger } from "../log.js";
import {
  MORALE_BREAK_THRESHOLD,
  MORALE_BREAK_THRESHOLD_BY_ENV,
  SECONDS_PER_TICK,
  TARGET_KIND_BIN,
  TARGET_KIND_RAC,
  type BattleState,
  type ForceFlag,
  FORCE_COMPONENT_INDEX,
  FORCE_FLOATS_PER_RAC,
  findBinRowById,
  findRacRowById,
} from "../state.js";
import { allocBoidFields, buildBoidFields, sampleField } from "../fields.js";
import { computeDoctrineMod, DOCTRINE_KNOBS, DOCTRINES } from "../doctrines.js";

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

  // Steering-lab: per-force gates. Missing flag = enabled. The lab
  // sets state.forceFlags to study the isolated effect of each term.
  const flags = state.forceFlags;
  const flag = (k: ForceFlag): boolean => flags?.[k] !== false;
  const f_separation = flag("separation");
  const f_closeRange = flag("closeRange");
  const f_cohesion = flag("cohesion");
  const f_alignment = flag("alignment");
  const f_seek = flag("seek");
  const f_hide = flag("hide");
  const f_avoid = flag("avoid");
  const f_envelopment = flag("envelopment");
  const f_doctrineMod = flag("doctrineMod");
  const f_slotOffset = flag("slotOffset");

  // Steering-lab: optional debug capture of per-rac force components.
  // Sized state.rac.id.length × FORCE_FLOATS_PER_RAC; reused across
  // ticks (caller must clear / read between runs as needed). When
  // undefined, no capture happens — zero overhead in production.
  const dbg = state._debugForces;

  // Lazy alloc: fields persist on state.
  if (!state._boidFields) {
    state._boidFields = allocBoidFields(state.bounds.w, state.bounds.h);
  }
  const fields = state._boidFields;
  buildBoidFields(state, fields);

  // Compute per-group centroids for cohesion. Splitting also happens
  // here when a group exceeds its doctrine's maxFormationSize. This
  // replaces the old field-based cohesion which had no notion of
  // distinct groups (so two phalanxes from different bins would pull
  // toward each other across 30m of empty field).
  const groupStats = computeGroupStats(state);
  applyFormationSplits(state, groupStats);

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
    // Split field-based separation from close-range pairwise. Field
    // separation pushes a rac DOWN the local density gradient — fine
    // for steering crowds, but it fights the slot-pull on edge racs in
    // a tight formation (the edge always sees a "go outward" gradient,
    // and that drag stops them keeping up with the leader). So field-
    // sep gets gated by inSlot below; close-range stays always-on so
    // physical overlap (two racs at the same point) is still resolved.
    let fieldSepX = f_separation ? -gradX * sepK : 0;
    let fieldSepY = f_separation ? -gradY * sepK : 0;
    let closeSepX = 0;
    let closeSepY = 0;

    // ---- Close-range hard separation (anti-overlap). ----
    // The field-based separation above operates at 4m cell granularity
    // — two racs 0.5m apart contribute equal density at the sample
    // point and produce ~zero gradient, so they happily pile on each
    // other. This explicit per-pair scan within CLOSE_R catches that
    // case.
    //
    // CLOSE_R is intentionally TIGHT (~body diameter): we only want
    // to fix actual overlap, not disrupt formation pitch. Phalanx
    // uses 1.4m grid pitch; if CLOSE_R > 1.4m it would push the
    // ranks apart and the phalanx never forms its block. 0.8m is
    // ~2× the raccoon body radius (0.5m) — units within that range
    // are visually overlapping; further apart, the formation's own
    // cohesion handles spacing.
    const CLOSE_R = 0.8;
    const CLOSE_R2 = CLOSE_R * CLOSE_R;
    const CLOSE_K = 10.0;
    const grid = state._racGrid;
    if (grid && f_closeRange) {
      forEachNear(grid, myX, myY, CLOSE_R, (j) => {
        if (j === i) return;
        if (!state.rac.alive[j]) return;
        const dx = myX - state.rac.x[j];
        const dy = myY - state.rac.y[j];
        const d2 = dx * dx + dy * dy;
        if (d2 >= CLOSE_R2) return;
        if (d2 < 1e-6) {
          // Perfect overlap (e.g., spawn jitter rounded both to the
          // same point). Push apart along a deterministic direction
          // derived from the id pair so the system is reproducible
          // and doesn't lock both at (0,0) forever.
          const h = ((state.rac.id[i] * 31 + state.rac.id[j]) >>> 0) / 4294967296;
          const ang = h * Math.PI * 2;
          closeSepX += Math.cos(ang) * CLOSE_K;
          closeSepY += Math.sin(ang) * CLOSE_K;
          return;
        }
        const d = Math.sqrt(d2);
        const w = ((CLOSE_R - d) / CLOSE_R) * CLOSE_K;
        closeSepX += (dx / d) * w;
        closeSepY += (dy / d) * w;
      });
    }

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
    // Doctrine multipliers fold in here unless the lab disables them.
    const dSeekMul = f_doctrineMod ? dMod.seekKMul : 1;
    const dCohMul = f_doctrineMod ? dMod.cohesionKMul : 1;
    const seekKEff = profile.targetSeekK * (1 + bold) * dSeekMul;
    const cohKEff = profile.cohesionK * (1 - bold * 0.8) * dCohMul;
    const alignKEff = profile.alignmentK * (1 - bold * 0.8);

    // ---- Cohesion: toward this rac's slot in the group formation. ----
    // Each rac has a slot offset from the formation's arrange() at spawn.
    // We pull toward (groupCentroid + slot) so the formation HOLDS its
    // shape on the march instead of collapsing into a point. With a
    // bare-centroid pull, every rac in a 10-wide line drags toward the
    // line's middle and the line caves in to a tight clump in seconds.
    // Slot-aware pull also lets shape-mode actually reform into the
    // selected formation: spawn jitter + slot offsets means the boid
    // system is doing the formation work each tick, not just at spawn.
    // Look up the rac's target early — we need distance-to-target to
    // collapse the slot offset for envelopment, which then feeds BOTH
    // cohesion (formation tightens as it closes on target) and seek
    // (each rac aims at a personal point on the formation that shrinks
    // toward the bare target as the rac approaches).
    const tidEarly = state.rac.targetId[i];
    const tkindEarly = state.rac.targetKind[i];
    let tgtXEarly = 0, tgtYEarly = 0, tgtFoundEarly = false;
    if (tidEarly >= 0 && tkindEarly === TARGET_KIND_RAC) {
      const tRow = findRacRowById(state, tidEarly);
      if (tRow >= 0) { tgtXEarly = state.rac.x[tRow]; tgtYEarly = state.rac.y[tRow]; tgtFoundEarly = true; }
    } else if (tidEarly >= 0 && tkindEarly === TARGET_KIND_BIN) {
      const tRow = findBinRowById(state, tidEarly);
      if (tRow >= 0) { tgtXEarly = state.bin.x[tRow]; tgtYEarly = state.bin.y[tRow]; tgtFoundEarly = true; }
    }
    // Envelopment factor: full slot far from target, collapses to 0
    // at the target itself. Without this the line marches at full slot
    // pitch all the way to the target and stops in a wide line — no
    // visible converge or wrap. With it, the formation tightens
    // uniformly as it closes (and ends up clustered AT the target,
    // not lined up beside it).
    const ENVELOP_R = 15;
    const distToTarget = tgtFoundEarly ? Math.hypot(tgtXEarly - myX, tgtYEarly - myY) : Number.POSITIVE_INFINITY;
    const fEnvelop = (f_envelopment && tgtFoundEarly) ? distToTarget / (distToTarget + ENVELOP_R) : 1;
    const effSlotS = profile.slotScale * fEnvelop;
    const slotMul = f_slotOffset ? effSlotS : 0;
    const mySlotDx = state.rac.slotDx[i] * slotMul;
    const mySlotDy = state.rac.slotDy[i] * slotMul;

    // Formation discipline: a rac with morale above the break
    // threshold ignores boid forces entirely and aims directly at its
    // slot. Boids only kick in when broken (morale crashed under
    // damage) or when doctrine says independent-in-contact.
    //
    // Leaders are never followers (they drive); broken racs go full
    // boid (the whole point of breaking is they stop holding the
    // line); independent-in-contact doctrines (skirmisher, fire-team,
    // fanatic) drop the leader-pull on first contact.
    const myRacId = state.rac.id[i];
    const myLeaderId = state.rac.squadLeaderId[i];
    const isLeader = myLeaderId === myRacId || myLeaderId < 0;
    const doc = DOCTRINES[state.rac.doctrineIdx[i]];
    const inIndependentContact =
      !!doc && doc.independentInContact && state.rac.contact[i] === 1;
    // Per-environment break threshold (city=0.1 holds tight, coastal=
    // 0.5 breaks fast). Falls back to the global default if the env
    // table is somehow short.
    const breakThreshold =
      MORALE_BREAK_THRESHOLD_BY_ENV[state.rac.env[i]] ?? MORALE_BREAK_THRESHOLD;
    const broken = state.rac.morale[i] < breakThreshold;
    let leaderRow = -1;
    let leaderTx = 0, leaderTy = 0;
    let leaderTargetFound = false;
    if (!isLeader) {
      leaderRow = findRacRowById(state, myLeaderId);
      if (leaderRow >= 0) {
        leaderTx = state.rac.x[leaderRow] + mySlotDx;
        leaderTy = state.rac.y[leaderRow] + mySlotDy;
        leaderTargetFound = true;
      }
    }
    // inFormation: this rac is a non-broken follower with a live
    // leader and no doctrine override. Use slot-direct steering and
    // skip the entire force pipeline for movement.
    const inFormation =
      !isLeader && leaderTargetFound && !broken && !inIndependentContact;
    // For racs NOT in formation (leader, broken, independent), boids
    // computes forces normally. We keep `cohX/cohY` for the leader-pull
    // intent only when actively pulling — but since inFormation racs
    // bypass forces and the others are explicitly NOT pulling, cohX/Y
    // stays at zero here. That removes the old leader-pull-when-broken
    // behavior; broken racs are on their own.
    const cohX = 0;
    const cohY = 0;
    const followsLeader = inFormation; // legacy alias for follower seek branch below
    const shapeError = leaderTargetFound
      ? Math.hypot(leaderTx - myX, leaderTy - myY)
      : 0;

    // ---- Alignment: toward local same-side same-role average velocity. ----
    let alignX = 0;
    let alignY = 0;
    if (alignKEff > 0 && f_alignment) {
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
    // Reuse the early target lookup (used above for envelopment scaling).
    const tgtX = tgtXEarly;
    const tgtY = tgtYEarly;
    const tgtFound = tgtFoundEarly;
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
    // Only matters for racs NOT inFormation — formation racs bypass
    // forces entirely below.
    if (!f_seek) {
      seekX = 0;
      seekY = 0;
    } else if (f_doctrineMod && dMod.seekDirOverride) {
      seekX = dMod.seekDirOverride.dx * seekKEff;
      seekY = dMod.seekDirOverride.dy * seekKEff;
    } else if (tgtFound && !inCombat) {
      // Leader (or independent-in-contact follower): seek world target
      // with envelopment falloff. (target + slot × envelopFactor) so
      // far away the line marches wide, close in the slot collapses
      // and the formation tightens onto the target.
      const aimX = tgtX + mySlotDx;
      const aimY = tgtY + mySlotDy;
      const tdx = aimX - myX;
      const tdy = aimY - myY;
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
    if (profile.hideBehindK > 0 && tgtFound && f_hide) {
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

    // ---- Cavalry swarm avoidance: route around dense clusters. ----
    // Cavalry's high seek + low separation makes it plow through
    // crowds. Sample density along the seek lookahead; if blocked,
    // deflect perpendicular toward the side with less density. Other
    // roles (infantry/tank/archer) want to ENGAGE the crowd, not
    // dodge it, so this only fires for cavalry.
    let avoidX = 0;
    let avoidY = 0;
    if (myRole === ROLE_CAVALRY && tgtFound && f_avoid) {
      const seekDx = tgtX - myX;
      const seekDy = tgtY - myY;
      const seekLen = Math.hypot(seekDx, seekDy);
      if (seekLen > 1e-3) {
        const sx = seekDx / seekLen;
        const sy = seekDy / seekLen;
        const la = DOCTRINE_KNOBS.cavalrySwarmAvoidLookahead;
        const px = myX + sx * la;
        const py = myY + sy * la;
        const densAhead = sampleField(fields, fields.totalDensity, px, py);
        const thresh = DOCTRINE_KNOBS.cavalrySwarmAvoidThreshold;
        if (densAhead > thresh) {
          // Probe density to either perpendicular side; deflect
          // toward whichever is lighter.
          const perpX = -sy;
          const perpY = sx;
          const half = la * 0.5;
          const dLeft = sampleField(fields, fields.totalDensity, px + perpX * half, py + perpY * half);
          const dRight = sampleField(fields, fields.totalDensity, px - perpX * half, py - perpY * half);
          const sign = dLeft <= dRight ? 1 : -1;
          const strength = Math.min(densAhead - thresh, 4) * DOCTRINE_KNOBS.cavalrySwarmAvoidK;
          avoidX = perpX * sign * strength;
          avoidY = perpY * sign * strength;
        }
      }
    }

    // ---- Per-rac angular flank bias to break lockstep. ----
    // Deterministic offset based on rac id and per-role flankBiasK.
    // Cavalry flanks visibly (K=0.4 → ±23°), infantry slightly
    // spreads (0.15), archer/tank mostly straight. Adjacent racs
    // from the same spawn pick different sides of the approach.
    const sepX = fieldSepX + closeSepX;
    const sepY = fieldSepY + closeSepY;

    // Steering-lab debug capture: store the raw per-component forces
    // before the flank-bias rotation and velocity normalization. The
    // viz draws these as colored arrows centered on the rac.
    if (dbg) {
      const base = i * FORCE_FLOATS_PER_RAC;
      dbg[base + FORCE_COMPONENT_INDEX.separation * 2 + 0] = sepX;
      dbg[base + FORCE_COMPONENT_INDEX.separation * 2 + 1] = sepY;
      dbg[base + FORCE_COMPONENT_INDEX.cohesion * 2 + 0] = cohX;
      dbg[base + FORCE_COMPONENT_INDEX.cohesion * 2 + 1] = cohY;
      dbg[base + FORCE_COMPONENT_INDEX.alignment * 2 + 0] = alignX;
      dbg[base + FORCE_COMPONENT_INDEX.alignment * 2 + 1] = alignY;
      dbg[base + FORCE_COMPONENT_INDEX.seek * 2 + 0] = seekX;
      dbg[base + FORCE_COMPONENT_INDEX.seek * 2 + 1] = seekY;
      dbg[base + FORCE_COMPONENT_INDEX.hide * 2 + 0] = hideX;
      dbg[base + FORCE_COMPONENT_INDEX.hide * 2 + 1] = hideY;
      dbg[base + FORCE_COMPONENT_INDEX.avoid * 2 + 0] = avoidX;
      dbg[base + FORCE_COMPONENT_INDEX.avoid * 2 + 1] = avoidY;
    }

    const jitterAngle = Math.sin(state.rac.id[i] * 0.7) * profile.flankBiasK;
    const ca = Math.cos(jitterAngle);
    const sa = Math.sin(jitterAngle);
    let dvx = sepX + cohX + alignX + seekX + hideX + avoidX;
    let dvy = sepY + cohY + alignY + seekY + hideY + avoidY;
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
    // For the phalanx doctrine in contact, the support-bonus magnitude
    // is overridden by the autotuner knob (so the GA can rebalance
    // without editing formation cards). Other formations use their
    // profile value as before.
    const supportMaxEff =
      state.rac.doctrineIdx[i] === 1 /* phalanx */ && state.rac.contact[i]
        ? DOCTRINE_KNOBS.phalanxSupportMax
        : profile.supportBonusMax;
    if (supportMaxEff > 0) {
      const friendlyHere = sampleField(fields, fields.sideDensity[myOwner], myX, myY);
      const supportFrac = Math.min(1, Math.max(0, friendlyHere / profile.supportBonusFullAt));
      dmgMul *= 1 - supportMaxEff * supportFrac;
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
    // Phalanx contact speed: when this rac is the phalanx doctrine
    // and in formation-contact mode, the autotuner can override the
    // contact-mode slowdown (formation override is 0.2 default).
    const phalanxContactSlow =
      state.rac.doctrineIdx[i] === 1 /* phalanx */ && state.rac.contact[i]
        ? DOCTRINE_KNOBS.phalanxContactSpeed / 0.2 // ratio vs the formation's hardcoded 0.2
        : 1;
    const maxV =
      state.rac.effSpeed[i] *
      (surrounded ? SURROUND_SPEED_MUL : 1) *
      dMod.speedMul *
      phalanxContactSlow;
    const desiredLen = Math.hypot(dvx, dvy);
    const COMMIT_THRESHOLD = 0.5; // intent must exceed this to maxV-go
    let newVx: number;
    let newVy: number;
    if (inFormation && leaderRow >= 0) {
      // Formation discipline: a non-broken follower bypasses the
      // entire force pipeline and aims directly at its slot, predicted
      // one tick ahead by the leader's velocity. Direct velocity
      // (slotPredicted - me) / dt — capped at maxV so we don't
      // teleport across long gaps. Close-range pairwise still applies
      // as an additive nudge so two formation racs at the same point
      // resolve. This is "the rac doesn't care about boid forces; it
      // just wants to be in formation, and only switches to boids
      // when broken".
      const lx = state.rac.x[leaderRow];
      const ly = state.rac.y[leaderRow];
      const lvx = state.rac.vx[leaderRow];
      const lvy = state.rac.vy[leaderRow];
      const slotX = lx + lvx * dt + mySlotDx;
      const slotY = ly + lvy * dt + mySlotDy;
      const dxToSlot = (slotX - myX) / dt;
      const dyToSlot = (slotY - myY) / dt;
      const reqSpeed = Math.hypot(dxToSlot, dyToSlot);
      if (reqSpeed > maxV) {
        newVx = (dxToSlot / reqSpeed) * maxV;
        newVy = (dyToSlot / reqSpeed) * maxV;
      } else {
        newVx = dxToSlot;
        newVy = dyToSlot;
      }
      // Close-range anti-overlap (kept always-on so two slot-mates
      // that happen to overlap still resolve). closeSepX/Y is a force
      // direction × CLOSE_K; treat it as a velocity nudge over dt.
      newVx += closeSepX * dt;
      newVy += closeSepY * dt;
    } else if (inCombat) {
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
    // Bounds: only stop racs that were INSIDE and are about to cross
    // out. A rac that spawned off-screen (e.g. a deep platoon column
    // poking past the bounds) is allowed to march in toward the field
    // — no infinite "smash to edge" tick after tick.
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
    state.rac.prevFacing[i] = state.rac.facing[i];
    if (newVx !== 0 || newVy !== 0) {
      state.rac.facing[i] = Math.atan2(newVy, newVx);
    }
  }
}

interface GroupStats {
  count: number;
  sumX: number;
  sumY: number;
  members: number[];
  doctrineIdx: number;
  owner: 0 | 1;
}

/** Per-tick: scan alive racs, bucket by groupId, compute centroid
 *  position and member list. Used by cohesion (centroid pull) and
 *  by the split logic below (member partitioning). */
function computeGroupStats(state: BattleState): Map<number, GroupStats> {
  const out = new Map<number, GroupStats>();
  for (let i = 0; i < state.rac.count; i++) {
    if (!state.rac.alive[i]) continue;
    const gid = state.rac.groupId[i];
    let s = out.get(gid);
    if (!s) {
      s = {
        count: 0,
        sumX: 0,
        sumY: 0,
        members: [],
        doctrineIdx: state.rac.doctrineIdx[i],
        owner: state.rac.owner[i] as 0 | 1,
      };
      out.set(gid, s);
    }
    s.count += 1;
    s.sumX += state.rac.x[i];
    s.sumY += state.rac.y[i];
    s.members.push(i);
  }
  return out;
}

/** When a group exceeds its doctrine's maxFormationSize, partition
 *  its members along the doctrine's splitAxis. The bigger half keeps
 *  the original groupId; the smaller half (or upper half on ties)
 *  gets state.nextGroupId++.
 *
 *  Determinism: the partition is by sorted projection onto the axis,
 *  median split, with row-index tiebreak. Same inputs → same split.
 */
function applyFormationSplits(state: BattleState, stats: Map<number, GroupStats>): void {
  // Iterate stats in groupId order so the split sequence is
  // deterministic across runs. Map iteration order is insertion;
  // computeGroupStats inserts in row-index order (which is stable
  // per tick after the per-tick shuffle).
  const sortedGids: number[] = [...stats.keys()].sort((a, b) => a - b);
  for (const gid of sortedGids) {
    const s = stats.get(gid)!;
    const def = DOCTRINES[s.doctrineIdx];
    if (!def || def.splitAxis === "none") continue;
    if (s.count <= def.maxFormationSize) continue;

    // Pick split axis as a 2D unit vector. "lateral" / "front-rear"
    // are relative to the group's seek direction (toward enemy).
    // We approximate "toward enemy" as the side-mirror: side 0
    // faces -x, side 1 faces +x.
    const forwardX = s.owner === 0 ? -1 : 1;
    const forwardY = 0;
    let axisX = 1, axisY = 0; // direction we project members along to bisect
    switch (def.splitAxis) {
      case "lateral":
        // Bisect perpendicular to forward → axis is forward direction.
        axisX = forwardX;
        axisY = forwardY;
        break;
      case "front-rear":
        // Bisect along forward → axis is perpendicular to forward.
        axisX = -forwardY;
        axisY = forwardX;
        break;
      case "perpendicular":
        // Bisect perpendicular to enemy axis (cardinal +x).
        axisX = 1;
        axisY = 0;
        break;
      case "random": {
        // Hash gid for deterministic per-group axis selection.
        const h = ((gid * 2654435761) >>> 0) / 4294967296;
        const ang = h * Math.PI * 2;
        axisX = Math.cos(ang);
        axisY = Math.sin(ang);
        break;
      }
    }

    // Project each member onto the axis (relative to centroid) and
    // sort. Lower half keeps gid; upper half gets new gid.
    const cx = s.sumX / s.count;
    const cy = s.sumY / s.count;
    const projections: { row: number; t: number }[] = s.members.map((row) => ({
      row,
      t: (state.rac.x[row] - cx) * axisX + (state.rac.y[row] - cy) * axisY,
    }));
    projections.sort((a, b) => (a.t === b.t ? a.row - b.row : a.t - b.t));
    const half = Math.floor(projections.length / 2);
    const newGid = state.nextGroupId++;
    for (let k = half; k < projections.length; k++) {
      state.rac.groupId[projections[k].row] = newGid;
    }
  }
}
