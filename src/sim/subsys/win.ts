/**
 * Win-condition check. Sets state.winner / state.endReason when one
 * side has zero alive bins AND zero alive raccoons. Also exposes a
 * `resolveTimeout` helper that runners call at the tick limit when
 * neither side has been wiped — picks a winner by score so timeouts
 * become decisive outcomes rather than draws.
 *
 * Does NOT emit battle_end — the caller (runner / battle viewer) emits
 * it after the tick loop exits, so battle_end remains the last row in
 * the log (matching the structural invariant).
 */

import type { ContentBundle } from "../content.js";
import type { Logger } from "../log.js";
import type { BattleState } from "../state.js";

export function winTick(state: BattleState, content: ContentBundle, log: Logger): void {
  void content;
  void log;
  if (state.winner !== -1) return;

  let racsA = 0;
  let racsB = 0;
  let binsA = 0;
  let binsB = 0;
  for (let i = 0; i < state.bin.count; i++) {
    if (!state.bin.alive[i]) continue;
    if (state.bin.owner[i] === 0) binsA++;
    else binsB++;
  }
  for (let i = 0; i < state.rac.count; i++) {
    if (!state.rac.alive[i]) continue;
    if (state.rac.owner[i] === 0) racsA++;
    else racsB++;
  }
  const aWiped = binsA === 0 && racsA === 0;
  const bWiped = binsB === 0 && racsB === 0;
  if (aWiped && bWiped) {
    // Both sides finished off in the same tick — call it a draw.
    state.winner = -1; // stays -1; caller will record endReason
    state.endReason = "all-bins";
  } else if (aWiped) {
    state.winner = 1;
    state.endReason = "all-bins";
  } else if (bWiped) {
    state.winner = 0;
    state.endReason = "all-bins";
  }
}

/** Tiebreaker for runners that hit the tick limit without a decisive
 *  outcome. Score each side by:
 *      score = bins_alive × 1000
 *            + racs_alive × 10
 *            + total_alive_hp × 0.01
 *  Higher score wins. Sets winner + endReason = "tiebreak". If both
 *  sides score identically (very rare), winner stays -1 / "draw". */
export function resolveTimeout(state: BattleState): void {
  if (state.winner !== -1) return;
  const score = [0, 0];
  let racsA = 0;
  let racsB = 0;
  let binsA = 0;
  let binsB = 0;
  for (let i = 0; i < state.bin.count; i++) {
    if (!state.bin.alive[i]) continue;
    const o = state.bin.owner[i];
    score[o] += 1000;
    score[o] += state.bin.hp[i] * 0.01;
    if (o === 0) binsA++;
    else binsB++;
  }
  for (let i = 0; i < state.rac.count; i++) {
    if (!state.rac.alive[i]) continue;
    const o = state.rac.owner[i];
    score[o] += 10;
    score[o] += state.rac.hp[i] * 0.01;
    if (o === 0) racsA++;
    else racsB++;
  }
  if (score[0] > score[1]) {
    state.winner = 0;
    state.endReason = "tiebreak";
  } else if (score[1] > score[0]) {
    state.winner = 1;
    state.endReason = "tiebreak";
  } else {
    // Truly tied — stays a draw.
    state.endReason = "draw";
  }
  // Suppress unused-var warning while keeping the names for future use.
  void binsA;
  void binsB;
  void racsA;
  void racsB;
}
