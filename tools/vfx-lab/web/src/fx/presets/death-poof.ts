import type { ParticlePreset } from "../types";

export const deathPoof: ParticlePreset = {
  kind: "particle",
  id: "death-poof",
  name: "Death Poof",
  mode: "burst",
  attach: false,
  capacity: 128,
  emitRate: 0,
  burst: 50,
  lifetime: { min: 0.7, max: 1.4 },
  size: { min: 0.2, max: 0.55 },
  speed: { min: 1.0, max: 3.0 },
  emitBox: [0.2, 0.2, 0.2],
  direction1: [-1, -1, 0.3],
  direction2: [1, 1, 1.5],
  gravity: [0, 0, -1.2],
  colorStart: [0.85, 0.85, 0.92, 1.0],
  colorEnd: [0.35, 0.35, 0.45, 0.0],
  blendMode: "standard",
};
