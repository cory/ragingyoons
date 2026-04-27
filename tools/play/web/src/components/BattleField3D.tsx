// 3D battle playback. Runs the canonical sim in-browser via @sim and
// drives the existing InstancedBoidsField from per-tick raccoon
// positions. Sim runs at 15 Hz; render loop interleaves ticks based on
// frame dt. When a battle ends, a fresh seed restarts.
//
// Coord convention: RH Z-up world. Sim places racs in roughly
// [-bounds.w/2, bounds.w/2] x [-bounds.h/2, bounds.h/2]; Babylon scene
// uses a smaller half-extent so the camera can frame both sides. Sim
// units are scaled to babylon meters via SIM_TO_BABYLON.
//
// Pre-req: tools/designer's server must be running on port 7321 to
// serve /api/cards.

import "@babylonjs/core/Engines/Extensions/engine.uniformBuffer";
import "@babylonjs/core/Materials/standardMaterial";
import "@babylonjs/core/Meshes/Builders/discBuilder";
import "@babylonjs/core/Meshes/Builders/linesBuilder";
import "@babylonjs/core/Meshes/Builders/planeBuilder";

import {
  ArcRotateCamera,
  Color3,
  Color4,
  HemisphericLight,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

import { useEffect, useRef, useState } from "react";

import { asRaccoon, defaultRaccoonSpec, specFromUnit } from "@ry/character/raccoon";
import { generateTeams } from "@ry/character/teams";
import { DEFAULT_FUR_LENGTH, DEFAULT_NOISE_FREQ } from "@ry/render/furShells";
import {
  resolveTimeout,
  setupBattle,
  tick,
  type BattleState,
  type ContentBundle,
} from "@sim/index.js";
import { MemoryLogger } from "@sim/log.js";
import type { InstancedBoid } from "@sim/instancedBoids";
import { InstancedBoidsField } from "@sim/instancedBoids";

import { loadContentFromApi } from "../sim-bridge";

interface Props {
  /** Sim bounds (width = height) — must match the comps' expected battlefield. */
  simBounds?: number;
  /** Babylon scene half-extent. Camera frames this; sim coords are scaled to fit. */
  halfExtent?: number;
  /** Initial comp ids (must exist in cards/comps/). */
  compA?: string;
  compB?: string;
  /** Boid pool roster (visual variety; no relation to which sim rac drives which boid). */
  rosterSeed?: string;
  /** Max simultaneous boids — must exceed the peak alive rac count.
   *  test-city-swarm hits ~280 alive on its swarm side, so the default
   *  must comfortably exceed that. */
  maxBoids?: number;
  /** Bump to force a full re-mount (engine + sim restart) without
   *  changing comps. Useful for "restart this matchup" buttons. */
  restartCounter?: number;
}

const SIM_DT = 1 / 15;
const TICK_BUDGET_PER_RENDER = 4; // cap so a long pause doesn't flood ticks

/** Shortest-arc angle lerp. `a` and `b` may be unwrapped; result wraps to (-π, π]. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function uuidv4(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  a[6] = (a[6] & 0x0f) | 0x40;
  a[8] = (a[8] & 0x3f) | 0x80;
  const h = [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function BattleField3D({
  simBounds = 100,
  // Sim spreads bins to ±0.4 × bounds along the wide axis (±40 of ±50)
  // and ±0.15 × bounds on the short axis. halfExtent=18 → babylon
  // x-spread of ±14.4, y-spread of ±5.4. Camera framing below handles
  // that aspect.
  halfExtent = 18,
  compA = "test-city-swarm",
  compB = "test-suburban-wall",
  rosterSeed = "rgyoons-replay",
  maxBoids = 400,
  restartCounter = 0,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("loading content…");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let engine: WebGPUEngine | null = null;
    let scene: Scene | null = null;
    let field: InstancedBoidsField | null = null;
    let onResize: (() => void) | null = null;
    let ro: ResizeObserver | null = null;

    (async () => {
      try {
        setStatus("loading content…");
        const content: ContentBundle = await loadContentFromApi();
        if (disposed) return;
        if (!content.comps.has(compA)) throw new Error(`comp not found: ${compA}`);
        if (!content.comps.has(compB)) throw new Error(`comp not found: ${compB}`);

        setStatus("starting WebGPU…");
        const supportsWebGPU = await WebGPUEngine.IsSupportedAsync;
        if (!supportsWebGPU) throw new Error("WebGPU not supported. Try Chrome or Edge.");
        const eng = new WebGPUEngine(canvas, { antialias: true, stencil: true });
        await eng.initAsync();
        if (disposed) {
          eng.dispose();
          return;
        }
        engine = eng;

        const sc = new Scene(engine);
        sc.useRightHandedSystem = true;
        sc.clearColor = new Color4(0.04, 0.035, 0.03, 1);
        sc.ambientColor = new Color3(0.18, 0.16, 0.14);
        scene = sc;

        // Tactical view: coord remap puts the wide axis into screen
        // depth. Camera looks from -Y (player side) toward +Y (enemy
        // side). Radius ~1.6 × halfExtent so the full ±halfExtent depth
        // sits in front of camera with room.
        const cam = new ArcRotateCamera(
          "cam",
          -Math.PI / 2,                   // camera south of origin (-Y)
          Math.PI / 2.6,                  // matches boid demo: ~21° above horizon
          halfExtent * 1.6,               // ~29m for halfExtent=18 — fits ±halfExtent depth
          new Vector3(0, 0, 0),
          sc,
        );
        cam.upVector = new Vector3(0, 0, 1);
        cam.lowerRadiusLimit = halfExtent * 0.6;
        cam.upperRadiusLimit = halfExtent * 4;
        cam.lowerBetaLimit = 0.15;
        cam.upperBetaLimit = Math.PI / 2.05;
        cam.attachControl(true);
        cam.wheelDeltaPercentage = 0.05;
        cam.panningSensibility = 0;

        const key = new HemisphericLight("key", new Vector3(0.3, 0.4, 1), sc);
        key.intensity = 0.95;
        key.diffuse = new Color3(1.0, 0.92, 0.78);
        key.groundColor = new Color3(0.18, 0.16, 0.14);

        const groundR = halfExtent * 1.4;
        const ground = MeshBuilder.CreateDisc("ground", { radius: groundR, tessellation: 96 }, sc);
        ground.position.z = -0.001;

        const z = 0.002;
        const center = MeshBuilder.CreateLines("center-line", {
          points: [new Vector3(-halfExtent, 0, z), new Vector3(halfExtent, 0, z)],
        }, sc);
        center.color = new Color3(0.55, 0.42, 0.16);
        center.alpha = 0.4;
        center.isPickable = false;

        const bounds = MeshBuilder.CreateLines("bounds", {
          points: [
            new Vector3(-halfExtent, -halfExtent, z),
            new Vector3(+halfExtent, -halfExtent, z),
            new Vector3(+halfExtent, +halfExtent, z),
            new Vector3(-halfExtent, +halfExtent, z),
            new Vector3(-halfExtent, -halfExtent, z),
          ],
        }, sc);
        bounds.color = new Color3(1.0, 0.42, 0.16);
        bounds.alpha = 0.35;
        bounds.isPickable = false;

        // Team marker discs — one mesh per side, thin-instanced per
        // alive rac. Player (compA, owner=0) = warm accent; enemy
        // (compB, owner=1) = cool blue. Lifted off the ground enough
        // to dodge z-fight; double-sided so face culling can't hide it.
        const teamDiscZ = 0.12;
        const teamDiscMatA = new StandardMaterial("teamDiscMatA", sc);
        teamDiscMatA.disableLighting = true;
        teamDiscMatA.emissiveColor = new Color3(1.0, 0.42, 0.16);
        teamDiscMatA.alpha = 0.4;
        const teamDiscMatB = new StandardMaterial("teamDiscMatB", sc);
        teamDiscMatB.disableLighting = true;
        teamDiscMatB.emissiveColor = new Color3(0.30, 0.55, 1.0);
        teamDiscMatB.alpha = 0.4;
        const DOUBLESIDE = 2; // Mesh.DOUBLESIDE; avoid the import dance
        const teamDiscA = MeshBuilder.CreateDisc("teamDiscA",
          { radius: 0.55, tessellation: 24, sideOrientation: DOUBLESIDE }, sc);
        teamDiscA.material = teamDiscMatA;
        teamDiscA.isPickable = false;
        teamDiscA.alwaysSelectAsActiveMesh = true; // master at origin; instances span field
        const teamDiscB = MeshBuilder.CreateDisc("teamDiscB",
          { radius: 0.55, tessellation: 24, sideOrientation: DOUBLESIDE }, sc);
        teamDiscB.material = teamDiscMatB;
        teamDiscB.isPickable = false;
        teamDiscB.alwaysSelectAsActiveMesh = true;
        const teamMatA = new Float32Array(maxBoids * 16);
        const teamMatB = new Float32Array(maxBoids * 16);
        // Identity rotation; per-frame we only update translation. Pre-fill
        // the rotation/scale terms so we touch only translation each frame.
        for (let i = 0; i < maxBoids; i++) {
          const off = i * 16;
          teamMatA[off + 0] = 1; teamMatA[off + 5] = 1; teamMatA[off + 10] = 1; teamMatA[off + 15] = 1;
          teamMatB[off + 0] = 1; teamMatB[off + 5] = 1; teamMatB[off + 10] = 1; teamMatB[off + 15] = 1;
        }
        // Register the buffers up-front (non-static) so the mesh starts
        // in thin-instance mode and we can just bump count + flag the
        // buffer dirty each frame.
        teamDiscA.thinInstanceSetBuffer("matrix", teamMatA, 16, false);
        teamDiscB.thinInstanceSetBuffer("matrix", teamMatB, 16, false);
        teamDiscA.thinInstanceCount = 0;
        teamDiscB.thinInstanceCount = 0;

        // ─── Spawn bins ────────────────────────────────────────────────
        // Box per bin: 0.9×0.9 cross-section × 1.6 tall. Thin-instanced
        // per side, packed into the front of each per-team buffer each
        // frame so dying bins drop out cleanly. Matrix is column-major,
        // pre-filled with Rx(π/2) so the box's local Y dimension (1.6)
        // becomes vertical in our z-up world; per frame we update only
        // the translation columns.
        const MAX_BINS_PER_SIDE = 8;
        const BIN_HALF_HEIGHT = 0.8;
        const binMatA = new StandardMaterial("binMatA", sc);
        binMatA.diffuseColor = new Color3(0.30, 0.18, 0.10);
        binMatA.specularColor = new Color3(0.20, 0.10, 0.05);
        binMatA.emissiveColor = new Color3(0.40, 0.18, 0.06);
        const binMatB = new StandardMaterial("binMatB", sc);
        binMatB.diffuseColor = new Color3(0.12, 0.18, 0.30);
        binMatB.specularColor = new Color3(0.08, 0.12, 0.20);
        binMatB.emissiveColor = new Color3(0.10, 0.20, 0.50);
        const binMeshA = MeshBuilder.CreateBox("binMeshA", { width: 0.9, height: 1.6, depth: 0.9 }, sc);
        binMeshA.material = binMatA;
        binMeshA.isPickable = false;
        binMeshA.alwaysSelectAsActiveMesh = true;
        const binMeshB = MeshBuilder.CreateBox("binMeshB", { width: 0.9, height: 1.6, depth: 0.9 }, sc);
        binMeshB.material = binMatB;
        binMeshB.isPickable = false;
        binMeshB.alwaysSelectAsActiveMesh = true;
        const binBufA = new Float32Array(MAX_BINS_PER_SIDE * 16);
        const binBufB = new Float32Array(MAX_BINS_PER_SIDE * 16);
        // Pre-fill Rx(π/2) rotation + identity translation for all slots.
        // Column-major: col0=(1,0,0,0), col1=(0,0,1,0), col2=(0,-1,0,0), col3=(0,0,0,1).
        for (let i = 0; i < MAX_BINS_PER_SIDE; i++) {
          const off = i * 16;
          for (const buf of [binBufA, binBufB]) {
            buf[off + 0] = 1;  buf[off + 1] = 0;  buf[off + 2] = 0;  buf[off + 3] = 0;
            buf[off + 4] = 0;  buf[off + 5] = 0;  buf[off + 6] = 1;  buf[off + 7] = 0;
            buf[off + 8] = 0;  buf[off + 9] = -1; buf[off + 10] = 0; buf[off + 11] = 0;
            buf[off + 12] = 0; buf[off + 13] = 0; buf[off + 14] = 0; buf[off + 15] = 1;
          }
        }
        binMeshA.thinInstanceSetBuffer("matrix", binBufA, 16, false);
        binMeshB.thinInstanceSetBuffer("matrix", binBufB, 16, false);
        binMeshA.thinInstanceCount = 0;
        binMeshB.thinInstanceCount = 0;

        // ─── Projectiles ──────────────────────────────────────────────
        // Small glowing spheres tracking state.atk positions. Per-side
        // colored. Identity rotation; per frame we just write translation.
        const MAX_ATKS_PER_SIDE = 256;
        const ATK_Z = 1.0; // chest-height
        const atkMatA = new StandardMaterial("atkMatA", sc);
        atkMatA.disableLighting = true;
        atkMatA.emissiveColor = new Color3(1.0, 0.75, 0.35);
        const atkMatB = new StandardMaterial("atkMatB", sc);
        atkMatB.disableLighting = true;
        atkMatB.emissiveColor = new Color3(0.45, 0.80, 1.0);
        const atkMeshA = MeshBuilder.CreateSphere("atkMeshA", { diameter: 0.30, segments: 6 }, sc);
        atkMeshA.material = atkMatA;
        atkMeshA.isPickable = false;
        atkMeshA.alwaysSelectAsActiveMesh = true;
        const atkMeshB = MeshBuilder.CreateSphere("atkMeshB", { diameter: 0.30, segments: 6 }, sc);
        atkMeshB.material = atkMatB;
        atkMeshB.isPickable = false;
        atkMeshB.alwaysSelectAsActiveMesh = true;
        const atkBufA = new Float32Array(MAX_ATKS_PER_SIDE * 16);
        const atkBufB = new Float32Array(MAX_ATKS_PER_SIDE * 16);
        // Pre-fill identity rotation/scale; per-frame writes only translation.
        for (let i = 0; i < MAX_ATKS_PER_SIDE; i++) {
          const off = i * 16;
          for (const buf of [atkBufA, atkBufB]) {
            buf[off + 0] = 1; buf[off + 5] = 1; buf[off + 10] = 1; buf[off + 15] = 1;
          }
        }
        atkMeshA.thinInstanceSetBuffer("matrix", atkBufA, 16, false);
        atkMeshB.thinInstanceSetBuffer("matrix", atkBufB, 16, false);
        atkMeshA.thinInstanceCount = 0;
        atkMeshB.thinInstanceCount = 0;

        // Boid pool — visual variety only. Each frame we map sim racs
        // to boid slots by index; the boid's archetype need not match
        // the sim rac's role/env/cur for v0.
        setStatus("spawning boids…");
        // renderScale 0.33 (= demo's 0.5 / 1.5) — TFT-style tactical
        // view wants smaller raccoons than the demo's character-focus
        // framing.
        const f = new InstancedBoidsField(sc, { bounds: halfExtent, renderScale: 0.33 });
        field = f;
        const roster = generateTeams(rosterSeed);
        const baseSpec = defaultRaccoonSpec();
        const pool = roster.units.map((u) => asRaccoon(u, specFromUnit(u, baseSpec)));
        f.setCount(maxBoids, pool);
        f.setFur(true, { furLength: DEFAULT_FUR_LENGTH, noiseFreq: DEFAULT_NOISE_FREQ });
        // Wider LOD window than the boid demo's 6/20 — the tactical
        // camera puts the far side of the field ~45m out (after coord
        // remap), but we still want fur on those units (lower shell
        // count). Far units beyond 50m drop fur entirely.
        f.setFurLodRange(8.0, 50.0);

        // CRITICAL: stepAnimate re-sorts field.boids by source-unit-id
        // every frame for batch rendering. If we map boids[i] = rac[i]
        // we'll write all sim positions into one source's slice and
        // park the rest — visible as "only one team's archetype on
        // screen." Snapshot the array now to keep a stable per-slot
        // mapping; the boid OBJECTS' .pos fields still drive rendering
        // regardless of array order.
        const boidBySlot: InstancedBoid[] = [...f.boids];

        // Sim setup. Restart with a fresh seed when the battle ends.
        // Sim places bins along its X axis (sign × 0.30..0.40 × bounds.w);
        // we rotate -90° around Z when going to babylon so the wide
        // axis becomes depth (into-screen) rather than width:
        //   babylon.x =  sim.y                          (sides → screen left/right)
        //   babylon.y = -sim.x                          (player +X → bottom, enemy -X → top)
        // Velocities + facing rotate the same way (facing - π/2).
        const SIM_TO_BABYLON = halfExtent / (simBounds / 2);

        // Per-slot snapshots for sub-tick interpolation. Indexed by
        // boid slot (NOT sim rac slot). The slot allocator below maps
        // sim rac.id → a stable boid slot via a free list, so slots
        // get reused as racs die and respawn.
        const prevX = new Float32Array(maxBoids);
        const prevY = new Float32Array(maxBoids);
        const prevFacing = new Float32Array(maxBoids);
        const prevAlive = new Uint8Array(maxBoids);
        const curX = new Float32Array(maxBoids);
        const curY = new Float32Array(maxBoids);
        const curFacing = new Float32Array(maxBoids);
        const curVx = new Float32Array(maxBoids);
        const curVy = new Float32Array(maxBoids);
        const curAlive = new Uint8Array(maxBoids);
        const curOwner = new Uint8Array(maxBoids); // 0 = compA (player), 1 = compB (enemy)

        let battleState: BattleState | null = null;
        let log: MemoryLogger | null = null;

        // sim rac.count is append-only (slots never reused), but alive
        // racs are sparse within that array. Map sim rac.id → boid slot
        // via a free-list allocator: when a rac dies, its slot is
        // released; new racs claim a slot from the free list.
        const slotByRacId = new Map<number, number>();
        const freeSlots: number[] = [];
        for (let i = maxBoids - 1; i >= 0; i--) freeSlots.push(i);

        const snapshotCurrent = () => {
          if (!battleState) return;
          const r = battleState.rac;
          // 1. Release slots for racs that died since last snapshot.
          for (const [racId, slot] of slotByRacId) {
            const row = battleState.racRowById.get(racId);
            if (row === undefined || !r.alive[row]) {
              slotByRacId.delete(racId);
              freeSlots.push(slot);
              curAlive[slot] = 0;
            }
          }
          // 2. Assign slots to alive racs and snapshot state.
          //    Coord remap: babylon = (sim.y, -sim.x), facing - π/2.
          for (let i = 0; i < r.count; i++) {
            if (!r.alive[i]) continue;
            const racId = r.id[i];
            const xb = r.y[i] * SIM_TO_BABYLON;
            const yb = -r.x[i] * SIM_TO_BABYLON;
            const fb = r.facing[i] - Math.PI / 2;
            let slot = slotByRacId.get(racId);
            if (slot === undefined) {
              const free = freeSlots.pop();
              if (free === undefined) continue; // pool exhausted
              slot = free;
              slotByRacId.set(racId, slot);
              // Newly assigned slot — initialize prev = cur so the
              // sub-tick lerp is a no-op for the first frame, even if
              // the slot was just released by a different rac in the
              // same tick (otherwise we'd streak from the dead rac's
              // last position to the new rac's spawn position).
              prevX[slot] = xb;
              prevY[slot] = yb;
              prevFacing[slot] = fb;
              prevAlive[slot] = 0;
            }
            curX[slot] = xb;
            curY[slot] = yb;
            curFacing[slot] = fb;
            curVx[slot] = r.vy[i] * SIM_TO_BABYLON;
            curVy[slot] = -r.vx[i] * SIM_TO_BABYLON;
            curAlive[slot] = 1;
            curOwner[slot] = r.owner[i];
          }
        };

        const startBattle = () => {
          const seed = Math.floor(Math.random() * 1e9);
          const battleId = uuidv4();
          log = new MemoryLogger({
            battle_id: battleId,
            seed,
            service_version: "tools/play",
            content_version: content.version,
          });
          battleState = setupBattle(content, {
            seed,
            battleId,
            compA,
            compB,
            bounds: { w: simBounds, h: simBounds },
            verbosity: "events",
          });
          log.setTickReader(() => battleState!.tick);
          log.drain();
          // Reset slot allocator and snapshot tick-0 into both prev and cur.
          slotByRacId.clear();
          freeSlots.length = 0;
          for (let i = maxBoids - 1; i >= 0; i--) freeSlots.push(i);
          prevAlive.fill(0);
          curAlive.fill(0);
          snapshotCurrent();
          prevX.set(curX);
          prevY.set(curY);
          prevFacing.set(curFacing);
          prevAlive.set(curAlive);
        };
        startBattle();
        setStatus("battle running");

        let simAccumulator = 0;
        eng.runRenderLoop(() => {
          if (disposed || !engine || !scene || !field || !battleState || !log) return;
          const dt = engine.getDeltaTime() / 1000;

          // Advance sim. Cap ticks per render to avoid catch-up storms.
          simAccumulator += dt;
          let ticksThisFrame = 0;
          while (simAccumulator >= SIM_DT && ticksThisFrame < TICK_BUDGET_PER_RENDER) {
            simAccumulator -= SIM_DT;
            ticksThisFrame++;
            // Promote current → previous before stepping the sim, then
            // capture the new tick into current. Sub-tick render frames
            // interpolate between the two.
            prevX.set(curX);
            prevY.set(curY);
            prevFacing.set(curFacing);
            prevAlive.set(curAlive);
            tick(battleState, content, log);
            log.drain();
            snapshotCurrent();
            // Newly-alive slots (just spawned this tick) have no prior
            // position — copy current into prev so the lerp is a no-op
            // and they don't streak from origin.
            for (let i = 0; i < maxBoids; i++) {
              if (!prevAlive[i] && curAlive[i]) {
                prevX[i] = curX[i];
                prevY[i] = curY[i];
                prevFacing[i] = curFacing[i];
              }
            }
            if (battleState.winner !== -1 || battleState.endReason !== null) {
              if (battleState.winner === -1 && battleState.endReason === null) {
                resolveTimeout(battleState);
              }
              startBattle();
              break;
            }
          }
          if (simAccumulator > SIM_DT) simAccumulator = SIM_DT; // prevent runaway when paused

          // Sub-tick interpolation — alpha is the fraction of the next
          // sim tick we've already rendered past, in [0, 1). Iterate
          // boidBySlot (stable order), NOT field.boids (sort-shuffled).
          // Same loop also packs per-team disc matrices for the team
          // markers — done in one pass to share the alive-slot scan.
          const alpha = Math.max(0, Math.min(1, simAccumulator / SIM_DT));
          const M = boidBySlot.length;
          let aCount = 0;
          let bCount = 0;
          for (let i = 0; i < M; i++) {
            const b = boidBySlot[i];
            if (curAlive[i]) {
              const x = prevX[i] + (curX[i] - prevX[i]) * alpha;
              const y = prevY[i] + (curY[i] - prevY[i]) * alpha;
              b.pos.set(x, y, 0);
              b.vel.set(curVx[i], curVy[i], 0);
              b.heading = lerpAngle(prevFacing[i], curFacing[i], alpha);
              // Team marker translation. Disc mesh is built in the XY
              // plane; rotation/scale terms in the matrix were pre-set
              // to identity, so only the translation row updates.
              const mat = curOwner[i] === 0 ? teamMatA : teamMatB;
              const off = (curOwner[i] === 0 ? aCount++ : bCount++) * 16;
              mat[off + 12] = x;
              mat[off + 13] = y;
              mat[off + 14] = teamDiscZ;
            } else {
              b.pos.set(10000, 10000, -1000);
              b.vel.set(0, 0, 0);
            }
          }
          teamDiscA.thinInstanceCount = aCount;
          teamDiscB.thinInstanceCount = bCount;
          teamDiscA.thinInstanceBufferUpdated("matrix");
          teamDiscB.thinInstanceBufferUpdated("matrix");

          // Pack alive spawn bins into per-team buffers. Coord remap
          // matches the rac one (babylon = (sim.y, -sim.x)).
          const bn = battleState.bin;
          let aBins = 0, bBins = 0;
          for (let i = 0; i < bn.count; i++) {
            if (!bn.alive[i]) continue;
            const owner = bn.owner[i];
            if (owner === 0 ? aBins >= MAX_BINS_PER_SIDE : bBins >= MAX_BINS_PER_SIDE) continue;
            const buf = owner === 0 ? binBufA : binBufB;
            const off = (owner === 0 ? aBins++ : bBins++) * 16;
            buf[off + 12] = bn.y[i] * SIM_TO_BABYLON;
            buf[off + 13] = -bn.x[i] * SIM_TO_BABYLON;
            buf[off + 14] = BIN_HALF_HEIGHT;
          }
          binMeshA.thinInstanceCount = aBins;
          binMeshB.thinInstanceCount = bBins;
          binMeshA.thinInstanceBufferUpdated("matrix");
          binMeshB.thinInstanceBufferUpdated("matrix");

          // Pack alive in-flight projectiles per team. Same coord remap
          // as bins/racs (babylon = (sim.y, -sim.x)).
          const ak = battleState.atk;
          let aAtks = 0, bAtks = 0;
          for (let i = 0; i < ak.count; i++) {
            if (!ak.alive[i]) continue;
            const owner = ak.sourceOwner[i];
            if (owner === 0 ? aAtks >= MAX_ATKS_PER_SIDE : bAtks >= MAX_ATKS_PER_SIDE) continue;
            const buf = owner === 0 ? atkBufA : atkBufB;
            const off = (owner === 0 ? aAtks++ : bAtks++) * 16;
            buf[off + 12] = ak.y[i] * SIM_TO_BABYLON;
            buf[off + 13] = -ak.x[i] * SIM_TO_BABYLON;
            buf[off + 14] = ATK_Z;
          }
          atkMeshA.thinInstanceCount = aAtks;
          atkMeshB.thinInstanceCount = bAtks;
          atkMeshA.thinInstanceBufferUpdated("matrix");
          atkMeshB.thinInstanceBufferUpdated("matrix");

          field.stepAnimate(dt);
          scene.render();
        });

        onResize = () => engine?.resize();
        window.addEventListener("resize", onResize);
        // Engine reads canvas dims at init; if the layout shifted after
        // (sidebar mount, etc.), the framebuffer can stay sized for an
        // earlier, smaller viewport — manifests as "only see one side"
        // because the X-axis spread overflows the stale framebuffer.
        ro = new ResizeObserver(() => engine?.resize());
        ro.observe(canvas);
        // One forced resize on next frame to catch first-paint sizing.
        requestAnimationFrame(() => engine?.resize());

        // Diagnostic: log bin layout per side and canvas dims so we can
        // see whether "only one side" is a framing issue or a sim issue.
        if (battleState && (battleState as BattleState).bin.count > 0) {
          const bs = battleState as BattleState;
          const bySide: Record<number, { n: number; xs: number[]; ys: number[] }> = {
            0: { n: 0, xs: [], ys: [] },
            1: { n: 0, xs: [], ys: [] },
          };
          for (let i = 0; i < bs.bin.count; i++) {
            const o = bs.bin.owner[i];
            const slot = bySide[o];
            if (slot) {
              slot.n++;
              slot.xs.push(bs.bin.x[i]);
              slot.ys.push(bs.bin.y[i]);
            }
          }
          const fmt = (s: { n: number; xs: number[]; ys: number[] }) =>
            `${s.n} bins · x=[${s.xs.map((x) => x.toFixed(0)).join(",")}] y=[${s.ys.map((y) => y.toFixed(0)).join(",")}]`;
          const rect = canvas.getBoundingClientRect();
          console.log(
            `[BattleField3D] canvas CSS=${rect.width.toFixed(0)}×${rect.height.toFixed(0)}px`
            + ` element=${canvas.width}×${canvas.height}px`
            + ` engine=${eng.getRenderWidth()}×${eng.getRenderHeight()}px`
            + ` aspect=${(rect.width / rect.height).toFixed(2)} ·`
            + ` halfExtent=${halfExtent} scale=${SIM_TO_BABYLON.toFixed(3)} · cam r=${cam.radius.toFixed(1)}`,
          );
          console.log(`[BattleField3D] side 0 (compA="${compA}"): ${fmt(bySide[0])} → after remap, babylon y=${(-bySide[0].xs[0] * SIM_TO_BABYLON).toFixed(1)} (player at bottom)`);
          console.log(`[BattleField3D] side 1 (compB="${compB}"): ${fmt(bySide[1])} → after remap, babylon y=${(-bySide[1].xs[0] * SIM_TO_BABYLON).toFixed(1)} (enemy at top)`);
          console.log(`[BattleField3D] boid pool: ${boidBySlot.length} boids, sources=${new Set(boidBySlot.map((b) => b.source.unit.id)).size}`);
        }

        // Periodic diagnostic so we can see whether both sides spawn racs.
        let _diagCounter = 0;
        const diagInterval = setInterval(() => {
          if (disposed || !battleState) return;
          _diagCounter++;
          const r = battleState.rac;
          let aliveA = 0, aliveB = 0;
          const aPos: string[] = [];
          const bPos: string[] = [];
          for (let i = 0; i < r.count; i++) {
            if (!r.alive[i]) continue;
            if (r.owner[i] === 0) {
              aliveA++;
              if (aPos.length < 3) aPos.push(`(${r.x[i].toFixed(0)},${r.y[i].toFixed(0)})`);
            } else {
              aliveB++;
              if (bPos.length < 3) bPos.push(`(${r.x[i].toFixed(0)},${r.y[i].toFixed(0)})`);
            }
          }
          console.log(
            `[BattleField3D diag #${_diagCounter}] tick=${battleState.tick} rac.count=${r.count}`
            + ` alive A=${aliveA} ${aPos.join(",")}  B=${aliveB} ${bPos.join(",")}`,
          );
        }, 2000);
        // Cleanup the interval on dispose
        const _origRoDisconnect = ro?.disconnect.bind(ro);
        if (ro && _origRoDisconnect) {
          ro.disconnect = () => { clearInterval(diagInterval); _origRoDisconnect(); };
        }
      } catch (err) {
        console.error("[BattleField3D] init failed", err);
        if (!disposed) setError(String((err as Error)?.message ?? err));
      }
    })();

    return () => {
      disposed = true;
      if (onResize) window.removeEventListener("resize", onResize);
      try { ro?.disconnect(); } catch (e) { console.warn("disconnect ro", e); }
      try { field?.dispose(); } catch (e) { console.warn("dispose field", e); }
      try { scene?.dispose(); } catch (e) { console.warn("dispose scene", e); }
      try { engine?.dispose(); } catch (e) { console.warn("dispose engine", e); }
    };
  }, [compA, compB, halfExtent, maxBoids, rosterSeed, simBounds, restartCounter]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "100%", display: "block", outline: "none" }}
      />
      {error ? (
        <div style={{
          position: "absolute", inset: 0, display: "flex",
          alignItems: "center", justifyContent: "center",
          padding: 24, color: "var(--blood)", textAlign: "center",
          fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.5,
          background: "rgba(10,9,8,0.7)",
        }}>
          {error}
          <br />
          <span style={{ color: "var(--ink-3)" }}>
            (designer server on :7321 must be running for /api/cards)
          </span>
        </div>
      ) : (
        <div style={{
          position: "absolute", left: 12, bottom: 12,
          fontFamily: "var(--font-mono)", fontSize: 10,
          letterSpacing: "0.1em", color: "var(--ink-3)",
          textTransform: "uppercase",
          pointerEvents: "none",
        }}>
          {status}
        </div>
      )}
    </div>
  );
}
