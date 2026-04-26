/**
 * Team generation. Two teams of 10 unit variants each, with team-level
 * coherence (faction set, base hue, archetype mix, personality bias)
 * and per-unit variety (personality, formation role, individual palette
 * jitter inside the team's hue band).
 */
import { generateUnit, type Unit } from "./generator";
import { chance, irange, makeRNG, pick, range, type RNG } from "./rng";
import {
  moodReactionsFor,
  PERSONALITIES,
  type PersonalityName,
  speedMulFor,
} from "./personality";

const TEAM_SIZE = 10;

const FACTION_KEYS = ["ember", "azure", "jade", "amethyst", "bone", "void"] as const;
type FactionKey = (typeof FACTION_KEYS)[number];

const ARCHETYPE_KEYS = ["Warden", "Striker", "Caster", "Beast", "Construct", "Specter"] as const;

const TEAM_NAMES_A = ["Aurum", "Solis", "Crimson", "Heliodor", "Gilded"];
const TEAM_NAMES_B = ["Verdant", "Umber", "Stygian", "Hollow", "Nocturne"];

export interface Team {
  index: 0 | 1;
  name: string;
  baseHue: number;                    // 0..360
  factions: FactionKey[];             // 2-3 factions
  archetypeMix: Record<string, number>;
  personalityBias: PersonalityName[];
  units: Unit[];
}

export interface Roster {
  teams: [Team, Team];
  /** Flat 20-unit list, team A first then B. Boid spawn picks uniformly
   *  → ~50/50 split emerges naturally. */
  units: Unit[];
}

export function generateTeams(seedStr: string, teamSize = TEAM_SIZE): Roster {
  const rng = makeRNG(seedStr);
  const baseHueA = rng() * 360;
  // Team B sits 150-210° from A so the two teams are visually distinct.
  const baseHueB = (baseHueA + 150 + rng() * 60) % 360;

  const teamA = makeTeam(rng, 0, baseHueA, teamSize, TEAM_NAMES_A);
  const teamB = makeTeam(rng, 1, baseHueB, teamSize, TEAM_NAMES_B);

  return {
    teams: [teamA, teamB],
    units: [...teamA.units, ...teamB.units],
  };
}

function makeTeam(
  rng: RNG,
  index: 0 | 1,
  baseHue: number,
  size: number,
  nameTable: readonly string[],
): Team {
  // 2-3 factions per team (independently rolled — overlap with the other
  // team is fine; team-baseHue rotation differentiates them visually).
  const numFactions = chance(rng, 0.5) ? 2 : 3;
  const factions = sampleN(rng, [...FACTION_KEYS], numFactions);

  // Archetype weighting: 1-2 archetypes are favored 3× over the rest.
  const numFavored = irange(rng, 1, 2);
  const favored = new Set(sampleN(rng, [...ARCHETYPE_KEYS], numFavored));
  const archetypeMix: Record<string, number> = {};
  for (const a of ARCHETYPE_KEYS) archetypeMix[a] = favored.has(a) ? 3 : 1;

  // 1-2 personality leanings; 60% of units adopt one of them.
  const personalityBias = sampleN(
    rng,
    [...PERSONALITIES],
    chance(rng, 0.5) ? 1 : 2,
  );

  // Faction sub-bands inside the team's base hue. Spaced so faction-mates
  // sit visually closest, team-mates close, opposing teams far.
  const factionSubOffsets = factions.map(
    (_, i) => (i - (factions.length - 1) / 2) * 22,
  );

  const units: Unit[] = [];
  for (let i = 0; i < size; i++) {
    const archetype = pickWeighted(rng, archetypeMix);
    const factionIdx = irange(rng, 0, factions.length - 1);
    const factionKey = factions[factionIdx];
    const hueOverride =
      (baseHue + factionSubOffsets[factionIdx] + range(rng, -5, 5) + 360) % 360;

    const unit = generateUnit(rng, {
      archetype,
      faction: factionKey,
      hueOverride,
    });
    unit.teamIndex = index;

    if (personalityBias.length > 0 && chance(rng, 0.6)) {
      unit.personality = pick(rng, personalityBias);
      unit.moods = moodReactionsFor(unit.personality);
      unit.speedMul = speedMulFor(unit.personality, rng);
    }
    units.push(unit);
  }

  return {
    index,
    name: pick(rng, nameTable),
    baseHue,
    factions,
    archetypeMix,
    personalityBias,
    units,
  };
}

function sampleN<T>(rng: RNG, pool: T[], n: number): T[] {
  const out: T[] = [];
  const local = [...pool];
  for (let i = 0; i < n && local.length > 0; i++) {
    const idx = irange(rng, 0, local.length - 1);
    out.push(local[idx]);
    local.splice(idx, 1);
  }
  return out;
}

function pickWeighted(rng: RNG, weights: Record<string, number>): string {
  const keys = Object.keys(weights);
  let total = 0;
  for (const k of keys) total += weights[k];
  let r = rng() * total;
  for (const k of keys) {
    r -= weights[k];
    if (r <= 0) return k;
  }
  return keys[keys.length - 1];
}
