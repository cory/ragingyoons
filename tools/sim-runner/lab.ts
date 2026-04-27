/**
 * Boid / formation / behavior lab.
 *
 * Builds controlled scenarios — single bin, no enemies, archer-vs-rac
 * kite, surrounded ring, etc. — runs the sim for a fixed number of
 * ticks, and emits a snapshot per scenario:
 *   - SVG frames at chosen ticks (top-down, role-shaped)
 *   - JSON summary with positions, velocities, optional force breakdown
 *
 * The output is *for inspection*: tune tactics.ts coefficients, run
 * the lab, look at the SVG. Snapshots are stable per seed so they can
 * also be diffed in CI as regression tests.
 *
 * Subcommands:
 *   spawn <unit>                    one bin, no enemies
 *   march <unit> <distance>         one bin marching toward dummy
 *   kite <archer> <enemy> <dist>    archer vs single enemy
 *   surround <unit> <n> <r>         unit surrounded by ring of enemies
 *   formation <unit> <formation>    (after item 4 lands)
 *
 * Output: lab/<scenario>/<seed>/
 *   frame-0000.svg, frame-0005.svg, frame-0015.svg, frame-0030.svg
 *   summary.json
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadContentFromFs } from "../../src/sim/load-fs.js";
import { MemoryLogger } from "../../src/sim/log.js";
import { setupBattle, tick, type BattleConfig, type BattleState } from "../../src/sim/index.js";
import { CURIOSITY_TO_IDX, ENV_TO_IDX, ROLE_TO_IDX, type ContentBundle, type UnitDef } from "../../src/sim/content.js";
import { makeRng } from "../../src/sim/rng.js";
import {
  MAX_BINS,
  MAX_RACS,
  MAX_ATKS,
  MAX_GARRISON_SLOTS,
  TARGET_KIND_RAC,
  TARGET_KIND_BIN,
  composeFormationProfiles,
} from "../../src/sim/state.js";
import { composeTactics } from "../../src/sim/tactics.js";
import {
  DEFAULT_FORMATION_BY_ROLE,
  FORMATIONS,
  FORMATION_TO_IDX,
  type FormationId,
} from "../../src/sim/formations.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Default snapshot timestamps (in ticks) for any scenario.
const SNAPSHOT_TICKS = [0, 5, 15, 30, 60, 120, 240];

// Canvas / world bounds for the lab. Same as production.
const BOUNDS_W = 100;
const BOUNDS_H = 100;
const SVG_PX = 720;
const PX_PER_M = SVG_PX / Math.max(BOUNDS_W, BOUNDS_H);

interface FrameSummary {
  tick: number;
  racs: Array<{
    id: number;
    owner: 0 | 1;
    role: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    hp: number;
  }>;
  bins: Array<{ id: number; owner: 0 | 1; x: number; y: number; alive: 0 | 1 }>;
}

interface ScenarioOutput {
  scenario: string;
  args: Record<string, unknown>;
  seed: number;
  frames: FrameSummary[];
  metrics: Record<string, number>;
}

// ---------- empty state builders (same shape as tests/helpers) ----------

function emptyState(seed: number): BattleState {
  const stateAny = {
    tick: 0,
    rng: makeRng(seed),
    battleId: `lab-${seed}`,
    contentVersion: "lab",
    seed,
    bounds: { w: BOUNDS_W, h: BOUNDS_H },
    unitIdTable: [] as string[],
    bin: emptyBin(),
    rac: emptyRac(),
    atk: emptyAtk(),
    nextBinId: 1,
    nextRacId: 1,
    nextAtkId: 1,
    winner: -1 as -1 | 0 | 1,
    endReason: null as BattleState["endReason"],
    tacticPerSide: composeTactics(),
    formationProfile: [[], []] as BattleState["formationProfile"],
    formationContactProfile: [[], []] as BattleState["formationContactProfile"],
    racRowById: new Map<number, number>(),
    binRowById: new Map<number, number>(),
  };
  const state = stateAny as unknown as BattleState;
  composeFormationProfiles(state);
  return state;
}

function emptyBin() {
  return {
    count: 0,
    id: new Int32Array(MAX_BINS),
    owner: new Uint8Array(MAX_BINS),
    unitIdIdx: new Int32Array(MAX_BINS),
    envIdx: new Uint8Array(MAX_BINS),
    curIdx: new Uint8Array(MAX_BINS),
    hp: new Float32Array(MAX_BINS),
    hpMax: new Float32Array(MAX_BINS),
    x: new Float32Array(MAX_BINS),
    y: new Float32Array(MAX_BINS),
    starTier: new Uint8Array(MAX_BINS),
    garrisonCap: new Uint8Array(MAX_BINS),
    slotRespawnT: new Float32Array(MAX_BINS * MAX_GARRISON_SLOTS),
    slotOccupant: new Int32Array(MAX_BINS * MAX_GARRISON_SLOTS),
    alive: new Uint8Array(MAX_BINS),
  };
}

function emptyRac() {
  return {
    count: 0,
    id: new Int32Array(MAX_RACS),
    owner: new Uint8Array(MAX_RACS),
    sourceBinId: new Int32Array(MAX_RACS),
    sourceSlotIdx: new Int32Array(MAX_RACS),
    unitIdIdx: new Int32Array(MAX_RACS),
    role: new Uint8Array(MAX_RACS),
    env: new Uint8Array(MAX_RACS),
    cur: new Uint8Array(MAX_RACS),
    hp: new Float32Array(MAX_RACS),
    hpMax: new Float32Array(MAX_RACS),
    rage: new Float32Array(MAX_RACS),
    rageCap: new Float32Array(MAX_RACS),
    x: new Float32Array(MAX_RACS),
    y: new Float32Array(MAX_RACS),
    vx: new Float32Array(MAX_RACS),
    vy: new Float32Array(MAX_RACS),
    facing: new Float32Array(MAX_RACS),
    prevFacing: new Float32Array(MAX_RACS),
    targetId: new Int32Array(MAX_RACS),
    targetKind: new Uint8Array(MAX_RACS),
    attackCooldown: new Float32Array(MAX_RACS),
    statuses: Array.from({ length: MAX_RACS }, () => []),
    alive: new Uint8Array(MAX_RACS),
    effSpeed: new Float32Array(MAX_RACS),
    effDamage: new Float32Array(MAX_RACS),
    effRange: new Float32Array(MAX_RACS),
    effAttackRate: new Float32Array(MAX_RACS),
    effArmor: new Float32Array(MAX_RACS),
    dmgTakenMul: new Float32Array(MAX_RACS),
    surroundedDamageMul: new Float32Array(MAX_RACS),
    statsDirty: new Uint8Array(MAX_RACS),
    formationIdx: new Uint8Array(MAX_RACS),
    contact: new Uint8Array(MAX_RACS),
  };
}

function emptyAtk() {
  return {
    count: 0,
    id: new Int32Array(MAX_ATKS),
    sourceRacId: new Int32Array(MAX_ATKS),
    sourceOwner: new Uint8Array(MAX_ATKS),
    kindIdx: new Uint8Array(MAX_ATKS),
    damage: new Float32Array(MAX_ATKS),
    appliesStatusIds: Array.from({ length: MAX_ATKS }, () => []),
    x: new Float32Array(MAX_ATKS),
    y: new Float32Array(MAX_ATKS),
    vx: new Float32Array(MAX_ATKS),
    vy: new Float32Array(MAX_ATKS),
    radius: new Float32Array(MAX_ATKS),
    ttl: new Float32Array(MAX_ATKS),
    alive: new Uint8Array(MAX_ATKS),
  };
}

// ---------- entity placement (manual; bypasses spawn.ts) ----------

function internUnitId(state: BattleState, unitId: string): number {
  let i = state.unitIdTable.indexOf(unitId);
  if (i < 0) {
    i = state.unitIdTable.length;
    state.unitIdTable.push(unitId);
  }
  return i;
}

function placeRac(
  state: BattleState,
  unit: UnitDef,
  owner: 0 | 1,
  x: number,
  y: number,
): number {
  const slot = state.rac.count;
  state.rac.id[slot] = state.nextRacId++;
  state.rac.owner[slot] = owner;
  state.rac.unitIdIdx[slot] = internUnitId(state, unit.id);
  state.rac.role[slot] = ROLE_TO_IDX[unit.role];
  state.rac.env[slot] = ENV_TO_IDX[unit.environment];
  state.rac.cur[slot] = CURIOSITY_TO_IDX[unit.curiosity];
  state.rac.hp[slot] = unit.stats.hp;
  state.rac.hpMax[slot] = unit.stats.hp;
  state.rac.rage[slot] = 0;
  state.rac.rageCap[slot] = unit.rage.capacity;
  state.rac.x[slot] = x;
  state.rac.y[slot] = y;
  state.rac.vx[slot] = 0;
  state.rac.vy[slot] = 0;
  state.rac.facing[slot] = owner === 0 ? 0 : Math.PI;
  state.rac.prevFacing[slot] = state.rac.facing[slot];
  state.rac.targetId[slot] = -1;
  state.rac.targetKind[slot] = 0;
  state.rac.attackCooldown[slot] = 0;
  state.rac.statuses[slot] = [];
  state.rac.alive[slot] = 1;
  // Apply tactic.speedMul into effSpeed at lab placement, matching
  // what spawn.ts does in production.
  const profile = state.tacticPerSide[owner][ROLE_TO_IDX[unit.role]];
  state.rac.effSpeed[slot] = unit.stats.speed * profile.speedMul;
  state.rac.effDamage[slot] = unit.stats.damage;
  state.rac.effRange[slot] = unit.stats.range;
  state.rac.effAttackRate[slot] = unit.stats.attack_rate;
  state.rac.effArmor[slot] = unit.stats.armor;
  state.rac.dmgTakenMul[slot] = 1;
  state.rac.surroundedDamageMul[slot] = 1;
  // Default formation per role so boids reads the right profile.
  const fid = DEFAULT_FORMATION_BY_ROLE[unit.role];
  state.rac.formationIdx[slot] = FORMATION_TO_IDX[fid];
  state.rac.sourceBinId[slot] = -1;
  state.rac.sourceSlotIdx[slot] = -1;
  state.rac.count = slot + 1;
  state.racRowById.set(state.rac.id[slot], slot);
  return slot;
}

function placeBin(
  state: BattleState,
  unit: UnitDef,
  owner: 0 | 1,
  x: number,
  y: number,
): number {
  const slot = state.bin.count;
  state.bin.id[slot] = state.nextBinId++;
  state.bin.owner[slot] = owner;
  state.bin.unitIdIdx[slot] = internUnitId(state, unit.id);
  state.bin.envIdx[slot] = ENV_TO_IDX[unit.environment];
  state.bin.curIdx[slot] = CURIOSITY_TO_IDX[unit.curiosity];
  state.bin.hp[slot] = unit.bin.hp;
  state.bin.hpMax[slot] = unit.bin.hp;
  state.bin.x[slot] = x;
  state.bin.y[slot] = y;
  state.bin.starTier[slot] = 1;
  state.bin.garrisonCap[slot] = Math.min(unit.bin.garrison_cap, MAX_GARRISON_SLOTS);
  for (let s = 0; s < MAX_GARRISON_SLOTS; s++) {
    state.bin.slotRespawnT[slot * MAX_GARRISON_SLOTS + s] = 0;
    state.bin.slotOccupant[slot * MAX_GARRISON_SLOTS + s] = -1;
  }
  state.bin.alive[slot] = 1;
  state.bin.count = slot + 1;
  state.binRowById.set(state.bin.id[slot], slot);
  return slot;
}

// ---------- snapshot capture ----------

function snapshot(state: BattleState): FrameSummary {
  const racs: FrameSummary["racs"] = [];
  for (let i = 0; i < state.rac.count; i++) {
    if (!state.rac.alive[i]) continue;
    racs.push({
      id: state.rac.id[i],
      owner: state.rac.owner[i] as 0 | 1,
      role: state.rac.role[i],
      x: state.rac.x[i],
      y: state.rac.y[i],
      vx: state.rac.vx[i],
      vy: state.rac.vy[i],
      hp: state.rac.hp[i],
    });
  }
  const bins: FrameSummary["bins"] = [];
  for (let i = 0; i < state.bin.count; i++) {
    bins.push({
      id: state.bin.id[i],
      owner: state.bin.owner[i] as 0 | 1,
      x: state.bin.x[i],
      y: state.bin.y[i],
      alive: state.bin.alive[i] as 0 | 1,
    });
  }
  return { tick: state.tick, racs, bins };
}

// ---------- SVG renderer ----------

const ROLE_LABEL = ["T", "A", "C", "I"];
const SIDE_FILL = ["#7da9e6", "#e67d7d"];
const SIDE_BIN = ["#3a6db8", "#b83a3a"];

function worldToSvg(x: number, y: number): [number, number] {
  // Center origin in SVG, +x right, +y up (so flip y).
  const sx = SVG_PX * 0.5 + x * PX_PER_M;
  const sy = SVG_PX * 0.5 - y * PX_PER_M;
  return [sx, sy];
}

function shape(role: number, cx: number, cy: number, fill: string): string {
  if (role === 0) {
    // Tank: square
    return `<rect x="${cx - 6}" y="${cy - 6}" width="12" height="12" fill="${fill}" stroke="#000" stroke-opacity="0.5"/>`;
  }
  if (role === 1) {
    // Archer: triangle
    return `<polygon points="${cx},${cy - 5} ${cx - 4},${cy + 4} ${cx + 4},${cy + 4}" fill="${fill}"/>`;
  }
  if (role === 2) {
    // Cavalry: diamond
    return `<polygon points="${cx},${cy - 6} ${cx + 4},${cy} ${cx},${cy + 6} ${cx - 4},${cy}" fill="${fill}"/>`;
  }
  // Infantry: circle
  return `<circle cx="${cx}" cy="${cy}" r="4.5" fill="${fill}"/>`;
}

function renderSvg(frame: FrameSummary, scenarioLabel: string): string {
  const items: string[] = [];
  // Background
  items.push(
    `<rect x="0" y="0" width="${SVG_PX}" height="${SVG_PX}" fill="#161616"/>`,
  );
  // Bins
  for (const b of frame.bins) {
    const [sx, sy] = worldToSvg(b.x, b.y);
    if (b.alive) {
      items.push(
        `<rect x="${sx - 9}" y="${sy - 9}" width="18" height="18" fill="${SIDE_BIN[b.owner]}" stroke="#000" stroke-opacity="0.5"/>`,
      );
    } else {
      items.push(
        `<line x1="${sx - 7}" y1="${sy - 7}" x2="${sx + 7}" y2="${sy + 7}" stroke="#444"/><line x1="${sx + 7}" y1="${sy - 7}" x2="${sx - 7}" y2="${sy + 7}" stroke="#444"/>`,
      );
    }
  }
  // Velocity vectors for each rac (small line)
  for (const r of frame.racs) {
    const [sx, sy] = worldToSvg(r.x, r.y);
    const v = Math.hypot(r.vx, r.vy);
    if (v > 0.01) {
      const VLEN = 12; // px
      const ex = sx + (r.vx / v) * VLEN;
      const ey = sy - (r.vy / v) * VLEN;
      items.push(
        `<line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke="#888" stroke-opacity="0.7"/>`,
      );
    }
  }
  // Racs
  for (const r of frame.racs) {
    const [sx, sy] = worldToSvg(r.x, r.y);
    items.push(shape(r.role, sx, sy, SIDE_FILL[r.owner]));
  }
  // Title overlay
  items.push(
    `<text x="${SVG_PX * 0.5}" y="20" fill="#888" text-anchor="middle" font-family="ui-monospace,monospace" font-size="13">${scenarioLabel} — tick ${frame.tick}</text>`,
  );
  // HUD
  let na = 0,
    nb = 0;
  for (const r of frame.racs) (r.owner === 0 ? na++ : nb++);
  items.push(
    `<text x="10" y="${SVG_PX - 10}" fill="#9bc4f0" font-family="ui-monospace,monospace" font-size="11">side 0: ${na} racs</text>`,
  );
  items.push(
    `<text x="${SVG_PX - 10}" y="${SVG_PX - 10}" fill="#f09b9b" font-family="ui-monospace,monospace" font-size="11" text-anchor="end">side 1: ${nb} racs</text>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_PX}" height="${SVG_PX}" viewBox="0 0 ${SVG_PX} ${SVG_PX}">${items.join("\n")}</svg>`;
}

// ---------- metrics ----------

function computeMetrics(frames: FrameSummary[]): Record<string, number> {
  if (frames.length === 0) return {};
  const last = frames[frames.length - 1];
  const racs = last.racs;
  if (racs.length < 2) return { rac_count: racs.length };

  // Mean pairwise distance among side-0 racs only (pack tightness).
  const side0 = racs.filter((r) => r.owner === 0);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < side0.length; i++) {
    for (let j = i + 1; j < side0.length; j++) {
      const dx = side0[i].x - side0[j].x;
      const dy = side0[i].y - side0[j].y;
      sum += Math.hypot(dx, dy);
      count += 1;
    }
  }
  const meanPair = count > 0 ? sum / count : 0;

  // Bounding box of side-0 racs.
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const r of side0) {
    if (r.x < minX) minX = r.x;
    if (r.x > maxX) maxX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.y > maxY) maxY = r.y;
  }
  const bbArea = side0.length > 0 ? (maxX - minX) * (maxY - minY) : 0;

  // Mean speed.
  let speedSum = 0;
  for (const r of side0) speedSum += Math.hypot(r.vx, r.vy);
  const meanSpeed = side0.length > 0 ? speedSum / side0.length : 0;

  return {
    rac_count: racs.length,
    side0_count: side0.length,
    side0_mean_pair_dist: round(meanPair, 2),
    side0_bbox_area: round(bbArea, 2),
    side0_mean_speed: round(meanSpeed, 2),
  };
}

function round(n: number, decimals: number): number {
  const k = 10 ** decimals;
  return Math.round(n * k) / k;
}

// ---------- runner ----------

interface RunOpts {
  scenario: string;
  args: Record<string, unknown>;
  seed: number;
  ticks: number;
  setupFn: (state: BattleState, content: ContentBundle) => void;
  /** Optional snapshot tick override. */
  snapshotAt?: number[];
  /** Output dir (default: lab/<scenario>/<seed>/). */
  outDir?: string;
}

async function runScenario(opts: RunOpts, content: ContentBundle): Promise<void> {
  const cfg: BattleConfig = {
    seed: opts.seed,
    battleId: `lab-${opts.scenario}-${opts.seed}`,
    compA: "*lab*",
    compB: "*lab*",
    bounds: { w: BOUNDS_W, h: BOUNDS_H },
    verbosity: "events",
  };
  // Build state manually — bypass setupBattle's comp loader.
  const state = emptyState(opts.seed);
  void cfg;

  opts.setupFn(state, content);

  const log = new MemoryLogger({
    battle_id: state.battleId,
    seed: opts.seed,
    service_version: "lab",
    content_version: content.version,
  });
  log.setTickReader(() => state.tick);
  log.drain();

  const snapTicks = opts.snapshotAt ?? SNAPSHOT_TICKS;
  const snapSet = new Set(snapTicks);
  const frames: FrameSummary[] = [];
  if (snapSet.has(0)) frames.push(snapshot(state));
  for (let t = 1; t <= opts.ticks; t++) {
    tick(state, content, log);
    log.drain();
    if (snapSet.has(t)) frames.push(snapshot(state));
  }
  if (!snapSet.has(opts.ticks)) frames.push(snapshot(state));

  const metrics = computeMetrics(frames);

  const dir = opts.outDir ?? path.join(REPO_ROOT, "lab", opts.scenario, `seed-${opts.seed}`);
  await fs.mkdir(dir, { recursive: true });

  // Write SVG frames
  for (const f of frames) {
    const label = `${opts.scenario} ${JSON.stringify(opts.args)}`;
    const svg = renderSvg(f, label);
    const fname = `frame-${String(f.tick).padStart(4, "0")}.svg`;
    await fs.writeFile(path.join(dir, fname), svg);
  }

  // Write JSON summary
  const out: ScenarioOutput = {
    scenario: opts.scenario,
    args: opts.args,
    seed: opts.seed,
    frames,
    metrics,
  };
  await fs.writeFile(path.join(dir, "summary.json"), JSON.stringify(out, null, 2));

  // Console summary
  process.stdout.write(`[lab] ${opts.scenario} ${JSON.stringify(opts.args)} seed=${opts.seed}\n`);
  process.stdout.write(`      output: ${path.relative(REPO_ROOT, dir)}\n`);
  for (const [k, v] of Object.entries(metrics)) {
    process.stdout.write(`      ${k}: ${v}\n`);
  }
}

// ---------- scenarios ----------

function ringPositions(n: number, r: number, cx = 0, cy = 0): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

/** Resolve a unit by id; throw if not found. */
function getUnit(content: ContentBundle, id: string): UnitDef {
  const u = content.units.get(id);
  if (!u) throw new Error(`unknown unit id "${id}". Available: ${[...content.units.keys()].slice(0, 5).join(", ")}…`);
  return u;
}

/** scenario: spawn — single bin's worth of units, no enemies. */
function scenarioSpawn(unitId: string, seed: number) {
  return (state: BattleState, content: ContentBundle) => {
    const u = getUnit(content, unitId);
    // Mimic spawn.ts burst at fixed positions in a small jittered cluster.
    const burst = u.bin.spawn_burst ?? [2, 5, 5, 10][ROLE_TO_IDX[u.role]];
    void seed;
    for (let k = 0; k < burst; k++) {
      const a = (k / burst) * Math.PI * 2;
      const r = 1.5 + (k % 3) * 0.4;
      placeRac(state, u, 0, Math.cos(a) * r, Math.sin(a) * r);
    }
  };
}

/** scenario: formation — one unit's burst arranged by a specified
 *  formation, then settled for N ticks. Lets you visualize a formation
 *  shape without the rest of the battle's complications.
 *  If `targetDistance > 0`, also places a static dummy enemy that
 *  distance away so seek/cohesion/hide-behind have something to
 *  resolve against. */
function scenarioFormation(unitId: string, formationId: FormationId | null, targetDistance: number = 0) {
  return (state: BattleState, content: ContentBundle) => {
    const u = getUnit(content, unitId);
    const fid = formationId ?? DEFAULT_FORMATION_BY_ROLE[u.role];
    const formationIdx = FORMATION_TO_IDX[fid];
    const def = FORMATIONS[formationIdx];
    if (!def) throw new Error(`unknown formation ${fid}`);
    if (def.role !== u.role) {
      throw new Error(
        `formation '${fid}' is for role '${def.role}', but '${unitId}' is '${u.role}'`,
      );
    }
    const burst = u.bin.spawn_burst ?? [2, 5, 5, 10][ROLE_TO_IDX[u.role]];
    const dummy = getUnit(content, "city-barbarian-tank-brick");
    // Place dummy first if requested. Will be at -targetDistance/2;
    // friendlies at +targetDistance/2 (canonical side-0 placement).
    let dummyId = -1;
    if (targetDistance > 0) {
      const dRow = placeRac(state, dummy, 1, -targetDistance / 2, 0);
      state.rac.hp[dRow] = 1e9;
      state.rac.hpMax[dRow] = 1e9;
      dummyId = state.rac.id[dRow];
    }
    // forward = -1 means enemies are at -x (canonical side-0 placement).
    for (let k = 0; k < burst; k++) {
      const off = def.arrange({ burstIdx: k, burstSize: burst, forward: -1 });
      const baseX = targetDistance > 0 ? targetDistance / 2 : 0;
      const slot = placeRac(state, u, 0, baseX + off.dx, off.dy);
      state.rac.formationIdx[slot] = formationIdx;
      if (dummyId >= 0) {
        state.rac.targetId[slot] = dummyId;
        state.rac.targetKind[slot] = TARGET_KIND_RAC;
      }
    }
  };
}

/** scenario: march — units spawn at -X, dummy enemy rac at +X, see motion. */
function scenarioMarch(unitId: string, distance: number) {
  return (state: BattleState, content: ContentBundle) => {
    const u = getUnit(content, unitId);
    const dummy = getUnit(content, "city-barbarian-tank-brick"); // any tank as a punching bag
    const burst = u.bin.spawn_burst ?? [2, 5, 5, 10][ROLE_TO_IDX[u.role]];
    for (let k = 0; k < burst; k++) {
      const a = (k / burst) * Math.PI * 2;
      const r = 1.5 + (k % 3) * 0.4;
      placeRac(state, u, 0, -distance / 2 + Math.cos(a) * r, Math.sin(a) * r);
    }
    // Dummy enemy at +distance/2.
    const dRow = placeRac(state, dummy, 1, distance / 2, 0);
    state.rac.hp[dRow] = 1e9; // immortal dummy
    state.rac.hpMax[dRow] = 1e9;
    // Set targets for the spawned units.
    const dummyId = state.rac.id[dRow];
    for (let i = 0; i < state.rac.count; i++) {
      if (i === dRow) continue;
      state.rac.targetId[i] = dummyId;
      state.rac.targetKind[i] = TARGET_KIND_RAC;
    }
  };
}

/** scenario: kite — single archer, single enemy. */
function scenarioKite(archerId: string, enemyId: string, distance: number) {
  return (state: BattleState, content: ContentBundle) => {
    const a = getUnit(content, archerId);
    const e = getUnit(content, enemyId);
    placeRac(state, a, 0, 0, 0);
    const eRow = placeRac(state, e, 1, distance, 0);
    state.rac.hp[eRow] = 1e9;
    state.rac.hpMax[eRow] = 1e9;
    state.rac.targetId[0] = state.rac.id[eRow];
    state.rac.targetKind[0] = TARGET_KIND_RAC;
  };
}

/** scenario: surround — center unit surrounded by ring of enemies. */
function scenarioSurround(unitId: string, ringN: number, ringR: number) {
  return (state: BattleState, content: ContentBundle) => {
    const u = getUnit(content, unitId);
    const enemy = getUnit(content, "city-barbarian-tank-brick");
    const cRow = placeRac(state, u, 0, 0, 0);
    for (const [x, y] of ringPositions(ringN, ringR)) {
      placeRac(state, enemy, 1, x, y);
    }
    state.rac.targetId[cRow] = state.rac.id[1];
    state.rac.targetKind[cRow] = TARGET_KIND_RAC;
  };
}

/** scenario: archer-line-vs-tank — archers behind tanks, enemy approach.
 *  Tests that the hide-behind force keeps archers in the back row. */
function scenarioArcherLine(archerId: string, tankId: string) {
  return (state: BattleState, content: ContentBundle) => {
    const a = getUnit(content, archerId);
    const t = getUnit(content, tankId);
    const enemy = getUnit(content, "city-barbarian-tank-brick");
    // Tanks in front (closer to enemy)
    for (let i = 0; i < 3; i++) {
      placeRac(state, t, 0, -10, (i - 1) * 2);
    }
    // Archers behind
    for (let i = 0; i < 4; i++) {
      placeRac(state, a, 0, -16, (i - 1.5) * 1.5);
    }
    // Approaching enemy line at +distance
    for (let i = 0; i < 5; i++) {
      const eRow = placeRac(state, enemy, 1, 20, (i - 2) * 2.5);
      state.rac.hp[eRow] = 1e9;
      state.rac.hpMax[eRow] = 1e9;
    }
    // Targets: each side-0 unit targets nearest side-1 unit (id=2 of
    // each enemy works fine via target.ts's first tick).
  };
}

// ---------- CLI ----------

interface CLIArgs {
  scenario: string;
  positional: string[];
  flags: Record<string, string | number | boolean>;
}

function parseArgs(argv: string[]): CLIArgs {
  if (argv.length === 0) {
    throw new Error("usage: lab <scenario> [args] [--flag=value]");
  }
  const scenario = argv[0];
  const positional: string[] = [];
  const flags: Record<string, string | number | boolean> = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        const key = a.slice(2, eq);
        const val = a.slice(eq + 1);
        flags[key] = isNaN(Number(val)) ? val : Number(val);
      } else {
        // Support `--key value` form too. Peek at next arg; if it
        // doesn't start with --, consume it as the value.
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = isNaN(Number(next)) ? next : Number(next);
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { scenario, positional, flags };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const seed = (args.flags.seed as number) ?? 42;
  const ticks = (args.flags.ticks as number) ?? 60;
  const content = await loadContentFromFs({ repoRoot: REPO_ROOT });

  switch (args.scenario) {
    case "spawn": {
      const unit = args.positional[0];
      if (!unit) throw new Error("usage: lab spawn <unit-id>");
      await runScenario(
        {
          scenario: "spawn",
          args: { unit },
          seed,
          ticks,
          setupFn: scenarioSpawn(unit, seed),
        },
        content,
      );
      break;
    }
    case "march": {
      const unit = args.positional[0];
      const dist = Number(args.positional[1] ?? 40);
      if (!unit) throw new Error("usage: lab march <unit-id> [distance]");
      await runScenario(
        {
          scenario: "march",
          args: { unit, distance: dist },
          seed,
          ticks,
          setupFn: scenarioMarch(unit, dist),
        },
        content,
      );
      break;
    }
    case "kite": {
      const a = args.positional[0];
      const e = args.positional[1];
      const d = Number(args.positional[2] ?? 25);
      if (!a || !e) throw new Error("usage: lab kite <archer> <enemy> [distance]");
      await runScenario(
        {
          scenario: "kite",
          args: { archer: a, enemy: e, distance: d },
          seed,
          ticks,
          setupFn: scenarioKite(a, e, d),
        },
        content,
      );
      break;
    }
    case "surround": {
      const u = args.positional[0];
      const n = Number(args.positional[1] ?? 6);
      const r = Number(args.positional[2] ?? 4);
      if (!u) throw new Error("usage: lab surround <unit> [ring_n] [ring_r]");
      await runScenario(
        {
          scenario: "surround",
          args: { unit: u, ring_n: n, ring_r: r },
          seed,
          ticks,
          setupFn: scenarioSurround(u, n, r),
        },
        content,
      );
      break;
    }
    case "formation": {
      const unit = args.positional[0];
      const formationId = (args.positional[1] ?? null) as FormationId | null;
      const targetDistance = Number(args.flags.target ?? 0);
      if (!unit) throw new Error("usage: lab formation <unit-id> [formation-id] [--target=<m>]");
      await runScenario(
        {
          scenario: "formation",
          args: { unit, formation: formationId ?? "default", target: targetDistance },
          seed,
          ticks,
          setupFn: scenarioFormation(unit, formationId, targetDistance),
        },
        content,
      );
      break;
    }
    case "archer-line": {
      const a = args.positional[0];
      const t = args.positional[1];
      if (!a || !t) throw new Error("usage: lab archer-line <archer> <tank>");
      await runScenario(
        {
          scenario: "archer-line",
          args: { archer: a, tank: t },
          seed,
          ticks,
          setupFn: scenarioArcherLine(a, t),
        },
        content,
      );
      break;
    }
    default:
      process.stderr.write(`unknown scenario "${args.scenario}". Subcommands:\n`);
      process.stderr.write(`  spawn <unit>\n`);
      process.stderr.write(`  march <unit> [distance]\n`);
      process.stderr.write(`  kite <archer> <enemy> [distance]\n`);
      process.stderr.write(`  surround <unit> [ring_n] [ring_r]\n`);
      process.stderr.write(`  archer-line <archer> <tank>\n`);
      process.exit(2);
  }
}

main().catch((e) => {
  process.stderr.write(`[lab] failed: ${String(e?.stack ?? e)}\n`);
  process.exit(1);
});
