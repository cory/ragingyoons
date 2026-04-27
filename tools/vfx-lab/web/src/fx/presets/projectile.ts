import type { ProjectilePreset } from "../types";

export const projectile: ProjectilePreset = {
  kind: "projectile",
  id: "projectile-bolt",
  name: "Magic Bolt",
  speed: 18,
  meshRadius: 0.18,
  meshColor: [1.0, 0.85, 0.4],
  trailPresetId: "projectile-trail",
  impactPresetId: "sparks",
};
