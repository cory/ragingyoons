/**
 * Formations.
 *
 * A formation is a per-role way of arranging a bin's burst at spawn
 * time PLUS a tactic-coefficient override that changes how the units
 * move and fight. Formations are layered after the per-role defaults
 * and per-side tactic overrides.
 *
 * Schema:
 *   - `id` — string id, used in card frontmatter (`formation: phalanx`)
 *   - `role` — which role this formation applies to. Spawning a tank
 *     bin with `formation: phalanx` (an infantry formation) is an
 *     error caught at content load.
 *   - `arrange(args)` — given a burst index, burst size, and side,
 *     returns an offset relative to the bin in (dx, dy). Spawn jitter
 *     is still applied on top in spawn.ts.
 *   - `tacticOverride` — partial TacticProfile that's layered onto
 *     the role default to produce the formation's effective profile.
 *
 * Defaults: each role has a default formation (line for tank/inf,
 * loose-deuce for cav, two-line for archer). Bins without a `formation`
 * field get the default.
 *
 * The "forward" direction for a side is the unit-vector toward the
 * enemy half of the field. Side 0 is at +x, so forward = -x; side 1
 * is at -x, so forward = +x. The arrange functions take a `forward`
 * scalar (+1 / -1 along x) so formations like `arrowhead` can place
 * the apex toward the enemy.
 */

import type { RoleId } from "./content.js";
import type { TacticProfile } from "./tactics.js";

export type FormationId =
  | "tank-line"
  | "tank-arrowhead"
  | "infantry-line"
  | "infantry-phalanx"
  | "cavalry-loose-deuce"
  | "cavalry-flexible-fours"
  | "cavalry-lone-gunmen"
  | "archer-one-line"
  | "archer-two-line"
  | "archer-sniper";

export interface FormationArrangeArgs {
  burstIdx: number;
  burstSize: number;
  /** +1 if enemy is to +x of this bin (i.e., owner=1), -1 otherwise. */
  forward: number;
}

export interface FormationDef {
  id: FormationId;
  role: RoleId;
  /** Spawn-position offset in meters, relative to the bin center. */
  arrange(args: FormationArrangeArgs): { dx: number; dy: number };
  /** Tactic-coefficient override applied while the rac is NOT in
   *  contact with enemies. Phalanx in march mode is loose enough to
   *  move without falling apart; archer/cav formations are usually
   *  the same in march and contact. Layered after role defaults. */
  tacticOverride: Partial<TacticProfile>;
  /** Optional override applied when the rac IS in contact (any enemy
   *  within CONTACT_RADIUS). Phalanx contact mode tightens ranks
   *  hard — high cohesion, near-zero speed, lock orientation. If
   *  omitted the formation has only one mode (march = contact). */
  contactOverride?: Partial<TacticProfile>;
}

// ---------- arrangement helpers ----------

/** Spread `n` units evenly along the perpendicular-to-forward axis,
 *  centered on the bin, with `pitch` meters between adjacent units. */
function spreadPerp(idx: number, n: number, pitch: number): { dx: number; dy: number } {
  const center = (n - 1) * 0.5;
  return { dx: 0, dy: (idx - center) * pitch };
}

/** Lay out `n` units in a `cols × rows` grid, with the front row toward
 *  the enemy. col 0 is the back row, col cols-1 is the front. */
function gridPerp(idx: number, n: number, cols: number, pitchX: number, pitchY: number, forward: number): { dx: number; dy: number } {
  const rows = Math.ceil(n / cols);
  const row = Math.floor(idx / cols); // back-to-front index 0..rows-1
  const col = idx % cols;
  // Center in y; in x, push the row toward enemy proportionally.
  const yOffset = (col - (cols - 1) * 0.5) * pitchY;
  const xOffset = (row - (rows - 1) * 0.5) * pitchX * -forward; // negative forward = "back" of the formation
  return { dx: xOffset, dy: yOffset };
}

// ---------- formation definitions ----------

export const FORMATIONS: FormationDef[] = [
  // ----- TANK -----
  {
    id: "tank-line",
    role: "tank",
    arrange(args) {
      // Tank burst is 2; spread laterally 2.5m apart so they form a
      // visible front line covering more y-axis ground.
      return spreadPerp(args.burstIdx, args.burstSize, 2.5);
    },
    tacticOverride: { alignmentK: 1.4, cohesionK: 0.8 },
    // Tanks in contact: close ranks, hold line. Already stopped by
    // stop-in-combat; this just tightens visually.
    contactOverride: { alignmentK: 2.0, cohesionK: 1.6, separationK: 0.5 },
  },
  {
    id: "tank-arrowhead",
    role: "tank",
    arrange(args) {
      // Tank burst 2: apex forward, second tank back-and-staggered.
      // For larger bursts (overrides) we'd open the arrow wider.
      const FORWARD_PUSH = 1.5;
      const STAGGER = 1.5;
      if (args.burstIdx === 0) {
        return { dx: args.forward * FORWARD_PUSH, dy: 0 };
      }
      return { dx: -args.forward * STAGGER, dy: args.burstIdx === 1 ? -STAGGER : STAGGER };
    },
    tacticOverride: { targetSeekK: 4.0, cohesionK: 0.6, alignmentK: 1.0 },
  },

  // ----- INFANTRY -----
  {
    id: "infantry-line",
    role: "infantry",
    arrange(args) {
      // 10 infantry per burst → 10-wide row with 1.4m pitch.
      return spreadPerp(args.burstIdx, args.burstSize, 1.4);
    },
    tacticOverride: { alignmentK: 1.4, cohesionK: 1.4 },
    // Infantry-line in contact: tighten ranks, slow.
    contactOverride: {
      alignmentK: 2.0,
      cohesionK: 2.2,
      separationK: 0.5,
      speedMul: 0.3,
    },
  },
  {
    id: "infantry-phalanx",
    role: "infantry",
    arrange(args) {
      // 4-wide × 3-deep grid in MARCH (loose) spacing. Contact mode
      // tightens via the contactOverride below.
      return gridPerp(args.burstIdx, args.burstSize, 4, 1.4, 1.4, args.forward);
    },
    tacticOverride: {
      // MARCH mode: loose-enough spacing to move without collapsing.
      // Cohesion ≈ 1.5× separation keeps the block from drifting
      // apart but doesn't crush it into a column. Alignment locks
      // the direction of advance. Slow speed so ranks stay together.
      separationK: 1.0,
      cohesionK: 1.5,
      alignmentK: 2.0,
      speedMul: 0.55,
      targetSeekK: 1.4,
      flankBiasK: 0.0,
    },
    contactOverride: {
      // SYNASPISMOS — the dense locked-shield formation that received
      // charges. Cohesion dominates separation hard; speed near zero
      // (we're holding the line, not advancing); damage taken much
      // reduced (shields up). Boids' stop-in-combat already pins
      // infantry; this just *visually* tightens the block while it
      // fights.
      separationK: 0.4,
      cohesionK: 3.0,
      alignmentK: 3.0,
      speedMul: 0.2,
      targetSeekK: 0.8,
      flankBiasK: 0.0,
    },
  },

  // ----- CAVALRY -----
  {
    id: "cavalry-loose-deuce",
    role: "cavalry",
    arrange(args) {
      // 5 cavalry → 2 pairs + 1 trailing single. 4m between pairs.
      const pair = Math.floor(args.burstIdx / 2);
      const inPair = args.burstIdx % 2;
      const yPair = (pair - 1) * 4;
      const yJitter = inPair === 0 ? -0.6 : 0.6;
      return { dx: 0, dy: yPair + yJitter };
    },
    tacticOverride: { cohesionK: 0.5, flankBiasK: 0.3 },
  },
  {
    id: "cavalry-flexible-fours",
    role: "cavalry",
    arrange(args) {
      // 5 cavalry → one 4-cluster + 1 trailing.
      if (args.burstIdx < 4) {
        const r = 1.6;
        const a = (args.burstIdx / 4) * Math.PI * 2;
        return { dx: Math.cos(a) * r, dy: Math.sin(a) * r };
      }
      return { dx: -args.forward * 3, dy: 0 };
    },
    tacticOverride: { cohesionK: 0.9, flankBiasK: 0.25 },
  },
  {
    id: "cavalry-lone-gunmen",
    role: "cavalry",
    arrange(args) {
      // 5 cavalry → scatter wide. Use index-derived angle for spread.
      const a = (args.burstIdx / args.burstSize) * Math.PI * 2 + 0.7;
      const r = 4 + (args.burstIdx % 2);
      return { dx: Math.cos(a) * r, dy: Math.sin(a) * r };
    },
    tacticOverride: { cohesionK: 0, flankBiasK: 0.55, targetSeekK: 5.5 },
  },

  // ----- ARCHER -----
  {
    id: "archer-one-line",
    role: "archer",
    arrange(args) {
      // 5 archers in a single row, 1.5m apart.
      return spreadPerp(args.burstIdx, args.burstSize, 1.5);
    },
    tacticOverride: {
      // Lag the front line so they're naturally behind whoever
      // advances first. hideStandoff sample reaches further so the
      // "is there a friendly between me and the enemy?" check sees
      // the front-line tank/infantry ~12m ahead.
      hideBehindK: 4.0,
      hideStandoff: 12,
      alignmentK: 1.0,
      speedMul: 0.85, // slower than infantry → naturally trails
    },
  },
  {
    id: "archer-two-line",
    role: "archer",
    arrange(args) {
      // 5 archers → front row of 3, back row of 2 (offset by half pitch).
      // forward=-1 means enemy is at -x; the FRONT row (closer to
      // enemy) gets dx = +forward*0.6 (i.e., toward enemy = negative
      // x for side 0). Back row sits behind, +x for side 0.
      const front = args.burstIdx < 3;
      const idxInRow = front ? args.burstIdx : args.burstIdx - 3;
      const sizeInRow = front ? 3 : 2;
      const pitch = 1.6;
      const center = (sizeInRow - 1) * 0.5;
      const yOffset = (idxInRow - center) * pitch + (front ? 0 : pitch * 0.5);
      const xOffset = front ? args.forward * 0.6 : -args.forward * 0.6;
      return { dx: xOffset, dy: yOffset };
    },
    tacticOverride: {
      hideBehindK: 4.0,
      hideStandoff: 14,
      alignmentK: 1.2,
      speedMul: 0.75, // significantly slower so infantry advances first
    },
  },
  {
    id: "archer-sniper",
    role: "archer",
    arrange(args) {
      // 5 archers → 2 on each flank + 1 center. Wider y spread,
      // pulled back in x.
      const flank = args.burstIdx < 2 ? -1 : args.burstIdx < 4 ? 1 : 0;
      const within = args.burstIdx < 2 ? args.burstIdx : args.burstIdx < 4 ? args.burstIdx - 2 : 0;
      const yOffset = flank * 6 + within * 1.2 - 0.6;
      const xOffset = -args.forward * 2;
      return { dx: xOffset, dy: yOffset };
    },
    tacticOverride: {
      hideBehindK: 3.0,
      hideStandoff: 18,
      cohesionK: 0,
      alignmentK: 0,
      flankBiasK: 0.5,
      speedMul: 0.7, // snipers are slow + careful
    },
  },
];

export const FORMATION_TO_IDX: Record<FormationId, number> = (() => {
  const m: Partial<Record<FormationId, number>> = {};
  FORMATIONS.forEach((f, i) => {
    m[f.id] = i;
  });
  return m as Record<FormationId, number>;
})();

/** Default formation per role, used when a bin doesn't specify one. */
export const DEFAULT_FORMATION_BY_ROLE: Record<RoleId, FormationId> = {
  tank: "tank-line",
  archer: "archer-two-line",
  cavalry: "cavalry-loose-deuce",
  infantry: "infantry-line",
};

export function getFormation(id: FormationId): FormationDef {
  const idx = FORMATION_TO_IDX[id];
  return FORMATIONS[idx];
}

export function isValidFormationId(s: string): s is FormationId {
  return s in FORMATION_TO_IDX;
}
