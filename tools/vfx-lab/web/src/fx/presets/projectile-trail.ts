import type { ParticlePreset } from "../types";

export const projectileTrail: ParticlePreset = {
  kind: "particle",
  id: "projectile-trail",
  name: "Projectile Trail",
  hidden: true,
  mode: "continuous",
  attach: true,
  capacity: 200,
  emitRate: 140,
  lifetime: { min: 0.15, max: 0.35 },
  size: { min: 0.06, max: 0.16 },
  speed: { min: 0.1, max: 0.4 },
  emitBox: [0.04, 0.04, 0.04],
  direction1: [-0.2, -0.2, -0.2],
  direction2: [0.2, 0.2, 0.2],
  gravity: [0, 0, 0],
  colorStart: [1.0, 0.9, 0.5, 1.0],
  colorEnd: [1.0, 0.3, 0.05, 0.0],
  blendMode: "additive",
};
