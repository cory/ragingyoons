/**
 * Per-frame driver: turn (gait, mood, t) into bone TRS and a world transform.
 *
 * Coordinate frame is RH Z-up throughout (matches walker exactly):
 *   World:     +Z up. Track lies on the XY plane, character moves CCW.
 *   Character: +X forward, +Y left, +Z up.
 *   Walker:    walker.x = forward = +X, walker.y = lateral = +Y, walker.z = vertical = +Z.
 *
 * Bone rest layouts come from rigLayout: spine chain rises along +Z;
 * footL is at +Y, footR at -Y; both feet drop to z=0 at rest.
 */
import { Bone, Matrix, Quaternion, Vector3 } from "@babylonjs/core";
import type { CharacterMesh } from "../character/mesh";
import { UNIT_SCALE, WORLD_R_BABYLON, WORLD_R_WALKER } from "../scale";
import { computeBob, GAITS, skipFoot, walkFoot } from "./gait";
import {
  deriveExpression,
  type Expression,
  type Mood,
  WOBBLE_PITCH_FREQ,
  WOBBLE_PITCH_PHASE,
  WOBBLE_ROLL_FREQ,
} from "./mood";

export { WORLD_R_WALKER };

const SPINE_NOISE_FREQ = [0.83, 1.27, 1.61];

const TMP_S = new Vector3(1, 1, 1);
const TMP_Q = new Quaternion();
const TMP_T = new Vector3();

/**
 * Set a bone's local TRS. Euler order: roll (around X = forward axis),
 * pitch (around Y = lateral axis), yaw (around Z = up axis).
 */
function setBoneLocal(
  bone: Bone,
  px: number,
  py: number,
  pz: number,
  rollX: number,
  pitchY: number,
  yawZ: number,
): void {
  TMP_T.set(px, py, pz);
  Quaternion.FromEulerAnglesToRef(rollX, pitchY, yawZ, TMP_Q);
  const m = Matrix.Compose(TMP_S, TMP_Q, TMP_T);
  bone.getLocalMatrix().copyFrom(m);
  bone.markAsDirty();
}

export interface DriverState {
  phase: number;
  trackPhi: number;
  slowTime: number;
  gaitName: keyof typeof GAITS;
  mood: Mood;
  prevLiftedR: boolean;
  prevLiftedL: boolean;
}

export function makeDriverState(
  initialGait: keyof typeof GAITS = "walk",
  initialMood?: Mood,
): DriverState {
  return {
    phase: 0,
    trackPhi: 0,
    slowTime: 0,
    gaitName: initialGait,
    mood: initialMood ?? { energy: 0, posture: 0, composure: 0, stance: 0 },
    prevLiftedR: false,
    prevLiftedL: false,
  };
}

export interface UpdateOpts {
  speedMul?: number;
  onPlant?: (side: "L" | "R", worldX: number, worldY: number, headingZ: number) => void;
}

export function updateDriver(
  ch: CharacterMesh,
  state: DriverState,
  dt: number,
  opts: UpdateOpts = {},
): Expression {
  const speedMul = opts.speedMul ?? 1;
  const gait = GAITS[state.gaitName];
  const ex = deriveExpression({ mood: state.mood, gait, worldR: WORLD_R_WALKER });

  state.slowTime += dt;
  state.phase += dt * ex.phaseRate * speedMul;
  state.trackPhi += dt * ex.trackRate * speedMul;
  if (state.phase > Math.PI * 2) state.phase -= Math.PI * 2;
  if (state.trackPhi > Math.PI * 2) state.trackPhi -= Math.PI * 2;

  const phi = state.phase / (Math.PI * 2);
  const f = ex.stanceFrac;
  const A = ex.strideAmp;

  const wobbleRoll =
    Math.sin(state.slowTime * WOBBLE_ROLL_FREQ) * ex.wobbleAmpRoll;
  const wobblePitch =
    Math.sin(state.slowTime * WOBBLE_PITCH_FREQ + WOBBLE_PITCH_PHASE) *
    ex.wobbleAmpPitch;

  // Foot kinematics in walker frame: x = forward, z = vertical lift.
  let footRight, footLeft;
  if (ex.contactPattern === "skip") {
    const D = (2 * A) / f;
    footRight = skipFoot(phi, f, A, D, ex.hopRatio, ex.liftAmp);
    footLeft = skipFoot((phi + 0.5) % 1, f, A, D, ex.hopRatio, ex.liftAmp);
  } else {
    footRight = walkFoot(phi, f, A, ex.liftAmp);
    footLeft = walkFoot((phi + 0.5) % 1, f, A, ex.liftAmp);
  }

  const bobZ = computeBob(phi, f, ex.bobShape) * ex.bobAmp * ex.bobBias;

  // Hip transients.
  // pitch around Y (forward/back bow), roll around X (sideways sway).
  const hipPitchY =
    ex.hipPitchBaseline + Math.sin(state.phase) * ex.hipPitchAmp + wobblePitch;
  const hipRollX = -Math.sin(state.phase) * ex.hipRollAmp + wobbleRoll;

  // Counter-rotation lag on the upper spine.
  const torsoRollX = -Math.sin(state.phase + Math.PI) * ex.torsoRollAmp;

  // Spine composure noise.
  const t = state.slowTime;
  const noiseLow =
    ex.spineNoiseGain *
    (Math.sin(t * SPINE_NOISE_FREQ[0]) * 0.06 +
      Math.sin(t * SPINE_NOISE_FREQ[1] + 1.7) * 0.04);
  const noiseHigh =
    ex.spineNoiseGain *
    (Math.sin(t * SPINE_NOISE_FREQ[1] + 0.6) * 0.07 +
      Math.sin(t * SPINE_NOISE_FREQ[2] + 2.3) * 0.05);

  // Energy-driven upper-body bounce.
  const upperBounce = Math.sin(state.phase * 2) * ex.upperBounceGain;

  const layout = ch.rig.layout;
  const { hip, spineLow, spineHigh, head, footL, footR } = ch.rig.bones;

  // Hip — bob translates +Z; pitchY (lean) + rollX (sway) applied locally.
  setBoneLocal(
    hip,
    0,
    0,
    layout.zHip + bobZ * UNIT_SCALE,
    hipRollX,
    hipPitchY,
    0,
  );

  setBoneLocal(
    spineLow,
    0,
    0,
    layout.zLow - layout.zHip,
    noiseLow * 0.4,
    ex.spineLowPitch + noiseLow,
    0,
  );
  setBoneLocal(
    spineHigh,
    0,
    0,
    layout.zHigh - layout.zLow,
    torsoRollX,
    ex.spineHighPitch + noiseHigh + upperBounce,
    0,
  );
  setBoneLocal(
    head,
    0,
    0,
    layout.zHead - layout.zHigh,
    0,
    ex.headPitch,
    0,
  );

  // Feet — walker output goes straight in: x = forward stride, z = lift.
  // Foot rest is hip-relative (0, ±footY, -zHip); per-frame stride/lift add.
  const footLateralWorld = ex.footY * UNIT_SCALE;
  const zFootRel = -layout.zHip;
  setBoneLocal(
    footL,
    footLeft.x * UNIT_SCALE,
    +footLateralWorld,
    zFootRel + footLeft.z * UNIT_SCALE,
    0,
    0,
    0,
  );
  setBoneLocal(
    footR,
    footRight.x * UNIT_SCALE,
    -footLateralWorld,
    zFootRel + footRight.z * UNIT_SCALE,
    0,
    0,
    0,
  );

  // World transform — circle in XY plane at z=0, CCW heading along tangent.
  const cx = WORLD_R_BABYLON * Math.cos(state.trackPhi);
  const cy = WORLD_R_BABYLON * Math.sin(state.trackPhi);
  ch.root.position.set(cx, cy, 0);
  // Character +X (forward) aligns with tangent (-sin φ, cos φ, 0).
  // Yaw around +Z: ψ = trackPhi + π/2.
  const yaw = state.trackPhi + Math.PI / 2;
  ch.root.rotation.set(0, 0, yaw);

  // Plant detection — emit on lifted→grounded transition for each foot.
  if (opts.onPlant) {
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    if (state.prevLiftedR && !footRight.lifted) {
      const lx = footRight.x * UNIT_SCALE;
      const ly = -footLateralWorld;
      opts.onPlant("R", cx + cosY * lx - sinY * ly, cy + sinY * lx + cosY * ly, yaw);
    }
    if (state.prevLiftedL && !footLeft.lifted) {
      const lx = footLeft.x * UNIT_SCALE;
      const ly = +footLateralWorld;
      opts.onPlant("L", cx + cosY * lx - sinY * ly, cy + sinY * lx + cosY * ly, yaw);
    }
  }
  state.prevLiftedR = footRight.lifted;
  state.prevLiftedL = footLeft.lifted;

  return ex;
}
