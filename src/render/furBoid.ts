/**
 * Shell-fur material for the boid render path.
 *
 * Differs from `fur.ts` (track mode) in two ways:
 *   1. **VAT sampling** instead of skeleton uniforms. The boid body is
 *      animated by a Vertex Animation Texture (RGBA32F, 4 texels per
 *      bone matrix per frame). We sample 2 bone influences from the
 *      texture and compose the influence matrix manually — same shape
 *      as the track-mode skinning math, but matrices come from the
 *      texture instead of `mBones[]`.
 *   2. **Thin-instance world matrix** instead of a single `world`
 *      uniform. Each boid carries its world TRS in the per-instance
 *      `world0/1/2/3` vec4 attributes; the source mesh's `world`
 *      uniform composes on top (Babylon convention for thin instances).
 *
 * Per-instance VAT settings (`bakedVertexAnimationSettingsInstanced =
 * vec4(fromFrame, toFrame, phaseFrames, fps)`) come from the boid sim's
 * animBuffer. Boids set `fps = 0` so the per-instance phase drives
 * playback directly; the global `bakedVertexAnimationTime` only matters
 * when fps > 0. We still declare it so the shader matches Babylon's
 * canonical VAT formula and behaves correctly if any caller ever
 * provides a non-zero fps.
 *
 * RH Z-up world. Vertex color attribute carries the per-band raccoon
 * palette (RGB) and the per-vertex fur mask (alpha).
 */
import {
  type Mesh,
  type Scene,
  ShaderLanguage,
  ShaderMaterial,
} from "@babylonjs/core";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";

const VERTEX_NAME = "raccoonFurBoidVertexShader";
const FRAGMENT_NAME = "raccoonFurBoidFragmentShader";

const VERTEX_SRC = /* wgsl */ `
attribute position: vec3f;
attribute normal: vec3f;
attribute color: vec4f;
#if NUM_BONE_INFLUENCERS>0
attribute matricesIndices: vec4f;
attribute matricesWeights: vec4f;
#endif
#ifdef INSTANCES
attribute world0: vec4f;
attribute world1: vec4f;
attribute world2: vec4f;
attribute world3: vec4f;
#ifdef BAKED_VERTEX_ANIMATION_TEXTURE
attribute bakedVertexAnimationSettingsInstanced: vec4f;
#endif
#endif

uniform world: mat4x4f;
uniform viewProjection: mat4x4f;
uniform cameraPosition: vec3f;
#ifdef BAKED_VERTEX_ANIMATION_TEXTURE
uniform bakedVertexAnimationTime: f32;
#endif
uniform uShellIndex: f32;
uniform uShellCount: f32;
uniform uShellSpacing: f32;

#ifdef BAKED_VERTEX_ANIMATION_TEXTURE
var bakedVertexAnimationTexture: texture_2d<f32>;
#endif

varying vWorldPos: vec3f;
varying vNormal: vec3f;
varying vShellT: f32;
varying vViewDir: vec3f;
varying vLocalPos: vec3f;
varying vColor: vec3f;
varying vFurAmount: f32;

#ifdef BAKED_VERTEX_ANIMATION_TEXTURE
fn readMatrixFromVAT(smp: texture_2d<f32>, boneIndex: f32, frame: f32) -> mat4x4<f32> {
  let offset = i32(boneIndex) * 4;
  let frameUV = i32(frame);
  let m0 = textureLoad(smp, vec2<i32>(offset + 0, frameUV), 0);
  let m1 = textureLoad(smp, vec2<i32>(offset + 1, frameUV), 0);
  let m2 = textureLoad(smp, vec2<i32>(offset + 2, frameUV), 0);
  let m3 = textureLoad(smp, vec2<i32>(offset + 3, frameUV), 0);
  return mat4x4<f32>(m0, m1, m2, m3);
}
#endif

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  // VAT skinning. When the engine compiles this shader for a draw that
  // doesn't have instances (e.g., a transient state where the boid
  // body has zero thinInstanceCount), Babylon doesn't bind the VAT
  // attribute and the #ifdef path falls back to rest-pose so we still
  // produce a valid pipeline.
  var influence: mat4x4<f32>;
#if defined(INSTANCES) && defined(BAKED_VERTEX_ANIMATION_TEXTURE)
  let vatStart = vertexInputs.bakedVertexAnimationSettingsInstanced.x;
  let vatEnd   = vertexInputs.bakedVertexAnimationSettingsInstanced.y;
  let vatPhase = vertexInputs.bakedVertexAnimationSettingsInstanced.z;
  let vatSpeed = vertexInputs.bakedVertexAnimationSettingsInstanced.w;

  // Match Babylon's canonical VAT frame computation (bakedVertexAnimation
  // include) so behavior stays consistent if/when fps != 0.
  let totalFrames = vatEnd - vatStart + 1.0;
  let time = uniforms.bakedVertexAnimationTime * vatSpeed / totalFrames;
  let frameCorrection = select(1.0, 0.0, time < 1.0);
  let numOfFrames = totalFrames - frameCorrection;
  var frameNum = fract(time) * numOfFrames;
  frameNum = (frameNum + vatPhase) % numOfFrames;
  frameNum = floor(frameNum);
  frameNum = frameNum + vatStart + frameCorrection;

  let i0 = vertexInputs.matricesIndices[0];
  let i1 = vertexInputs.matricesIndices[1];
  let w0 = vertexInputs.matricesWeights[0];
  let w1 = vertexInputs.matricesWeights[1];
  influence  = readMatrixFromVAT(bakedVertexAnimationTexture, i0, frameNum) * w0;
  influence += readMatrixFromVAT(bakedVertexAnimationTexture, i1, frameNum) * w1;
#else
  influence = mat4x4<f32>(
    vec4f(1.0, 0.0, 0.0, 0.0),
    vec4f(0.0, 1.0, 0.0, 0.0),
    vec4f(0.0, 0.0, 1.0, 0.0),
    vec4f(0.0, 0.0, 0.0, 1.0),
  );
#endif

  let skinnedPos = (influence * vec4f(vertexInputs.position, 1.0)).xyz;
  let skinnedNormal = normalize((influence * vec4f(vertexInputs.normal, 0.0)).xyz);

  let denom = max(1.0, uniforms.uShellCount - 1.0);
  let shellT = uniforms.uShellIndex / denom;
  let furAmount = vertexInputs.color.a;

  let offsetPos = skinnedPos + skinnedNormal * (uniforms.uShellIndex * uniforms.uShellSpacing * furAmount);

  // Compose source mesh world matrix with per-instance world matrix
  // (matches Babylon's instancesVertex include for THIN_INSTANCES).
#ifdef INSTANCES
  let instanceWorld = mat4x4<f32>(
    vertexInputs.world0,
    vertexInputs.world1,
    vertexInputs.world2,
    vertexInputs.world3,
  );
  let finalWorld = uniforms.world * instanceWorld;
#else
  let finalWorld = uniforms.world;
#endif

  let worldPos = finalWorld * vec4f(offsetPos, 1.0);
  vertexOutputs.position = uniforms.viewProjection * worldPos;
  vertexOutputs.vWorldPos = worldPos.xyz;
  vertexOutputs.vNormal = (finalWorld * vec4f(skinnedNormal, 0.0)).xyz;
  vertexOutputs.vShellT = shellT;
  vertexOutputs.vViewDir = uniforms.cameraPosition - worldPos.xyz;
  // Sample noise in REST-pose mesh-local space (constant per vertex)
  // so strands stick to the body and ride deformations with it.
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

  let cutoff = mix(0.05, 0.85, fragmentInputs.vShellT);
  if (fragmentInputs.vFurAmount > 0.5 && fragmentInputs.vShellT > 0.0 && strand < cutoff) {
    discard;
  }

  let L = normalize(vec3f(0.3, 0.4, 1.0));
  let wrap = pow(dot(N, L) * 0.5 + 0.5, 1.4);
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

export interface FurBoidMaterialOpts {
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
  /** Mesh whose `bakedVertexAnimationManager.time` should drive this
   *  shell's VAT time uniform. Boids set per-instance fps=0 so this is
   *  effectively unused, but we wire it for completeness. */
  driverMesh?: Mesh;
}

export function createFurBoidMaterial(scene: Scene, opts: FurBoidMaterialOpts): ShaderMaterial {
  registerShaders();

  const mat = new ShaderMaterial(
    `raccoonFurBoid_s${opts.shellIndex}`,
    scene,
    "raccoonFurBoid",
    {
      // Bone vertex attributes (matricesIndices, matricesWeights) are
      // auto-added by ShaderMaterial when it sees a skeleton on the
      // mesh. world0/1/2/3 + bakedVertexAnimationSettingsInstanced are
      // auto-added when INSTANCES + BAKED_VERTEX_ANIMATION_TEXTURE
      // defines are set. We pass those defines so Babylon binds the
      // thin-instance + VAT buffers without us having to list them
      // here (avoids the location-collision trap from track mode).
      attributes: ["position", "normal", "color"],
      uniforms: [
        "world",
        "viewProjection",
        "cameraPosition",
        "bakedVertexAnimationTime",
        "uShellIndex",
        "uShellCount",
        "uShellSpacing",
        "uNoiseFreq",
        "uTipDarken",
        "uRimColor",
        "uRimStrength",
      ],
      samplers: ["bakedVertexAnimationTexture"],
      // Don't force INSTANCES / BAKED_VERTEX_ANIMATION_TEXTURE here —
      // ShaderMaterial sets them automatically based on the mesh's
      // actual state at draw time (useInstances flag + bvaManager
      // presence). Forcing them on would cause the shader to expect
      // attributes that the pipeline doesn't always bind.
      shaderLanguage: ShaderLanguage.WGSL,
    },
  );

  mat.setFloat("uShellIndex", opts.shellIndex);
  mat.setFloat("uShellCount", opts.shellCount);
  mat.setFloat("uShellSpacing", opts.shellSpacing);
  mat.setFloat("uNoiseFreq", opts.noiseFreq ?? 55.0);
  mat.setFloat("uTipDarken", opts.tipDarken ?? 0.18);
  const rc = opts.rimColor ?? [0.95, 0.9, 0.78];
  mat.setColor3("uRimColor", { r: rc[0], g: rc[1], b: rc[2] } as never);
  mat.setFloat("uRimStrength", opts.rimStrength ?? 0.35);

  mat.backFaceCulling = true;

  // Sync per-frame VAT time + texture from the driver body's manager.
  // Boids set per-instance fps=0 so VATTime is a no-op; we still push
  // it so any future caller that uses fps>0 sees correct playback.
  const driver = opts.driverMesh ?? null;
  mat.onBindObservable.add(() => {
    if (!driver) return;
    const mgr = driver.bakedVertexAnimationManager;
    if (!mgr) return;
    const effect = mat.getEffect();
    if (!effect) return;
    effect.setFloat("bakedVertexAnimationTime", mgr.time);
    if (mgr.texture) {
      effect.setTexture("bakedVertexAnimationTexture", mgr.texture);
    }
  });

  return mat;
}
