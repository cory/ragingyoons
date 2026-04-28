import {
  Effect,
  type Mesh,
  MeshBuilder,
  Scene,
  ShaderMaterial,
} from "@babylonjs/core";

// Deep-space backdrop on a sphere skydome. Procedural — no texture downloads.
// Three star size layers with twinkle, soft FBM nebula tints, Milky Way band.

const VERTEX = /* glsl */ `
  precision highp float;
  attribute vec3 position;
  uniform mat4 worldViewProjection;
  varying vec3 vDir;
  void main(void) {
    gl_Position = worldViewProjection * vec4(position, 1.0);
    vDir = position;
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec3 vDir;
  uniform float time;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i + vec3(0.0,0.0,0.0)), hash(i + vec3(1.0,0.0,0.0)), f.x),
          mix(hash(i + vec3(0.0,1.0,0.0)), hash(i + vec3(1.0,1.0,0.0)), f.x), f.y),
      mix(mix(hash(i + vec3(0.0,0.0,1.0)), hash(i + vec3(1.0,0.0,1.0)), f.x),
          mix(hash(i + vec3(0.0,1.0,1.0)), hash(i + vec3(1.0,1.0,1.0)), f.x), f.y),
      f.z);
  }

  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.55;
    for (int i = 0; i < 5; i++) {
      v += a * vnoise(p);
      p *= 2.07;
      a *= 0.5;
    }
    return v;
  }

  float starLayer(vec3 dir, float density, float threshold, float seed) {
    vec3 sp = floor(dir * density);
    vec3 fp = fract(dir * density) - 0.5;
    float h = fract(sin(dot(sp, vec3(12.9898, 78.233, 45.164)) + seed) * 43758.5453);
    float r = length(fp);
    return smoothstep(0.05, 0.0, r) * smoothstep(threshold, 1.0, h);
  }

  void main(void) {
    vec3 dir = normalize(vDir);

    vec3 col = vec3(0.012, 0.015, 0.05);

    float n1 = fbm(dir * 2.0);
    float n2 = fbm(dir * 0.7 + vec3(11.0, 5.0, 3.0));
    vec3 nebulaCool = vec3(0.07, 0.13, 0.32);
    vec3 nebulaWarm = vec3(0.32, 0.08, 0.22);
    col = mix(col, nebulaCool, smoothstep(0.45, 0.85, n1) * 0.45);
    col = mix(col, nebulaWarm, smoothstep(0.55, 0.9, n2) * 0.32);

    vec3 mwAxis = normalize(vec3(0.4, 0.85, 0.35));
    float mwBand = 1.0 - abs(dot(dir, mwAxis));
    mwBand = smoothstep(0.85, 1.0, mwBand);
    col += mwBand * vec3(0.1, 0.07, 0.18) * 0.6;

    float s1 = starLayer(dir, 380.0, 0.997, 1.0);
    float s2 = starLayer(dir, 200.0, 0.9985, 2.5);
    float s3 = starLayer(dir, 90.0, 0.998, 5.0);

    float twink1 = 0.7 + 0.3 * sin(time * 2.0 + s1 * 50.0);
    float twink2 = 0.6 + 0.4 * sin(time * 2.7 + s2 * 30.0);

    col += vec3(0.85, 0.9, 1.0) * s1 * twink1 * 0.75;
    col += vec3(1.0, 0.95, 0.78) * s2 * twink2;
    col += vec3(1.0, 0.82, 0.6) * s3 * 1.5;

    col += vec3(1.0) * mwBand * (s1 + s2) * 0.5;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export interface SkyHandle {
  mesh: Mesh;
  material: ShaderMaterial;
}

export function buildSky(scene: Scene): SkyHandle {
  Effect.ShadersStore["spaceSkyVertexShader"] = VERTEX;
  Effect.ShadersStore["spaceSkyFragmentShader"] = FRAGMENT;

  const mesh = MeshBuilder.CreateSphere(
    "skyDome",
    { diameter: 1000, segments: 24 },
    scene
  );
  mesh.infiniteDistance = true;
  mesh.isPickable = false;
  mesh.applyFog = false;

  const material = new ShaderMaterial("spaceSkyMat", scene, "spaceSky", {
    attributes: ["position"],
    uniforms: ["worldViewProjection", "time"],
  });
  material.backFaceCulling = false;
  material.disableDepthWrite = true;
  mesh.material = material;
  mesh.renderingGroupId = 0;

  const t0 = performance.now();
  scene.onBeforeRenderObservable.add(() => {
    material.setFloat("time", (performance.now() - t0) / 1000);
  });

  return { mesh, material };
}
