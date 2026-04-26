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
  eyeSize: 3.8,
  eyeSpread: 0.55,
  // > 1 sits the disc just outside the band surface to avoid z-fight.
  eyeForward: 1.04,
  eyeBandIdx: 1,
  maskStrength: 0.55,
  bodyPeakDefault: 0.5,
  bodyOverlapDefault: 0.55,
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

function pickRaccoonHue(rng: RNG): number {
  // Mostly cool grays + occasional warm browns. Saturation/lightness still
  // come from the palette pipeline downstream.
  if (chance(rng, 0.7)) return range(rng, 200, 240); // cool gray-blue
  return pick(rng, [22, 32, 42]); // warm sepia/brown
}
