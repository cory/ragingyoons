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
  MORALE_BREAK_THRESHOLD,
  MORALE_BREAK_THRESHOLD_BY_ENV,
  MORALE_ROUTING_FLOOR,
  MORALE_ROUTING_MAX,
  MORALE_ROUTING_RADIUS,
  MORALE_ROUTING_RATE,
  RALLY_RECOVERY_RATE,
  SECONDS_PER_TICK,
  type BattleState,
} from "../state.js";

export function moraleTick(state: BattleState): void {
  const grid = state._racGrid;
  if (!grid) return;
  const dt = SECONDS_PER_TICK;

  for (let i = 0; i < state.rac.count; i++) {
    if (!state.rac.alive[i]) continue;
    const myThreshold =
      MORALE_BREAK_THRESHOLD_BY_ENV[state.rac.env[i]] ?? MORALE_BREAK_THRESHOLD;
    // Rally recovery: a rac heading back toward a friendly leader
    // gains morale per second. Once back above the break threshold
    // the next motion decision will flip them out of RALLY (broken
    // = false → MARCH/ENGAGE). Capped at 1.0 to avoid drifting past
    // full morale.
    if (state.rac.behavior[i] === BEHAVIOR_RALLY) {
      state.rac.morale[i] = Math.min(
        1,
        state.rac.morale[i] + RALLY_RECOVERY_RATE * dt,
      );
      continue;
    }
    // Already broken (and not rallying) — skip; routing-ally cascade
    // only affects held racs.
    if (state.rac.morale[i] < myThreshold) continue;

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
    const drop = ratePerSec * dt;
    const current = state.rac.morale[i];
    // Soft floor: routing-only damage can't push below MORALE_ROUTING_FLOOR.
    // If we're already below from other causes, this leaves us alone.
    if (current <= MORALE_ROUTING_FLOOR) continue;
    state.rac.morale[i] = Math.max(MORALE_ROUTING_FLOOR, current - drop);
  }
}
