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
  armL: 6,
  armR: 7,
  handL: 8,
  handR: 9,
  tail: 10,
  tail1: 11,
  tail2: 12,
} as const;

export type BoneIndex = (typeof BONE)[keyof typeof BONE];
export const NUM_BONES = 13;

export interface RigLayout {
  legHeight: number;
  bodyHeight: number;
  height: number;
  zHip: number;   // top of legs / bottom of body
  zLow: number;
  zHigh: number;
  zHead: number;
  /** Lateral offset (world units) of the shoulder anchors from spine. */
  shoulderY: number;
  /** Z of the shoulder relative to spineHigh's z (negative = below). */
  shoulderZRel: number;
  /** Hand-bone offset from its parent arm bone, in arm-local frame.
   *  Y-magnitude (handL gets +armTipY, handR gets -armTipY). */
  armTipX: number;
  armTipY: number;
  armTipZ: number;
  /** Tail-bone rest position in mesh-local (= world) coords. The bone
   *  is parented to spineLow; its local translation is computed from
   *  these and spineLow's z. The driver pitches/rolls the bone per
   *  frame for bouncy spring-tail motion. */
  tailBaseX: number;
  tailAttachZ: number;
  /** World-units offset along the tail axis from one tail bone to the
   *  next (tail0→tail1, tail1→tail2). Used as each child bone's local
   *  rest translation so the chain runs along the tail. */
  tailSegOffsetX: number;
  tailSegOffsetZ: number;
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
    armL: Bone;
    armR: Bone;
    handL: Bone;
    handR: Bone;
    tail: Bone;
    tail1: Bone;
    tail2: Bone;
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
    shoulderY: 0,         // raccoon mesh fills these in
    shoulderZRel: 0,
    armTipX: 0,
    armTipY: 0,
    armTipZ: 0,
    tailBaseX: 0,
    tailAttachZ: 0,
    tailSegOffsetX: 0,
    tailSegOffsetZ: 0,
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
  // Arms: child of spineHigh, anchored at the shoulder. Per-frame the
  // driver applies pitchY (rotation around the lateral axis) so the
  // arms swing forward / back in counter-stride to the same-side leg.
  const armL = new Bone(
    "armL",
    skeleton,
    spineHigh,
    Matrix.Translation(0, +layout.shoulderY, layout.shoulderZRel),
  );
  const armR = new Bone(
    "armR",
    skeleton,
    spineHigh,
    Matrix.Translation(0, -layout.shoulderY, layout.shoulderZRel),
  );
  // Hands: child of arms, anchored at the arm tip. No animation today
  // — they just ride the arm swing — but they're attachment points for
  // future props (held items).
  const handL = new Bone(
    "handL",
    skeleton,
    armL,
    Matrix.Translation(layout.armTipX, +layout.armTipY, layout.armTipZ),
  );
  const handR = new Bone(
    "handR",
    skeleton,
    armR,
    Matrix.Translation(layout.armTipX, -layout.armTipY, layout.armTipZ),
  );
  // Tail: 3-bone chain so the tail curves into an arc rather than
  // pivoting rigidly. tail0 is rooted at the tail base under spineLow;
  // tail1 and tail2 are each translated one segment along the tail
  // axis. The driver pitches and rolls each bone with successive
  // phase lags for a wave / spring feel that compounds down the chain.
  const tail = new Bone(
    "tail",
    skeleton,
    spineLow,
    Matrix.Translation(layout.tailBaseX, 0, layout.tailAttachZ - zLow),
  );
  const tail1 = new Bone(
    "tail1",
    skeleton,
    tail,
    Matrix.Translation(layout.tailSegOffsetX, 0, layout.tailSegOffsetZ),
  );
  const tail2 = new Bone(
    "tail2",
    skeleton,
    tail1,
    Matrix.Translation(layout.tailSegOffsetX, 0, layout.tailSegOffsetZ),
  );

  return {
    skeleton,
    layout,
    bones: {
      hip, spineLow, spineHigh, head, footL, footR,
      armL, armR, handL, handR, tail, tail1, tail2,
    },
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
