/**
 * Mood model + (mood, gait) → per-frame expression constants.
 * Same axes and presets as walking-triangle, generalised to a
 * multi-joint spine: posture is distributed across spineLow, spineHigh,
 * head as curvature instead of a single torso pivot.
 */
import type { Gait } from "./gait";

export type MoodAxis = "energy" | "posture" | "composure" | "stance";
export const MOOD_AXES: readonly MoodAxis[] = ["energy", "posture", "composure", "stance"];

export type Mood = Record<MoodAxis, number>;

export const PRESETS: Record<string, [number, number, number, number]> = {
  neutral: [0.0, 0.0, 0.0, 0.0],
  happy: [0.55, 0.55, 0.2, 0.1],
  sad: [-0.55, -0.65, -0.15, -0.3],
  angry: [0.8, -0.3, 0.1, 0.6],
  proud: [0.1, 0.65, 0.55, 0.5],
  anxious: [0.3, -0.2, -0.55, -0.6],
  drunk: [-0.1, -0.1, -0.95, 0.3],
  sneaking: [-0.45, -0.4, 0.3, -0.45],
  weary: [-0.8, -0.55, 0.05, -0.1],
};

export function presetMood(name: keyof typeof PRESETS): Mood {
  const v = PRESETS[name];
  return { energy: v[0], posture: v[1], composure: v[2], stance: v[3] };
}

// Baselines (walker units, before world-scale conversion).
export const footY0 = 22;
export const strideAmp0 = 24;
export const liftAmp0 = 14;
export const bobAmp0 = 5;
export const pitchAmp0 = 0.10;
export const rollAmp0 = 0.13;
export const phaseRate0 = 3.6;

export const WOBBLE_ROLL_FREQ = 0.70;
export const WOBBLE_PITCH_FREQ = 0.55;
export const WOBBLE_PITCH_PHASE = 1.30;

export interface Expression {
  // Gait clocks
  phaseRate: number;
  trackRate: number;

  // Foot kinematics (walker units)
  strideAmp: number;
  liftAmp: number;
  bobAmp: number;
  bobBias: number;
  bobShape: "walk" | "run" | "skip";
  contactPattern: "alternating" | "skip";
  hopRatio: number;
  stanceFrac: number;
  footY: number;

  // Hip transients (gait-driven, oscillating with phase)
  hipPitchAmp: number;
  hipPitchBaseline: number;
  hipRollAmp: number;

  // Spine curvature (mood-driven, distributed across joints)
  spineLowPitch: number;
  spineHighPitch: number;
  headPitch: number;

  // Counter-rotation (torso roll lag, applied to spineHigh)
  torsoRollAmp: number;

  // Composure noise gains for spine joints
  spineNoiseGain: number;

  // Slow drift wobble at the hip
  wobbleAmpRoll: number;
  wobbleAmpPitch: number;

  // Energy-driven upper-body bounce
  upperBounceGain: number;
}

export interface ExpressionInput {
  mood: Mood;
  gait: Gait;
  worldR: number; // walker units
}

export function deriveExpression({ mood, gait, worldR }: ExpressionInput): Expression {
  const e = mood.energy;
  const p = mood.posture;
  const c = mood.composure;
  const s = mood.stance;

  const energyScale = 1 + 0.6 * e - 0.5 * Math.max(0, -e);
  const phaseRate = phaseRate0 * gait.cadence * energyScale;
  const strideAmp = strideAmp0 * gait.stride * (1 + 0.4 * e);
  const liftFromEnergy = Math.max(2, liftAmp0 * (1 + 0.6 * e));
  const liftAmp = liftFromEnergy * gait.lift;
  const bobMag = bobAmp0 * gait.bob * (0.6 + 0.7 * Math.abs(e));

  // Posture distributed across spine joints. Sad (p<0) is a forward
  // C-curl; proud (p>0) is an S-arch (low back, mid forward, head up).
  let spineLowPitch: number;
  let spineHighPitch: number;
  let headPitch: number;
  if (p < 0) {
    spineLowPitch = p * 0.05;
    spineHighPitch = p * 0.12;
    headPitch = p * 0.10;
  } else {
    spineLowPitch = p * 0.06;
    spineHighPitch = -p * 0.10;
    headPitch = p * 0.10;
  }

  const hipPitchBaseline = gait.leanOffset;
  const bobBias = 1 + (p >= 0 ? p : 2 * p);

  const composureScale = 1 - 0.7 * c;
  const hipPitchAmp = pitchAmp0 * composureScale * (1 + 0.4 * Math.abs(e));
  const hipRollAmp = rollAmp0 * composureScale * (1 + 0.3 * Math.max(0, -e));
  const torsoRollAmp = 0.18 * composureScale * (1 + 0.4 * Math.max(0, -c));
  const spineNoiseGain = Math.max(0, -c);

  const footY = footY0 * (1 + 0.45 * s);

  const wobbleGain = Math.max(0, -c);
  const wobbleAmpRoll = 0.18 * wobbleGain;
  const wobbleAmpPitch = 0.10 * wobbleGain;

  const upperBounceGain = Math.max(0, e) * 0.04;

  const stanceFrac = gait.stanceFrac;
  const trackRate = (strideAmp * phaseRate) / (Math.PI * worldR * stanceFrac);

  return {
    phaseRate,
    trackRate,
    strideAmp,
    liftAmp,
    bobAmp: bobMag,
    bobBias,
    bobShape: gait.bobShape,
    contactPattern: gait.contactPattern,
    hopRatio: gait.hopRatio ?? 0,
    stanceFrac,
    footY,
    hipPitchAmp,
    hipPitchBaseline,
    hipRollAmp,
    spineLowPitch,
    spineHighPitch,
    headPitch,
    torsoRollAmp,
    spineNoiseGain,
    wobbleAmpRoll,
    wobbleAmpPitch,
    upperBounceGain,
  };
}
