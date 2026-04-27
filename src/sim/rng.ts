/**
 * Mulberry32 — small, fast, seeded PRNG. Single source of randomness for
 * the sim. Threaded through state so every random decision is
 * reproducible from the seed.
 *
 * Determinism contract: nothing in `src/sim/` may call `Math.random`,
 * `Date.now`, or `performance.now`. All randomness goes through this
 * module.
 */

export interface RngState {
  /** 32-bit unsigned integer state. Mutable. */
  s: number;
}

export function makeRng(seed: number): RngState {
  // Seed is normalized to a 32-bit unsigned int. Avoid 0 to keep the
  // initial state non-degenerate.
  const s = (seed | 0) >>> 0;
  return { s: s === 0 ? 0x9e3779b9 : s };
}

/** Returns a float in [0, 1). Advances state. */
export function rngFloat(rng: RngState): number {
  rng.s = (rng.s + 0x6d2b79f5) | 0;
  let t = rng.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Integer in [lo, hi). */
export function rngInt(rng: RngState, lo: number, hi: number): number {
  return lo + Math.floor(rngFloat(rng) * (hi - lo));
}

/** Float in [lo, hi). */
export function rngRange(rng: RngState, lo: number, hi: number): number {
  return lo + rngFloat(rng) * (hi - lo);
}

/** Pick uniformly from a non-empty array. */
export function rngPick<T>(rng: RngState, arr: readonly T[]): T {
  return arr[rngInt(rng, 0, arr.length)];
}
