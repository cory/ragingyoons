/**
 * Squad-leader promotion. Each tick (before boids reads leader
 * positions), we scan the rac table; for any rac whose
 * squadLeaderId points at a dead/missing rac, we promote the
 * lowest-id surviving squad member to be the new leader and
 * rewrite squadLeaderId for everyone in that squad.
 *
 * Determinism: we promote by lowest racId so the choice is
 * reproducible across runs (no RNG, no timing dependency). If
 * every squad member is dead, leaderId stays -1; cohesion in
 * boids skips squads with missing leaders.
 */

import type { BattleState } from "../state.js";
import { findRacRowById } from "../state.js";

export function squadTick(state: BattleState): void {
  // Bucket alive racs by squadId, tracking the lowest-id member —
  // that's our candidate leader. We only do work when we actually
  // detect a missing leader; no-ops are cheap.
  type Bucket = { lowestRacId: number; needsPromotion: boolean };
  const buckets = new Map<number, Bucket>();

  for (let i = 0; i < state.rac.count; i++) {
    if (!state.rac.alive[i]) continue;
    const sid = state.rac.squadId[i];
    if (sid === 0) continue; // unaffiliated rac
    const rid = state.rac.id[i];
    let b = buckets.get(sid);
    if (!b) {
      b = { lowestRacId: rid, needsPromotion: false };
      buckets.set(sid, b);
    } else if (rid < b.lowestRacId) {
      b.lowestRacId = rid;
    }
    // If this rac thinks its leader is gone, the squad needs promotion.
    const leaderId = state.rac.squadLeaderId[i];
    if (leaderId < 0 || findRacRowById(state, leaderId) < 0) {
      b.needsPromotion = true;
    }
  }

  if (buckets.size === 0) return;
  // Apply promotions: rewrite every alive rac's squadLeaderId to its
  // bucket's lowest-id member when the squad needs it.
  for (let i = 0; i < state.rac.count; i++) {
    if (!state.rac.alive[i]) continue;
    const sid = state.rac.squadId[i];
    if (sid === 0) continue;
    const b = buckets.get(sid);
    if (!b || !b.needsPromotion) continue;
    state.rac.squadLeaderId[i] = b.lowestRacId;
  }
}
