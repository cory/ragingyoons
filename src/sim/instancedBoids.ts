/**
 * Instanced boids field using Babylon's BakedVertexAnimationManager (VAT)
 * + ThinInstances. Each unique unit gets:
 *   - one source Mesh (built via buildCharacter)
 *   - one VAT texture (32 frames × 4 gaits, baked by procedurally driving
 *     the skeleton through one cycle per gait at neutral mood)
 *   - a BakedVertexAnimationManager wired to that texture
 *   - thin-instance buffers: "matrix" (per-instance world matrix) and
 *     "bakedVertexAnimationSettingsInstanced" (per-instance vec4
 *     [fromFrame, toFrame, timeOffset, fps]).
 *
 * Per frame: write matrix + anim params for each boid, advance the
 * manager's global time. One draw call per source unit (~8 total)
 * regardless of boid count, with each instance running its own anim
 * phase via the timeOffset attribute.
 */
import {
  BakedVertexAnimationManager,
  Color3,
  Constants,
  Matrix,
  Mesh,
  RawTexture,
  type Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
  Vector4,
  VertexData,
} from "@babylonjs/core";
import { type CharacterMesh } from "../character/mesh";
import {
  buildRaccoonDecomposed,
  type DecomposedRaccoon,
} from "../character/raccoonMesh";
import type { Unit } from "../character/generator";
import type { LookMix } from "../character/raccoon";
import {
  type DriverState,
  makeDriverState,
  updateDriver,
} from "../walker/driver";
import { type LookState, makeLookState, stepLook } from "../walker/look";
import { GAITS } from "../walker/gait";
import {
  type Mood,
  phaseRate0,
  presetMood,
  strideAmp0,
} from "../walker/mood";
import { createRig, NUM_BONES, type RigLayout } from "../rig/skeleton";
import { UNIT_SCALE } from "../scale";
import {
  type BoidTraits,
  FACTION_IDS,
  FACTION_REL_MATRIX,
  FACTION_STRIDE,
  traitsFor,
} from "./rules";

const CHASED_SPEED_BONUS = 1.4;
const FRIENDS_THRESHOLD = 2;
const MOOD_LERP = 0.06;
/** Frames a contender context must persist before it commits. Prevents
 *  boids from flickering animation when neighbor proximity oscillates
 *  on a context boundary. ~500 ms at 60 fps. */
const CONTEXT_HYSTERESIS = 30;
/** Hard cap on neighbors processed per boid in the fine-grid (separation,
 *  is-chased, friend-count) loop. Only kicks in inside dense clusters —
 *  prevents O(k²) blow-up when a cell list packs full. */
const MAX_FINE_NEIGHBORS = 32;
/** Per-pair cap on the separation impulse MAGNITUDE (m/s² scale, before
 *  sepWeight). Capping the magnitude — not the per-component factor —
 *  keeps super-close pairs at maximum force instead of having impulse
 *  decay back to zero as dist→0 (which is what happens if you cap the
 *  factor and then multiply by ox/oy whose own magnitudes shrink). */
const MAX_SEP_PAIR_FORCE = 40;

/** Coarse grid cell size — used for align/cohere aggregates and per-faction
 *  chase aggregates. Larger cells = cheaper aggregate sampling. */
const COARSE_CELL = 6;
/** Fine grid cell size — used for per-pair separation, is-chased, and
 *  no-overlap. Tighter cells = far fewer wasted distance checks. */
const FINE_CELL = 2;
/** Per-instance world-space scale applied to each rendered boid. Keeps
 *  the totem characters visually compact in the flock view. */
const BOID_RENDER_SCALE = 0.5;

const GAIT_LIST = ["walk", "run", "shuffle"] as const;
type GaitName = (typeof GAIT_LIST)[number];
const FRAMES_PER_GAIT = 32;

type PRESETS_LOOKUP =
  | "neutral"
  | "happy"
  | "sad"
  | "anxious"
  | "angry"
  | "weary"
  | "drunk";
const MOOD_LIST: PRESETS_LOOKUP[] = [
  "neutral", "happy", "sad", "anxious", "angry", "weary", "drunk",
];
const NUM_MOODS = MOOD_LIST.length;

interface GaitRange {
  from: number;
  to: number;
  /** Frames-per-second the boid plays this gait at neutral world speed. */
  baseFps: number;
}

type GaitMoodRanges = Record<GaitName, Record<PRESETS_LOOKUP, GaitRange>>;

function defaultGaitSpeed(gaitName: keyof typeof GAITS): number {
  const gait = GAITS[gaitName];
  const phaseRate = phaseRate0 * gait.cadence;
  const strideAmp = strideAmp0 * gait.stride;
  return ((strideAmp * phaseRate) / (Math.PI * gait.stanceFrac)) * UNIT_SCALE;
}

function lerpMood(m: Mood, target: Mood, k: number): void {
  m.energy    += (target.energy    - m.energy)    * k;
  m.posture   += (target.posture   - m.posture)   * k;
  m.composure += (target.composure - m.composure) * k;
  m.stance    += (target.stance    - m.stance)    * k;
}

interface BakedAnim {
  /** RGBA32F vertex animation texture, same layout as before. */
  tex: RawTexture;
  /** Head bone's body-local translation per frame (3 floats per frame:
   *  x, y, z). Indexed as `frameIdx*3 + axis`. Used to make the rigid
   *  head mesh follow the body's animated head bone (bob + sway). */
  headTranslations: Float32Array;
}

/**
 * Bake every (gait, mood) pair into a vertex-animation texture by
 * procedurally driving a temporary skeleton at evenly-spaced phase samples.
 * Frame layout: gait g, mood m, frame f → row = (g·MOODS + m)·FRAMES + f.
 * Texture: width = bones × 4 RGBA texels, height = total frames, RGBA32F.
 *
 * Also records the head bone's body-local position per frame so callers
 * can move a separate (rigid) head mesh in lock-step with the body
 * without re-running the driver.
 */
function bakeGaitVAT(
  scene: Scene,
  layout: RigLayout,
  footLateral: number,
): BakedAnim {
  const totalFrames = FRAMES_PER_GAIT * GAIT_LIST.length * NUM_MOODS;
  const W = NUM_BONES * 4;
  const H = totalFrames;
  const buf = new Float32Array(W * H * 4);
  const headTranslations = new Float32Array(totalFrames * 3);

  const tmpRig = createRig(scene, layout, footLateral);
  const stubRoot = new TransformNode("vatStub", scene);
  const dummyCh: CharacterMesh = {
    root: stubRoot as unknown as CharacterMesh["root"],
    rig: tmpRig,
    unit: null as unknown as Unit,
    height: layout.height,
    footLateral,
  };
  const ds = makeDriverState("walk", presetMood("neutral"));

  // World-rest position of each bone is just translation (no rotation
  // in the rest pose). invBind is its negation — multiplied by the
  // bone's animated absolute matrix to get the deformation matrix
  // baked into the VAT.
  const shoulderZAbs = layout.zHigh + layout.shoulderZRel;
  const handZAbs = shoulderZAbs + layout.armTipZ;
  const invBind: Matrix[] = [
    Matrix.Translation(0, 0, -layout.zHip),                                  // hip
    Matrix.Translation(0, 0, -layout.zLow),                                   // spineLow
    Matrix.Translation(0, 0, -layout.zHigh),                                  // spineHigh
    Matrix.Translation(0, 0, -layout.zHead),                                  // head
    Matrix.Translation(0, -footLateral, 0),                                   // footL
    Matrix.Translation(0, +footLateral, 0),                                   // footR
    Matrix.Translation(0, -layout.shoulderY, -shoulderZAbs),                  // armL
    Matrix.Translation(0, +layout.shoulderY, -shoulderZAbs),                  // armR
    Matrix.Translation(-layout.armTipX, -(layout.shoulderY + layout.armTipY), -handZAbs), // handL
    Matrix.Translation(-layout.armTipX, +(layout.shoulderY + layout.armTipY), -handZAbs), // handR
  ];
  const tmpMat = new Matrix();

  for (let g = 0; g < GAIT_LIST.length; g++) {
    ds.gaitName = GAIT_LIST[g];
    for (let m = 0; m < NUM_MOODS; m++) {
      // Snap mood; bake reflects the steady-state expression for this gait.
      ds.mood = presetMood(MOOD_LIST[m]);
      // Reset slow-time wobble per (gait, mood) so noise doesn't carry across.
      ds.slowTime = 0;
      ds.prevLiftedR = false;
      ds.prevLiftedL = false;
      for (let f = 0; f < FRAMES_PER_GAIT; f++) {
        // Set phase directly. dt=0 prevents driver from advancing it.
        ds.phase = (f / FRAMES_PER_GAIT) * Math.PI * 2;
        updateDriver(dummyCh, ds, 0, { skipWorldPlacement: true });

        const bones = tmpRig.skeleton.bones;
        const frameIdx = (g * NUM_MOODS + m) * FRAMES_PER_GAIT + f;
        for (let b = 0; b < NUM_BONES; b++) {
          const worldM = bones[b].getAbsoluteMatrix();
          invBind[b].multiplyToRef(worldM, tmpMat);
          const base = (frameIdx * W + b * 4) * 4;
          const mm = tmpMat.m;
          for (let i = 0; i < 16; i++) buf[base + i] = mm[i];
        }
        // Head bone's body-local translation = its absolute matrix's
        // translation column (skeleton root sits at body-local origin).
        const headT = bones[3].getAbsoluteMatrix().getTranslation();
        const tOff = frameIdx * 3;
        headTranslations[tOff + 0] = headT.x;
        headTranslations[tOff + 1] = headT.y;
        headTranslations[tOff + 2] = headT.z;
      }
    }
  }

  tmpRig.skeleton.dispose();
  stubRoot.dispose();

  const tex = new RawTexture(
    buf, W, H,
    Constants.TEXTUREFORMAT_RGBA,
    scene,
    false, false,
    Texture.NEAREST_SAMPLINGMODE,
    Constants.TEXTURETYPE_FLOAT,
  );
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  tex.name = "vatBake";
  return { tex, headTranslations };
}

class BoidSource {
  unit: Unit;
  decomp: DecomposedRaccoon;
  capacity: number;
  count = 0;
  freeSlots: number[] = [];
  /** Body+legs matrix per instance — drives the VAT-skinned mesh. */
  bodyMatrixBuffer: Float32Array;
  /** Head matrix per instance — drives the rigid head mesh. */
  headMatrixBuffer: Float32Array;
  animBuffer: Float32Array;
  manager: BakedVertexAnimationManager;
  gaitMoodRanges: GaitMoodRanges;
  /** Body-local Z (in world units) of the head bone's rest position. */
  headOffsetZ: number;
  /** Per-(gait,mood,frame) head bone translation in body-local frame.
   *  Sampled per boid each frame so the rigid head mesh tracks the
   *  body's animated head bone (bob + spine sway) instead of sitting
   *  static at the rest position. 3 floats per frame: x, y, z. */
  headTranslations: Float32Array;

  constructor(unit: Unit, scene: Scene, capacity: number) {
    this.unit = unit;
    this.capacity = capacity;
    // Body+legs as a skinned VAT-bakeable mesh; head as a rigid mesh
    // whose per-instance matrix is computed each frame on the CPU. Lets
    // each boid yaw its head independently of the baked body animation.
    const decomp = buildRaccoonDecomposed(unit, scene);
    this.decomp = decomp;
    this.headOffsetZ = decomp.headOffsetZ;

    // Bake one VAT for this unit's body; its skeleton's rest layout
    // determines the inverse bind matrices used during the bake. The
    // head bone is still in the skeleton — but no body verts skin to it,
    // so its baked transform has no visible effect on the body mesh.
    const baked = bakeGaitVAT(scene, decomp.rig.layout, decomp.footLateral);
    const tex = baked.tex;
    this.headTranslations = baked.headTranslations;

    const manager = new BakedVertexAnimationManager(scene);
    manager.texture = tex;
    manager.animationParameters = new Vector4(0, FRAMES_PER_GAIT - 1, 0, 30);
    decomp.body.bakedVertexAnimationManager = manager;
    this.manager = manager;

    // Pre-compute (gait, mood) frame ranges and neutral-world-speed fps.
    const ranges = {} as GaitMoodRanges;
    for (let g = 0; g < GAIT_LIST.length; g++) {
      const gName = GAIT_LIST[g];
      const gait = GAITS[gName];
      const phaseRate = phaseRate0 * gait.cadence;
      const cycleTime = (2 * Math.PI) / phaseRate;
      const baseFps = FRAMES_PER_GAIT / cycleTime;
      const perMood = {} as Record<PRESETS_LOOKUP, GaitRange>;
      for (let m = 0; m < NUM_MOODS; m++) {
        const start = (g * NUM_MOODS + m) * FRAMES_PER_GAIT;
        perMood[MOOD_LIST[m]] = {
          from: start,
          to: start + FRAMES_PER_GAIT - 1,
          baseFps,
        };
      }
      ranges[gName] = perMood;
    }
    this.gaitMoodRanges = ranges;

    // ThinInstance buffers — one for the VAT body (matrix + anim params),
    // one for the rigid head (matrix only).
    this.bodyMatrixBuffer = new Float32Array(capacity * 16);
    this.headMatrixBuffer = new Float32Array(capacity * 16);
    for (let i = 0; i < capacity; i++) {
      const o = i * 16;
      this.bodyMatrixBuffer[o + 0] = 1;
      this.bodyMatrixBuffer[o + 5] = 1;
      this.bodyMatrixBuffer[o + 10] = 1;
      this.bodyMatrixBuffer[o + 15] = 1;
      this.headMatrixBuffer[o + 0] = 1;
      this.headMatrixBuffer[o + 5] = 1;
      this.headMatrixBuffer[o + 10] = 1;
      this.headMatrixBuffer[o + 15] = 1;
    }
    this.animBuffer = new Float32Array(capacity * 4);

    decomp.body.thinInstanceSetBuffer("matrix", this.bodyMatrixBuffer, 16, false);
    decomp.body.thinInstanceSetBuffer(
      "bakedVertexAnimationSettingsInstanced",
      this.animBuffer,
      4,
      false,
    );
    decomp.body.thinInstanceCount = 0;
    decomp.body.alwaysSelectAsActiveMesh = true;
    decomp.body.doNotSyncBoundingInfo = true;

    decomp.head.thinInstanceSetBuffer("matrix", this.headMatrixBuffer, 16, false);
    decomp.head.thinInstanceCount = 0;
    decomp.head.alwaysSelectAsActiveMesh = true;
    decomp.head.doNotSyncBoundingInfo = true;
  }

  allocSlot(): number {
    if (this.freeSlots.length > 0) return this.freeSlots.pop() as number;
    if (this.count >= this.capacity) return -1;
    return this.count++;
  }

  freeSlot(slot: number): void {
    this.freeSlots.push(slot);
  }

  flush(dt: number): void {
    this.decomp.body.thinInstanceCount = this.count;
    this.decomp.body.thinInstanceBufferUpdated("matrix");
    this.decomp.body.thinInstanceBufferUpdated(
      "bakedVertexAnimationSettingsInstanced",
    );
    this.decomp.head.thinInstanceCount = this.count;
    this.decomp.head.thinInstanceBufferUpdated("matrix");
    this.manager.time += dt;
  }

  dispose(): void {
    this.manager.texture?.dispose();
    this.decomp.body.dispose(false, true);
    this.decomp.head.dispose(false, true);
    this.decomp.rig.skeleton.dispose();
  }
}

/**
 * Debug overlay: thin ring per boid sized to its separateRadius (the
 * personal-space radius used by the symmetric per-pair separation rule).
 * Lets us eyeball whether two near-overlapping boids are inside each
 * other's space. One ring mesh, thin-instanced.
 */
class RadiiOverlay {
  private mesh: Mesh;
  private buffer: Float32Array;
  private capacity = 0;
  visible = false;

  constructor(scene: Scene) {
    this.mesh = RadiiOverlay.buildRingMesh(scene);
    const mat = new StandardMaterial("radii-mat", scene);
    mat.emissiveColor = new Color3(0.85, 0.2, 0.2);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    this.mesh.material = mat;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.doNotSyncBoundingInfo = true;
    this.mesh.setEnabled(false);
    // Prime the mesh into thin-instance mode immediately so the base mesh
    // never renders as a stray unit at the origin.
    this.buffer = new Float32Array(64 * 16);
    this.capacity = 64;
    this.mesh.thinInstanceSetBuffer("matrix", this.buffer, 16, false);
    this.mesh.thinInstanceCount = 0;
  }

  private static buildRingMesh(scene: Scene): Mesh {
    const segments = 48;
    const innerR = 0.96;
    const outerR = 1.0;
    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      positions.push(cs * innerR, sn * innerR, 0.02);
      positions.push(cs * outerR, sn * outerR, 0.02);
      normals.push(0, 0, 1, 0, 0, 1);
    }
    for (let i = 0; i < segments; i++) {
      const i0 = i * 2;
      const i1 = i * 2 + 1;
      const j0 = ((i + 1) % segments) * 2;
      const j1 = j0 + 1;
      indices.push(i0, j0, i1);
      indices.push(j0, j1, i1);
    }
    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;
    const mesh = new Mesh("radii-ring", scene);
    vd.applyToMesh(mesh);
    return mesh;
  }

  private ensureCapacity(n: number): void {
    if (n <= this.capacity) return;
    let cap = Math.max(this.capacity, 64);
    while (cap < n) cap *= 2;
    this.buffer = new Float32Array(cap * 16);
    this.capacity = cap;
    this.mesh.thinInstanceSetBuffer("matrix", this.buffer, 16, false);
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.mesh.setEnabled(on);
  }

  update(boids: InstancedBoid[]): void {
    if (!this.visible) return;
    this.ensureCapacity(boids.length);
    const buf = this.buffer;
    for (let i = 0; i < boids.length; i++) {
      const b = boids[i];
      const r = b.separateR;
      const o = i * 16;
      buf[o + 0] = r;  buf[o + 1] = 0;  buf[o + 2] = 0;  buf[o + 3] = 0;
      buf[o + 4] = 0;  buf[o + 5] = r;  buf[o + 6] = 0;  buf[o + 7] = 0;
      buf[o + 8] = 0;  buf[o + 9] = 0;  buf[o + 10] = 1; buf[o + 11] = 0;
      buf[o + 12] = b.pos.x; buf[o + 13] = b.pos.y; buf[o + 14] = 0; buf[o + 15] = 1;
    }
    this.mesh.thinInstanceCount = boids.length;
    this.mesh.thinInstanceBufferUpdated("matrix");
  }

  clear(): void {
    this.mesh.thinInstanceCount = 0;
  }

  dispose(): void {
    this.mesh.material?.dispose();
    this.mesh.dispose();
  }
}

/**
 * Highlight ring for the currently-selected boid. Single thin-instance,
 * green, slightly elevated so it sits above the radii overlay. Repositioned
 * each frame from the selected boid's pos.
 */
class SelectionMarker {
  private mesh: Mesh;
  private buffer: Float32Array;
  visible = false;

  constructor(scene: Scene) {
    this.mesh = SelectionMarker.buildMarkerMesh(scene);
    const mat = new StandardMaterial("sel-mat", scene);
    mat.emissiveColor = new Color3(0.2, 0.85, 0.35);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    this.mesh.material = mat;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.doNotSyncBoundingInfo = true;
    this.buffer = new Float32Array(16);
    this.mesh.thinInstanceSetBuffer("matrix", this.buffer, 16, false);
    this.mesh.thinInstanceCount = 0;
    this.mesh.setEnabled(false);
  }

  private static buildMarkerMesh(scene: Scene): Mesh {
    const segments = 48;
    const innerR = 0.88;
    const outerR = 1.0;
    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      positions.push(cs * innerR, sn * innerR, 0.04);
      positions.push(cs * outerR, sn * outerR, 0.04);
      normals.push(0, 0, 1, 0, 0, 1);
    }
    for (let i = 0; i < segments; i++) {
      const i0 = i * 2;
      const i1 = i * 2 + 1;
      const j0 = ((i + 1) % segments) * 2;
      const j1 = j0 + 1;
      indices.push(i0, j0, i1);
      indices.push(j0, j1, i1);
    }
    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;
    const mesh = new Mesh("sel-marker", scene);
    vd.applyToMesh(mesh);
    return mesh;
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.mesh.setEnabled(on);
    this.mesh.thinInstanceCount = on ? 1 : 0;
  }

  update(b: InstancedBoid | null): void {
    if (!this.visible || !b) return;
    // Slightly larger than the boid's personal-space ring so the green
    // marker frames the red radius rather than overlapping it.
    const r = b.separateR + 0.15;
    const buf = this.buffer;
    buf[0] = r;  buf[1] = 0;  buf[2] = 0;  buf[3] = 0;
    buf[4] = 0;  buf[5] = r;  buf[6] = 0;  buf[7] = 0;
    buf[8] = 0;  buf[9] = 0;  buf[10] = 1; buf[11] = 0;
    buf[12] = b.pos.x; buf[13] = b.pos.y; buf[14] = 0; buf[15] = 1;
    this.mesh.thinInstanceBufferUpdated("matrix");
  }

  dispose(): void {
    this.mesh.material?.dispose();
    this.mesh.dispose();
  }
}

type BoidContext = "idle" | "friends" | "chasing" | "chased";

export interface InstancedBoid {
  pos: Vector3;
  vel: Vector3;
  unit: Unit;
  driverState: DriverState;
  traits: BoidTraits;
  archetype: string;
  factionKey: string;
  factionId: number;
  alignR2: number;
  cohereR2: number;
  /** Personal-space radius (linear). Per-pair separation uses max of
   *  the two boids' radii, so a small unit still feels a big neighbor. */
  separateR: number;
  separateR2: number;
  chaseR2: number;
  currentGait: keyof typeof GAITS;
  defaultSpeed: number;
  /** Per-instance VAT phase in frames, range [0, FRAMES_PER_GAIT). We
   *  integrate this ourselves each frame and write it as the shader's
   *  "offset" with fps=0, instead of relying on the global manager time
   *  multiplied by a per-frame-jittery fps. That formula
   *    realFrame = (time*fps + offset) % range + from
   *  produces visible phase snaps whenever fps changes — even by ~5%.
   *  Manual integration keeps the displayed frame continuous regardless
   *  of how the desired fps fluctuates with current speed. */
  phase: number;
  /** Visual heading (rad), slewed toward velocity direction at maxYawRate.
   *  Decoupled from velocity so brief separation impulses don't spin
   *  the body during dense-cluster jostling. */
  heading: number;
  source: BoidSource;
  slot: number;
  targetMood: PRESETS_LOOKUP;

  // Hysteresis: committed context vs latest contender + frames held.
  context: BoidContext;
  pendingContext: BoidContext;
  pendingFrames: number;

  // ── Per-unit personality cached for the hot path ──
  /** Multiplier on archetype maxSpeed. */
  unitSpeedMul: number;
  /** Mood this unit defaults to in idle / friend / chase contexts. */
  idleMood: PRESETS_LOOKUP;
  friendsMood: PRESETS_LOOKUP;
  chasingMood: PRESETS_LOOKUP;
  chasedMood: PRESETS_LOOKUP;
  /** Available gaits for this unit, each with its natural-cadence world
   *  speed. Sorted ascending. Gait is picked each frame to match the
   *  boid's actual achieved speed (not its intent), so a unit pinned in
   *  a cluster animates at its real pace. */
  gaitChoices: { name: GaitName; defaultSpeed: number }[];
  /** Per-boid head look state — drives independent head yaw on top of
   *  the VAT-baked body animation. Stepped each frame in stepAnimate. */
  lookState: LookState;
  /** Personality-derived mix of idle/camera/influence look weights. */
  lookMix: LookMix;
  /** World position of the boid's current "interesting point" — feeds
   *  into the head-look "influence" mode. Updated each frame in
   *  stepFlock from the fine-grid neighbor scan; defaults to (0,0). */
  influenceX: number;
  influenceY: number;
}

export interface InstancedBoidsFieldOpts {
  bounds?: number;
  perSourceCapacity?: number;
}

export class InstancedBoidsField {
  boids: InstancedBoid[] = [];
  readonly bounds: number;
  private sources = new Map<string, BoidSource>();
  private perSourceCapacity: number;

  // Dual grid: fine cells for short-range per-pair work (separation,
  // is-chased, no-overlap); coarse cells for long-range aggregates
  // (align/cohere, per-faction chase).
  private fN: number;
  private cN: number;
  private fineLists: InstancedBoid[][];
  private cCount: Int32Array;
  private cSumVx: Float32Array;
  private cSumVy: Float32Array;
  private cSumPx: Float32Array;
  private cSumPy: Float32Array;
  private cFCount: Int32Array;
  private cFSumPx: Float32Array;
  private cFSumPy: Float32Array;
  private radii: RadiiOverlay;
  private marker: SelectionMarker;
  /** Currently-selected boid for inspection. Tracked by reference, not
   *  by slot, since slots are repacked every frame in stepAnimate. */
  selected: InstancedBoid | null = null;

  constructor(private scene: Scene, opts: InstancedBoidsFieldOpts = {}) {
    this.bounds = opts.bounds ?? 25;
    this.perSourceCapacity = opts.perSourceCapacity ?? 4096;

    this.fN = Math.max(1, Math.ceil((this.bounds * 2) / FINE_CELL));
    this.cN = Math.max(1, Math.ceil((this.bounds * 2) / COARSE_CELL));
    const fNN = this.fN * this.fN;
    const cNN = this.cN * this.cN;
    this.fineLists = new Array(fNN);
    for (let i = 0; i < fNN; i++) this.fineLists[i] = [];
    this.cCount = new Int32Array(cNN);
    this.cSumVx = new Float32Array(cNN);
    this.cSumVy = new Float32Array(cNN);
    this.cSumPx = new Float32Array(cNN);
    this.cSumPy = new Float32Array(cNN);
    this.cFCount = new Int32Array(cNN * FACTION_STRIDE);
    this.cFSumPx = new Float32Array(cNN * FACTION_STRIDE);
    this.cFSumPy = new Float32Array(cNN * FACTION_STRIDE);
    this.radii = new RadiiOverlay(scene);
    this.marker = new SelectionMarker(scene);
  }

  setRadiiVisible(on: boolean): void {
    this.radii.setVisible(on);
  }

  /**
   * Pick the boid nearest the screen-space pointer, by raycasting to the
   * z=0 plane (where boids live) and finding the closest within a small
   * world-space tolerance. Cheap at any boid count — no thin-instance
   * bounding-info rebuild required.
   */
  pickAt(x: number, y: number, pickRadius = 0.8): InstancedBoid | null {
    const cam = this.scene.activeCamera;
    if (!cam) return null;
    const ray = this.scene.createPickingRay(x, y, null, cam, false);
    if (Math.abs(ray.direction.z) < 1e-6) return null;
    const t = -ray.origin.z / ray.direction.z;
    if (t < 0) return null;
    const px = ray.origin.x + ray.direction.x * t;
    const py = ray.origin.y + ray.direction.y * t;
    let best: InstancedBoid | null = null;
    let bestD2 = pickRadius * pickRadius;
    for (const b of this.boids) {
      const dx = b.pos.x - px;
      const dy = b.pos.y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = b; }
    }
    return best;
  }

  setSelected(b: InstancedBoid | null): void {
    this.selected = b;
    this.marker.setVisible(b !== null);
  }

  private fineIndex(coord: number): number {
    let i = ((coord + this.bounds) / FINE_CELL) | 0;
    if (i < 0) i = 0;
    else if (i >= this.fN) i = this.fN - 1;
    return i;
  }

  private coarseIndex(coord: number): number {
    let i = ((coord + this.bounds) / COARSE_CELL) | 0;
    if (i < 0) i = 0;
    else if (i >= this.cN) i = this.cN - 1;
    return i;
  }

  private rebuildField(): void {
    const fN = this.fN;
    const cN = this.cN;
    for (const cell of this.fineLists) cell.length = 0;
    this.cCount.fill(0);
    this.cSumVx.fill(0);
    this.cSumVy.fill(0);
    this.cSumPx.fill(0);
    this.cSumPy.fill(0);
    this.cFCount.fill(0);
    this.cFSumPx.fill(0);
    this.cFSumPy.fill(0);

    for (const b of this.boids) {
      const fci = this.fineIndex(b.pos.x);
      const fcj = this.fineIndex(b.pos.y);
      this.fineLists[fcj * fN + fci].push(b);

      const cci = this.coarseIndex(b.pos.x);
      const ccj = this.coarseIndex(b.pos.y);
      const cIdx = ccj * cN + cci;
      this.cCount[cIdx]++;
      this.cSumVx[cIdx] += b.vel.x;
      this.cSumVy[cIdx] += b.vel.y;
      this.cSumPx[cIdx] += b.pos.x;
      this.cSumPy[cIdx] += b.pos.y;
      const fIdx = cIdx * FACTION_STRIDE + b.factionId;
      this.cFCount[fIdx]++;
      this.cFSumPx[fIdx] += b.pos.x;
      this.cFSumPy[fIdx] += b.pos.y;
    }
  }

  count(): number {
    return this.boids.length;
  }

  setCount(target: number, pool: Unit[]): void {
    while (this.boids.length > target) {
      const last = this.boids.pop();
      if (!last) break;
      this.despawn(last);
    }
    let stuckGuard = 0;
    let lastLen = this.boids.length;
    while (this.boids.length < target) {
      const unit = pool[Math.floor(Math.random() * pool.length)];
      if (!unit) break;
      this.spawn(unit);
      // Defensive: if no progress (all source caps exhausted, pool empty,
      // etc.), break instead of infinite-looping.
      if (this.boids.length === lastLen) {
        stuckGuard++;
        if (stuckGuard > pool.length * 2) break;
      } else {
        stuckGuard = 0;
        lastLen = this.boids.length;
      }
    }
  }

  private getOrCreateSource(unit: Unit): BoidSource {
    let src = this.sources.get(unit.id);
    if (src) return src;
    src = new BoidSource(unit, this.scene, this.perSourceCapacity);
    this.sources.set(unit.id, src);
    return src;
  }

  private spawn(unit: Unit): void {
    const src = this.getOrCreateSource(unit);
    const slot = src.allocSlot();
    if (slot < 0) return;

    const traits = traitsFor(unit.archetype);
    // Per-unit personal-space radius — scales with the actual body
    // width so chonky raccoons enforce more spacing and tiny ones
    // enforce less. Reference is the slider-default body max ry (~41
    // walker units). Comfort margin baked into the constant.
    let maxRy = 0;
    if (unit.raccoon) {
      for (const b of unit.raccoon.body) if (b.ry > maxRy) maxRy = b.ry;
    }
    const REFERENCE_MAX_RY = 41;
    const COMFORT = 1.30;
    const sizeScale = maxRy > 0 ? (maxRy / REFERENCE_MAX_RY) * COMFORT : 1;
    const sepR = traits.separateRadius * sizeScale;
    // Build the per-unit gait menu (sorted ascending by world speed). Each
    // frame we'll snap to the gait whose natural speed is closest to the
    // boid's actually-achieved speed.
    const gaitChoices = unit.availableGaits
      .map((g) => ({ name: g as GaitName, defaultSpeed: defaultGaitSpeed(g) }))
      .sort((a, b) => a.defaultSpeed - b.defaultSpeed);
    const startGait = gaitChoices[0].name;

    const ds = makeDriverState(startGait, presetMood("neutral"));

    const px = (Math.random() * 2 - 1) * this.bounds;
    const py = (Math.random() * 2 - 1) * this.bounds;
    const pos = new Vector3(px, py, 0);
    const vh = Math.random() * Math.PI * 2;
    const speed = (traits.minSpeed + traits.maxSpeed) * 0.5 * unit.speedMul;
    const vel = new Vector3(speed * Math.cos(vh), speed * Math.sin(vh), 0);

    this.boids.push({
      pos, vel, unit, driverState: ds, traits,
      archetype: unit.archetype,
      factionKey: unit.factionKey,
      factionId: FACTION_IDS[unit.factionKey] ?? 0,
      alignR2: traits.alignRadius * traits.alignRadius,
      cohereR2: traits.cohereRadius * traits.cohereRadius,
      separateR: sepR,
      separateR2: sepR * sepR,
      chaseR2: traits.chaseRadius * traits.chaseRadius,
      currentGait: startGait,
      defaultSpeed: gaitChoices[0].defaultSpeed,
      phase: Math.random() * FRAMES_PER_GAIT,
      heading: vh,
      source: src,
      slot,
      targetMood: unit.moods.idle as PRESETS_LOOKUP,
      context: "idle",
      pendingContext: "idle",
      pendingFrames: 0,
      unitSpeedMul: unit.speedMul,
      idleMood: unit.moods.idle as PRESETS_LOOKUP,
      friendsMood: unit.moods.friends as PRESETS_LOOKUP,
      chasingMood: unit.moods.chasing as PRESETS_LOOKUP,
      chasedMood: unit.moods.chased as PRESETS_LOOKUP,
      gaitChoices,
      lookState: makeLookState(),
      lookMix: unit.raccoon?.lookMix ?? { idle: 0.5, camera: 0.25, influence: 0.25 },
      influenceX: 0,
      influenceY: 0,
    });
  }

  private despawn(b: InstancedBoid): void {
    b.source.freeSlot(b.slot);
    if (this.selected === b) this.setSelected(null);
  }

  setVisible(v: boolean): void {
    for (const src of this.sources.values()) {
      src.decomp.body.setEnabled(v);
      src.decomp.head.setEnabled(v);
    }
  }

  dispose(): void {
    this.boids.length = 0;
    for (const src of this.sources.values()) src.dispose();
    this.sources.clear();
    this.radii.clear();
    this.setSelected(null);
  }

  step(dt: number): void {
    this.stepFlock(dt);
    this.stepAnimate(dt);
  }

  stepFlock(dt: number): void {
    const dtCl = Math.min(dt, 0.05);
    const bnd = this.bounds;
    const W = bnd * 2;
    const fN = this.fN;
    const cN = this.cN;
    this.rebuildField();

    for (const b of this.boids) {
      const t = b.traits;
      const bFid = b.factionId;
      const bFidRow = bFid * FACTION_STRIDE;
      const bChaseEnabled = t.chaseRadius > 0;
      const bChaseR2 = b.chaseR2;
      const bSepR = b.separateR;
      const bAlignR2 = b.alignR2;
      const bArch = b.archetype;
      const bx = b.pos.x;
      const by = b.pos.y;

      // ─ Coarse-grid 3×3 aggregate for align + cohere (~9 m reach). ─
      const cci = this.coarseIndex(bx);
      const ccj = this.coarseIndex(by);
      let aggCount = 0;
      let aggVx = 0, aggVy = 0, aggPx = 0, aggPy = 0;
      for (let dy = -1; dy <= 1; dy++) {
        let cy = ccj + dy;
        if (cy < 0) cy += cN; else if (cy >= cN) cy -= cN;
        const row = cy * cN;
        for (let dx = -1; dx <= 1; dx++) {
          let cx = cci + dx;
          if (cx < 0) cx += cN; else if (cx >= cN) cx -= cN;
          const idx = row + cx;
          aggCount += this.cCount[idx];
          aggVx += this.cSumVx[idx]; aggVy += this.cSumVy[idx];
          aggPx += this.cSumPx[idx]; aggPy += this.cSumPy[idx];
        }
      }
      aggCount -= 1;
      aggVx -= b.vel.x; aggVy -= b.vel.y;
      aggPx -= bx; aggPy -= by;

      let fx = 0, fy = 0;
      if (aggCount > 0) {
        const inv = 1 / aggCount;
        fx += (aggVx * inv - b.vel.x) * t.alignWeight;
        fy += (aggVy * inv - b.vel.y) * t.alignWeight;
        fx += (aggPx * inv - bx) * t.cohereWeight;
        fy += (aggPy * inv - by) * t.cohereWeight;
      }

      // ─ Fine-grid 3×3 per-pair: separation + is-chased + friend count. ─
      // Separation accumulator is held aside and applied AFTER the
      // acceleration clamp so close-pair "collisions" can push apart at
      // any magnitude — the unit's maxAccel only governs self-directed
      // steering (align / cohere / chase).
      const fci = this.fineIndex(bx);
      const fcj = this.fineIndex(by);
      let sx = 0, sy = 0;
      let isChased = false;
      let friendsNearby = 0;
      let processed = 0;
      // Nearest neighbor (wrapped world coords) — used as the head-look
      // "influence" point in stepAnimate. Tracked here because we're
      // already iterating the fine-grid neighbors anyway.
      let nearestD2 = Infinity;
      let nearestX = 0, nearestY = 0;
      fineLoop: for (let dy = -1; dy <= 1; dy++) {
        let cy = fcj + dy;
        if (cy < 0) cy += fN; else if (cy >= fN) cy -= fN;
        const row = cy * fN;
        for (let dx = -1; dx <= 1; dx++) {
          let cx = fci + dx;
          if (cx < 0) cx += fN; else if (cx >= fN) cx -= fN;
          const list = this.fineLists[row + cx];
          for (let k = 0, kn = list.length; k < kn; k++) {
            if (processed >= MAX_FINE_NEIGHBORS) break fineLoop;
            const o = list[k];
            if (o === b) continue;
            let ox = o.pos.x - bx;
            let oy = o.pos.y - by;
            if (ox > bnd) ox -= W; else if (ox < -bnd) ox += W;
            if (oy > bnd) oy -= W; else if (oy < -bnd) oy += W;
            const od2 = ox * ox + oy * oy;
            if (od2 < 1e-6) continue;
            processed++;
            if (od2 < nearestD2) {
              nearestD2 = od2;
              nearestX = bx + ox;
              nearestY = by + oy;
            }
            // Effective separation distance = max of the two personal-space
            // radii. Symmetric: a small Specter near a large Construct feels
            // the Construct's radius too, so they don't pack into each other.
            //
            // Force law: cubic 1/r^3 pressure ((pairR/dist)^3 - 1 in
            // factor form, which gives |F| = pairR^3/dist^2 - dist).
            //   dist=pairR        |F| = 0           (touch, no force)
            //   dist=pairR/2      |F| = 3.5*pairR   (half-radius compression)
            //   dist=pairR/4      |F| = 15.75*pairR (deep)
            //   dist→0            |F| → ∞           (capped at MAX_SEP_PAIR_FORCE)
            // We cap the impulse MAGNITUDE rather than the per-component
            // factor so super-close pairs stay at the cap instead of
            // having force decay toward zero (which a factor-cap would
            // produce, since |F| = dist * factor).
            const pairR = bSepR > o.separateR ? bSepR : o.separateR;
            const pairR2 = pairR * pairR;
            if (od2 < pairR2) {
              const od2Floor = od2 > 0.0025 ? od2 : 0.0025;
              const distSafe = Math.sqrt(od2Floor);
              let mag = (pairR2 * pairR) / od2Floor - distSafe;
              if (mag > MAX_SEP_PAIR_FORCE) mag = MAX_SEP_PAIR_FORCE;
              const k2 = mag / distSafe;
              sx -= ox * k2; sy -= oy * k2;
            }
            if (od2 < bAlignR2 && o.archetype === bArch) friendsNearby++;
            if (o.chaseR2 > 0 && od2 < o.chaseR2) {
              if (FACTION_REL_MATRIX[o.factionId * FACTION_STRIDE + bFid] > 0) {
                isChased = true;
              }
            }
          }
        }
      }

      // Commit the head-look influence point. Nearest neighbor when
      // available, world center otherwise. (Chase target gets priority
      // a few lines down if the boid is actively chasing something.)
      if (nearestD2 < Infinity) {
        b.influenceX = nearestX;
        b.influenceY = nearestY;
      } else {
        b.influenceX = 0;
        b.influenceY = 0;
      }

      // ─ Coarse-grid 5×5 per-faction chase aggregates (~15 m reach). ─
      let isChasing = false;
      if (bChaseEnabled) {
        let hx = 0, hy = 0;
        // Strongest hostile aggregate target — used as the look-influence
        // point when this boid is actively chasing. "Strongest" = highest
        // `rel * cnt / dd` (the same magnitude that drives chase impulse).
        let chaseTargetW = 0;
        let chaseTargetX = 0;
        let chaseTargetY = 0;
        for (let dy = -2; dy <= 2; dy++) {
          let cy = ccj + dy;
          if (cy < 0) cy += cN; else if (cy >= cN) cy -= cN;
          const row = cy * cN;
          for (let dx = -2; dx <= 2; dx++) {
            let cx = cci + dx;
            if (cx < 0) cx += cN; else if (cx >= cN) cx -= cN;
            const baseFIdx = (row + cx) * FACTION_STRIDE;
            for (let f = 0; f < FACTION_STRIDE; f++) {
              const cnt = this.cFCount[baseFIdx + f];
              if (cnt === 0) continue;
              const rel = FACTION_REL_MATRIX[bFidRow + f];
              if (rel === 0) continue;
              const cxw = this.cFSumPx[baseFIdx + f] / cnt;
              const cyw = this.cFSumPy[baseFIdx + f] / cnt;
              let ddx = cxw - bx;
              let ddy = cyw - by;
              if (ddx > bnd) ddx -= W; else if (ddx < -bnd) ddx += W;
              if (ddy > bnd) ddy -= W; else if (ddy < -bnd) ddy += W;
              const dd2 = ddx * ddx + ddy * ddy;
              if (dd2 < 1e-6 || dd2 > bChaseR2) continue;
              const dd = Math.sqrt(dd2);
              const k2 = (rel * cnt) / dd;
              hx += ddx * k2; hy += ddy * k2;
              if (rel > 0) {
                isChasing = true;
                if (k2 > chaseTargetW) {
                  chaseTargetW = k2;
                  chaseTargetX = bx + ddx;
                  chaseTargetY = by + ddy;
                }
              }
            }
          }
        }
        fx += hx * t.chaseWeight; fy += hy * t.chaseWeight;
        // Chasing overrides the nearest-neighbor influence — the
        // raccoon locks onto its prey.
        if (isChasing && chaseTargetW > 0) {
          b.influenceX = chaseTargetX;
          b.influenceY = chaseTargetY;
        }
      }

      // Clamp self-directed acceleration (align / cohere / chase) to the
      // unit's archetype maxAccel. Separation is added AFTER the clamp —
      // collisions trump steering choices.
      const aMag = Math.hypot(fx, fy);
      if (aMag > t.maxAccel) {
        const k = t.maxAccel / aMag;
        fx *= k; fy *= k;
      }
      fx += sx * t.separateWeight;
      fy += sy * t.separateWeight;
      b.vel.x += fx * dtCl;
      b.vel.y += fy * dtCl;

      const maxSpeed = t.maxSpeed * b.unitSpeedMul * (isChased ? CHASED_SPEED_BONUS : 1);
      const minSpeed = t.minSpeed * b.unitSpeedMul;
      const speed = Math.hypot(b.vel.x, b.vel.y);
      if (speed > maxSpeed) {
        const k = maxSpeed / speed;
        b.vel.x *= k; b.vel.y *= k;
      } else if (speed < minSpeed) {
        const k = minSpeed / Math.max(speed, 1e-4);
        b.vel.x *= k; b.vel.y *= k;
      }

      b.pos.x += b.vel.x * dtCl;
      b.pos.y += b.vel.y * dtCl;

      if (b.pos.x > bnd) b.pos.x -= W;
      else if (b.pos.x < -bnd) b.pos.x += W;
      if (b.pos.y > bnd) b.pos.y -= W;
      else if (b.pos.y < -bnd) b.pos.y += W;

      // Hysteresis: derive the desired context this frame, then only
      // commit a change after CONTEXT_HYSTERESIS consecutive frames of
      // contention. Avoids gait/mood flicker at boundary distances.
      let desiredContext: BoidContext = "idle";
      if (isChased) desiredContext = "chased";
      else if (isChasing) desiredContext = "chasing";
      else if (friendsNearby >= FRIENDS_THRESHOLD) desiredContext = "friends";

      if (desiredContext === b.context) {
        b.pendingFrames = 0;
        b.pendingContext = b.context;
      } else if (desiredContext === b.pendingContext) {
        b.pendingFrames++;
        if (b.pendingFrames >= CONTEXT_HYSTERESIS) {
          b.context = desiredContext;
          b.pendingFrames = 0;
        }
      } else {
        b.pendingContext = desiredContext;
        b.pendingFrames = 1;
      }

      // Mood is still context-driven (chased = scared, chasing = angry,
      // etc.) — but gait is picked from the boid's actual achieved speed
      // so a "chased" boid pinned in a cluster doesn't run-animate while
      // barely moving. Pick the gaitChoice whose natural speed is closest
      // to the integrated speed below.
      let targetMoodName: PRESETS_LOOKUP;
      switch (b.context) {
        case "chased":  targetMoodName = b.chasedMood;  break;
        case "chasing": targetMoodName = b.chasingMood; break;
        case "friends": targetMoodName = b.friendsMood; break;
        default:        targetMoodName = b.idleMood;
      }
      b.targetMood = targetMoodName;

      const achievedSpeed = Math.hypot(b.vel.x, b.vel.y);
      const choices = b.gaitChoices;
      let bestGait = choices[0].name;
      let bestDefault = choices[0].defaultSpeed;
      let bestDist = Math.abs(bestDefault - achievedSpeed);
      for (let gi = 1; gi < choices.length; gi++) {
        const d = Math.abs(choices[gi].defaultSpeed - achievedSpeed);
        if (d < bestDist) {
          bestDist = d;
          bestGait = choices[gi].name;
          bestDefault = choices[gi].defaultSpeed;
        }
      }
      if (b.currentGait !== bestGait) {
        b.currentGait = bestGait;
        b.driverState.gaitName = bestGait;
        b.defaultSpeed = bestDefault;
      }

      // Slew heading toward velocity direction, capped at the unit's
      // maxYawRate. Decouples body orientation from raw velocity so a
      // separation impulse can shove the boid sideways without spinning
      // it. shortest-arc wrap to (-π, π] before clamping.
      const desired = Math.atan2(b.vel.y, b.vel.x);
      let dh = desired - b.heading;
      if (dh > Math.PI) dh -= 2 * Math.PI;
      else if (dh < -Math.PI) dh += 2 * Math.PI;
      const maxStep = t.maxYawRate * dtCl;
      if (dh > maxStep) dh = maxStep;
      else if (dh < -maxStep) dh = -maxStep;
      b.heading += dh;
      if (b.heading > Math.PI) b.heading -= 2 * Math.PI;
      else if (b.heading < -Math.PI) b.heading += 2 * Math.PI;
    }

    // No hard no-overlap pass: boids pass magically through each other.
    // Position-level enforcement was fighting cohesion in dense clusters
    // and producing visible vibration. Soft separation force is enough.
  }

  stepAnimate(dt: number): void {
    // Reset per-source counts; we re-pack instances each frame to keep
    // matrix/anim buffers contiguous up to thinInstanceCount.
    for (const src of this.sources.values()) {
      src.count = 0;
      src.freeSlots.length = 0;
    }

    // Camera position drives "look at camera" mode. Same value for all
    // boids this frame; cached once to avoid per-boid lookup.
    const cam = this.scene.activeCamera;
    const camX = cam ? cam.globalPosition.x : 0;
    const camY = cam ? cam.globalPosition.y : 0;

    for (const b of this.boids) {
      const slot = b.source.count++;
      b.slot = slot;

      // Animation params: (fromFrame, toFrame, offsetFrames, fps).
      // Mood-aware: pick the (currentGait, targetMood) bake range so
      // posture/cadence carry the boid's emotional state.
      //
      // We integrate the per-instance phase ourselves and send fps=0,
      // so the shader renders frame = (offset % range) + from. This
      // decouples the displayed frame from the global manager time —
      // a per-frame fps wobble (which is unavoidable since speedMul
      // tracks vel magnitude) no longer time-warps the playhead.
      const range = b.source.gaitMoodRanges[b.currentGait as GaitName][b.targetMood];

      // World matrix: rotation around Z by heading + translation, with
      // a uniform render scale so the totem characters sit visually
      // small in the boid view. Babylon matrix is column-major in m[].
      const cosY = Math.cos(b.heading);
      const sinY = Math.sin(b.heading);
      const s = BOID_RENDER_SCALE;
      const mb = b.source.bodyMatrixBuffer;
      const mOff = slot * 16;
      mb[mOff +  0] = cosY * s; mb[mOff +  1] = sinY * s; mb[mOff +  2] = 0; mb[mOff +  3] = 0;
      mb[mOff +  4] = -sinY * s; mb[mOff +  5] = cosY * s; mb[mOff +  6] = 0; mb[mOff +  7] = 0;
      mb[mOff +  8] = 0;        mb[mOff +  9] = 0;        mb[mOff + 10] = s; mb[mOff + 11] = 0;
      mb[mOff + 12] = b.pos.x; mb[mOff + 13] = b.pos.y; mb[mOff + 14] = 0; mb[mOff + 15] = 1;

      // Head matrix. Track the body's animated head bone (bob + sway)
      // by sampling the per-frame head translation baked in BoidSource.
      // Then layer the per-boid look-yaw on top so each raccoon turns
      // its head independently of body heading.
      const headYaw = stepLook(
        b.lookState,
        {
          cx: b.pos.x,
          cy: b.pos.y,
          heading: b.heading,
          camX,
          camY,
          influenceX: b.influenceX,
          influenceY: b.influenceY,
          mix: b.lookMix,
        },
        dt,
      );
      // Sample head bone translation for the current frame. Floor the
      // phase — at 60 fps the per-frame jump is sub-pixel.
      const frameInt = b.phase | 0;
      const tOff = (range.from + frameInt) * 3;
      const headT = b.source.headTranslations;
      const hLocX = headT[tOff + 0];
      const hLocY = headT[tOff + 1];
      const hLocZ = headT[tOff + 2];
      // Rotate body-local head offset by body heading (already-cached
      // cosY/sinY), scale, and add to boid world pos.
      const wOffX = (cosY * hLocX - sinY * hLocY) * s;
      const wOffY = (sinY * hLocX + cosY * hLocY) * s;
      const wOffZ = hLocZ * s;
      const cosH = Math.cos(b.heading + headYaw);
      const sinH = Math.sin(b.heading + headYaw);
      const hb = b.source.headMatrixBuffer;
      hb[mOff +  0] = cosH * s; hb[mOff +  1] = sinH * s; hb[mOff +  2] = 0; hb[mOff +  3] = 0;
      hb[mOff +  4] = -sinH * s; hb[mOff +  5] = cosH * s; hb[mOff +  6] = 0; hb[mOff +  7] = 0;
      hb[mOff +  8] = 0;         hb[mOff +  9] = 0;         hb[mOff + 10] = s; hb[mOff + 11] = 0;
      hb[mOff + 12] = b.pos.x + wOffX;
      hb[mOff + 13] = b.pos.y + wOffY;
      hb[mOff + 14] = wOffZ;
      hb[mOff + 15] = 1;
      const currentSpeed = Math.hypot(b.vel.x, b.vel.y);
      const speedMul = currentSpeed / b.defaultSpeed;
      const desiredFps = range.baseFps * speedMul;
      b.phase += dt * desiredFps;
      // Wrap into [0, FRAMES_PER_GAIT). One mod is enough at 60 fps;
      // a defensive while-loop guards against pauses/hitches.
      while (b.phase >= FRAMES_PER_GAIT) b.phase -= FRAMES_PER_GAIT;
      while (b.phase < 0) b.phase += FRAMES_PER_GAIT;

      const ab = b.source.animBuffer;
      const aOff = slot * 4;
      ab[aOff + 0] = range.from;
      ab[aOff + 1] = range.to;
      ab[aOff + 2] = b.phase;
      ab[aOff + 3] = 0;
    }

    for (const src of this.sources.values()) src.flush(dt);
    this.radii.update(this.boids);
    this.marker.update(this.selected);
  }
}
