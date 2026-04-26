import { chance, irange, makeRNG, pick, range, weightedPick, type RNG } from "./rng";
import {
  type FormationRole,
  type GaitChoice,
  type MoodReactions,
  type PersonalityName,
  moodReactionsFor,
  pickAvailableGaits,
  pickFormationRole,
  pickPersonality,
  speedMulFor,
} from "./personality";

export type ShapeName =
  | "hexagon"
  | "hexagonV"
  | "octagon"
  | "square"
  | "pentagon"
  | "obelisk"
  | "triangle"
  | "diamond"
  | "rhombusFlat"
  | "blade"
  | "trapezoid"
  | "trapezoidI"
  | "shield"
  | "star5"
  | "star6"
  | "star8"
  | "circle"
  | "disk"
  | "crescent";

export type LayerRole = "base" | "body" | "crown";
export type ToneKey = "primary" | "accent";
export type ProtrusionKind = "none" | "horns" | "blades" | "spikes" | "antennae";
export type EyeKind = "double" | "single" | "triple" | "none";

export type ShadeKey =
  | "primary"
  | "primaryMid"
  | "primaryDark"
  | "primaryLight"
  | "accent"
  | "accentDark"
  | "accentLight";

export type PaletteMode = "smooth" | "vibrant" | "duotone" | "monochrome";

export interface Layer {
  shape: ShapeName;
  r: number;
  thickness: number;
  x: number;
  role: LayerRole;
  tone: ToneKey;
  inset: boolean;
  shadeKey: ShadeKey;
}

export interface Palette {
  primary: string;
  primaryMid: string;
  primaryDark: string;
  primaryLight: string;
  accent: string;
  accentDark: string;
  accentLight: string;
  shadow: string;
  glow: string;
  h: number;
  s: number;
  l: number;
  accentH: number;
}

export interface Stats {
  hp: number;
  atk: number;
  mag: number;
}

export interface Unit {
  id: string;
  name: string;
  epithet: string;
  archetype: string;
  faction: string;
  factionKey: string;
  palette: Palette;
  paletteMode: PaletteMode;
  profile: string;
  layers: Layer[];
  eyes: EyeKind;
  eyeLayer: number;
  protrusions: ProtrusionKind;
  aura: boolean;
  tier: number;
  stats: Stats;
  floating: boolean;
  // ── Personality (Phase 1) ──────────────────────────────────────
  personality: PersonalityName;
  /** Mood reaction lookup for this unit, derived from its personality. */
  moods: MoodReactions;
  /** Multiplier on the archetype's max speed. */
  speedMul: number;
  /** Subset of gaits this unit is willing to use. Always contains "walk". */
  availableGaits: GaitChoice[];
  /** Where this unit wants to sit in its team's formation. */
  formationRole: FormationRole;

  // ── Team membership (Phase 2). Stamped after generation. ────────
  teamIndex: 0 | 1;
}

const FACTIONS = {
  ember: { name: "EMBER", hue: 14, shift: 38, sat: 78, lit: 56 },
  azure: { name: "AZURE", hue: 212, shift: -28, sat: 70, lit: 56 },
  jade: { name: "JADE", hue: 152, shift: 56, sat: 60, lit: 48 },
  amethyst: { name: "AMETHYST", hue: 285, shift: -50, sat: 58, lit: 56 },
  bone: { name: "BONE", hue: 38, shift: 178, sat: 28, lit: 76 },
  void: { name: "VOID", hue: 248, shift: 92, sat: 48, lit: 32 },
} as const;

type FactionKey = keyof typeof FACTIONS;

const hsl = (h: number, s: number, l: number, a = 1): string =>
  a === 1 ? `hsl(${h} ${s}% ${l}%)` : `hsla(${h} ${s}% ${l}% / ${a})`;

function makePalette(rng: RNG, factionKey: FactionKey, hueOverride?: number): Palette {
  const f = FACTIONS[factionKey];
  const h = hueOverride !== undefined
    ? (hueOverride + 360) % 360
    : (f.hue + range(rng, -8, 8) + 360) % 360;
  const s = Math.max(20, Math.min(95, f.sat + range(rng, -10, 8)));
  const l = Math.max(20, Math.min(85, f.lit + range(rng, -6, 6)));
  const accentH = (h + f.shift + 360) % 360;
  return {
    primary: hsl(h, s, l),
    primaryMid: hsl(h, s * 0.92, l * 0.8),
    primaryDark: hsl(h, s * 0.8, Math.max(10, l * 0.45)),
    primaryLight: hsl(h, s * 0.7, Math.min(90, l * 1.35)),
    accent: hsl(accentH, Math.min(95, s * 1.05), 62),
    accentDark: hsl(accentH, s, 32),
    accentLight: hsl(accentH, Math.min(95, s * 1.05), 78),
    shadow: hsl(h, s * 0.4, 8),
    glow: hsl(accentH, 92, 70),
    h,
    s,
    l,
    accentH,
  };
}

const SYL = {
  pre: ["Vex","Krell","Lum","Mor","Drak","Ny","Tor","Vyr","Och","Zal","Skry","Pyl","Fen","Gar","Hes","Iv","Kor","Vol","Xen","Ar","Bel","Cor","Em","Nox","Quor","Rhae","Suv","Thal","Umb","Wre"],
  mid: ["e","or","u","a","i","y","ae","ou","ar","el"],
  suf: ["mire","tor","drix","nax","vex","rune","morn","vail","scar","thal","kar","zar","lyn","fen","rok","gard","uun","phix","tred","shen","vor","lith","moth","ric","wynn","stor"],
} as const;

const EPITHETS = [
  "the Sundered","the Vow-keeper","of the Deep Hex","the Quiet Edict","the Ninth Gate",
  "the Faceted","of Cold Light","the Recurrent","the Iron Choir","the Auger",
  "the Last Seal","the Slow Star","the Edge-walker","the Glass-eyed","the Mire-born",
  "the Spire","the Numbered","the Gilded Wound","the Hollow Crown","the Returner",
  "the Shaper","of Lost Octaves","the Brittle King","the Soft Knife","the Long Wait",
] as const;

function genName(rng: RNG): string {
  const a = pick(rng, SYL.pre);
  const b = chance(rng, 0.35) ? pick(rng, SYL.mid) : "";
  const c = pick(rng, SYL.suf);
  return a + b + c;
}

interface Archetype {
  factions: FactionKey[];
  base: ShapeName[];
  body: ShapeName[];
  crown: ShapeName[];
  profile: string[];
  layers: [number, number];
  bias: [number, number, number];
  floating?: boolean;
}

const ARCHETYPES: Record<string, Archetype> = {
  Warden: {
    factions: ["azure", "bone", "jade"],
    base: ["hexagon", "octagon", "trapezoidI", "disk"],
    body: ["hexagon", "octagon", "shield", "square", "trapezoidI"],
    crown: ["pentagon", "shield", "diamond", "hexagonV"],
    profile: ["tower", "obelisk", "pyramid"],
    layers: [4, 5],
    bias: [0.5, 0.3, 0.2],
  },
  Striker: {
    factions: ["ember", "amethyst", "void"],
    base: ["pentagon", "hexagon", "trapezoidI"],
    body: ["triangle", "diamond", "rhombusFlat", "pentagon"],
    crown: ["triangle", "blade", "diamond", "star5"],
    profile: ["pyramid", "totem"],
    layers: [3, 5],
    bias: [0.25, 0.55, 0.2],
  },
  Caster: {
    factions: ["amethyst", "azure", "void"],
    base: ["hexagon", "disk", "octagon"],
    body: ["star6", "diamond", "circle", "hexagonV"],
    crown: ["star5", "star8", "circle", "crescent"],
    profile: ["vase", "drone", "totem"],
    layers: [3, 5],
    bias: [0.25, 0.2, 0.55],
  },
  Beast: {
    factions: ["jade", "ember", "bone"],
    base: ["disk", "circle", "trapezoidI"],
    body: ["circle", "rhombusFlat", "pentagon", "hexagonV"],
    crown: ["triangle", "diamond", "star5", "circle"],
    profile: ["totem", "vase", "tower"],
    layers: [3, 5],
    bias: [0.42, 0.4, 0.18],
  },
  Construct: {
    factions: ["bone", "azure", "void"],
    base: ["square", "octagon", "trapezoidI"],
    body: ["square", "octagon", "trapezoid", "hexagonV"],
    crown: ["square", "triangle", "diamond", "obelisk"],
    profile: ["obelisk", "tower", "pyramid"],
    layers: [4, 6],
    bias: [0.45, 0.4, 0.15],
  },
  Specter: {
    factions: ["void", "amethyst", "azure"],
    base: ["disk", "circle"],
    body: ["circle", "diamond", "crescent"],
    crown: ["star8", "circle", "crescent"],
    profile: ["vase", "drone"],
    layers: [3, 4],
    bias: [0.2, 0.3, 0.5],
    floating: true,
  },
};

function pickShadeKeys(rng: RNG, mode: PaletteMode, count: number): ShadeKey[] {
  switch (mode) {
    case "smooth": {
      // Smooth ascending gradient from primaryDark at base to primaryLight at crown.
      const ramp: ShadeKey[] = ["primaryDark", "primaryMid", "primary", "primaryLight"];
      const out: ShadeKey[] = [];
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0 : i / (count - 1);
        const idx = Math.min(ramp.length - 1, Math.round(t * (ramp.length - 1)));
        out.push(ramp[idx]);
      }
      return out;
    }
    case "monochrome": {
      const shade = pick(rng, ["primary", "primaryMid", "primaryDark"] as const) as ShadeKey;
      return Array.from({ length: count }, () => shade);
    }
    case "duotone": {
      const a = pick(rng, ["primary", "primaryDark", "primaryMid"] as const) as ShadeKey;
      const b = pick(rng, ["accent", "accentDark", "accentLight"] as const) as ShadeKey;
      // Sometimes flip so accent starts; gives bottom-accent variety.
      const flip = chance(rng, 0.4);
      return Array.from({ length: count }, (_, i) => ((i % 2 === 0) === flip ? b : a));
    }
    case "vibrant": {
      // Per-layer role-weighted random across the full palette.
      const all: ShadeKey[] = [
        "primary", "primaryMid", "primaryDark", "primaryLight",
        "accent", "accentDark", "accentLight",
      ];
      const out: ShadeKey[] = [];
      for (let i = 0; i < count; i++) {
        const isBase = i === 0;
        const isCrown = i === count - 1;
        let weights: number[];
        if (isBase) weights = [0.18, 0.12, 0.30, 0.05, 0.18, 0.17, 0.00];
        else if (isCrown) weights = [0.10, 0.08, 0.04, 0.18, 0.22, 0.10, 0.28];
        else weights = [0.18, 0.18, 0.06, 0.10, 0.20, 0.10, 0.18];
        out.push(weightedPick(rng, all, weights));
      }
      return out;
    }
  }
}

function profileSizes(profile: string, n: number, rng: RNG, baseR: number): number[] {
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / Math.max(1, n - 1);
    let mul: number;
    switch (profile) {
      case "tower":
        mul = 1.0 - t * 0.18;
        break;
      case "pyramid":
        mul = 1.05 - t * 0.62;
        break;
      case "vase":
        mul = 0.78 + Math.sin(t * Math.PI) * 0.42 - t * 0.22;
        break;
      case "obelisk":
        mul = i === 0 ? 1.12 : i === n - 1 ? 0.42 : 0.78 - t * 0.18;
        break;
      case "totem":
        mul = 0.92 + (i % 2 === 0 ? 0.16 : -0.12);
        break;
      case "drone":
        mul = 0.55 + t * 0.55;
        break;
      default:
        mul = 1.0;
    }
    mul *= 1 + range(rng, -0.04, 0.04);
    sizes.push(Math.max(8, baseR * mul));
  }
  return sizes;
}

export interface GenerateOpts {
  archetype?: string;
  faction?: FactionKey;
  /** When set, the palette's primary hue is forced to this value. Used by
   *  team generation so faction members within a team cluster around a
   *  team-defined hue band. */
  hueOverride?: number;
}

export function generateUnit(rng: RNG, opts: GenerateOpts = {}): Unit {
  const archetypeKey = opts.archetype ?? pick(rng, Object.keys(ARCHETYPES));
  const A = ARCHETYPES[archetypeKey];
  const factionKey = opts.faction ?? pick(rng, A.factions);
  const palette = makePalette(rng, factionKey, opts.hueOverride);
  const profile = pick(rng, A.profile);
  const layerCount = irange(rng, A.layers[0], A.layers[1]);
  const baseR = 46;
  const sizes = profileSizes(profile, layerCount, rng, baseR);

  const paletteMode = weightedPick<PaletteMode>(
    rng,
    ["smooth", "vibrant", "duotone", "monochrome"],
    [0.35, 0.35, 0.20, 0.10],
  );
  const shadeKeys = pickShadeKeys(rng, paletteMode, layerCount);

  const layers: Layer[] = [];
  for (let i = 0; i < layerCount; i++) {
    const isTop = i === layerCount - 1;
    const isBottom = i === 0;
    const role: LayerRole = isBottom ? "base" : isTop ? "crown" : "body";
    const pool = role === "base" ? A.base : role === "crown" ? A.crown : A.body;
    const shape = pick(rng, pool);
    const r = sizes[i];
    const thickness = r * range(rng, 0.36, 0.66);
    const xOffset = chance(rng, 0.18) ? range(rng, -2.5, 2.5) : 0;
    const useAccent = chance(rng, role === "crown" ? 0.55 : role === "base" ? 0.15 : 0.22);
    const inset = chance(rng, role === "body" ? 0.35 : 0.15);
    layers.push({
      shape,
      r,
      thickness,
      x: xOffset,
      role,
      tone: useAccent ? "accent" : "primary",
      inset,
      shadeKey: shadeKeys[i],
    });
  }

  const eyes = weightedPick<EyeKind>(rng, ["double", "single", "triple", "none"], [0.55, 0.18, 0.10, 0.17]);
  const candidateLayers: number[] = [];
  for (let i = 1; i < layerCount; i++) candidateLayers.push(i);
  const eyeLayer = pick(rng, candidateLayers.length ? candidateLayers : [Math.max(0, layerCount - 1)]);

  const protrusions = weightedPick<ProtrusionKind>(
    rng,
    ["none", "horns", "blades", "spikes", "antennae"],
    [0.4, 0.18, 0.18, 0.12, 0.12],
  );

  const aura = chance(rng, 0.32);
  const tier = weightedPick<number>(rng, [1, 2, 3], [0.55, 0.30, 0.15]);

  const totalPoints = 16 + tier * 5;
  const bias = A.bias;
  const stats: Stats = {
    hp: Math.max(1, Math.round(totalPoints * bias[0] * range(rng, 0.85, 1.2))),
    atk: Math.max(1, Math.round(totalPoints * bias[1] * range(rng, 0.85, 1.2))),
    mag: Math.max(1, Math.round(totalPoints * bias[2] * range(rng, 0.85, 1.2))),
  };

  const id = "u" + Math.floor(rng() * 1e9).toString(36);
  const name = genName(rng);
  const epithet = pick(rng, EPITHETS);
  const floating = !!A.floating;

  // ── Personality + per-unit traits ────────────────────────────────
  const personality = pickPersonality(rng);
  const moods = moodReactionsFor(personality);
  const speedMul = speedMulFor(personality, rng);
  const availableGaits = pickAvailableGaits(rng);
  const formationRole = pickFormationRole(archetypeKey, rng);

  return {
    id,
    name,
    epithet,
    archetype: archetypeKey,
    faction: FACTIONS[factionKey].name,
    factionKey,
    palette,
    paletteMode,
    profile,
    layers,
    eyes,
    eyeLayer,
    protrusions,
    aura,
    tier,
    stats,
    floating,
    personality,
    moods,
    speedMul,
    availableGaits,
    formationRole,
    teamIndex: 0,
  };
}

export function generateRoster(seedStr: string, count = 12): Unit[] {
  const rng = makeRNG(seedStr);
  const units: Unit[] = [];
  for (let i = 0; i < count; i++) units.push(generateUnit(rng));
  return units;
}
