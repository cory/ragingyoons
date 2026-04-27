import type { ParticlePreset } from "../types";

export const freezeAura: ParticlePreset = {
  kind: "particle",
  id: "freeze-aura",
  name: "Freeze Aura",
  mode: "continuous",
  attach: true,
  capacity: 180,
  emitRate: 30,
  lifetime: { min: 1.0, max: 2.2 },
  size: { min: 0.06, max: 0.16 },
  speed: { min: 0.4, max: 1.0 },
  emitBox: [0.55, 0.55, 0.5],
  direction1: [-0.3, -0.3, 0.2],
  direction2: [0.3, 0.3, 0.8],
  gravity: [0, 0, 0.2],
  colorStart: [0.7, 0.95, 1.0, 1.0],
  colorEnd: [0.3, 0.6, 0.95, 0.0],
  blendMode: "additive",
};
