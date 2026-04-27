/**
 * Synergy subsystem.
 *
 * Hardcoded mapping from card-side synergy descriptions to machine
 * mods. The cards remain the human-readable spec; mismatches between
 * card text and behavior should be reconciled here, not by parsing
 * prose.
 *
 * v0a covers:
 *   - Stat-mul mods on raccoons (speed, damage, range, hp, armor) —
 *     consumed by `synergyModsFor` in status.recompute + spawn.
 *   - Bin-side mods (bin_hp at setup; garrison_mul at spawn) —
 *     consumed via `synergyBinMods`.
 *   - Per-attack conditional mods (anti_bin_damage) — combat queries
 *     `synergyModsFor.antiBinDamageMul`.
 *
 * Threshold counting: per-side per-env / per-cur **alive bin count**.
 * Recomputed each tick by `synergyTick` and stashed on state._synergy.
 */

import type { ContentBundle } from "../content.js";
import type { Logger } from "../log.js";
import type { BattleState } from "../state.js";

interface SideCounts {
  byEnv: Uint8Array;
  byCur: Uint8Array;
}

export interface SynergyState {
  side: SideCounts[]; // [0, 1]
  /** Set of currently-active "axis:side:ownerIdx:threshold" synergies. */
  active: Set<string>;
}

export function emptySynergyState(): SynergyState {
  return {
    side: [
      { byEnv: new Uint8Array(4), byCur: new Uint8Array(4) },
      { byEnv: new Uint8Array(4), byCur: new Uint8Array(4) },
    ],
    active: new Set<string>(),
  };
}

function recountBins(state: BattleState, syn: SynergyState): void {
  for (let s = 0; s < 2; s++) {
    syn.side[s].byEnv.fill(0);
    syn.side[s].byCur.fill(0);
  }
  for (let i = 0; i < state.bin.count; i++) {
    if (!state.bin.alive[i]) continue;
    const owner = state.bin.owner[i];
    syn.side[owner].byEnv[state.bin.envIdx[i]] += 1;
    syn.side[owner].byCur[state.bin.curIdx[i]] += 1;
  }
}

type Mod =
  | { stat: "speed"; mul: number }
  | { stat: "damage"; mul: number }
  | { stat: "range"; mul: number }
  | { stat: "attack_rate"; mul: number }
  | { stat: "hp"; mul: number }
  | { stat: "armor"; add: number }
  | { stat: "bin_hp"; mul: number }
  | { stat: "anti_bin_damage"; mul: number }
  | { stat: "garrison_mul"; mul: number };

const ENV_SYNERGIES: { threshold: number; mods: Mod[] }[][] = [
  // city (0) — conditional density bonus is a combat hook (TBD).
  [],
  // suburban (1)
  [
    { threshold: 2, mods: [{ stat: "bin_hp", mul: 1.20 }] },
    // Suburban 3 (proximity-to-own-bin armor) is positional. Deferred.
  ],
  // park (2)
  [
    { threshold: 2, mods: [{ stat: "speed", mul: 1.20 }] },
    // Park 3 (flank damage) is positional. Deferred.
  ],
  // coastal (3)
  [
    { threshold: 2, mods: [{ stat: "range", mul: 1.25 }] },
    // Coastal 3 (splash on hit) is a combat hook. Deferred.
  ],
];

const CUR_SYNERGIES: { threshold: number; mods: Mod[] }[][] = [
  // lockpickers (0)
  [
    { threshold: 2, mods: [{ stat: "anti_bin_damage", mul: 1.20 }] },
    // Lockpickers 3 (stealth) needs sensing-range hook. Deferred.
  ],
  // tinkerers (1) — rage augmentation lives in rage.ts. Deferred.
  [],
  // farmers (2) — Farmers-3 OVERWRITES Farmers-2 (max wins, not multiply).
  [
    { threshold: 2, mods: [{ stat: "garrison_mul", mul: 2.0 }] },
    { threshold: 3, mods: [{ stat: "garrison_mul", mul: 3.0 }] },
  ],
  // barbarians (3)
  [
    { threshold: 2, mods: [{ stat: "hp", mul: 1.20 }] },
    { threshold: 3, mods: [{ stat: "armor", add: 2 }] },
  ],
];

export function synergyTick(state: BattleState, content: ContentBundle, log: Logger): void {
  void content;
  if (!state._synergy) state._synergy = emptySynergyState();
  const syn = state._synergy;
  recountBins(state, syn);

  const now = new Set<string>();
  for (let side = 0; side < 2; side++) {
    for (let env = 0; env < 4; env++) {
      const count = syn.side[side].byEnv[env];
      for (const row of ENV_SYNERGIES[env]) {
        if (count >= row.threshold) now.add(`env:${side}:${env}:${row.threshold}`);
      }
    }
    for (let cur = 0; cur < 4; cur++) {
      const count = syn.side[side].byCur[cur];
      for (const row of CUR_SYNERGIES[cur]) {
        if (count >= row.threshold) now.add(`cur:${side}:${cur}:${row.threshold}`);
      }
    }
  }
  // Detect transitions; for each side that flipped, dirty every alive
  // rac on that side so statusTick recomputes effective stats next
  // pass. Without this, a rac whose synergy just turned on would keep
  // its old effective stats forever (we skip recompute when not dirty).
  const dirtySides = new Set<number>();
  for (const k of now) {
    if (!syn.active.has(k)) {
      const [axis, sideS, ownerIdxS, thresholdS] = k.split(":");
      const side = Number(sideS);
      dirtySides.add(side);
      log.emit("synergy_active", {
        side,
        axis: axis === "env" ? "environment" : "curiosity",
        owner_idx: Number(ownerIdxS),
        threshold: Number(thresholdS),
        state: "on",
      });
    }
  }
  for (const k of syn.active) {
    if (!now.has(k)) {
      const [axis, sideS, ownerIdxS, thresholdS] = k.split(":");
      const side = Number(sideS);
      dirtySides.add(side);
      log.emit("synergy_active", {
        side,
        axis: axis === "env" ? "environment" : "curiosity",
        owner_idx: Number(ownerIdxS),
        threshold: Number(thresholdS),
        state: "off",
      });
    }
  }
  if (dirtySides.size > 0) {
    for (let i = 0; i < state.rac.count; i++) {
      if (!state.rac.alive[i]) continue;
      if (dirtySides.has(state.rac.owner[i])) state.rac.statsDirty[i] = 1;
    }
  }
  syn.active = now;
}

/** Per-raccoon stat mods from active same-side synergies. */
export function synergyModsFor(
  state: BattleState,
  racRow: number,
): {
  speedMul: number;
  damageMul: number;
  rangeMul: number;
  attackRateMul: number;
  hpMul: number;
  armorAdd: number;
  /** +damage when this raccoon attacks a bin (Lockpickers-2). */
  antiBinDamageMul: number;
} {
  const out = {
    speedMul: 1,
    damageMul: 1,
    rangeMul: 1,
    attackRateMul: 1,
    hpMul: 1,
    armorAdd: 0,
    antiBinDamageMul: 1,
  };
  if (state.disableSynergies) return out;
  if (!state._synergy) return out;
  const side = state.rac.owner[racRow];
  const env = state.rac.env[racRow];
  const cur = state.rac.cur[racRow];
  const counts = state._synergy.side[side];

  const apply = (mods: Mod[]) => {
    for (const m of mods) {
      switch (m.stat) {
        case "speed": out.speedMul *= m.mul; break;
        case "damage": out.damageMul *= m.mul; break;
        case "range": out.rangeMul *= m.mul; break;
        case "attack_rate": out.attackRateMul *= m.mul; break;
        case "hp": out.hpMul *= m.mul; break;
        case "armor": out.armorAdd += m.add; break;
        case "anti_bin_damage": out.antiBinDamageMul *= m.mul; break;
        // bin_hp / garrison_mul are bin-side; consumed by synergyBinMods.
        case "bin_hp":
        case "garrison_mul":
          break;
      }
    }
  };

  for (const row of ENV_SYNERGIES[env]) {
    if (counts.byEnv[env] >= row.threshold) apply(row.mods);
  }
  for (const row of CUR_SYNERGIES[cur]) {
    if (counts.byCur[cur] >= row.threshold) apply(row.mods);
  }
  return out;
}

/** Bin-side mods. Looked up by side + bin's own env/cur idx. Used at
 *  setup (bin_hp) and at every spawn iteration (garrison_mul, since
 *  bins can come and go). */
export function synergyBinMods(
  state: BattleState,
  side: number,
  binEnvIdx: number,
  binCurIdx: number,
): { binHpMul: number; garrisonMul: number } {
  const out = { binHpMul: 1, garrisonMul: 1 };
  if (state.disableSynergies) return out;
  if (!state._synergy) return out;
  const counts = state._synergy.side[side];
  for (const row of ENV_SYNERGIES[binEnvIdx]) {
    if (counts.byEnv[binEnvIdx] < row.threshold) continue;
    for (const m of row.mods) {
      if (m.stat === "bin_hp") out.binHpMul *= m.mul;
    }
  }
  for (const row of CUR_SYNERGIES[binCurIdx]) {
    if (counts.byCur[binCurIdx] < row.threshold) continue;
    for (const m of row.mods) {
      if (m.stat === "bin_hp") out.binHpMul *= m.mul;
      // garrison_mul: take MAX, not product (Farmers-3 overrides Farmers-2).
      if (m.stat === "garrison_mul" && m.mul > out.garrisonMul) out.garrisonMul = m.mul;
    }
  }
  return out;
}

/** Cheap predicate for combat / spawn hooks. */
export function isSynergyActive(
  state: BattleState,
  axis: "environment" | "curiosity",
  side: number,
  ownerIdx: number,
  threshold: number,
): boolean {
  const counts = state._synergy?.side[side];
  if (!counts) return false;
  const c = axis === "environment" ? counts.byEnv[ownerIdx] : counts.byCur[ownerIdx];
  return c >= threshold;
}

/** Setup-time helper: populate `state._synergy` counts from current bin
 *  state without emitting events. Used by setupBattle to enable bin-HP
 *  synergy mods before any tick has run. */
export function populateSynergyCounts(state: BattleState): void {
  if (!state._synergy) state._synergy = emptySynergyState();
  recountBins(state, state._synergy);
}

/** Apply bin-side stat mods (bin_hp) to all alive bins. Idempotent —
 *  call once after `populateSynergyCounts` at setup time. Doing this
 *  again later (e.g., when a Suburban bin dies and the synergy drops)
 *  would shrink other bins' HP, which we explicitly DON'T do in v0a:
 *  bin HP is sticky after setup. */
export function applyBinHpSynergies(state: BattleState): void {
  if (!state._synergy) return;
  for (let i = 0; i < state.bin.count; i++) {
    if (!state.bin.alive[i]) continue;
    const mods = synergyBinMods(state, state.bin.owner[i], state.bin.envIdx[i], state.bin.curIdx[i]);
    if (mods.binHpMul !== 1) {
      state.bin.hp[i] *= mods.binHpMul;
      state.bin.hpMax[i] *= mods.binHpMul;
    }
  }
}
