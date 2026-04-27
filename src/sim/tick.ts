/**
 * Sim tick — top-level entry point.
 *
 * For phase 1a this is a no-op that increments tick count and emits a
 * `tick_summary` every TICK_SUMMARY_EVERY ticks. Subsystems plug in here
 * one at a time as we build them out.
 *
 * Pipeline order (commented placeholders are wired empty for now):
 *   1. spawn   — bin spawn / garrison-respawn
 *   2. target  — per-raccoon retarget
 *   3. boids   — steering + movement integrate
 *   4. attack  — basic attacks fire
 *   5. project — in-flight attacks tick + hit-resolve
 *   6. damage  — apply damage events
 *   7. status  — DoT ticks, expirations
 *   8. rage    — gain rules + auto-fire
 *   9. win     — end check
 */

import type { ContentBundle } from "./content.js";
import type { Logger } from "./log.js";
import type { BattleState } from "./state.js";
import { TICK_RATE_HZ, summarize } from "./state.js";
import { buildRacGrid, DEFAULT_CELL_SIZE } from "./grid.js";
import { boidsTick } from "./subsys/boids.js";
import { combatTick } from "./subsys/combat.js";
import { decayTick } from "./subsys/decay.js";
import { projectileTick } from "./subsys/projectile.js";
import { rageTick } from "./subsys/rage.js";
import { spawnTick } from "./subsys/spawn.js";
import { statusTick } from "./subsys/status.js";
import { synergyTick } from "./subsys/synergy.js";
import { targetTick } from "./subsys/target.js";
import { winTick } from "./subsys/win.js";

export const TICK_SUMMARY_EVERY = TICK_RATE_HZ; // = 1 second

export function tick(state: BattleState, content: ContentBundle, log: Logger): void {
  state.tick += 1;

  // Synergy state must be fresh before spawn (HP mul reads it) and
  // before status recompute (uses synergy mods). Bins spawning don't
  // change bin counts, so order spawn → synergy is wrong; synergy →
  // spawn means new raccoons read the current synergy state.
  synergyTick(state, content, log);
  spawnTick(state, content, log);
  // Build the shared rac spatial grid once per tick after spawn (so
  // freshly-spawned racs are visible to target / combat) and before
  // any subsystem that does range queries against them. Rebuilt every
  // tick because positions change in boids.
  state._racGrid = buildRacGrid(state, DEFAULT_CELL_SIZE);
  targetTick(state, content, log);
  boidsTick(state, content, log);
  combatTick(state, content, log);
  // Projectiles tick AFTER combat so freshly-fired arrows get one tick
  // of flight before resolution. Fired-this-tick arrows still try to
  // hit something this tick: if their target was point-blank, they
  // resolve on the spawn segment and damage applies before status tick.
  projectileTick(state, content, log);
  statusTick(state, content, log);
  rageTick(state, content, log);
  // Decay applies AFTER combat each tick so combat-driven kills get
  // attribution priority; pure-decay kills only land when nothing else
  // got the bin first this tick.
  decayTick(state, content, log);
  winTick(state, content, log);

  // tick_summary is one per second of sim time. It's a low-cardinality
  // heartbeat for batch analytics; the high-cardinality rows live in
  // the per-event kinds (rac_attack, damage_apply, etc.) once they exist.
  if (state.tick % TICK_SUMMARY_EVERY === 0) {
    const s = summarize(state);
    log.emit("tick_summary", {
      ...s,
      racs_alive_total: s.racs_alive_a + s.racs_alive_b,
      bins_alive_total: s.bins_alive_a + s.bins_alive_b,
    });
  }
  // Suppress unused-content warning until subsystems land.
  void content;
}
