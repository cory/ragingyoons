/**
 * Raccoon spec + procedural generator.
 *
 * A raccoon is built from two ellipse-band stacks (body, head) plus ears
 * and eyes. The body stack is soft-skinned across hip→spineLow→spineHigh
 * (no head influence); the head stack is rigid-skinned 100% to the head
 * bone, which sits ABOVE the body top so the head can yaw independently
 * of the body's heading.
 *
 * Coordinates are walker units, RH, X-forward, Y-left, Z-up — same as the
 * rest of the character pipeline. Conversion to babylon meters happens in
 * the mesh builder via UNIT_SCALE.
 */
import { chance, makeRNG, pick, range, type RNG } from "./rng";
import {
  type Layer,
  type Palette,
  type ShadeKey,
  type Unit,
  generateUnit,
} from "./generator";
import {
  moodReactionsFor,
  pickAvailableGaits,
  pickFormationRole,
  pickPersonality,
  speedMulFor,
} from "./personality";

/** A single ellipse band in a raccoon stack. rx is along +X (forward),
 *  ry is along +Y (lateral). Thickness extrudes along +Z. */
export interface RaccoonBand {
  rx: number;
  ry: number;
  thickness: number;
  /** Forward offset from the stack centerline (e.g., snout droop). */
  xOffset: number;
  shadeKey: ShadeKey;
}

export interface RaccoonArms {
  /** Arm length in walker units (shoulder → tip). */
  length: number;
  /** Radius at the shoulder end (walker units). Tip is `radius * tipMul`. */
  radius: number;
  /** Tip radius as a fraction of shoulder radius. <1 = tapered. */
  tipMul: number;
  /** Forward droop in radians. 0 = straight down, π/4 ≈ 45° forward. */
  droop: number;
  /** Lateral shoulder offset as a fraction of the body's max ry. */
  shoulderYFrac: number;
  /** Vertical shoulder height as a fraction of body height (0..1). */
  shoulderZFrac: number;
  /** Shade key for arm color. */
  shadeKey: ShadeKey;
}

export interface RaccoonTail {
  /** Total tail length in walker units. */
  length: number;
  /** Radius at the base in walker units. Tip is `baseRadius * tipMul`. */
  baseRadius: number;
  /** Tip radius as a fraction of base. <1 = tapered. */
  tipMul: number;
  /** Number of alternating-color segments along the tail. */
  segments: number;
  /** Upward tilt in radians. 0 = horizontal back, π/2 = straight up. */
  upTilt: number;
  /** Z fraction on body where tail attaches (0=hip, 1=top of body). */
  attachZFrac: number;
  /** Color of even-index segments. */
  primaryShade: ShadeKey;
  /** Color of odd-index segments — the "rings". */
  bandShade: ShadeKey;
}

export interface RaccoonEars {
  /** Cone height (walker units). */
  size: number;
  /** Lateral separation as a fraction of head top ry. ±spread*ry on Y. */
  spread: number;
  /** Outward tilt in radians. 0 = straight up, 0.4 ≈ ~23° outward. */
  tilt: number;
  shadeKey: ShadeKey;
}

export interface RaccoonEyes {
  /** Eye disc radius (walker units). */
  size: number;
  /** Lateral separation as a fraction of eye-band ry. ±spread*ry on Y. */
  spread: number;
  /** Forward push as a fraction of eye-band rx (0..1+). */
  forward: number;
  /** Index into head bands (0 = bottom). */
  bandIdx: number;
}

/** Look behavior weights. Need not sum to 1 — normalized at use. */
export interface LookMix {
  idle: number;
  camera: number;
  influence: number;
}

export interface RaccoonSpec {
  body: RaccoonBand[];     // bottom → top
  head: RaccoonBand[];     // bottom → top, sits above body
  /** Vertical gap between top of body and bottom of head stack (walker units). */
  headOffset: number;
  ears: RaccoonEars;
  arms: RaccoonArms;
  tail: RaccoonTail;
  eyes: RaccoonEyes;
  /** Strength of dark face mask shading on the eye band, 0..1. */
  maskStrength: number;
  /** Body band ellipsoid overlap, 0..0.85. 0 = bands just touch (visible
   *  necks), → 1 = centers coincide (single melted blob). */
  bodyOverlap: number;
  /** Fractional Z position of the body's biggest bulge, 0..1.
   *  0.15 = pear (bulge low), 0.5 = balanced egg, 0.85 = apple (bulge high). */
  bodyPeak: number;
  lookMix: LookMix;
}

/** Defaults that produce a recognizable bipedal raccoon. Tunable.
 *  Body radius is generated procedurally from `bodyPeak` (see
 *  `bodyRadiusMul`) — only the thickness profile and base radius live
 *  here. Head keeps a slight snout (rx > ry). */
export const RACCOON_DEFAULTS = {
  bodyBands: 5,
  headBands: 3,
  baseRx: 50,
  // Thicknesses pre-compensate the default overlap so the silhouette
  // reads about as tall as the cumulative-thickness sum used to.
  bodyThick: [16, 22, 27, 24, 19],
  // Head profile — slight snout (rx > ry).
  headRxMul: [0.62, 0.72, 0.52],
  headRyMul: [0.56, 0.64, 0.46],
  // Pre-compensate for the 50% overlap blend so the head silhouette ends
  // up about as tall as the old cumulative-thickness sum.
  headThick: [18, 21, 15],
  headOffset: 3,
  // Snout droop — small +X bias on the upper head bands.
  headXOffset: [0, 1.8, 0.6],
  earSize: 13,
  earSpread: 0.82,
  earTilt: 0.3,
  // Arms — short tapered cylinders that hang forward-down from upper body.
  armLength: 22,
  armRadius: 5.5,
  armTipMul: 0.65,
  armDroop: 0.45,
  armShoulderYFrac: 0.78,
  armShoulderZFrac: 0.86,
  // Tail — chain of alternating-color segments out the back.
  tailLength: 36,
  tailBaseRadius: 9,
  tailTipMul: 0.4,
  tailSegments: 5,
  tailUpTilt: 0.45,
  tailAttachZFrac: 0.30,
  eyeSize: 3.8,
  eyeSpread: 0.55,
  // > 1 sits the disc just outside the band surface to avoid z-fight.
  eyeForward: 1.04,
  eyeBandIdx: 1,
  maskStrength: 0.55,
  bodyPeakDefault: 0.5,
  bodyOverlapDefault: 0.65,
  // Bell curve params for body bulge profile.
  bodyRadiusPeak: 0.85,
  bodyRadiusEdge: 0.46,
} as const;

/** Returns the rx/ry multiplier (× baseRx) for a band whose center sits
 *  at fractional Z `bandT` (0 = bottom of body, 1 = top), given a peak
 *  fractional Z `peakT`. Bell-shaped: peak value at peakT, EDGE at the
 *  far end of the stack. Drives apple/pear silhouettes via `bodyPeak`. */
export function bodyRadiusMul(bandT: number, peakT: number): number {
  const PEAK = RACCOON_DEFAULTS.bodyRadiusPeak;
  const EDGE = RACCOON_DEFAULTS.bodyRadiusEdge;
  const d = bandT - peakT;
  let normD: number;
  if (d < 0) normD = peakT > 1e-3 ? -d / peakT : 1;
  else        normD = peakT < 1 - 1e-3 ? d / (1 - peakT) : 1;
  normD = Math.min(1, normD);
  return EDGE + (PEAK - EDGE) * (1 - normD * normD);
}

/** Compute fractional Z position (0..1) of each band's center under
 *  smoothMax overlap blending. Used to align the bell-curve radius
 *  profile with the actual silhouette positions. */
export function bandFractionalZs(thicknesses: number[], overlap: number): number[] {
  if (thicknesses.length === 0) return [];
  const halves = thicknesses.map((t) => t / 2);
  const centers: number[] = [halves[0]];
  for (let i = 1; i < halves.length; i++) {
    centers.push(centers[i - 1] + (halves[i - 1] + halves[i]) * (1 - overlap));
  }
  const totalH = centers[centers.length - 1] + halves[halves.length - 1];
  return centers.map((c) => (totalH > 0 ? c / totalH : 0));
}

/** Build the default raccoon spec. Slider-driven UI rebuilds bands via
 *  the same helpers (see specFromControls in main.ts). */
export function defaultRaccoonSpec(): RaccoonSpec {
  const D = RACCOON_DEFAULTS;
  const body = buildBodyBands(
    D.bodyThick.slice(),
    D.bodyPeakDefault,
    D.bodyOverlapDefault,
    D.baseRx,
    1,
    1,
  );
  const head: RaccoonBand[] = [];
  for (let i = 0; i < D.headBands; i++) {
    head.push({
      rx: D.baseRx * D.headRxMul[i],
      ry: D.baseRx * D.headRyMul[i],
      thickness: D.headThick[i],
      xOffset: D.headXOffset[i],
      shadeKey: pickHeadShade(i, D.headBands),
    });
  }
  return {
    body,
    head,
    headOffset: D.headOffset,
    ears: {
      size: D.earSize,
      spread: D.earSpread,
      tilt: D.earTilt,
      shadeKey: "primaryDark",
    },
    arms: {
      length: D.armLength,
      radius: D.armRadius,
      tipMul: D.armTipMul,
      droop: D.armDroop,
      shoulderYFrac: D.armShoulderYFrac,
      shoulderZFrac: D.armShoulderZFrac,
      shadeKey: "primaryDark",
    },
    tail: {
      length: D.tailLength,
      baseRadius: D.tailBaseRadius,
      tipMul: D.tailTipMul,
      segments: D.tailSegments,
      upTilt: D.tailUpTilt,
      attachZFrac: D.tailAttachZFrac,
      primaryShade: "primary",
      bandShade: "primaryDark",
    },
    eyes: {
      size: D.eyeSize,
      spread: D.eyeSpread,
      forward: D.eyeForward,
      bandIdx: D.eyeBandIdx,
    },
    maskStrength: D.maskStrength,
    bodyOverlap: D.bodyOverlapDefault,
    bodyPeak: D.bodyPeakDefault,
    lookMix: { idle: 0.5, camera: 0.25, influence: 0.25 },
  };
}

/** Build a body band stack of given thicknesses, with rx/ry shaped by a
 *  bell curve peaking at fractional Z `peakT`. xScale and yScale stretch
 *  forward (X) and lateral (Y) independently. */
export function buildBodyBands(
  thicknesses: number[],
  peakT: number,
  overlap: number,
  baseRx: number,
  xScale: number,
  yScale: number,
): RaccoonBand[] {
  const bandTs = bandFractionalZs(thicknesses, overlap);
  return thicknesses.map((t, i) => {
    const mul = bodyRadiusMul(bandTs[i], peakT);
    return {
      rx: baseRx * mul * xScale,
      ry: baseRx * mul * yScale,
      thickness: t,
      xOffset: 0,
      shadeKey: pickBodyShade(i, thicknesses.length),
    };
  });
}

function pickBodyShade(i: number, n: number): ShadeKey {
  // Smooth ramp dark→mid for the body. Raccoons read as gray-on-gray.
  const ramp: ShadeKey[] = ["primaryDark", "primaryMid", "primary", "primaryMid"];
  const t = n === 1 ? 0 : i / (n - 1);
  return ramp[Math.min(ramp.length - 1, Math.round(t * (ramp.length - 1)))];
}

function pickHeadShade(i: number, n: number): ShadeKey {
  // Bottom = lighter snout, middle = mask zone (mesh applies maskStrength),
  // top = primary fur cap.
  if (i === 0) return "primaryLight";
  if (i === n - 1) return "primary";
  return "primaryMid";
}

/** Layers are still required by Unit (and used by parts of the codebase
 *  that expect a single stack). For raccoons we synthesize a minimal
 *  Layer[] mirroring the body stack — used for height / leg sizing only.
 *  The actual raccoon mesh ignores `unit.layers` and reads `unit.raccoon`. */
function bodyAsLayers(spec: RaccoonSpec): Layer[] {
  return spec.body.map<Layer>((b, i, arr) => ({
    shape: "circle",
    r: Math.max(b.rx, b.ry),
    thickness: b.thickness,
    x: b.xOffset,
    role: i === 0 ? "base" : i === arr.length - 1 ? "crown" : "body",
    tone: "primary",
    inset: false,
    shadeKey: b.shadeKey,
    aspect: b.rx / Math.max(0.001, b.ry),
  }));
}

export interface GenerateRaccoonOpts {
  /** Override the personality's primary hue. Raccoons are typically grayish. */
  hueOverride?: number;
  /** Existing spec to extend (e.g., when slider edits already happened). */
  spec?: RaccoonSpec;
  /** Reuse an existing palette so the raccoon matches a generated unit. */
  palette?: Palette;
}

/** Build a Unit decorated as a raccoon. Reuses existing personality / mood
 *  / palette systems so the raccoon plugs straight into the driver. */
export function generateRaccoon(seedStr: string, opts: GenerateRaccoonOpts = {}): Unit {
  const rng = makeRNG(seedStr);
  // Borrow a stock unit for personality + faction + palette scaffolding.
  // Raccoons default to muted gray-ish hues unless an override is passed.
  const stock = generateUnit(rng, {
    hueOverride: opts.hueOverride ?? pickRaccoonHue(rng),
  });
  const spec = opts.spec ?? defaultRaccoonSpec();
  if (opts.palette) stock.palette = opts.palette;

  const layers = bodyAsLayers(spec);
  return {
    ...stock,
    name: stock.name,
    epithet: "the Hand-washer",
    archetype: "Raccoon",
    layers,
    eyes: "none",          // raccoon eyes are spec-driven, not the legacy eye system
    eyeLayer: 0,
    protrusions: "none",   // ears come from spec
    floating: false,
    kind: "raccoon",
    raccoon: spec,
    personality: stock.personality,
    moods: moodReactionsFor(stock.personality),
    speedMul: speedMulFor(stock.personality, rng),
    availableGaits: pickAvailableGaits(rng),
    formationRole: pickFormationRole("Raccoon", rng),
  };
}

/** Wrap an existing Unit (its archetype, personality, palette, faction,
 *  team membership, etc. are preserved) with a raccoon spec. This is
 *  the standard way to "render this guy as a raccoon" — nothing about
 *  the underlying identity changes. */
export function asRaccoon(unit: Unit, spec: RaccoonSpec): Unit {
  return {
    ...unit,
    kind: "raccoon",
    raccoon: spec,
  };
}

function pickRaccoonHue(rng: RNG): number {
  // Mostly cool grays + occasional warm browns. Saturation/lightness still
  // come from the palette pipeline downstream.
  if (chance(rng, 0.7)) return range(rng, 200, 240); // cool gray-blue
  return pick(rng, [22, 32, 42]); // warm sepia/brown
}

// ── Per-unit raccoon variation ─────────────────────────────────────
// Each Unit has archetype / personality / tier / faction. Those fields
// already encode "what kind of guy is this"; here we read them to bend
// the slider-driven base spec into a per-unit shape so the roster +
// flock visibly differ. RNG seeded by unit.id for determinism.

interface ArchetypeSkew {
  /** Overall scale — multiplies both height and width together. */
  scale: number;
  /** INDEPENDENT vertical scale (multiplies band thicknesses + leg height
   *  and head height). Decoupled from horizontal so raccoons can be tall
   *  and skinny or short and fat. */
  vert: number;
  /** INDEPENDENT horizontal scale (multiplies all band rx + ry). */
  horiz: number;
  /** Extra multiplier on head only (head/body ratio). */
  headMul: number;
  /** Multiplier on ear size. */
  earMul: number;
  /** Bias added to bodyPeak (− = pear, + = apple). */
  peakBias: number;
  /** Multiplier on body length (X) — < 1 stubby, > 1 lanky front-to-back. */
  bodyLen: number;
  /** Multiplier on body width (Y) — > 1 chunky lateral. */
  bodyWid: number;
  /** Multiplier on arm length. */
  armLen: number;
  /** Multiplier on arm radius. */
  armR: number;
  /** Bias added to arm droop (radians). */
  armDroopBias: number;
  /** Multiplier on tail length. */
  tailLen: number;
  /** Multiplier on tail base radius (= bushiness). */
  tailR: number;
  /** Bias added to tail upTilt (radians). */
  tailTiltBias: number;
}

const ARCH_SKEW: Record<string, ArchetypeSkew> = {
  // Big and heavy — tall AND wide. Beefy.
  Warden:    { scale: 1.30, vert: 1.10, horiz: 1.20, headMul: 0.92, earMul: 0.85, peakBias: 0.00,  bodyLen: 1.00, bodyWid: 1.08, armLen: 1.05, armR: 1.20, armDroopBias: -0.05, tailLen: 1.05, tailR: 1.25, tailTiltBias: -0.10 },
  // Tall and narrow — lanky, very long whippy tail.
  Striker:   { scale: 0.95, vert: 1.30, horiz: 0.78, headMul: 1.00, earMul: 1.00, peakBias: -0.10, bodyLen: 0.96, bodyWid: 0.92, armLen: 1.25, armR: 0.85, armDroopBias: 0.05,  tailLen: 1.35, tailR: 0.80, tailTiltBias: 0.10 },
  // Small and round — apple-y, fluffy short tail.
  Caster:    { scale: 0.85, vert: 0.85, horiz: 1.05, headMul: 1.10, earMul: 1.30, peakBias: 0.14,  bodyLen: 0.94, bodyWid: 0.96, armLen: 0.92, armR: 0.85, armDroopBias: 0.20,  tailLen: 0.85, tailR: 1.30, tailTiltBias: 0.20 },
  // Short and wide — stout chunk, medium fat tail.
  Beast:     { scale: 1.10, vert: 0.78, horiz: 1.32, headMul: 1.00, earMul: 1.05, peakBias: -0.04, bodyLen: 1.04, bodyWid: 1.12, armLen: 0.92, armR: 1.10, armDroopBias: -0.08, tailLen: 1.10, tailR: 1.40, tailTiltBias: -0.05 },
  // Boxy / blocky — medium tall, short stiff tail.
  Construct: { scale: 1.05, vert: 1.05, horiz: 1.18, headMul: 0.90, earMul: 0.80, peakBias: 0.00,  bodyLen: 0.94, bodyWid: 1.04, armLen: 1.00, armR: 1.18, armDroopBias: -0.20, tailLen: 0.70, tailR: 1.05, tailTiltBias: -0.25 },
  // Tiny and slight — small all over, very long thin tail.
  Specter:   { scale: 0.72, vert: 1.20, horiz: 0.78, headMul: 1.20, earMul: 1.25, peakBias: 0.12,  bodyLen: 0.96, bodyWid: 0.92, armLen: 1.30, armR: 0.75, armDroopBias: -0.05, tailLen: 1.55, tailR: 0.70, tailTiltBias: 0.05 },
};

const DEFAULT_SKEW: ArchetypeSkew = {
  scale: 1, vert: 1, horiz: 1, headMul: 1, earMul: 1, peakBias: 0,
  bodyLen: 1, bodyWid: 1, armLen: 1, armR: 1, armDroopBias: 0,
  tailLen: 1, tailR: 1, tailTiltBias: 0,
};

const PERSONALITY_LOOK: Record<string, LookMix> = {
  stoic:     { idle: 0.30, camera: 0.10, influence: 0.60 }, // tracks the action
  manic:     { idle: 0.75, camera: 0.05, influence: 0.20 }, // jittery
  drunk:     { idle: 0.85, camera: 0.05, influence: 0.10 }, // wandering gaze
  weary:     { idle: 0.55, camera: 0.05, influence: 0.40 },
  berserker: { idle: 0.20, camera: 0.10, influence: 0.70 }, // locks onto target
  skittish:  { idle: 0.55, camera: 0.30, influence: 0.15 }, // checks the viewer
  stalwart:  { idle: 0.25, camera: 0.20, influence: 0.55 },
};

const DEFAULT_LOOK: LookMix = { idle: 0.5, camera: 0.25, influence: 0.25 };

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function deepCloneSpec(spec: RaccoonSpec): RaccoonSpec {
  return {
    body: spec.body.map((b) => ({ ...b })),
    head: spec.head.map((b) => ({ ...b })),
    headOffset: spec.headOffset,
    ears: { ...spec.ears },
    arms: { ...spec.arms },
    tail: { ...spec.tail },
    eyes: { ...spec.eyes },
    maskStrength: spec.maskStrength,
    bodyOverlap: spec.bodyOverlap,
    bodyPeak: spec.bodyPeak,
    lookMix: { ...spec.lookMix },
  };
}

/** Derive a per-unit raccoon spec from the slider-driven base spec.
 *  Deterministic per unit (seeded by unit.id). Archetype + tier shape
 *  proportions; personality picks lookMix; small RNG jitter adds variety.
 *
 *  Body band radii are RESHAPED to follow the bell curve at the biased
 *  peak/overlap, so the silhouette bulges in the new place rather than
 *  keeping the slider-base shape. */
export function specFromUnit(unit: Unit, base: RaccoonSpec): RaccoonSpec {
  const rng = makeRNG("rcn:" + unit.id);
  const spec = deepCloneSpec(base);

  const arch = ARCH_SKEW[unit.archetype] ?? DEFAULT_SKEW;
  const tierBoost = 1 + (unit.tier - 1) * 0.10; // tier 1=1.0, tier 3=1.20
  // Independent vertical and horizontal scales so raccoons can be tall
  // and skinny, short and fat, etc. — not just uniformly bigger/smaller.
  const baseScale = arch.scale * tierBoost * (1 + range(rng, -0.12, 0.12));
  const vertMul = arch.vert * (1 + range(rng, -0.18, 0.18));
  const horizMul = arch.horiz * (1 + range(rng, -0.18, 0.18));

  // Asymmetry roll: most raccoons are roughly round (rx≈ry), but some
  // get squeezed front-to-back into flat-and-wide pancakes (or rarer,
  // long-and-thin). Drives the body, head, and (lightly) the arms so
  // the look is consistent end-to-end.
  let asymLen = 1;
  let asymWid = 1;
  const asymRoll = rng();
  if (asymRoll < 0.32) {
    // Flat-and-wide: shorten X (front-to-back), expand Y (side-to-side).
    const k = range(rng, 0.30, 0.55);
    asymLen = 1 - k;            // 0.45 .. 0.70
    asymWid = 1 + k * 0.55;     // 1.17 .. 1.30
  } else if (asymRoll < 0.42) {
    // Long-and-thin: rarer, opposite skew.
    const k = range(rng, 0.20, 0.40);
    asymLen = 1 + k;
    asymWid = 1 - k * 0.5;
  }
  // else: symmetric (~58%)

  const lenMul = arch.bodyLen * horizMul * asymLen * (1 + range(rng, -0.10, 0.10));
  const widMul = arch.bodyWid * horizMul * asymWid * (1 + range(rng, -0.10, 0.10));

  const oldPeak = base.bodyPeak;
  const oldOverlap = base.bodyOverlap;
  spec.bodyPeak = clamp(
    oldPeak + arch.peakBias + range(rng, -0.05, 0.05),
    0.15, 0.85,
  );
  spec.bodyOverlap = clamp(oldOverlap + range(rng, -0.06, 0.06), 0, 0.85);

  // Reshape body radii: rescale by (new bell-curve mul) / (old bell-curve
  // mul) per band, so the silhouette tracks the new peak/overlap. Then
  // apply per-unit baseScale + length/width multipliers.
  const thicknesses = spec.body.map((b) => b.thickness);
  const oldBandTs = bandFractionalZs(thicknesses, oldOverlap);
  const newBandTs = bandFractionalZs(thicknesses, spec.bodyOverlap);
  for (let i = 0; i < spec.body.length; i++) {
    const oldMul = bodyRadiusMul(oldBandTs[i], oldPeak);
    const newMul = bodyRadiusMul(newBandTs[i], spec.bodyPeak);
    const reshape = newMul / Math.max(1e-6, oldMul);
    const b = spec.body[i];
    b.rx *= reshape * baseScale * lenMul;
    b.ry *= reshape * baseScale * widMul;
    b.thickness *= baseScale * vertMul;
  }

  const headScale = baseScale * arch.headMul * (1 + range(rng, -0.08, 0.08));
  for (const b of spec.head) {
    b.rx *= headScale * horizMul * asymLen;
    b.ry *= headScale * horizMul * asymWid;
    b.thickness *= headScale * vertMul;
  }
  spec.ears.size *= baseScale * arch.earMul * (1 + range(rng, -0.18, 0.18));
  spec.ears.spread *= 1 + range(rng, -0.18, 0.18);
  spec.ears.tilt += range(rng, -0.12, 0.12);

  spec.arms.length *= baseScale * arch.armLen * (1 + range(rng, -0.10, 0.10));
  spec.arms.radius *= baseScale * arch.armR * (1 + range(rng, -0.08, 0.08));
  spec.arms.droop += arch.armDroopBias + range(rng, -0.06, 0.06);

  // Tail size tracks the body's actual horizontal extent — pancake-flat
  // raccoons get pancake-wide tails too, instead of a tiny stub.
  const bodyHorizExtent = baseScale * horizMul * Math.max(asymLen, asymWid);
  spec.tail.length *= bodyHorizExtent * arch.tailLen * (1 + range(rng, -0.18, 0.18));
  spec.tail.baseRadius *= bodyHorizExtent * arch.tailR * (1 + range(rng, -0.15, 0.15));
  spec.tail.upTilt += arch.tailTiltBias + range(rng, -0.10, 0.10);

  spec.eyes.spread *= 1 + range(rng, -0.10, 0.10);
  spec.maskStrength = clamp(spec.maskStrength + range(rng, -0.18, 0.18), 0, 1);

  spec.lookMix = PERSONALITY_LOOK[unit.personality] ?? DEFAULT_LOOK;

  return spec;
}
