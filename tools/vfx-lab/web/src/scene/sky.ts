import {
  Color3,
  Effect,
  Mesh,
  MeshBuilder,
  Scene,
  ShaderMaterial,
  Vector3,
} from "@babylonjs/core";

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
  uniform vec3 sunDir;
  uniform vec3 horizonColor;
  uniform vec3 zenithColor;
  uniform vec3 groundColor;
  uniform vec3 sunColor;
  uniform float cloudiness;
  uniform float starBrightness;
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

  void main(void) {
    vec3 dir = normalize(vDir);
    float elev = dir.z;

    vec3 sky;
    if (elev >= 0.0) {
      float t = pow(elev, 0.65);
      sky = mix(horizonColor, zenithColor, t);
    } else {
      sky = mix(horizonColor, groundColor, pow(-elev, 0.5));
    }

    float sunDot = max(0.0, dot(dir, sunDir));
    float disc = smoothstep(0.9988, 0.9996, sunDot) * 2.0;
    float halo = pow(sunDot, 80.0) * 0.55;
    float bloom = pow(sunDot, 8.0) * 0.18;
    sky += sunColor * (disc + halo + bloom);

    if (elev > 0.02 && cloudiness > 0.0) {
      vec2 cp = vec2(dir.x, dir.y) / max(0.12, dir.z);
      cp *= 1.5;
      cp += vec2(time * 0.018, time * 0.009);
      float c = fbm(vec3(cp, time * 0.04));
      float thresh = mix(0.62, 0.42, cloudiness);
      c = smoothstep(thresh, thresh + 0.18, c);
      float horizonFade = smoothstep(0.05, 0.35, elev);
      vec3 cloudCol = mix(horizonColor * 1.05, vec3(1.0, 0.98, 0.95), 0.7);
      cloudCol = mix(cloudCol, sunColor, halo * 0.5);
      sky = mix(sky, cloudCol, c * cloudiness * horizonFade);
    }

    if (starBrightness > 0.0 && elev > 0.0) {
      vec3 sp = floor(dir * 280.0);
      float h = fract(sin(dot(sp, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
      float star = smoothstep(0.9965, 1.0, h);
      float twinkle = 0.7 + 0.3 * sin(time * 3.0 + h * 50.0);
      sky += vec3(star * twinkle * starBrightness);
    }

    gl_FragColor = vec4(sky, 1.0);
  }
`;

export interface SkyParams {
  sunDir: Vector3;
  horizon: Color3;
  zenith: Color3;
  ground: Color3;
  sun: Color3;
  cloudiness: number;
  starBrightness: number;
}

export interface SkyHandle {
  mesh: Mesh;
  material: ShaderMaterial;
  setParams: (p: SkyParams) => void;
}

export function buildSky(scene: Scene): SkyHandle {
  Effect.ShadersStore["customSkyVertexShader"] = VERTEX;
  Effect.ShadersStore["customSkyFragmentShader"] = FRAGMENT;

  const mesh = MeshBuilder.CreateSphere(
    "skyDome",
    { diameter: 1000, segments: 32 },
    scene
  );
  mesh.isPickable = false;
  mesh.infiniteDistance = true;
  mesh.applyFog = false;

  const material = new ShaderMaterial("skyMat", scene, "customSky", {
    attributes: ["position"],
    uniforms: [
      "worldViewProjection",
      "sunDir",
      "horizonColor",
      "zenithColor",
      "groundColor",
      "sunColor",
      "cloudiness",
      "starBrightness",
      "time",
    ],
  });
  material.backFaceCulling = false;
  material.disableDepthWrite = true;
  mesh.material = material;
  mesh.renderingGroupId = 0;

  const t0 = performance.now();
  scene.onBeforeRenderObservable.add(() => {
    material.setFloat("time", (performance.now() - t0) / 1000);
  });

  const setParams = (p: SkyParams) => {
    material.setVector3("sunDir", p.sunDir);
    material.setColor3("horizonColor", p.horizon);
    material.setColor3("zenithColor", p.zenith);
    material.setColor3("groundColor", p.ground);
    material.setColor3("sunColor", p.sun);
    material.setFloat("cloudiness", p.cloudiness);
    material.setFloat("starBrightness", p.starBrightness);
  };

  return { mesh, material, setParams };
}
