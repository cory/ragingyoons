# Raging Yoons — v0 Property Taxonomy

The full set of dials available on bins, units, and attacks. Synergies operate
by *modifying* these properties — they don't introduce new ones. This is the
shared vocabulary for design, content records, and the in-engine editor.

## Static vs dynamic
Every property is **static on the content record** but **dynamic at runtime**.
Synergies, star tier, formation, and battlefield context modify effective values
each tick. The sim reads *effective* stats per tick; the content records hold
*base* stats. Synergy effects are themselves data records of the form
"modify property X by Y under condition Z."

---

## Bin properties
- **HP**
- **Spawn cadence** (locked: garrison-respawn — see [`v0-sim.md`](./v0-sim.md))
- **Garrison cap** — max raccoons alive from this bin at once; scales +1 per star
- **Star tier** — 1/2/3; scales bin HP + spawn rate + garrison cap + raccoon stats
- **Tier-3 form** (`tier3_form`): `swarm | titan | hybrid`
  - **swarm** — 3★ spawns more, bigger raccoons (default for low cost tiers)
  - **titan** — 3★ collapses to 1 GIGANTIC raccoon (default for tier 6)
  - **hybrid** — 3★ spawns 2 large raccoons (a "duo finisher")
- **Cost tier** — 1–6; gates shop appearance via the round-rolling distribution
- **Synergy contribution** — which Environment + Curiosity this bin counts toward

## Unit (raccoon) properties

### Survivability
- **HP**
- **Armor** — flat damage reduction
- **Damage type & resistances** — e.g. physical / stink / shock; hook for curiosity synergies

### Movement (boids)
- **Speed** (max)
- **Max delta-v/s** (acceleration)
- **View direction / FOV cone**
- **Friend sensing range**
- **Enemy sensing range**
- **Stealthiness** — counter-detection; reduces enemy effective sensing range against this unit
- **Boid weights** — alignment, separation, cohesion
- **Formation policy** — how this role positions relative to allies of other roles (tanks-front, archers-back, cavalry-flank, infantry-clump)

### Combat ↔ movement coupling
- **Attack-stop factor** — 0 = attack while moving, 1 = must stop to attack (archers ≈ 1)
- **Damage-stagger factor** — slowdown applied when hit
- **Flank bonus** — damage multiplier when attacking from behind
- **Combined-attack bonus** — damage bonus when N allies attack the same target
- **Target priority** — closest / lowest-HP / bin-first / by-role; primary curiosity hook

### Rage system
- **Rage capacity** — meter size
- **Rage gain rule** — defined by **role** (Tank / Archer / Cavalry / Infantry). Each role has a fixed rule:
  - **Tank** → per damage taken
  - **Archer** → per attack landed
  - **Cavalry** → per second spent attacking
  - **Infantry** → per second adjacent to allied raccoons
  This is the **role fingerprint** — what makes a role *feel* different beyond raw stats.
- **Rage trigger** — **auto-fires when meter fills**. No player trigger (this is an auto-battler — players only watch).
- **No rage decay** — rage points stick once gained; meter only resets when fired.

## Attack properties (basic and rage share the same shape)
- **Damage**
- **Attack rate** (basic only; rage is one-shot)
- **Range**
- **Targeting** — single-target / area
- **Area size** (if AoE)
- **Knockback distance**
- **Slow magnitude × duration**
- **Status / effect** — open slot for stun, fear, mark, burn; powerful curiosity hook
- **Damage type** — pairs with unit resistances above

---

## Implications for the engine
- Content records are typed: `BinDef`, `UnitDef`, `AttackDef`, `SynergyDef`, plus
  `RageGainRule` as a tagged enum.
- The sim's tick loop computes effective stats by folding active synergies and
  modifiers over base stats — never mutates the base records.
- The admin editor edits base records and synergy modifier records; versioning
  applies at the bundle level (see `v0-design.md` → Authoring & content pipeline).
