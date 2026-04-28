import {
  Color3,
  DirectionalLight,
  HemisphericLight,
  Scene,
  ShadowGenerator,
  Vector3,
} from "@babylonjs/core";

// Afternoon lighting fixed for ragingyoons: warm, side-angled, dramatic
// shadows. Independent of any visible sun particle direction.

export interface LightingRig {
  hemi: HemisphericLight;
  sunLight: DirectionalLight;
  shadow: ShadowGenerator;
}

export function buildLighting(scene: Scene): LightingRig {
  const hemi = new HemisphericLight("hemi", new Vector3(0, 0, 1), scene);
  hemi.intensity = 0.55;
  hemi.diffuse = new Color3(1.0, 0.95, 0.85);
  hemi.groundColor = new Color3(0.4, 0.32, 0.25);

  const sunLight = new DirectionalLight(
    "sunLight",
    new Vector3(-0.5, 0.35, -0.85).normalize(),
    scene
  );
  sunLight.position = new Vector3(0, 0, 30);
  sunLight.intensity = 1.25;
  sunLight.diffuse = new Color3(1.0, 0.92, 0.78);
  sunLight.specular = sunLight.diffuse;
  sunLight.shadowEnabled = true;

  const shadow = new ShadowGenerator(1024, sunLight);
  shadow.useBlurExponentialShadowMap = true;
  shadow.blurScale = 2;

  return { hemi, sunLight, shadow };
}
