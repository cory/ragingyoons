/**
 * Bin decay (sudden-death timer).
 *
 * Without a forcing function, defensive comps stalemate forever — the
 * batch runner showed near-100% draws at 1000 ticks for tanky mirrors.
 * Decay is the design lever that makes battles converge: starting at
 * SUDDEN_DEATH_TICK, every alive bin loses a fixed fraction of its
 * MAX HP per second to passive decay.
 *
 * Tuning intent (v0a):
 *   - Battles should be ~95% conclusive at 1000 ticks (~67s sim).
 *   - Combat-driven outcomes are still preferred; decay is a backstop.
 *   - Decay starts at 30s (tick 450) so the first ~30s plays out as
 *     a pure combat round before the floor starts moving.
 *   - 5%/sec of max HP → an unfought bin dies in 20s. With even some
 *     focus-fire, bins die in 10-15s of decay → 95% conclusive at 1000.
 *
 * Decay deaths emit `bin_death` events with `last_hit_by=-1` and
 * `last_hit_unit="decay"` so log analysis can distinguish them from
 * combat kills.
 */

import type { ContentBundle } from "../content.js";
import type { Logger } from "../log.js";
import { MAX_GARRISON_SLOTS, SECONDS_PER_TICK, type BattleState } from "../state.js";

export const SUDDEN_DEATH_TICK = 450;
export const DECAY_FRAC_PER_SEC = 0.05;

export function decayTick(state: BattleState, content: ContentBundle, log: Logger): void {
  void content;
  if (state.tick < SUDDEN_DEATH_TICK) return;
  const dt = SECONDS_PER_TICK;
  const fracPerTick = DECAY_FRAC_PER_SEC * dt;
  for (let i = 0; i < state.bin.count; i++) {
    if (!state.bin.alive[i]) continue;
    const decayHp = state.bin.hpMax[i] * fracPerTick;
    const before = state.bin.hp[i];
    const after = before - decayHp;
    if (after <= 0) {
      state.bin.hp[i] = 0;
      state.bin.alive[i] = 0;
      state.binRowById.delete(state.bin.id[i]);
      for (let s = 0; s < MAX_GARRISON_SLOTS; s++) {
        const slotIdx = i * MAX_GARRISON_SLOTS + s;
        state.bin.slotOccupant[slotIdx] = -1;
        state.bin.slotRespawnT[slotIdx] = Number.POSITIVE_INFINITY;
      }
      log.emit("bin_death", {
        bin_id: state.bin.id[i],
        owner: state.bin.owner[i],
        unit_id: state.unitIdTable[state.bin.unitIdIdx[i]],
        last_hit_by: -1,
        last_hit_unit: "decay",
        cause: "sudden_death",
        x: state.bin.x[i],
        y: state.bin.y[i],
      });
    } else {
      state.bin.hp[i] = after;
    }
  }
}
