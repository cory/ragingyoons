# Raging Yoons — v0 Content Catalog

Living catalog of locked content. Stat numbers are deferred to balance pass —
this doc holds **names, identities, and synergy directions** only.

See [`v0-design.md`](./v0-design.md) for the spec and [`v0-taxonomy.md`](./v0-taxonomy.md)
for the property dials synergies operate on.

---

## Environments (origin axis) — 4

Visual identifier: **primary fur/coat color** + matching bin theme.

| Environment | Color           | Vibe                                            | Synergy direction              |
|-------------|-----------------|-------------------------------------------------|--------------------------------|
| **City**    | grimy charcoal  | dumpsters, alleys, fire escapes, neon           | **Density / swarm** — damage scales with nearby allies               |
| **Suburban**| warm tan        | manicured lawns, garages, kiddie pools          | **Defense / homefield** — bin HP + proximity-to-bin armor            |
| **Park**    | mossy green     | forests, picnic areas, ponds                    | **Mobility / ambush** — speed, stealth, flank damage                 |
| **Coastal** | seafoam blue    | piers, boardwalks, bait shops                   | **Ranged / splash** — range + AoE on hit                             |

### Synergy effects (numbers TBD; direction locked)

Buffs apply to all raccoons of that environment regardless of spawning bin.

**City** — *Density / swarm*
- **2 bins:** +damage when within friend-sensing range of 3+ allied raccoons
- **3 bins:** +attack rate per nearby allied raccoon, up to a cap

**Suburban** — *Defense / homefield*
- **2 bins:** +HP on Suburban bins
- **3 bins:** Suburban raccoons gain armor that scales with proximity to their own bin (defenders tankier near home; bonus fades when straying)

**Park** — *Mobility / ambush*
- **2 bins:** +move speed and +stealthiness
- **3 bins:** +bonus damage on flank attacks (stacks multiplicatively with Cavalry's natural flank bonus)

**Coastal** — *Ranged / splash*
- **2 bins:** +attack range
- **3 bins:** attacks deal small splash AoE on hit (natural counter to clumped City comps)

### Counter-adjacencies
- City swarm ← trampled by → Coastal splash
- Coastal chip ← outranged-into-melee by → Park ambush
- Park ambush ← walls off against → Suburban turtle
- Suburban turtle ← ground down by → City attrition

---

## Curiosities (class trait axis) — 4

Visual identifier: **item in paw**. Color is owned by Environment; Curiosity must
be readable independently of color.

| Curiosity      | Item                              | Synergy direction                          |
|----------------|-----------------------------------|--------------------------------------------|
| **Lockpickers**| stick                             | Anti-bin + stealth                         |
| **Tinkerers**  | sparky thing (gadget on a stick)  | Rage-attack augmentation                   |
| **Farmers**    | pitchfork / hoe (stick + shaped end) | Production — bins make extra units      |
| **Barbarians** | none                              | Toughness (HP + armor)                     |

### Synergy effects (numbers TBD; direction locked)

**Lockpickers** — *Anti-bin / sneak*
- **2 bins:** Lockpicker raccoons deal +bonus damage to enemy bins
- **3 bins:** Lockpicker raccoons gain +stealthiness (reduces enemy effective sensing range against them)

**Tinkerers** — *Rage-attack augmentation*
- **2 bins:** Tinkerer rage attacks apply slow on hit
- **3 bins:** Tinkerer rage attacks gain extra range

**Farmers** — *Production*
- **2 bins:** Farmer bins spawn 2 raccoons per spawn instead of 1
- **3 bins:** Farmer bins spawn 3 raccoons per spawn

**Barbarians** — *Toughness*
- **2 bins:** Barbarian raccoons gain +HP
- **3 bins:** Barbarian raccoons additionally gain +armor

### Natural diagonals (env × curiosity flagship comps)
- **City + Farmers** — swarm (more bodies × crowd-damage scaling)
- **Suburban + Barbarians** — full turtle (tanky bins + tanky raccoons)
- **Park + Lockpickers** — ambush bin-snipers (fast, sneaky, melt bins)
- **Coastal + Tinkerers** — ranged control (long-range slows from afar)

Off-axis builds (Coastal Farmers, Suburban Lockpickers) are allowed; they
just don't get the natural alignment bonus.

---

## Cards / units — 30+ across 4×4×4 grid

39 cards authored under `cards/units/` (filename pattern:
`<environment>-<curiosity>-<role>-<name>.md`). A card describes a unit identity;
placing it on the board materializes a bin that spawns raccoons of that unit.

Each card's YAML frontmatter carries:
- `cost: 1–6` — shop cost tier
- `role`, `environment`, `curiosity`
- `stats: { hp, damage, attack_rate, range, speed, armor }` — raccoon base stats
- `bin: { hp, garrison_cap, spawn_cadence }` — bin block
- `rage: { capacity, attack: { ... } }` — bespoke rage attack per cell
- `visual: { silhouette, color, item }`
- `tier3_form: swarm | titan | hybrid` — 3★ identity (see [`v0-taxonomy.md`](./v0-taxonomy.md))

The 39 existing cards need `tier3_form` backfilled (default `swarm` for T1–T5,
`titan` for T6).
