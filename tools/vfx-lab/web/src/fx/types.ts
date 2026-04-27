import type { AbstractMesh, Vector3 } from "@babylonjs/core";

export type Vec3 = [number, number, number];
export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

export interface ParticlePreset {
  kind: "particle";
  id: string;
  name: string;
  hidden?: boolean;
  mode: "burst" | "continuous";
  attach: boolean;
  capacity: number;
  emitRate: number;
  burst?: number;
  duration?: number;
  lifetime: { min: number; max: number };
  size: { min: number; max: number };
  speed: { min: number; max: number };
  emitBox: Vec3;
  direction1: Vec3;
  direction2: Vec3;
  gravity: Vec3;
  colorStart: RGBA;
  colorEnd: RGBA;
  blendMode: "additive" | "standard";
}

export interface ProjectilePreset {
  kind: "projectile";
  id: string;
  name: string;
  hidden?: boolean;
  speed: number;
  meshRadius: number;
  meshColor: RGB;
  trailPresetId: string;
  impactPresetId: string;
}

export interface ShieldPreset {
  kind: "shield";
  id: string;
  name: string;
  hidden?: boolean;
  radius: number;
  color: RGB;
  rimColor: RGB;
  baseAlpha: number;
  rimAlpha: number;
  pulseHz: number;
  duration?: number;
}

export interface AoEPreset {
  kind: "aoe";
  id: string;
  name: string;
  hidden?: boolean;
  ringRadius: number;
  domeRadius: number;
  ringColor: RGB;
  domeColor: RGB;
  duration: number;
  burstPresetId: string;
}

export type FxPreset =
  | ParticlePreset
  | ProjectilePreset
  | ShieldPreset
  | AoEPreset;

export interface SpawnOpts {
  origin: Vector3;
  target?: Vector3;
  attachTo?: AbstractMesh;
}

export interface FxHandle {
  id: string;
  preset: FxPreset;
  dispose: () => void;
}
