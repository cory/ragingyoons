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
  /** Head mesh — shell 0 reuses it the same way. Stored so flush can
   *  set head shell counts in lockstep with body shell counts. */
  head: Mesh;
  /** Cloned BODY meshes for shells 1..N-1. */
  shells: Mesh[];
  /** Cloned HEAD meshes for shells 1..N-1. Mirrors `shells` so per-LOD
   *  counts apply identically to head shells. */
  headShells: Mesh[];
  /** All fur materials (body skin + body shells 1..N-1 + head skin +
   *  head shells 1..N-1). Used to dispose on detach. */
  furMaterials: ShaderMaterial[];
  /** Original material on body, restored on detach. */
  originalMaterial: Material | null;
  /** Original material on head, restored on detach. */
  originalHeadMaterial: Material | null;
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
  head: Mesh,
  scene: Scene,
  bodyMatrixBuffer: Float32Array,
  headMatrixBuffer: Float32Array,
  animBuffer: Float32Array,
  opts: FurAttachOpts = {},
): FurBoidState {
  const originalMaterial = body.material;
  const originalHeadMaterial = head.material;

  const shellCount = clampShellCount(opts.shellCount);
  const length = opts.furLength ?? DEFAULT_FUR_LENGTH;
  const noiseFreq = opts.noiseFreq ?? DEFAULT_NOISE_FREQ;
  const shellSpacing = spacingFromLength(length, shellCount);

  const furMaterials: ShaderMaterial[] = [];
  const shells: Mesh[] = [];
  const headShells: Mesh[] = [];

  // Shell 0 BODY: opaque skin layer.
  const skinMat = createFurBoidMaterial(scene, {
    shellIndex: 0,
    shellCount,
    shellSpacing,
    noiseFreq,
    driverMesh: body,
  });
  body.material = skinMat;
  furMaterials.push(skinMat);

  // Shell 0 HEAD: same shellIndex=0 but compiled against the rigid
  // head (no skeleton, no VAT). The shader's #if NUM_BONE_INFLUENCERS>0
  // / #ifdef BAKED_VERTEX_ANIMATION_TEXTURE gates produce a smaller
  // attribute set for this compile (no matricesIndices/Weights, no
  // bakedVertexAnimationSettingsInstanced).
  const headSkinMat = createFurBoidMaterial(scene, {
    shellIndex: 0,
    shellCount,
    shellSpacing,
    noiseFreq,
    driverMesh: head,
  });
  head.material = headSkinMat;
  furMaterials.push(headSkinMat);

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

    // Matching HEAD shell. Rigid (no skeleton, no VAT manager), so the
    // shader compile here is the simpler attribs-set variant. Same
    // shellIndex / spacing as the body shell so the fur reads as one
    // continuous coat across body+head.
    const headShell = head.clone(`${head.name}_furshell${i}`, null, true, false);
    if (headShell) {
      headShell.makeGeometryUnique();
      headShell.position.set(0, 0, 0);
      headShell.rotation.set(0, 0, 0);
      headShell.scaling.set(1, 1, 1);
      headShell.alwaysSelectAsActiveMesh = true;
      headShell.doNotSyncBoundingInfo = true;
      headShell.isPickable = false;
      headShell.thinInstanceSetBuffer("matrix", headMatrixBuffer, 16, false);
      headShell.thinInstanceCount = Math.max(1, head.thinInstanceCount);
      const headMat = createFurBoidMaterial(scene, {
        shellIndex: i,
        shellCount,
        shellSpacing,
        noiseFreq,
        driverMesh: head,
      });
      headShell.material = headMat;
      furMaterials.push(headMat);
      headShells.push(headShell);
    }
  }

  return { body, head, shells, headShells, furMaterials, originalMaterial, originalHeadMaterial };
}

export function detachBoidFurShells(state: FurBoidState): void {
  for (const shell of state.shells) shell.dispose();
  for (const shell of state.headShells) shell.dispose();
  for (const mat of state.furMaterials) mat.dispose();
  state.body.material = state.originalMaterial;
  state.head.material = state.originalHeadMaterial;
}

/** Mirror the body's thinInstanceCount onto every body+head shell.
 *  Each shell has its own GPU Buffer wrapping the shared Float32Array,
 *  so each needs its own dirty mark for the per-frame re-upload. Call
 *  once per frame, after the boid sim updates the body. */
export function syncBoidFurShells(state: FurBoidState): void {
  const bodyCount = state.body.thinInstanceCount;
  for (const shell of state.shells) {
    shell.thinInstanceCount = bodyCount;
    shell.thinInstanceBufferUpdated("matrix");
    shell.thinInstanceBufferUpdated("bakedVertexAnimationSettingsInstanced");
  }
  const headCount = state.head.thinInstanceCount;
  for (const shell of state.headShells) {
    shell.thinInstanceCount = headCount;
    shell.thinInstanceBufferUpdated("matrix");
  }
}

/** Live tweak — apply slider values to all shells without rebuilding.
 *  Uses the existing shell stack's length (state.furMaterials.length)
 *  to compute spacing, so the same furLength stays consistent across
 *  changes to shellCount (which goes through a full re-attach). */
export function updateBoidFurParams(state: FurBoidState, opts: FurAttachOpts): void {
  if (opts.furLength !== undefined) {
    // Each shell stack (body + head) has shellCount entries in
    // furMaterials, so total length is 2 * shellCount. Recover the
    // per-stack count to keep spacing consistent.
    const perStack = Math.max(1, state.furMaterials.length / 2);
    const spacing = spacingFromLength(opts.furLength, perStack);
    for (const mat of state.furMaterials) mat.setFloat("uShellSpacing", spacing);
  }
  if (opts.noiseFreq !== undefined) {
    for (const mat of state.furMaterials) mat.setFloat("uNoiseFreq", opts.noiseFreq);
  }
}
