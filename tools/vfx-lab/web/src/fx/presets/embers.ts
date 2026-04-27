import type { ParticlePreset } from "../types";

export const embers: ParticlePreset = {
  kind: "particle",
  id: "embers",
  name: "Ambient Embers",
  mode: "continuous",
  attach: false,
  capacity: 600,
  emitRate: 80,
  lifetime: { min: 2.0, max: 5.0 },
  size: { min: 0.04, max: 0.12 },
  speed: { min: 0.4, max: 1.2 },
  emitBox: [8, 8, 0.2],
  direction1: [-0.2, -0.2, 0.5],
  direction2: [0.2, 0.2, 1.5],
  gravity: [0, 0, 0.6],
  colorStart: [1.0, 0.7, 0.3, 1.0],
  colorEnd: [1.0, 0.25, 0.05, 0.0],
  blendMode: "additive",
};
