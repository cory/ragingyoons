/**
 * Coordinate convention (matches walker exactly):
 *   World:     right-handed, Z-up. Track is on the XY plane.
 *              Forward (CCW around the circle) is the +tangent direction.
 *   Character: right-handed, X-forward, Y-left, Z-up.
 *   Bones:     chain runs UP along +Z. Lateral offset for feet is on ±Y.
 */
import { Bone, Matrix, type Scene, Skeleton, Vector3 } from "@babylonjs/core";

export const BONE = {
  hip: 0,
  spineLow: 1,
  spineHigh: 2,
  head: 3,
  footL: 4,
  footR: 5,
} as const;

export type BoneIndex = (typeof BONE)[keyof typeof BONE];

export interface RigLayout {
  legHeight: number;
  bodyHeight: number;
  height: number;
  zHip: number;   // top of legs / bottom of body
  zLow: number;
  zHigh: number;
  zHead: number;
}

export interface Rig {
  skeleton: Skeleton;
  layout: RigLayout;
  bones: {
    hip: Bone;
    spineLow: Bone;
    spineHigh: Bone;
    head: Bone;
    footL: Bone;
    footR: Bone;
  };
}

export function rigLayout(legHeight: number, bodyHeight: number): RigLayout {
  return {
    legHeight,
    bodyHeight,
    height: legHeight + bodyHeight,
    zHip: legHeight,
    zLow: legHeight + bodyHeight * 0.25,
    zHigh: legHeight + bodyHeight * 0.65,
    zHead: legHeight + bodyHeight * 0.95,
  };
}

export function createRig(scene: Scene, layout: RigLayout, footLateral: number): Rig {
  const skeleton = new Skeleton("rig", "rig", scene);
  const { zHip, zLow, zHigh, zHead } = layout;

  // Bones positioned along +Z. Local rest = translation from parent.
  const hip = new Bone("hip", skeleton, null, Matrix.Translation(0, 0, zHip));
  const spineLow = new Bone(
    "spineLow",
    skeleton,
    hip,
    Matrix.Translation(0, 0, zLow - zHip),
  );
  const spineHigh = new Bone(
    "spineHigh",
    skeleton,
    spineLow,
    Matrix.Translation(0, 0, zHigh - zLow),
  );
  const head = new Bone(
    "head",
    skeleton,
    spineHigh,
    Matrix.Translation(0, 0, zHead - zHigh),
  );
  // Feet: hip-relative. +Y is left of forward, -Z drops to ground.
  const footL = new Bone(
    "footL",
    skeleton,
    hip,
    Matrix.Translation(0, +footLateral, -zHip),
  );
  const footR = new Bone(
    "footR",
    skeleton,
    hip,
    Matrix.Translation(0, -footLateral, -zHip),
  );

  return {
    skeleton,
    layout,
    bones: { hip, spineLow, spineHigh, head, footL, footR },
  };
}

/**
 * Soft skinning weights for a body vertex at world-z. Returns up to 2 bone
 * influences along the spine chain.
 */
export function skinWeightsAtZ(
  z: number,
  layout: RigLayout,
): { i0: number; w0: number; i1: number; w1: number } {
  const { zHip, zLow, zHigh, zHead } = layout;
  if (z <= zHip) return { i0: BONE.hip, w0: 1, i1: 0, w1: 0 };
  if (z >= zHead) return { i0: BONE.head, w0: 1, i1: 0, w1: 0 };
  if (z < zLow) {
    const t = (z - zHip) / (zLow - zHip);
    return { i0: BONE.hip, w0: 1 - t, i1: BONE.spineLow, w1: t };
  }
  if (z < zHigh) {
    const t = (z - zLow) / (zHigh - zLow);
    return { i0: BONE.spineLow, w0: 1 - t, i1: BONE.spineHigh, w1: t };
  }
  const t = (z - zHigh) / (zHead - zHigh);
  return { i0: BONE.spineHigh, w0: 1 - t, i1: BONE.head, w1: t };
}
