/**
 * First slice of the paper-textures port: ground-disc only.
 *
 * Custom WGSL ShaderMaterial that adds anisotropic fiber noise + a
 * subtle Fresnel rim on top of a half-Lambert base. No skinning, no
 * thin instances — just validation that we can author WGSL in this
 * Babylon stack and have it compile, render, and read as paper.
 *
 * Once this looks right, the same noise / rim machinery moves into the
 * character material (which adds skinning + per-instance color).
 */
import {
  Color3,
  type Scene,
  ShaderLanguage,
  ShaderMaterial,
} from "@babylonjs/core";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";

const VERTEX_NAME = "paperGroundVertexShader";
const FRAGMENT_NAME = "paperGroundFragmentShader";

const VERTEX_SRC = /* wgsl */ `
attribute position: vec3f;
attribute normal: vec3f;
attribute uv: vec2f;

uniform world: mat4x4f;
uniform viewProjection: mat4x4f;
uniform cameraPosition: vec3f;

varying vWorldPos: vec3f;
varying vNormal: vec3f;
varying vUV: vec2f;
varying vViewDir: vec3f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let worldPos = uniforms.world * vec4f(vertexInputs.position, 1.0);
  vertexOutputs.position = uniforms.viewProjection * worldPos;
  vertexOutputs.vWorldPos = worldPos.xyz;
  vertexOutputs.vNormal = (uniforms.world * vec4f(vertexInputs.normal, 0.0)).xyz;
  vertexOutputs.vUV = vertexInputs.uv;
  vertexOutputs.vViewDir = uniforms.cameraPosition - worldPos.xyz;
}
`;

const FRAGMENT_SRC = /* wgsl */ `
varying vWorldPos: vec3f;
varying vNormal: vec3f;
varying vUV: vec2f;
varying vViewDir: vec3f;

uniform uBase: vec3f;
uniform uFiberFreq: vec2f;
uniform uFiberAmp: f32;
uniform uRimStrength: f32;
uniform uRimColor: vec3f;

fn paperHash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn paperVnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f0 = fract(p);
  // Quintic smoothstep — much less visible grid alignment than cubic.
  let f = f0 * f0 * f0 * (f0 * (f0 * 6.0 - 15.0) + 10.0);
  return mix(
    mix(paperHash(i), paperHash(i + vec2f(1.0, 0.0)), f.x),
    mix(paperHash(i + vec2f(0.0, 1.0)), paperHash(i + vec2f(1.0, 1.0)), f.x),
    f.y
  );
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  // Flip the geometric normal toward the viewer if needed. CreateDisc's
  // generated normal sign isn't reliable in our RH Z-up world, and the
  // ground is double-sided anyway — we always want the lit side to face
  // wherever the camera is.
  let V = normalize(fragmentInputs.vViewDir);
  var N = normalize(fragmentInputs.vNormal);
  if (dot(N, V) < 0.0) { N = -N; }

  // Half-Lambert against +Z sky direction (matches our HemisphericLight).
  let L = normalize(vec3f(0.3, 0.4, 1.0));
  let wrap = pow(dot(N, L) * 0.5 + 0.5, 1.4);
  var col = uniforms.uBase * (0.7 + 0.35 * wrap);

  // Anisotropic fiber. Sample world-XY (the ground lives in XY) so the
  // grain aligns with the world, not the disc's polar UVs (which would
  // produce visible radial seams).
  let q = fragmentInputs.vWorldPos.xy * uniforms.uFiberFreq;
  let n = paperVnoise(q) - 0.5;

  // Auto-derive fiber direction from base luminance: dark bases get
  // bright fibers, light bases get dark fibers — visible against
  // either underground.
  let baseLuma = dot(uniforms.uBase, vec3f(0.299, 0.587, 0.114));
  let fiberSign = mix(1.0, -1.0, smoothstep(0.18, 0.45, baseLuma));
  col = col + n * uniforms.uFiberAmp * fiberSign * 0.07;

  // Fresnel rim toward warm cream — brings up the disc edges where the
  // ground meets the fog-paper background.
  let nv = clamp(dot(N, V), 0.0, 1.0);
  let fres = pow(1.0 - nv, 2.6);
  col = mix(col, uniforms.uRimColor, fres * 0.5 * uniforms.uRimStrength);

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

export interface PaperGroundOpts {
  base?: Color3;
  fiberFreq?: [number, number];
  fiberAmp?: number;
  rimStrength?: number;
  rimColor?: Color3;
}

export function createPaperGroundMaterial(
  scene: Scene,
  opts: PaperGroundOpts = {},
): ShaderMaterial {
  registerShaders();

  const mat = new ShaderMaterial(
    "paperGround",
    scene,
    "paperGround",
    {
      attributes: ["position", "normal", "uv"],
      uniforms: [
        "world",
        "viewProjection",
        "cameraPosition",
        "uBase",
        "uFiberFreq",
        "uFiberAmp",
        "uRimStrength",
        "uRimColor",
      ],
      shaderLanguage: ShaderLanguage.WGSL,
    },
  );

  const base = opts.base ?? new Color3(0.91, 0.886, 0.836);
  const fiberFreq = opts.fiberFreq ?? [4.0, 0.4];
  const rimColor = opts.rimColor ?? new Color3(1.0, 0.96, 0.88);

  mat.setColor3("uBase", base);
  mat.setVector2("uFiberFreq", { x: fiberFreq[0], y: fiberFreq[1] });
  mat.setFloat("uFiberAmp", opts.fiberAmp ?? 1.4);
  mat.setFloat("uRimStrength", opts.rimStrength ?? 0.4);
  mat.setColor3("uRimColor", rimColor);

  // Ground sits below everything; we don't need backface culling but
  // also don't need to fight depth.
  mat.backFaceCulling = false;

  return mat;
}
