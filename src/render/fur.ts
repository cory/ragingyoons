/**
 * Shell-fur material — v0, NO SKINNING.
 *
 * Adapted minimally from `paperGround.ts` (the proven WGSL
 * ShaderMaterial in this project): same shader-store registration,
 * same uniform pattern. The only changes are (a) the vertex stage
 * displaces position outward along the normal by shellIndex *
 * shellSpacing, and (b) the fragment stage alpha-cutouts against a 3D
 * noise sample so outer shells thin into wisps.
 *
 * Skinning is intentionally not wired here — meshes will render in
 * rest pose with fur on. Once the fur look is validated, we adapt the
 * vertex stage to skin position+normal before applying the shell
 * offset (separate change, separate test).
 */
import {
  type Scene,
  ShaderLanguage,
  ShaderMaterial,
} from "@babylonjs/core";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";

const VERTEX_NAME = "raccoonFurVertexShader";
const FRAGMENT_NAME = "raccoonFurFragmentShader";

const VERTEX_SRC = /* wgsl */ `
attribute position: vec3f;
attribute normal: vec3f;

uniform world: mat4x4f;
uniform viewProjection: mat4x4f;
uniform cameraPosition: vec3f;
uniform uShellIndex: f32;
uniform uShellCount: f32;
uniform uShellSpacing: f32;

varying vWorldPos: vec3f;
varying vNormal: vec3f;
varying vShellT: f32;
varying vViewDir: vec3f;
varying vLocalPos: vec3f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let denom = max(1.0, uniforms.uShellCount - 1.0);
  let shellT = uniforms.uShellIndex / denom;

  // Push outward along the mesh-local normal. Mesh-local space is fine
  // here because no skinning yet — the rest-pose normals are the only
  // normals we have.
  let localPos = vertexInputs.position + vertexInputs.normal * (uniforms.uShellIndex * uniforms.uShellSpacing);

  let worldPos = uniforms.world * vec4f(localPos, 1.0);
  vertexOutputs.position = uniforms.viewProjection * worldPos;
  vertexOutputs.vWorldPos = worldPos.xyz;
  vertexOutputs.vNormal = (uniforms.world * vec4f(vertexInputs.normal, 0.0)).xyz;
  vertexOutputs.vShellT = shellT;
  vertexOutputs.vViewDir = uniforms.cameraPosition - worldPos.xyz;
  vertexOutputs.vLocalPos = vertexInputs.position;
}
`;

const FRAGMENT_SRC = /* wgsl */ `
varying vWorldPos: vec3f;
varying vNormal: vec3f;
varying vShellT: f32;
varying vViewDir: vec3f;
varying vLocalPos: vec3f;

uniform uBaseColor: vec3f;
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
  // (vShellT = 0) is fully opaque (the skin underneath).
  let cutoff = fragmentInputs.vShellT * 0.9 + 0.05;
  if (fragmentInputs.vShellT > 0.0 && strand < cutoff) {
    discard;
  }

  let L = normalize(vec3f(0.3, 0.4, 1.0));
  let wrap = pow(dot(N, L) * 0.5 + 0.5, 1.4);
  let ao = mix(0.55, 1.0, fragmentInputs.vShellT);
  let tip = 1.0 - uniforms.uTipDarken * fragmentInputs.vShellT;

  var col = uniforms.uBaseColor * (0.55 + 0.45 * wrap) * ao * tip;

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
  /** RGB base color of the fur. Defaults to a warm raccoon brown. */
  baseColor?: [number, number, number];
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
      attributes: ["position", "normal"],
      uniforms: [
        "world",
        "viewProjection",
        "cameraPosition",
        "uShellIndex",
        "uShellCount",
        "uShellSpacing",
        "uBaseColor",
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
  const bc = opts.baseColor ?? [0.42, 0.36, 0.30];
  mat.setColor3("uBaseColor", { r: bc[0], g: bc[1], b: bc[2] } as never);
  mat.setFloat("uNoiseFreq", opts.noiseFreq ?? 90.0);
  mat.setFloat("uTipDarken", opts.tipDarken ?? 0.18);
  const rc = opts.rimColor ?? [0.95, 0.9, 0.78];
  mat.setColor3("uRimColor", { r: rc[0], g: rc[1], b: rc[2] } as never);
  mat.setFloat("uRimStrength", opts.rimStrength ?? 0.35);

  mat.backFaceCulling = true;

  return mat;
}
