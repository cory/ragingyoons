import { MeshBuilder, Scene } from "@babylonjs/core";
import { SkyMaterial } from "@babylonjs/materials";

export function buildSky(scene: Scene): SkyMaterial {
  const sky = MeshBuilder.CreateBox("skyBox", { size: 1000 }, scene);
  sky.isPickable = false;
  sky.infiniteDistance = true;
  const mat = new SkyMaterial("skyMat", scene);
  mat.backFaceCulling = false;
  mat.luminance = 0.5;
  mat.turbidity = 8;
  mat.rayleigh = 2;
  mat.useSunPosition = false;
  mat.inclination = 0.4;
  mat.azimuth = 0.25;
  sky.material = mat;
  return mat;
}
