import type { ParticlePreset } from "../types";

export const sparks: ParticlePreset = {
  kind: "particle",
  id: "sparks",
  name: "Hit Sparks",
  mode: "burst",
  attach: false,
  capacity: 256,
  emitRate: 0,
  burst: 60,
  lifetime: { min: 0.25, max: 0.6 },
  size: { min: 0.05, max: 0.15 },
  speed: { min: 4, max: 9 },
  emitBox: [0.05, 0.05, 0.05],
  direction1: [-1, -1, 0.2],
  direction2: [1, 1, 1.5],
  gravity: [0, 0, -12],
  colorStart: [1.0, 0.9, 0.4, 1.0],
  colorEnd: [1.0, 0.3, 0.05, 0.0],
  blendMode: "additive",
};
