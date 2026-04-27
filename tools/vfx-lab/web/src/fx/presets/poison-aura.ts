import type { ParticlePreset } from "../types";

export const poisonAura: ParticlePreset = {
  kind: "particle",
  id: "poison-aura",
  name: "Poison Aura",
  mode: "continuous",
  attach: true,
  capacity: 200,
  emitRate: 40,
  lifetime: { min: 0.8, max: 1.6 },
  size: { min: 0.08, max: 0.18 },
  speed: { min: 0.3, max: 1.0 },
  emitBox: [0.6, 0.6, 0.5],
  direction1: [-0.3, -0.3, -0.2],
  direction2: [0.3, 0.3, 0.5],
  gravity: [0, 0, -3],
  colorStart: [0.4, 1.0, 0.3, 1.0],
  colorEnd: [0.1, 0.55, 0.1, 0.0],
  blendMode: "additive",
};
