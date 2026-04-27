# Raging Yoons — v0 Design Spec

A TFT-shaped auto-battler where cards are *trashbins* that spawn raging raccoons,
not units themselves. Match-three to upgrade bins. Last strategist standing wins.

> **See also:** [`v0-taxonomy.md`](./v0-taxonomy.md) — the full property taxonomy
> for bins, units, and attacks. Synergies operate by modifying those properties.
>
> **See also:** [`v0-sim.md`](./v0-sim.md) — simulation architecture (tick rate,
> state shape, content loading, determinism). Locked decisions: 15 Hz, garrison-
> respawn, flat plane, `src/sim/` module location.

## Match shape
- **6 players**, last strategist standing wins
- **100 HP** per strategist; loss damage formula in §Loss damage
- **~30s shop / placement** → **~40s combat** per round, ~17 rounds (~20 minutes per match)
- **All PvP** (no creep rounds for v0). Between rounds: bins persist on board with
  their positions and full HP; raccoons / rage / status / projectiles all clear.
- **Matchmaking:** random with anti-repeat; odd survivor count → ghost match
  (copy of an idle player's last board)
- **Auto-battler**: player only acts in shop phase; combat is fully simulated and
  server-streamable (headless sim + state streaming is a target)

## Trashconomy
- Earn trash from: per-round stipend, kills, losing-side bonus
- Spend trash on:
  - Expanding board cap (more bins on field)
  - Buying a specific bin to complete a 3-set
  - Rerolling shop
- No auto-leveling — every increase in scale is a deliberate spend

## Bins
- Card = a specific bin with a **fixed raccoon type** baked in
- Bin has **HP**, is directly attackable; when destroyed it stops spawning but its
  already-spawned raccoons keep fighting
- **Last raccoon alive** wins the round
- 3 identical bins merge → 2-star bin (more HP, faster spawn, beefier raccoons,
  splashier attacks)
- Tier visual: **can → bin → big bin**
- Spawn cadence is the one big mechanical TBD — prototype
  **continuous / wave / garrison-respawn** and pick one

## Raccoons — 4 roles (silhouette = role)

| Role     | Behavior                                                  | Shape                    |
|----------|-----------------------------------------------------------|--------------------------|
| Tank     | low DPS, high HP, slow, short range, forms formations     | big in all dimensions    |
| Archer   | low DPS, mid HP, long range, flees, hides behind allies   | tiny in all dimensions   |
| Cavalry  | high DPS, low HP, fast, flanks / gets behind              | tall and a bit wider     |
| Infantry | mid stats, highest numbers, stronger together / weak alone| thin and tall            |

DPS lives entirely in raccoons; bins are pure spawners.

## Axes — three of them

1. **Role** (Tank / Archer / Cavalry / Infantry) — defines movement & flocking
   behavior, targeting priority, and **rage-gain rule**. **No synergies on this
   axis.** Role is the unit's combat fingerprint.
2. **Environment** (origin trait axis): 4 of them, each = a **primary color** on
   the raccoon's coat and the bin. Synergies at 2/3 of a kind.
3. **Curiosity** (class trait axis): 4 of them, each = an **item in paw**.
   Synergies at 2/3 of a kind.

**Rage attack shape is per-unit, not per-axis.** Each of the 30+ unique unit cells
(Role × Environment × Curiosity) defines its own bespoke rage attack visuals and
mechanics. Role only sets *when* rage fires (gain rule); the cell defines *what*
it does.

Synergies count **per bin**, not per raccoon (one bin contributes one Environment
pip and one Curiosity pip regardless of how many raccoons it has spawned).
Synergy effects are stat modifiers from the taxonomy — they don't introduce new
properties.

## Content scope
- **4 roles × 4 environments × 4 curiosities = 64 cells**, target 30+ unique bins
  for v0
- Star-up scaling: 1-star = base, 2-star = bigger raccoons + splashier attacks,
  3-star = bigger still

## Battlefield
- TFT-style **hex grid, smaller hexes**, free-flowing boid movement (mappable
  back to hexes if needed)
- **Flat, non-wrapping** for v1; environment theming is **color pattern only**, no
  terrain or interactables
- Mirrored shared-layout matchups

## Authoring & content pipeline
- **Everything is editable in-engine** by admins: bins, raccoons, stats, synergies,
  environments, curiosities, economy numbers, spawn cadences. No code deploy
  required to add or tune content.
- **Versioned content**: every edit produces a new content version; matches lock to
  a version at start so balance changes don't perturb live games. Old versions are
  retained so we can replay, A/B, and roll back.
- Implication: data model is **content-as-data** (typed records), not hardcoded.
  Game sim reads from the active content version; the editor writes new versions.

## Coordinate convention (project-wide)
- **World:** right-handed, **Z-up**
- **Character:** X-forward, Y-left, Z-up
- Never default to Babylon's LH Y-up

---

## Known TBDs (don't block starting)

1. **Spawn cadence** — prototype continuous / wave / garrison and pick one
2. **Concrete unit list** — populate 30+ cells across the 4×4×4 grid with names + stats
3. **Stat curves** — DPS, HP, bin HP, spawn rate, currency rates; needs a balance pass
4. **Trashconomy numbers** — stipend, kill bounty, loss bonus, reroll cost,
   board-cap cost curve
5. **Synergy list** — what the 4 environments and 4 curiosities actually do at
   2/3 thresholds
6. **Server architecture** — headless sim + state streaming protocol
7. **Admin editor + versioning** — schema for content records, editor UX, version
   pinning per match, rollback / replay tooling

## Next session
Pick the **4 environments + 4 curiosities** by name and sketch their synergy
effects at 2/3 thresholds — that unlocks the unit list.
