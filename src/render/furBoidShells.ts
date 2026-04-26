/**
 * Attach/detach shell-fur layers to an instanced VAT-driven boid body.
 *
 * Each shell is a clone of the body. Cloning a thin-instance source
 * mesh does NOT propagate the per-instance matrix / VAT-settings
 * buffers that Babylon attached via `thinInstanceSetBuffer`, so we
 * re-attach the SAME `bodyMatrixBuffer` + `animBuffer` Float32Arrays
 * to each shell. Babylon allocates a separate underlying `Buffer` per
 * shell (one redundant GPU upload per shell per frame), but the JS
 * data is shared so per-frame writes from the boid sim land on every
 * shell once we mark each one dirty in `syncBoidFurShells`.
 *
 * Sharing the underlying GPU `Buffer` across shells is possible in
 * theory — `body._thinInstanceDataStorage.matrixBuffer.createVertexBuffer(...)`
 * gives you views off the same `Buffer` — but Babylon's renderer reads
 * from more places than just the geometry's vertex-buffer dict for
 * thin-instance attributes (e.g. `_thinInstanceDataStorage.matrixBuffer`
 * and `_userThinInstanceBuffersStorage.vertexBuffers` are queried
 * directly), so just stitching VertexBuffer views into the geometry
 * isn't enough. Doable but not worth the spelunking; we accept the
 * upload redundancy.
 *
 * The BakedVertexAnimationManager is assigned to each shell so
 * Babylon's `BAKED_VERTEX_ANIMATION_TEXTURE` define gets set on the
 * material when it's compiled.
 */
import {
  type Material,
  type Mesh,
  type Scene,
  type ShaderMaterial,
} from "@babylonjs/core";
import { createFurBoidMaterial } from "./furBoid";
import { DEFAULT_FUR_LENGTH, DEFAULT_NOISE_FREQ, type FurAttachOpts } from "./furShells";

/** Default shell count for boids. Lower than track mode (16) because
 *  shell fur cost scales as `boids × shells × per-pixel work`. The
 *  caller can override via FurAttachOpts.shellCount; the slider in
 *  main.ts uses that to let the user dial it down further at large
 *  boid counts. */
const DEFAULT_BOID_SHELL_COUNT = 4;

export interface FurBoidState {
  /** Body mesh — shell 0 reuses this. We hold the ref so sync() can
   *  read its current thinInstanceCount. */
  body: Mesh;
  /** Cloned meshes for shells 1..N-1. */
  shells: Mesh[];
  /** All fur materials (length = SHELL_COUNT, including shell 0's). */
  furMaterials: ShaderMaterial[];
  /** Original material on body, restored on detach. */
  originalMaterial: Material | null;
}

function spacingFromLength(length: number, shellCount: number): number {
  return length / Math.max(1, shellCount - 1);
}

function clampShellCount(n: number | undefined): number {
  const v = n ?? DEFAULT_BOID_SHELL_COUNT;
  return Math.max(1, Math.min(16, Math.floor(v)));
}

export function attachBoidFurShells(
  body: Mesh,
  scene: Scene,
  bodyMatrixBuffer: Float32Array,
  animBuffer: Float32Array,
  opts: FurAttachOpts = {},
): FurBoidState {
  const originalMaterial = body.material;

  const shellCount = clampShellCount(opts.shellCount);
  const length = opts.furLength ?? DEFAULT_FUR_LENGTH;
  const noiseFreq = opts.noiseFreq ?? DEFAULT_NOISE_FREQ;
  const shellSpacing = spacingFromLength(length, shellCount);

  const furMaterials: ShaderMaterial[] = [];
  const shells: Mesh[] = [];

  // Shell 0: opaque skin layer on the body itself.
  const skinMat = createFurBoidMaterial(scene, {
    shellIndex: 0,
    shellCount,
    shellSpacing,
    noiseFreq,
    driverMesh: body,
  });
  body.material = skinMat;
  furMaterials.push(skinMat);

  for (let i = 1; i < shellCount; i++) {
    const shell = body.clone(`${body.name}_furshell${i}`, null, true, false);
    if (!shell) continue;

    // Critical: clone() shares Geometry with the source by default.
    // Our follow-up `thinInstanceSetBuffer` calls mutate the geometry's
    // world0..3 vertex buffers — which would also mutate the body's
    // copy. When fur is later detached, the body's pipeline rebuilds
    // against poisoned geometry state, producing the "10 vertex buffers
    // > 8" device error and (incidentally) the zombie pile. Forcing
    // each shell to own its geometry isolates them.
    shell.makeGeometryUnique();

    shell.position.set(0, 0, 0);
    shell.rotation.set(0, 0, 0);
    shell.scaling.set(1, 1, 1);

    shell.skeleton = body.skeleton;
    shell.numBoneInfluencers = body.numBoneInfluencers;
    shell.bakedVertexAnimationManager = body.bakedVertexAnimationManager;
    shell.alwaysSelectAsActiveMesh = true;
    shell.doNotSyncBoundingInfo = true;
    shell.isPickable = false;

    shell.thinInstanceSetBuffer("matrix", bodyMatrixBuffer, 16, false);
    shell.thinInstanceSetBuffer(
      "bakedVertexAnimationSettingsInstanced",
      animBuffer,
      4,
      false,
    );
    // Critical: thinInstanceCount must be > 0 BEFORE the effect first
    // compiles. Babylon decides `useInstances` from `hasThinInstances`,
    // which reads `_thinInstanceDataStorage.instancesCount`. If that's
    // 0 at first compile, the shell's pipeline gets baked WITHOUT the
    // INSTANCES + BAKED_VERTEX_ANIMATION_TEXTURE defines — meaning no
    // world0..3 / bakedVertexAnimationSettingsInstanced attribs — and
    // when count later goes positive Babylon tries to recompile into a
    // 10-attrib pipeline that exceeds the 8-vertex-buffer device limit.
    // Mirroring body's count is fine when boids already exist; if body
    // is empty (e.g. fur toggled before any flush), fall back to 1 so
    // the pipeline still compiles with instancing enabled. The flush
    // pass will write the real per-LOD count next frame.
    shell.thinInstanceCount = Math.max(1, body.thinInstanceCount);

    const mat = createFurBoidMaterial(scene, {
      shellIndex: i,
      shellCount,
      shellSpacing,
      noiseFreq,
      driverMesh: body,
    });
    shell.material = mat;

    furMaterials.push(mat);
    shells.push(shell);
  }

  return { body, shells, furMaterials, originalMaterial };
}

export function detachBoidFurShells(state: FurBoidState): void {
  for (const shell of state.shells) shell.dispose();
  for (const mat of state.furMaterials) mat.dispose();
  state.body.material = state.originalMaterial;
}

/** Mirror the body's thinInstanceCount + buffer-updated flags onto
 *  every shell. Each shell has its own GPU Buffer wrapping the shared
 *  Float32Array, so each needs its own dirty mark for the per-frame
 *  re-upload. Call once per frame, after the boid sim updates the
 *  body. */
export function syncBoidFurShells(state: FurBoidState): void {
  const count = state.body.thinInstanceCount;
  for (const shell of state.shells) {
    shell.thinInstanceCount = count;
    shell.thinInstanceBufferUpdated("matrix");
    shell.thinInstanceBufferUpdated("bakedVertexAnimationSettingsInstanced");
  }
}

/** Live tweak — apply slider values to all shells without rebuilding.
 *  Uses the existing shell stack's length (state.furMaterials.length)
 *  to compute spacing, so the same furLength stays consistent across
 *  changes to shellCount (which goes through a full re-attach). */
export function updateBoidFurParams(state: FurBoidState, opts: FurAttachOpts): void {
  if (opts.furLength !== undefined) {
    const spacing = spacingFromLength(opts.furLength, state.furMaterials.length);
    for (const mat of state.furMaterials) mat.setFloat("uShellSpacing", spacing);
  }
  if (opts.noiseFreq !== undefined) {
    for (const mat of state.furMaterials) mat.setFloat("uNoiseFreq", opts.noiseFreq);
  }
}
