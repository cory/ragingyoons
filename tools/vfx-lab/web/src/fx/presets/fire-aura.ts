import type { ParticlePreset } from "../types";

export const fireAura: ParticlePreset = {
  kind: "particle",
  id: "fire-aura",
  name: "Fire Aura",
  mode: "continuous",
  attach: true,
  capacity: 250,
  emitRate: 70,
  lifetime: { min: 0.4, max: 0.9 },
  size: { min: 0.12, max: 0.32 },
  speed: { min: 1.5, max: 3.5 },
  emitBox: [0.35, 0.35, 0.1],
  direction1: [-0.15, -0.15, 0.8],
  direction2: [0.15, 0.15, 1.6],
  gravity: [0, 0, 1.0],
  colorStart: [1.0, 0.9, 0.3, 1.0],
  colorEnd: [0.9, 0.1, 0.05, 0.0],
  blendMode: "additive",
};
