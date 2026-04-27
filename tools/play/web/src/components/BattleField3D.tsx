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
  /** Max simultaneous boids — must exceed the largest expected raccoon count. */
  maxBoids?: number;
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
  maxBoids = 120,
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

        // Boid pool — visual variety only. Each frame we map sim racs
        // to boid slots by index; the boid's archetype need not match
        // the sim rac's role/env/cur for v0.
        setStatus("spawning boids…");
        const f = new InstancedBoidsField(sc, { bounds: halfExtent });
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

        // Sim setup. Restart with a fresh seed when the battle ends.
        // Sim places bins along its X axis (sign × 0.30..0.40 × bounds.w);
        // we rotate -90° around Z when going to babylon so the wide
        // axis becomes depth (into-screen) rather than width:
        //   babylon.x =  sim.y                          (sides → screen left/right)
        //   babylon.y = -sim.x                          (player +X → bottom, enemy -X → top)
        // Velocities + facing rotate the same way (facing - π/2).
        const SIM_TO_BABYLON = halfExtent / (simBounds / 2);

        // Per-slot snapshots for sub-tick interpolation. Indexed by sim
        // rac slot (state.rac is SoA, slot i is stable across ticks for
        // a given rac, increases when new racs spawn). Sized to maxBoids
        // — extra slots are simply marked not-alive.
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

        let battleState: BattleState | null = null;
        let log: MemoryLogger | null = null;

        const snapshotInto = (xs: Float32Array, ys: Float32Array, fs: Float32Array, as: Uint8Array, vxs?: Float32Array, vys?: Float32Array) => {
          if (!battleState) return;
          const r = battleState.rac;
          const N = Math.min(r.count, maxBoids);
          for (let i = 0; i < N; i++) {
            // Coord remap: babylon = (sim.y, -sim.x). Facing rotates -π/2.
            xs[i] = r.y[i] * SIM_TO_BABYLON;
            ys[i] = -r.x[i] * SIM_TO_BABYLON;
            fs[i] = r.facing[i] - Math.PI / 2;
            as[i] = r.alive[i];
            if (vxs) vxs[i] = r.vy[i] * SIM_TO_BABYLON;
            if (vys) vys[i] = -r.vx[i] * SIM_TO_BABYLON;
          }
          for (let i = N; i < maxBoids; i++) as[i] = 0;
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
          // Initial snapshot — both prev and cur point at tick-0 state.
          prevAlive.fill(0);
          curAlive.fill(0);
          snapshotInto(curX, curY, curFacing, curAlive, curVx, curVy);
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
            snapshotInto(curX, curY, curFacing, curAlive, curVx, curVy);
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
          // sim tick we've already rendered past, in [0, 1).
          const alpha = Math.max(0, Math.min(1, simAccumulator / SIM_DT));
          const boids = field.boids;
          const M = boids.length;
          for (let i = 0; i < M; i++) {
            const b = boids[i];
            if (curAlive[i]) {
              const x = prevX[i] + (curX[i] - prevX[i]) * alpha;
              const y = prevY[i] + (curY[i] - prevY[i]) * alpha;
              b.pos.set(x, y, 0);
              b.vel.set(curVx[i], curVy[i], 0);
              b.heading = lerpAngle(prevFacing[i], curFacing[i], alpha);
            } else {
              b.pos.set(10000, 10000, -1000);
              b.vel.set(0, 0, 0);
            }
          }

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
  }, [compA, compB, halfExtent, maxBoids, rosterSeed, simBounds]);

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
