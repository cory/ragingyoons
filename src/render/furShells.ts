/**
 * Attach/detach a stack of shell-fur layers to a CharacterMesh.
 *
 * Shell 0 reuses the existing root mesh (its StandardMaterial is swapped
 * for a fur material at shellIndex=0 — fully opaque, the "skin" layer).
 * Shells 1..N-1 are clones of the root mesh, parented to the root so
 * they inherit its world transform and ride along with the driver. Each
 * clone gets its own fur material with an incrementing shellIndex; the
 * outer shells alpha-cutout against a 3D noise sample, which produces
 * the fluff silhouette.
 *
 * Toggling the fur off restores the original StandardMaterial and
 * disposes the clones + fur materials.
 */
import { type Material, type Mesh, type Scene, type ShaderMaterial } from "@babylonjs/core";
import type { CharacterMesh } from "../character/mesh";
import { createFurMaterial } from "./fur";

export interface FurState {
  /** Cloned meshes for shells 1..N-1. Shell 0 is the root mesh itself. */
  shells: Mesh[];
  /** All fur materials (length = SHELL_COUNT, including shell 0's). */
  furMaterials: ShaderMaterial[];
  /** Original material on root, restored on detach. */
  originalMaterial: Material | null;
}

export const SHELL_COUNT = 8;
/** Babylon meters per shell step. 8 shells × 0.0025 m ≈ 2 cm of fluff. */
export const SHELL_SPACING = 0.0025;

export function attachFurShells(ch: CharacterMesh, scene: Scene): FurState {
  const root = ch.root;
  const originalMaterial = root.material;

  const furMaterials: ShaderMaterial[] = [];
  const shells: Mesh[] = [];

  // Shell 0: opaque skin layer on the root mesh.
  const skinMat = createFurMaterial(scene, {
    shellIndex: 0,
    shellCount: SHELL_COUNT,
    shellSpacing: SHELL_SPACING,
  });
  root.material = skinMat;
  furMaterials.push(skinMat);

  // Shells 1..N-1: alpha-cutout fluff. Two subtleties when cloning a
  // skinned mesh that's already being moved every frame by the driver:
  //   1. Pass doNotCloneChildren = true. Otherwise each clone copies
  //      the previously-attached shells as children → exponential
  //      mesh growth (8 shells → 128 visible meshes).
  //   2. Clone copies root's local TRS (which the driver writes each
  //      frame). After parenting the shell to root, the inherited
  //      local TRS would compose with root's world TRS → the shell
  //      renders at roughly 2× root's offset. Reset the shell's local
  //      transform to identity so its world matrix == root's world
  //      matrix.
  for (let i = 1; i < SHELL_COUNT; i++) {
    const shell = root.clone(`${root.name}_shell${i}`, null, true, false);
    if (!shell) continue;
    shell.parent = root;
    shell.position.set(0, 0, 0);
    shell.rotation.set(0, 0, 0);
    shell.scaling.set(1, 1, 1);
    const mat = createFurMaterial(scene, {
      shellIndex: i,
      shellCount: SHELL_COUNT,
      shellSpacing: SHELL_SPACING,
    });
    shell.material = mat;
    shell.skeleton = root.skeleton;
    shell.numBoneInfluencers = root.numBoneInfluencers;
    shell.isPickable = false;
    furMaterials.push(mat);
    shells.push(shell);
  }

  return { shells, originalMaterial, furMaterials };
}

export function detachFurShells(ch: CharacterMesh, state: FurState): void {
  for (const shell of state.shells) shell.dispose();
  for (const mat of state.furMaterials) mat.dispose();
  ch.root.material = state.originalMaterial;
}
