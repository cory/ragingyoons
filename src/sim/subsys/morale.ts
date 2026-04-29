/**
 * moraleTick: per-tick morale dynamics that aren't tied to direct
 * damage events. Currently runs the routing-ally cascade — held racs
 * lose morale per second when broken same-side racs are visible
 * nearby. Saturating cap so a swarm of routers doesn't compound; soft
 * floor so routing alone can't drive a steady rac below the floor
 * (combat damage still can).
 *
 * Runs after combatTick so newly-broken racs from this tick's combat
 * are visible to their neighbors next tick. Cheap: single pass with
 * the spatial grid.
 */

import { forEachNear } from "../grid.js";
import {
  BEHAVIOR_RALLY,
  FLANK_THREAT_FRONT_CONE,
  FLANK_THREAT_RADIUS,
  FLANK_THREAT_RATE,
  FLANK_THREAT_REAR_CONE,
  MORALE_BREAK_THRESHOLD,
  MORALE_BREAK_THRESHOLD_BY_ENV,
  MORALE_ROUTING_FLOOR,
  MORALE_ROUTING_MAX,
  MORALE_ROUTING_RADIUS,
  MORALE_ROUTING_RATE,
  RALLY_RECOVERY_RATE,
  REAR_THREAT_RATE,
  SECONDS_PER_TICK,
  type BattleState,
} from "../state.js";

/** How often to recompute the per-squad flank/rear threat map. The
 *  result drives morale drain over seconds (FLANK_THREAT_RATE = 0.04
 *  / s), so a 6-tick refresh (~250 ms at 24 Hz) is fine. */
const SQUAD_THREAT_CADENCE = 6;
/** How often to run the routing-ally morale cascade. Cascade rate is
 *  per-second (MORALE_ROUTING_RATE), so on a check tick we apply the
 *  full window's worth of drain (rate × CADENCE × dt). Mod-N gate
 *  amortizes the per-rac neighbor scan. */
const ROUTING_CASCADE_CADENCE = 4;

export function moraleTick(state: BattleState): void {
  const grid = state._racGrid;
  if (!grid) return;
  const dt = SECONDS_PER_TICK;

  // Pass 1: per-squad flank/rear threat detection. We scan around
  // each LEADER (one rep per squad) and classify any enemy within
  // FLANK_THREAT_RADIUS by relative angle to the leader's facing.
  // Result: squadId → max threat level seen this tick (0 / 1 / 2).
  //
  // Cadence-gated: threat changes over seconds (a flanker is still a
  // flanker 250 ms later), so refreshing every SQUAD_THREAT_CADENCE
  // ticks is plenty. Cached squadFlankThreat carries between refreshes.
  if (
    state.tick % SQUAD_THREAT_CADENCE === 0 ||
    !state.squadFlankThreat
  ) {
    const squadThreat = new Map<number, number>();
    const frontCos = Math.cos(FLANK_THREAT_FRONT_CONE);
    const rearCos = Math.cos(FLANK_THREAT_REAR_CONE);
    for (let i = 0; i < state.rac.count; i++) {
      if (!state.rac.alive[i]) continue;
      if (state.rac.squadLeaderId[i] !== state.rac.id[i]) continue;
      const sqid = state.rac.squadId[i];
      const lFacing = state.rac.facing[i];
      const fwdX = Math.cos(lFacing);
      const fwdY = Math.sin(lFacing);
      const lx = state.rac.x[i];
      const ly = state.rac.y[i];
      const lOwner = state.rac.owner[i];
      let level = squadThreat.get(sqid) ?? 0;
      forEachNear(grid, lx, ly, FLANK_THREAT_RADIUS, (j) => {
        if (j === i) return;
        if (!state.rac.alive[j]) return;
        if (state.rac.owner[j] === lOwner) return;
        const dx = state.rac.x[j] - lx;
        const dy = state.rac.y[j] - ly;
        const d2 = dx * dx + dy * dy;
        if (d2 < 1e-6) return;
        // cos(angle) = (dir · fwd). |angle| > FRONT_CONE  ⇔  cos < cos(FRONT_CONE).
        const inv = 1 / Math.sqrt(d2);
        const cosA = (dx * fwdX + dy * fwdY) * inv;
        if (cosA < rearCos) {
          if (level < 2) level = 2;
        } else if (cosA < frontCos && level < 1) {
          level = 1;
        }
      });
      if (level > 0) squadThreat.set(sqid, level);
    }
    state.squadFlankThreat = squadThreat;
  }
  const squadThreat = state.squadFlankThreat;

  // Pass 2 prelude: count broken racs per side. The routing-cascade
  // inner scan is wasted work when nobody on your side is broken (the
  // common case in steady combat); we early-exit per rac below.
  const brokenBySide: [number, number] = [0, 0];
  for (let i = 0; i < state.rac.count; i++) {
    if (!state.rac.alive[i]) continue;
    const t =
      MORALE_BREAK_THRESHOLD_BY_ENV[state.rac.env[i]] ?? MORALE_BREAK_THRESHOLD;
    if (state.rac.morale[i] < t) brokenBySide[state.rac.owner[i]]++;
  }

  for (let i = 0; i < state.rac.count; i++) {
    if (!state.rac.alive[i]) continue;
    const myThreshold =
      MORALE_BREAK_THRESHOLD_BY_ENV[state.rac.env[i]] ?? MORALE_BREAK_THRESHOLD;
    // Rally recovery: a rac heading back toward a friendly leader
    // gains morale per second. Once back above the break threshold
    // the next motion decision will flip them out of RALLY (broken
    // = false → MARCH/ENGAGE). Capped at 1.0 to avoid drifting past
    // full morale. Rally racs are exempt from the flank penalty —
    // they're already broken, no point piling on.
    // Morale recovery: any broken rac that's no longer in contact
    // with enemies gains morale per second. Used to be RALLY-only
    // (broken racs heading to a leader), but the rally-on-leader
    // attractor produced blobs; now broken racs scatter via per-rac
    // ROUT and recover whenever they've fled out of contact range.
    if (state.rac.morale[i] < myThreshold && state.rac.contact[i] === 0) {
      state.rac.morale[i] = Math.min(
        1,
        state.rac.morale[i] + RALLY_RECOVERY_RATE * dt,
      );
      continue;
    }

    // Flank/rear threat penalty: every alive squad member loses
    // morale per second while the squad's leader sees an enemy in
    // its flank or rear quadrant. Models unit-wide panic when "the
    // line is being rolled up." Skips racs already below break
    // threshold (they're routing or rallying — see above).
    const sqid = state.rac.squadId[i];
    const threat = squadThreat.get(sqid) ?? 0;
    if (threat > 0) {
      const rate = threat === 2 ? REAR_THREAT_RATE : FLANK_THREAT_RATE;
      state.rac.morale[i] = Math.max(0, state.rac.morale[i] - rate * dt);
    }
    // Already broken (and not rallying) — skip; routing-ally cascade
    // only affects held racs.
    if (state.rac.morale[i] < myThreshold) continue;
    // Routing-cascade short-circuit: if no friendly is broken, no
    // neighbor will be a router, so skip the spatial scan entirely.
    if (brokenBySide[state.rac.owner[i]] === 0) continue;
    // Mod-N gate the per-rac neighbor scan. We apply a CADENCE-wide
    // window of drain on the check tick (rate × CADENCE × dt) so the
    // average drop rate stays the same. The (i + tick) phase spreads
    // work evenly across the cycle.
    if ((state.tick + i) % ROUTING_CASCADE_CADENCE !== 0) continue;

    let routingNearby = 0;
    forEachNear(grid, state.rac.x[i], state.rac.y[i], MORALE_ROUTING_RADIUS, (j) => {
      if (j === i) return;
      if (!state.rac.alive[j]) return;
      if (state.rac.owner[j] !== state.rac.owner[i]) return;
      const jThreshold =
        MORALE_BREAK_THRESHOLD_BY_ENV[state.rac.env[j]] ?? MORALE_BREAK_THRESHOLD;
      if (state.rac.morale[j] < jThreshold) routingNearby++;
    });
    if (routingNearby === 0) continue;

    const ratePerSec = Math.min(routingNearby * MORALE_ROUTING_RATE, MORALE_ROUTING_MAX);
    const drop = ratePerSec * dt * ROUTING_CASCADE_CADENCE;
    const current = state.rac.morale[i];
    // Soft floor: routing-only damage can't push below MORALE_ROUTING_FLOOR.
    // If we're already below from other causes, this leaves us alone.
    if (current <= MORALE_ROUTING_FLOOR) continue;
    state.rac.morale[i] = Math.max(MORALE_ROUTING_FLOOR, current - drop);
  }
}
