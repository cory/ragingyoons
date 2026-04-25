export type RNG = () => number;

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(a: number): RNG {
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRNG(seedStr: string): RNG {
  return mulberry32(xmur3(seedStr)());
}

export const pick = <T>(rng: RNG, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
export const range = (rng: RNG, a: number, b: number): number => a + rng() * (b - a);
export const irange = (rng: RNG, a: number, b: number): number => Math.floor(range(rng, a, b + 1));
export const chance = (rng: RNG, p: number): boolean => rng() < p;

export function weightedPick<T>(rng: RNG, items: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}
