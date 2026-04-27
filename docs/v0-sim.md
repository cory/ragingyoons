# Raging Yoons — v0 Sim Architecture

The simulation is a **platform-agnostic TypeScript module** at `src/sim/` —
no Babylon, no DOM, no `Math.random`, no `Date.now`, no `performance.now`.
It runs identically in the browser (phase 1) and Node (phase 2), which
gives us free determinism for batch testing (phase 3).

## Locked decisions

- **Tick rate:** 15 Hz fixed (66.67 ms per tick). Client interpolates for
  visual smoothness.
- **Spawn cadence (v0a):** garrison-respawn. Each bin tracks a per-slot
  respawn timer; when a raccoon from slot N dies, slot N's timer starts;
  when it expires, a fresh raccoon spawns in that slot.
- **Battlefield:** flat plane, no hex grid, no terrain features.
- **Module location:** `src/sim/` in the main app.
- **Starting bins:** 3 per player (the spec'd starting board cap). v0a tests
  use exactly 3-bin × 3-bin matchups.
- **Observability:** OT-compliant structured event logging from day one.
  See "Observability" below.

## Module layout

```
src/sim/
  content.ts       # load + validate cards/ → frozen ContentBundle
  state.ts         # State shape, entity types, IDs
  rng.ts           # Mulberry32 seeded RNG
  tick.ts          # the per-tick pipeline (entry point: tick(state, content))
  subsys/
    spawn.ts       # bin spawn + garrison respawn
    boids.ts       # steering from neighbors + role formation
    target.ts      # per-raccoon targeting
    attack.ts      # basic attacks + cooldowns
    project.ts     # in-flight projectiles / pulses / cones
    damage.ts      # apply damage + armor + death
    status.ts      # tick status effects (DoT, control, debuff expiry)
    rage.ts        # gain rule per role + auto-fire on full
    win.ts         # round-end check
  delta.ts         # state-delta encoding for streaming
  log.ts           # OT-compliant structured event logger
  index.ts         # public API: setupBattle, tick, snapshot
```

## Content loading

```ts
loadContent(cardsDir: string): ContentBundle
```

Walks `cards/`, parses YAML frontmatter, validates cross-refs, returns a
**frozen** bundle:

```ts
interface ContentBundle {
  version: string;              // git hash of cards/ at load time
  units: Map<string, UnitDef>;
  statuses: Map<string, StatusDef>;
  environments: Map<string, EnvDef>;
  curiosities: Map<string, CuriosityDef>;
  roles: Map<string, RoleDef>;
  synergies: SynergyDef[];      // env+curiosity synergies, indexed by owner
}
```

Validation runs at load time:
- Every unit's `apply: [...]` references a real status
- Every comp's `bins: [{id}]` references a real unit
- Every synergy's `owner` references a real env/curiosity
- Required fields present (HP, damage, attack_rate, etc.)

Battles **bind to a specific ContentBundle version** at start; mid-match
content edits don't perturb a running game (matches the
"version-pinned" requirement in v0-design.md).

## State shape

Flat structure-of-arrays with **dense numeric IDs** for entities. SoA
is cache-friendly and serializes compactly for streaming.

```ts
interface BattleState {
  tick: number;                 // 0, 1, 2, ...
  rng: RngState;                // seeded mulberry32 state
  contentVersion: string;
  bounds: { w: number; h: number };

  // Bins
  bin: {
    id: Uint32Array;
    owner: Uint8Array;          // 0 = player A, 1 = player B
    unitId: string[];           // index into ContentBundle.units
    hp: Float32Array;
    x: Float32Array; y: Float32Array;
    starTier: Uint8Array;       // 1, 2, 3
    garrisonSlots: Uint8Array;  // count alive
    slotRespawnT: Float32Array; // remaining respawn time per slot, packed
    alive: Uint8Array;          // 1 / 0
  };

  // Raccoons
  rac: {
    id: Uint32Array;
    owner: Uint8Array;
    sourceBinId: Uint32Array;   // which bin spawned them
    unitId: string[];
    role: Uint8Array;           // enum
    env: Uint8Array;
    curiosity: Uint8Array;
    hp: Float32Array;
    rage: Float32Array;
    x: Float32Array; y: Float32Array;
    vx: Float32Array; vy: Float32Array;
    facing: Float32Array;       // radians
    targetId: Int32Array;       // -1 if none
    attackCooldown: Float32Array;
    statuses: StatusInstance[][]; // sparse — most have none
    alive: Uint8Array;
  };

  // Active attacks (projectiles, AOE pulses, cones)
  atk: {
    id: Uint32Array;
    sourceRacId: Uint32Array;
    kind: Uint8Array;           // single / cone / line / aoe / pulse / dash / ...
    damage: Float32Array;
    appliesStatusIds: string[][];
    x: Float32Array; y: Float32Array;
    vx: Float32Array; vy: Float32Array;
    radius: Float32Array;
    timeToLive: Float32Array;
    alive: Uint8Array;
  };

  winner: -1 | 0 | 1;           // -1 = ongoing
  endReason: 'last-raccoon' | 'all-bins' | null;
}
```

Why typed arrays: streaming-friendly (a `Float32Array` slice is just bytes),
GC-friendly, and they push us toward a tight layout that'll port cleanly
if we ever want a Rust/Zig sim.

## Tick interface

```ts
function tick(state: BattleState, content: ContentBundle): void;
```

In-place mutation for performance — but the *only* code allowed to mutate
state is `tick()` and its sub-systems. Rendering reads via a snapshot
function (`snapshot(state) → ReadonlyState`) that returns frozen views.

**Pipeline order, per tick:**

1. `spawn.tick(state, content)` — for each alive bin, decrement slot
   respawn timers; spawn raccoons in slots whose timers hit zero.
2. `target.tick(state, content)` — per-raccoon retarget based on
   role's target_priority. Not every tick — every 4 ticks (≈266 ms)
   suffices and saves work.
3. `boids.tick(state, content)` — steering = α·separation + β·alignment
   + γ·cohesion + δ·targetSeek + ε·formation + ζ·flee. Coefficients
   come from role + status. Apply attack-stop factor (archers ≈ stop).
   Integrate velocity → position.
4. `attack.tick(state, content)` — for each raccoon: if cooldown ≤ 0
   and target in range → spawn an `atk` and reset cooldown.
5. `project.tick(state, content)` — advance in-flight attacks, hit-test,
   spawn damage events.
6. `damage.tick(state, content)` — apply damage events: armor reduction,
   subtract HP, apply listed statuses, mark dead.
7. `status.tick(state, content)` — DoTs tick (deal damage), expirations
   remove effects, control effects (locked, jittered) take hold for
   downstream subsystems next tick.
8. `rage.tick(state, content)` — each role's gain rule fires (Tank: per
   damage taken this tick; Archer: per attack landed; Cavalry: per
   second spent attacking; Infantry: per second adjacent to allies).
   When meter ≥ capacity, fire the unit's bespoke rage attack (an
   `atk` instance) and reset meter.
9. `win.tick(state, content)` — check end condition: last raccoon
   alive, OR (eventually) bins fully eliminated for one side.

## Determinism rules

- **Single RNG**, seeded at battle start. Threaded through `state.rng`.
  All randomness — boid jitter, target tiebreakers, status crit rolls,
  rage attack arc — pulls from this RNG.
- **No `Math.random`**, no `Date.now()`, no `performance.now()` in
  `src/sim/`. ESLint rule will enforce.
- **Stable iteration order:** when iterating entity arrays, always go
  in id order (the array order). When picking among ties (e.g., two
  enemies equidistant), break by lower id.
- **No async** inside tick. No microtasks. Pure CPU.
- **Float math** is allowed (we're single-language JS; same engine
  produces same results for same inputs). If we ever go cross-language,
  switch to fixed-point.

## Observability

OT-compliant **structured event logging** from day one. Wide, high-cardinality
NDJSON rows so we can query battle outcomes, root-cause win/loss, and feed
analytics tools without re-instrumenting later.

### Format
- **NDJSON** (newline-delimited JSON), one event per line.
- **Append-only**, never rewritten — per-battle file makes shard analysis
  trivial.
- **Flat top-level fields** with `sim.*` / `entity.*` / `event.*` namespacing
  (clickable in DuckDB, ClickHouse, jq). An OT-collector transform can
  promote/demote fields if/when we ingest into OT proper; we don't pay the
  nesting cost up front.
- Schema-versioned: every line carries `schema_version` so old logs stay
  readable as the schema evolves.

### Path layout
```
logs/
  battles/
    {YYYY-MM-DD}/
      battle-{ts}-{seed}-{battle_id}.ndjson    # one battle per file
  batch/
    {batch_id}/
      run-{i}.ndjson                            # phase-3 batch runs
      summary.ndjson                            # one row per battle
```

`logs/` is gitignored. Long-term storage is up to the operator (S3, etc.).

### Required fields on every event
```ts
interface BaseEvent {
  ts: string;             // RFC3339, real wall clock — for debugging
  tick: number;           // sim-time, monotonic per battle
  battle_id: string;      // uuid, scoped to a single battle
  schema_version: number; // bump when fields change
  event_kind: string;     // see registry below
  service_name: 'rgyoons-sim';
  service_version: string; // git hash of the sim module
  content_version: string; // git hash of cards/ at battle start
  seed: number;            // RNG seed
}
```

Add OT semantic-convention fields where they fit (`trace_id` = battle_id,
`span_id` = optional per-tick span). We can extend later.

### Event kinds (initial registry)

Sparse, named events — emitted only when something happens.

| event_kind        | when                                                 | extra fields |
|-------------------|------------------------------------------------------|----------------------------------------------------|
| `battle_start`    | once, t=0                                            | `comp_a`, `comp_b`, `bins_a[]`, `bins_b[]`         |
| `bin_spawn`       | bin instantiated                                     | `bin_id`, `owner`, `unit_id`, `x`, `y`, `hp`       |
| `rac_spawn`       | raccoon spawns from a bin                            | `rac_id`, `bin_id`, `unit_id`, `role`, `env`, `cur`, `hp_init`, `x`, `y` |
| `rac_target`      | raccoon picks a new target                           | `rac_id`, `prev_target`, `new_target`, `priority`  |
| `rac_attack`      | basic attack fires                                   | `rac_id`, `target_id`, `damage`, `range`, `hit`    |
| `damage_apply`    | damage resolves                                      | `src_rac`, `tgt_kind`, `tgt_id`, `dmg_raw`, `dmg_after_armor`, `tgt_hp_before`, `tgt_hp_after` |
| `status_apply`    | status added                                         | `tgt_id`, `status_id`, `duration`, `magnitude`, `src_rac` |
| `status_expire`   | status drops                                         | `tgt_id`, `status_id`                              |
| `rage_fire`       | rage attack triggers                                 | `rac_id`, `unit_id`, `targets[]`                   |
| `rac_death`       | raccoon HP ≤ 0                                       | `rac_id`, `last_hit_by`, `lifetime_ticks`, `damage_dealt`, `damage_taken` |
| `bin_death`       | bin HP ≤ 0                                           | `bin_id`, `last_hit_by`, `lifetime_ticks`          |
| `synergy_active`  | threshold hits (or unhits)                           | `owner`, `axis`, `threshold`, `state` ("on"/"off") |
| `tick_summary`    | every N ticks (default 15 = 1s)                      | `racs_alive_a`, `racs_alive_b`, `bins_alive_a`, `bins_alive_b`, `total_damage_a`, `total_damage_b` |
| `battle_end`      | win-check fires                                      | `winner`, `reason`, `final_tick`, `wallclock_ms`   |

Wide rows. A `damage_apply` row alone might carry 20+ columns once you add
`src_unit`, `src_role`, `src_env`, `src_cur`, `tgt_unit`, etc. — that
denormalization is the *point*: every row stands alone for query.

### Sampling / verbosity tiers
- **`events`** (default for batch): the sparse event registry above. ~10s of KB
  per battle. Enough to compute outcomes, attribute kills, replay synergies.
- **`events+snapshots`** (debug single battle): also dumps a full entity
  snapshot every N ticks to a sibling `*.snapshots.ndjson` file. Heavy but
  re-renderable for forensics.
- **`silent`** (perf benchmark): no logging at all.

The runtime accepts a `verbosity` config so phase-3 batch runs default to
`events` while UI-driven battles can crank up to `events+snapshots`.

### Logger interface
```ts
interface Logger {
  emit(eventKind: string, fields: Record<string, unknown>): void;
  flush(): Promise<void>;
}
```

Two implementations:
- `FileLogger(path)` for Node — buffered NDJSON writer, flushes on flush + on
  process exit.
- `MemoryLogger()` for the browser — accumulates in memory; the spectator UI
  can render the event stream live, and the user can download the NDJSON.

The sim module gets a logger handle at battle setup. Every subsystem takes
`(state, content, log)` and emits events as they happen. **No `console.log`
inside `src/sim/`.** ESLint rule will enforce.

### What this unlocks
- DuckDB / ClickHouse over `logs/` to answer "why did City+Farmers win"
- Aggregate damage attribution per unit / role / env / cur for tuning
- Phase-3 winrate matrix is a one-liner SQL over `battle_end` rows
- Replay any logged battle by feeding events back into the renderer

## Streaming

`delta(prevSnapshot, curSnapshot) → DeltaPacket`

- Initial: full snapshot
- Per tick: list of entity IDs whose tracked fields changed, plus the
  new values
- 15 Hz × small entity count (≤ ~80 raccoons + ≤ ~10 bins per side) =
  small bandwidth even before delta-coding

Phase 2 streams `DeltaPacket` over SSE; the renderer reconstructs
state by applying deltas.

## Open questions (don't block phase 1a)

- **Per-bin synergy effects** at runtime: how do synergy modifiers get
  baked into a unit's effective stats each tick? Probably: a derived
  per-comp `EffectiveStats` table computed once at battle start and
  whenever bins die (synergy thresholds may un-fire). Tick-time stat
  reads use the effective table.
- **Status stacking semantics:** "stack" status (e.g., hungry) needs
  per-instance independent ticking; "refresh" status (e.g., wet) just
  resets duration. State shape supports both via the per-raccoon
  `statuses[]` list.
- **Boid neighborhood query:** O(N²) is fine for ≤ 200 entities at 15 Hz.
  Add a uniform grid only if we measure trouble.
- **Bin placement:** for v0a, pick fixed slots on each side (a 2×2 grid =
  4 slots per player, matching the starting board cap). UI can later
  allow drag-placement and >4 once we wire up board-cap spend.

## Out of scope for v0a

- The trashconomy / shop / round structure
- Full match shell (multiple rounds, player HP, rotation)
- Items, creep rounds, environment effects on the field
- Boid neighborhood acceleration structures
- Cross-language portability
