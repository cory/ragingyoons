import type { AoEPreset } from "../types";

export const aoeBlast: AoEPreset = {
  kind: "aoe",
  id: "aoe-blast",
  name: "AoE Blast",
  ringRadius: 4,
  domeRadius: 2,
  ringColor: [1.0, 0.6, 0.2],
  domeColor: [1.0, 0.85, 0.4],
  duration: 0.6,
  burstPresetId: "sparks",
};
