# Plan: lab tooling, formations, behavior, perf

Snapshot taken 2026-04-27 after committing the field-boids + projectiles
+ four tactical modifiers (hide-behind / flank / turning / surrounded).
Current state: 9.4 b/s on the full 7×7 mirror matrix, 59 unit tests, 52
invariants, 12 probes. The battles are *combat-driven* now (no
tiebreaks), but several design problems remain visible.

This doc lays out what's left, in execution order. Steps build on each
other — earlier items unblock later ones — so don't shuffle without
care.

---

## 1. Lab tooling — *do this first*

**Why first:** every later item is a behavior tuning task. We've been
debugging boids by squinting at mirror battles, which mixes spawn,
target, formation, force-coefficient, and combat issues into a single
visual mess. Need a way to look at one thing at a time.

**Deliverable:** `tools/sim-runner/lab.ts` — a single-shot scenario
runner that constructs a controlled BattleState, runs N ticks, and
emits a PNG snapshot + JSON summary into `lab/<scenario>/<seed>/`.

**Scenarios:**

| Subcommand | Setup | Captures |
|---|---|---|
| `spawn <unit>` | one bin, no enemies | settled spawn shape after 5/15/30 ticks |
| `march <unit> <distance>` | one bin, static dummy target rac at +X | path + final layout |
| `kite <archer> <enemy>` | single archer vs single enemy at specified distance | velocity + position trace |
| `surround <unit> <ring_n> <ring_r>` | one unit centered, ring_n enemies at radius ring_r | surrounded flag activations + hp loss curve |
| `mirror <comp>` | two-side mirror, full battle | replay frames |
| `formation <unit> <formation>` | (after item 3 lands) one bin, formation override | settled spawn shape |

**Render output:** simple top-down PNG via the canvas-style renderer
already in BattleViewer.tsx, but server-side. Use `node-canvas` (small
dep) or just emit SVG (no dep). Probably SVG — easier to inspect, no
binary dep.

**JSON summary:** `{ tick, racs: [{id, x, y, vx, vy, role, owner, hp}], forces?: [{id, sep, coh, align, seek, hide}] }`. Optional force breakdown
gated by a `--debug-forces` flag that writes per-tick force components
from inside boids — needs a small instrumentation hook in boids.ts.

**Scope budget:** ~250 LOC. Reuse `setupBattle`, `tick`, the existing
log infrastructure. SVG renderer is ~80 LOC; scenario glue is ~100; the
debug-forces hook is ~30.

**Tests:** snapshot tests on the JSON output. `lab spawn cavalry-shadow
--seed 42` should produce a stable layout; commit the JSON, diff in CI.

---

## 2. Mirror bias fix

**Why second:** without this, the matrix output isn't trustworthy as a
design signal. Today's `city-swarm` mirror is 9A/1B which is iteration-
order asymmetry, not real winrate.

**Hypothesis:** lower-row attacker scans first in combat, lower-id
target wins ties in target.ts, side-0 spawns first so its raccoons
have lower row indices — a chain of "first writer wins" advantages.

**Fix:**
- Add `state._tickIterOrder: Int32Array` rebuilt each tick: a
  permutation of `[0..rac.count)` shuffled by a tick-seeded RNG that's
  side-independent (`mulberry32(state.seed ^ state.tick)`).
- Subsystems that iterate racs in id-order use `_tickIterOrder[k]`
  instead of `k` directly.
- Determinism preserved: same seed + tick → same shuffle → same battle.

**Cost:** O(N) shuffle per tick. Should be invisible in profiling.

**Validation:** run `--seeds 50` mirror, expect 25/25 ± noise.

---

## 3. Per-rac flank assignment + threat field

**Why third:** these are the highest design-impact behavior fixes
remaining. Together they break "youth soccer" without adding a lot of
state.

**Per-rac flank assignment** (~10 LOC):
- Each rac gets a fixed lateral angular bias from `id * 0.7 mod 2π`
  mapped to an offset in `[-30°, +30°]` perpendicular to its seek
  direction.
- Adds a small lateral component to seek so adjacent racs from the
  same spawn approach the target along visibly different paths.
- Already have id-based jitter in boids.ts; this extends it.

**Threat field** (~50 LOC, infrastructure):
- New per-side channel in `BoidFields`: `threat[side]` rasterized as
  `enemyDamage × enemyAttackRate / max(enemyHp, 1)`.
- Splat alongside density in `buildBoidFields`.
- Sample at unit position to drive: cavalry seeks low-threat (squishy
  archers), archers avoid high-threat zones.
- Per-role `threatBiasK` in TacticProfile.

**Cost:** field channel = ~3% perf budget. Per-rac sample = trivial.

---

## 4. Formations system

**Why fourth:** depends on lab tooling for design iteration, depends
on threat field if we want flank-formation behavior to use it.

**Schema:**
- New optional field on bin frontmatter: `formation`. Defaults per role
  (tank=line, infantry=line, cavalry=loose-deuce, archer=two-line).
- Formation list per role:
  - Tank: `line`, `arrowhead`
  - Infantry: `line`, `phalanx`
  - Cavalry: `loose-deuce`, `flexible-fours`, `lone-gunmen`
  - Archer: `one-line`, `two-line`, `sniper`

**Mechanism:**
- `src/sim/formations.ts` registry: `{ id, role, spawn(burst_idx, burst_size, bin_x, bin_y, enemy_dir) → {dx, dy, facing}, tacticOverride: Partial<TacticProfile>, behaviorTags: Set<string> }`
- `spawn.ts` reads bin's `formation`, calls registry's `spawn()` per
  burst index for arranged positions, stamps `state.rac.formationIdx`
  per rac.
- Tactic compose chain becomes: defaults → role override → formation
  override → per-side tactic override.
- Boids/combat read `formationIdx` if a behavior needs it (e.g.,
  `phalanx` could halve damage from front arc).

**Examples — spawn shape and tactic override:**

| Formation | Spawn shape | Override |
|---|---|---|
| `line` | spread perpendicular to enemy axis, 1.2m apart | +alignK, +cohK |
| `arrowhead` | wedge: center forward, flanks back | +seekK, +cohK toward apex |
| `phalanx` | tight square grid, 0.8m spacing | ++cohK, --sepK, --speedMul, frontal damage reduction |
| `loose-deuce` | pairs, 4m between pairs | low cohK paired only |
| `flexible-fours` | 4-unit clusters, 6m apart | medium cohK within group |
| `lone-gunmen` | scattered, 3m+ apart | cohK=0, +seekK |
| `one-line` | single row behind tanks | +hideBehindK, +alignK |
| `two-line` | two rows behind tanks | +hideBehindK |
| `sniper` | spread wide, on flanks | +hideStandoff, low cohK, per-id flank emphasis |

**Validation via lab:**
`lab formation suburban-tank-bouncer phalanx` → snapshot matches
expected square grid. Run with `march` to see how phalanx settles.

**Comp matrix expansion:** add 2 new comps using non-default
formations; expect them to win/lose differently than the same units in
default formations.

**Scope:** ~300 LOC sim, ~50 LOC card schema bumps, ~100 LOC tests.

---

## 5. Smart target priority

**Why fifth:** less critical once formations + flank assignment + threat
field are in. But finishes the AI feel.

**Mechanism:** replace nearest-enemy-rac in target.ts with a scoring
function:
```
score = (1 / d²) × roleAffinity[myRole][targetRole] × (1 + lowHpBonus × (1 − hpFrac))
```
- `roleAffinity[mySrc][targetTgt]` is a 4×4 table:
  - Tank: prefers tank/inf
  - Cavalry: prefers archer/inf low-hp
  - Archer: prefers archer first, then squishy inf
  - Infantry: prefers tank/inf

**Cost:** target.ts inner loop already iterates all racs; add 2 muls.
Trivial.

**Validation via lab:** `lab march city-cavalry-skitter` with mixed
enemy roles in the path; cavalry should curve toward the archer not
the tank.

---

## 6. Last-mile perf push

Defer until you actually need >9.4 b/s for sweeps. Items, ordered by
expected payoff:

- **Inline `forEachNear` at combat callsite**: hottest closure, ~5-8%
  of the combat slice
- **Skip surrounded sample for cavalry**: they ignore the speed mul
  anyway; saves 4 samples × N cav per tick
- **Per-side rac grid**: combat queries enemy-only; current grid stores
  all racs and we filter. A side-split grid would halve enemy scan size
- **Cache jitter angle per rac**: recomputed every tick currently;
  precompute at spawn into `Float32Array`
- **Status recompute throttle**: even with dirty flag, we allocate a
  new statuses array each tick when DoT prunes

Realistic ceiling without major refactor: ~12-14 b/s. Beyond that
needs WASM/SIMD or Web Worker parallelism (multiple battles in
parallel).

---

## What I'm NOT doing

These came up in discussion but aren't on this plan; flagging for future
me:

- **Friendly-shield damage attenuation**: rejected — covered by
  hide-behind force + projectile collision (the boid arrangement IS
  the shield).
- **Charge damage bonus (item 5 from earlier)**: skipped because cavalry
  range 2m + non-stopping already produces a "passing-charge" feel.
  Revisit if cavalry feels weak after item 1's bin-durability tuning.
- **Pile-on damage bonus**: skipped — implicit in current "all racs hit
  same target" behavior; explicit bonus would require per-tick attack-
  count bookkeeping per target. Revisit if focus-fire feels under-
  rewarded.

---

## Testing infrastructure summary

Per the user note: building behavior changes without inspection tools
is a bad time. The lab is the test harness for everything in items
2-5. Concretely:

- **Item 2 mirror bias**: `lab mirror city-swarm --seeds 50 --report-only` → expect 50/50 ± noise.
- **Item 3 threat field / flank**: `lab march <comp>` with debug-forces;
  visually inspect that flank biases are non-zero per-rac.
- **Item 4 formations**: every formation gets a `lab formation` snapshot
  test that compares to a stable JSON.
- **Item 5 target priority**: `lab march` with mixed enemy roles;
  assert the chosen target by id matches expected per role.

The lab outputs JSON → cheap to assert against in CI. PNGs/SVGs are
for human review during tuning, not asserted.

---

## Order summary

1. Lab tooling (1 day)
2. Mirror bias fix (½ day)
3. Per-rac flank + threat field (½ day)
4. Formations (1-2 days)
5. Smart target priority (½ day)
6. Last-mile perf (½ day, only if needed)

Total: 4-5 days of focused work for the full plan. Items 1-3 are the
high-value early picks if time is tight.
