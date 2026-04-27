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

## Match flow

1. **Opener carousel** — pre-match seeding. 30-card pool of T1 cards; 5 turns.
   Each turn each player sees a 5-card "page" from the current pool (no paid
   reroll); picks 1 simultaneously. Burned (unpicked) cards return to the pool.
   Collision (two players pick the same card) → loser re-picks from a fresh
   page of remaining pool. Final: each player owns 5 cards.
2. **Round 1 shop phase** — players place up to 3 cards as bins (board cap = 3
   to start); bench the rest. The first rolling shop view appears; standard
   shop rules apply.
3. **Combat** — auto-battle (~40s).
4. **Round end** — winner determined; loss damage applied; arcade bonus screen
   pays trash.
5. **Round 2+ shop phase** — pool grows by +30 cards (5 per player); rolling
   distribution shifts; auto-merges resolve; players reposition bins freely.
6. **Mid-match carousel** fires after each "opponent cycle" — once every alive
   player has been a matchup partner once. Pick order: reverse-HP rank
   (lowest first); 1 card per player; same collision rule as opener.
7. **Match ends** when one strategist remains (others reduced to 0 HP).

## Loss damage

```
damage_to_loser = base[round] + W_bin × surviving_enemy_bins
                              + W_rac × surviving_enemy_raccoons
```

- `base[round]` ramps with round number to ensure ~17-round match length even
  on small-board outcomes.
- **W_bin > W_rac** — bins (your permanent investment) count more than raccoons
  (respawnable garrison). Reinforces "destroy enemy bins" as the strategic
  through-line.
- "Surviving" = alive at the moment the win condition triggers.
- Concrete numbers TBD in balance pass.

## Cards, hand, and board

A **card** is a unit identity (a specific raccoon type). Placing a card on your
side of the board materializes a **bin** that spawns raccoons of that unit
indefinitely until destroyed.

- **Hand (bench): 10 slots** for owned-but-unplaced cards.
- **Starting board cap: 3 bins**; pay trash to expand (geometric curve, no hard ceiling).
- **Auto-merge** fires the moment 3 same-tier cards exist anywhere in your
  possession (any mix of hand and bins). The resulting next-tier card:
  - **replaces a contributing bin in place** if any contributors were bins
    (other contributing bins free their slots), OR
  - **lands on the bench** if all three contributors were in hand.
- 1★ → 2★ → 3★ progression; star tier persists across rounds.

## Shop — TFT-style shared rolling pool

- Each round, **5 new cards per player join the shared pool** (30 cards/round at 6 players).
- Each player's shop view = **5 cards** drawn from the pool. **Reroll** for a flat trash cost.
- **Unbought cards return to the pool** on next refresh — opponents may see them.
- Pool **distribution rolls forward** by round number. Indicative curve:
  - R1: 80% T1 / 20% T2
  - R2: 60% T1 / 20% T2 / 20% T3
  - … T1 floors at ~10%; T6 enters at the back of the curve
- **Personal level-up** (one-time, permanent, expensive): bumps your shop's
  distribution +1 step above the current round baseline. Capped at T6. Cards
  you don't buy still leak back to the shared pool — paying for level-up
  exposes higher-tier cards to opponents if you don't snap them up.
- **6 cost tiers** (T1–T6); T6 priced as a real splash buy.

## Trashconomy

**Income — no stipend; every coin is earned:**
- **Kill bounty** — trash per enemy raccoon killed
- **Loss bonus** — flat trash for losing the round (rubber-banding)
- **Interest** on banked trash, capped at 100 banked
- **Arcade bonus screen** at end of every round — small kudos awards across
  mutually different categories so no one player sweeps:
  rubber-banding, biggest-win-your-round, biggest-win-of-all-fights, most-damage,
  first-blood, pyrrhic (won with ≤1 raccoon), untouched (won losing zero
  raccoons), loud-loser (highest damage among losers).
- **No win-streak / loss-streak** bonuses — arcade categories cover that surface.

**Spend:**
- **Buy card** — price = card's cost tier (T1–T6).
- **Reroll shop** — flat trash cost per reroll.
- **Expand board cap** — geometric cost curve, no hard ceiling. Expansion
  consumes trash that could fund card exploration / level-up.
- **Level up** — one-time, permanent, expensive (see Shop above).

**Sell:** refund = `(cost − 1) × star_tier`. Same formula whether selling from
hand or board. Sold cards return to the shared pool. Selling a bin frees its
slot but doesn't reduce board cap.

No auto-leveling — every increase in scale is a deliberate spend.

## Bins

- A bin has **HP** and is directly attackable. When destroyed, it stops spawning,
  but its already-spawned raccoons keep fighting.
- **Round end:** last raccoon alive (or one side fully bin-eliminated). Bin HP
  refills next round.
- **Match loss:** all your bins destroyed (HP ≤ 0).
- **Spawn cadence (locked):** garrison-respawn — see [`v0-sim.md`](./v0-sim.md).
- **Star scaling routes** (per-card author choice): scale total bin DPS via
  unit count (garrison cap + spawn rate) or per-unit efficacy (raccoon HP /
  damage / range / attack rate / etc.). All raccoon dials may scale per star,
  but most of the per-star delta should sit in garrison rate.
- **3★ form** (`tier3_form` per-card field): `swarm | titan | hybrid`
  - **swarm** (default for low tiers) — 3★ spawns more, bigger raccoons
  - **titan** (default for T6) — 3★ collapses to 1 GIGANTIC raccoon
  - **hybrid** — 3★ spawns 2 large raccoons (a "duo finisher")
- Tier visual: **can → bin → big bin**.

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
- **4 roles × 4 environments × 4 curiosities = 64 cells**, target 30+ unique cards
  for v0 (39 currently authored under `cards/units/`)
- **6 cost tiers** (T1–T6); T6 priced as a real splash buy
- **Power floor:** 1 × 2★ defeats 2 × 1★ of the same cost tier (constrains
  balance — 2★ stats must be >2× 1★)
- **Tier-step power gradient** (one cost-tier step at fixed star):
  - +10–20% per tier at 1★
  - +30–40% per tier at 2★
  - +50–75% per tier at 3★
- Star-up scaling routes per card — see Bins above

## Battlefield
- TFT-style **hex grid, smaller hexes**, free-flowing boid movement (mappable
  back to hexes if needed)
- **Flat, non-wrapping** for v1; environment theming is **color pattern only**, no
  terrain or interactables
- Mirrored shared-layout matchups
- **Placement zone:** your side only
- **Repositioning:** free, unlimited, during shop phase
- **No in-combat user input** — bins are stationary, raccoons autonomous

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

1. **Stat curves & numbers** — DPS, HP, bin HP, spawn rate. Balance pass within
   the locked tier-step gradient (+10–20% / +30–40% / +50–75%) and the "1×2★
   beats 2×1★ of same tier" power floor.
2. **Trashconomy numbers** — kill bounty, loss bonus, reroll cost, board-cap
   cost curve, level-up cost, interest rate, arcade payouts. Structure locked,
   values TBD.
3. **Loss damage numbers** — `base[round]` curve, `W_bin`, `W_rac`. Formula
   locked, values TBD.
4. **Concrete card list** — 39 authored; target 30+ unique cells (the 4×4×4
   grid is intentionally not all filled). Backfill `tier3_form` on existing
   cards.
5. **Server architecture** — headless sim + state streaming protocol.
6. **Admin editor + versioning** — schema for content records, editor UX,
   version pinning per match, rollback / replay tooling.
7. **Tier 6 distinctness (v1)** — pure stat steepness for v0; later layer
   bespoke noun-damage types and status effects onto high-tier units.
