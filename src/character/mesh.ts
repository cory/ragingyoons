/**
 * Character mesh entry point. Raccoon is the only character — this file
 * is a thin wrapper around `buildRaccoon` so call sites can keep using
 * `buildCharacter` / `CharacterMesh` without knowing the underlying
 * builder.
 *
 * Coordinates: RH, Z-up. Body lives at z ∈ [legHeight, legHeight +
 * bodyHeight]; legs occupy z ∈ [0, legHeight]; head bone sits above
 * the body so it can yaw independently.
 */
import { type Mesh, type Scene } from "@babylonjs/core";
import type { Unit } from "./generator";
import type { Rig } from "../rig/skeleton";
import { buildRaccoon } from "./raccoonMesh";

export interface CharacterMesh {
  root: Mesh;
  rig: Rig;
  unit: Unit;
  height: number;
  footLateral: number;
}

export function buildCharacter(unit: Unit, scene: Scene): CharacterMesh {
  return buildRaccoon(unit, scene);
}
