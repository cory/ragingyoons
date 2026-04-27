import type { FxPreset } from "./types";
import { sparks } from "./presets/sparks";
import { deathPoof } from "./presets/death-poof";
import { aoeBlast } from "./presets/aoe-blast";
import { projectile } from "./presets/projectile";
import { projectileTrail } from "./presets/projectile-trail";
import { shieldBubble } from "./presets/shield-bubble";
import { poisonAura } from "./presets/poison-aura";
import { fireAura } from "./presets/fire-aura";
import { freezeAura } from "./presets/freeze-aura";
import { embers } from "./presets/embers";

const ALL: FxPreset[] = [
  sparks,
  deathPoof,
  aoeBlast,
  projectile,
  shieldBubble,
  poisonAura,
  fireAura,
  freezeAura,
  embers,
  projectileTrail,
];

export const PRESETS: Record<string, FxPreset> = Object.fromEntries(
  ALL.map((p) => [p.id, p])
);

export function listPresets(): FxPreset[] {
  return ALL.filter((p) => !p.hidden);
}

export function getPreset(id: string): FxPreset | undefined {
  return PRESETS[id];
}
