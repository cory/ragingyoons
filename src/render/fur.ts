/**
 * Shell-fur material.
 *
 * Adapted from `paperGround.ts` with two layers added:
 *   1. Vertex stage skins position+normal using bone influence
 *      (2 influencers, matching mesh.numBoneInfluencers in raccoonMesh.ts),
 *      then displaces along the skinned normal by shellIndex *
 *      shellSpacing — so fur tracks the walker animation.
 *   2. Fragment stage alpha-cutouts against a 3D noise sample so outer
 *      shells thin into wisps.
 *
 * Skinning declarations: matricesIndices/matricesWeights/mBones are
 * declared directly in this shader rather than via Babylon's
 * `#include<bonesDeclaration>` chunk — the include path produced
 * "struct member mBones not found" errors in our context. ShaderMaterial
 * still auto-binds the bone vertex buffers when it sees a skeleton on
 * the mesh (see ShaderMaterial.js "Bones" section), so we deliberately
 * omit "matricesIndices"/"matricesWeights" from the constructor's
 * attributes list to avoid a double-bind / location-collision.
 *
 * mBones is sized to NUM_BONES + 1 to match Babylon's `BonesPerMesh =
 * skeleton.bones.length + 1` convention; the upload via
 * `Skeleton.getTransformMatrices` writes NUM_BONES matrices and leaves
 * the trailing slot zero (we never index it).
 */
import {
  type Mesh,
  type Scene,
  ShaderLanguage,
  ShaderMaterial,
} from "@babylonjs/core";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { NUM_BONES } from "../rig/skeleton";

const BONES_ARRAY_SIZE = NUM_BONES + 1;

const VERTEX_NAME = "raccoonFurVertexShader";
const FRAGMENT_NAME = "raccoonFurFragmentShader";

const VERTEX_SRC = /* wgsl */ `
attribute position: vec3f;
attribute normal: vec3f;
attribute color: vec4f;
attribute matricesIndices: vec4f;
attribute matricesWeights: vec4f;

uniform world: mat4x4f;
uniform viewProjection: mat4x4f;
uniform cameraPosition: vec3f;
uniform mBones: array<mat4x4f, ${BONES_ARRAY_SIZE}>;
uniform uShellIndex: f32;
uniform uShellCount: f32;
uniform uShellSpacing: f32;

varying vWorldPos: vec3f;
varying vNormal: vec3f;
varying vShellT: f32;
varying vViewDir: vec3f;
varying vLocalPos: vec3f;
varying vColor: vec3f;
varying vFurAmount: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  // 2-influencer skinning. Mesh's matricesIndices/Weights buffers are
  // vec4 (Babylon-padded), but only the first 2 components carry data
  // for our soft-skinned body / single-bone rigid parts.
  let i0 = i32(vertexInputs.matricesIndices[0]);
  let i1 = i32(vertexInputs.matricesIndices[1]);
  let w0 = vertexInputs.matricesWeights[0];
  let w1 = vertexInputs.matricesWeights[1];
  let influence = uniforms.mBones[i0] * w0 + uniforms.mBones[i1] * w1;

  let skinnedPos = (influence * vec4f(vertexInputs.position, 1.0)).xyz;
  let skinnedNormal = normalize((influence * vec4f(vertexInputs.normal, 0.0)).xyz);

  let denom = max(1.0, uniforms.uShellCount - 1.0);
  let shellT = uniforms.uShellIndex / denom;

  // color.a doubles as per-vertex fur mask (set in raccoonMesh.ts).
  // Eyes get 0 → no shell offset, no cutout in the fragment stage →
  // they render as flat discs across all shells (only visible from the
  // innermost; outer shells stack on top so the eye stays sharp).
  let furAmount = vertexInputs.color.a;

  let offsetPos = skinnedPos + skinnedNormal * (uniforms.uShellIndex * uniforms.uShellSpacing * furAmount);

  let worldPos = uniforms.world * vec4f(offsetPos, 1.0);
  vertexOutputs.position = uniforms.viewProjection * worldPos;
  vertexOutputs.vWorldPos = worldPos.xyz;
  vertexOutputs.vNormal = (uniforms.world * vec4f(skinnedNormal, 0.0)).xyz;
  vertexOutputs.vShellT = shellT;
  vertexOutputs.vViewDir = uniforms.cameraPosition - worldPos.xyz;
  // Sample noise in REST-POSE mesh-local space (the raw vertex position
  // before bone influence), not in skinned space. Skinned position
  // changes as bones rotate, so noise sampled there shifts under the
  // surface → strands appear to swim. Rest-pose position is constant
  // per vertex, so each strand stays pinned to a specific spot on the
  // body and rides the deformation along with it.
  vertexOutputs.vLocalPos = vertexInputs.position;
  vertexOutputs.vColor = vertexInputs.color.rgb;
  vertexOutputs.vFurAmount = furAmount;
}
`;

const FRAGMENT_SRC = /* wgsl */ `
varying vWorldPos: vec3f;
varying vNormal: vec3f;
varying vShellT: f32;
varying vViewDir: vec3f;
varying vLocalPos: vec3f;
varying vColor: vec3f;
varying vFurAmount: f32;

uniform uNoiseFreq: f32;
uniform uTipDarken: f32;
uniform uRimColor: vec3f;
uniform uRimStrength: f32;

fn hash3(p: vec3f) -> f32 {
  return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
}

fn noise3(p: vec3f) -> f32 {
  let i = floor(p);
  let f0 = fract(p);
  let f = f0 * f0 * f0 * (f0 * (f0 * 6.0 - 15.0) + 10.0);
  let n000 = hash3(i);
  let n100 = hash3(i + vec3f(1.0, 0.0, 0.0));
  let n010 = hash3(i + vec3f(0.0, 1.0, 0.0));
  let n110 = hash3(i + vec3f(1.0, 1.0, 0.0));
  let n001 = hash3(i + vec3f(0.0, 0.0, 1.0));
  let n101 = hash3(i + vec3f(1.0, 0.0, 1.0));
  let n011 = hash3(i + vec3f(0.0, 1.0, 1.0));
  let n111 = hash3(i + vec3f(1.0, 1.0, 1.0));
  let nx00 = mix(n000, n100, f.x);
  let nx10 = mix(n010, n110, f.x);
  let nx01 = mix(n001, n101, f.x);
  let nx11 = mix(n011, n111, f.x);
  let nxy0 = mix(nx00, nx10, f.y);
  let nxy1 = mix(nx01, nx11, f.y);
  return mix(nxy0, nxy1, f.z);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  var N = normalize(fragmentInputs.vNormal);
  let V = normalize(fragmentInputs.vViewDir);
  if (dot(N, V) < 0.0) { N = -N; }

  let strand = noise3(fragmentInputs.vLocalPos * uniforms.uNoiseFreq);

  // Outer shells cull more aggressively → wispier fluff edge. Shell 0
  // (vShellT = 0) is fully opaque (the skin underneath). vFurAmount=0
  // (eyes) skips the cutout entirely so eye discs render across every
  // shell — they stay sharp under fur. Cap the max cutoff at 0.85
  // (instead of ~0.95): keeps enough strands passing on the outermost
  // shell so we don't get visible holes in the fluff at long lengths.
  let cutoff = mix(0.05, 0.85, fragmentInputs.vShellT);
  if (fragmentInputs.vFurAmount > 0.5 && fragmentInputs.vShellT > 0.0 && strand < cutoff) {
    discard;
  }

  let L = normalize(vec3f(0.3, 0.4, 1.0));
  let wrap = pow(dot(N, L) * 0.5 + 0.5, 1.4);
  // AO + tip darkening only affect actual fur — eyes (furAmount=0)
  // keep their full vertex color across shells.
  let ao = mix(mix(1.0, 0.55, fragmentInputs.vFurAmount), 1.0, fragmentInputs.vShellT);
  let tip = 1.0 - uniforms.uTipDarken * fragmentInputs.vShellT * fragmentInputs.vFurAmount;

  var col = fragmentInputs.vColor * (0.55 + 0.45 * wrap) * ao * tip;

  let nv = clamp(dot(N, V), 0.0, 1.0);
  let fres = pow(1.0 - nv, 2.4);
  col = col + uniforms.uRimColor * (fres * uniforms.uRimStrength);

  fragmentOutputs.color = vec4f(col, 1.0);
}
`;

let registered = false;
function registerShaders(): void {
  if (registered) return;
  ShaderStore.ShadersStoreWGSL[VERTEX_NAME] = VERTEX_SRC;
  ShaderStore.ShadersStoreWGSL[FRAGMENT_NAME] = FRAGMENT_SRC;
  registered = true;
}

export interface FurMaterialOpts {
  shellIndex: number;
  shellCount: number;
  /** World-space (babylon meters) spacing between adjacent shells. */
  shellSpacing: number;
  /** Strand frequency in 1/(walker units of mesh-local position). Higher = finer. */
  noiseFreq?: number;
  /** Tip-darken amount in [0,1]; positive darkens, negative lightens. */
  tipDarken?: number;
  /** Rim color & strength for the fluff edge highlight. */
  rimColor?: [number, number, number];
  rimStrength?: number;
}

export function createFurMaterial(scene: Scene, opts: FurMaterialOpts): ShaderMaterial {
  registerShaders();

  const mat = new ShaderMaterial(
    `raccoonFur_s${opts.shellIndex}`,
    scene,
    "raccoonFur",
    {
      // Bone vertex attributes (matricesIndices, matricesWeights) are
      // auto-added by ShaderMaterial when it detects the mesh skeleton —
      // listing them here would double-bind and break the pipeline.
      attributes: ["position", "normal"],
      uniforms: [
        "world",
        "viewProjection",
        "cameraPosition",
        "mBones",
        "uShellIndex",
        "uShellCount",
        "uShellSpacing",
        "uNoiseFreq",
        "uTipDarken",
        "uRimColor",
        "uRimStrength",
      ],
      shaderLanguage: ShaderLanguage.WGSL,
    },
  );

  mat.setFloat("uShellIndex", opts.shellIndex);
  mat.setFloat("uShellCount", opts.shellCount);
  mat.setFloat("uShellSpacing", opts.shellSpacing);
  mat.setFloat("uNoiseFreq", opts.noiseFreq ?? 90.0);
  mat.setFloat("uTipDarken", opts.tipDarken ?? 0.18);
  const rc = opts.rimColor ?? [0.95, 0.9, 0.78];
  mat.setColor3("uRimColor", { r: rc[0], g: rc[1], b: rc[2] } as never);
  mat.setFloat("uRimStrength", opts.rimStrength ?? 0.35);

  mat.backFaceCulling = true;

  // Per-frame bone-matrix upload. ShaderMaterial doesn't auto-upload
  // bones the way StandardMaterial does, so we hook onBindObservable
  // and push the skeleton's transform matrices via the underlying
  // Effect (Float32Array path — ShaderMaterial.setMatrices wants a
  // Matrix[] copy).
  mat.onBindObservable.add((mesh) => {
    const skel = (mesh as Mesh).skeleton;
    if (!skel) return;
    const effect = mat.getEffect();
    if (!effect) return;
    effect.setMatrices("mBones", skel.getTransformMatrices(mesh as Mesh));
  });

  return mat;
}
