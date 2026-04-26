/**
 * Per-unit personality profiles. Each unit is born with a personality
 * that biases its mood reactions, max speed, and flavor.
 */
import type { RNG } from "./rng";
import { pick, range, weightedPick } from "./rng";

export type MoodKey =
  | "neutral"
  | "happy"
  | "sad"
  | "anxious"
  | "angry"
  | "weary"
  | "drunk";

export type MoodContext = "idle" | "friends" | "chasing" | "chased";

export type MoodReactions = Record<MoodContext, MoodKey>;

export type PersonalityName =
  | "stoic"
  | "manic"
  | "drunk"
  | "weary"
  | "berserker"
  | "skittish"
  | "stalwart";

export const PERSONALITIES: PersonalityName[] = [
  "stoic", "manic", "drunk", "weary", "berserker", "skittish", "stalwart",
];

interface PersonalityProfile {
  /** Override map; any context not specified falls back to the default. */
  moods: Partial<MoodReactions>;
  /** [min, max] sampled at generation time and applied as a multiplier
   *  to the archetype's max speed. */
  speedRange: [number, number];
}

/** No-personality default mood table. */
const DEFAULT_MOODS: MoodReactions = {
  idle: "neutral",
  friends: "happy",
  chasing: "angry",
  chased: "anxious",
};

const PROFILES: Record<PersonalityName, PersonalityProfile> = {
  stoic: {
    moods: { friends: "neutral", chased: "neutral" },
    speedRange: [0.95, 1.05],
  },
  manic: {
    moods: { idle: "happy", friends: "happy", chasing: "happy", chased: "happy" },
    speedRange: [1.00, 1.20],
  },
  drunk: {
    moods: { idle: "drunk", friends: "drunk", chasing: "drunk", chased: "drunk" },
    speedRange: [0.60, 0.85],
  },
  weary: {
    moods: { idle: "weary", friends: "weary", chasing: "sad", chased: "sad" },
    speedRange: [0.70, 0.90],
  },
  berserker: {
    moods: { friends: "angry", chasing: "angry", chased: "angry" },
    speedRange: [1.10, 1.30],
  },
  skittish: {
    moods: { idle: "anxious", chasing: "anxious", chased: "anxious" },
    speedRange: [0.95, 1.15],
  },
  stalwart: {
    moods: { idle: "neutral", friends: "happy", chasing: "angry", chased: "neutral" },
    speedRange: [0.95, 1.10],
  },
};

/** Pick a personality, weighted; common ones picked more. */
const PERSONALITY_WEIGHTS: number[] = [
  0.18, // stoic
  0.12, // manic
  0.08, // drunk — rarer but visible
  0.14, // weary
  0.10, // berserker
  0.18, // skittish
  0.20, // stalwart
];

export function pickPersonality(rng: RNG): PersonalityName {
  return weightedPick(rng, PERSONALITIES, PERSONALITY_WEIGHTS);
}

export function moodReactionsFor(personality: PersonalityName): MoodReactions {
  const overrides = PROFILES[personality].moods;
  return {
    idle:    overrides.idle    ?? DEFAULT_MOODS.idle,
    friends: overrides.friends ?? DEFAULT_MOODS.friends,
    chasing: overrides.chasing ?? DEFAULT_MOODS.chasing,
    chased:  overrides.chased  ?? DEFAULT_MOODS.chased,
  };
}

export function speedMulFor(personality: PersonalityName, rng: RNG): number {
  const [lo, hi] = PROFILES[personality].speedRange;
  return range(rng, lo, hi);
}

// ── Available gaits ─────────────────────────────────────────────────

export type GaitChoice = "walk" | "run" | "shuffle";

/** Every unit can walk; some can run; some can shuffle. Distribution
 *  biased so most units have at least one fast gait. */
export function pickAvailableGaits(rng: RNG): GaitChoice[] {
  const hasRun = rng() < 0.70;
  const hasShuffle = rng() < 0.30;
  const out: GaitChoice[] = ["walk"];
  if (hasRun) out.push("run");
  if (hasShuffle) out.push("shuffle");
  return out;
}

// ── Formation role ─────────────────────────────────────────────────

export type FormationRole = "front" | "back" | "flank" | "free";

const ARCHETYPE_FORMATION: Record<string, FormationRole> = {
  Warden: "back",
  Striker: "front",
  Caster: "flank",
  Beast: "free",
  Construct: "back",
  Specter: "front",
};

/** Archetype-biased role with a small chance of override. */
export function pickFormationRole(archetype: string, rng: RNG): FormationRole {
  const archDefault = ARCHETYPE_FORMATION[archetype] ?? "free";
  if (rng() < 0.20) {
    return pick(rng, ["front", "back", "flank", "free"] as const);
  }
  return archDefault;
}
