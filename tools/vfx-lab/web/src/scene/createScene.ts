import {
  ArcRotateCamera,
  Color4,
  Engine,
  Scene,
  Vector3,
} from "@babylonjs/core";
import { buildArena } from "./arena";
import { buildSurrounds } from "./surrounds";
import { buildSky } from "./sky";
import { buildLighting, type LightingRig } from "./lighting";

export interface SceneHandles {
  engine: Engine;
  scene: Scene;
  camera: ArcRotateCamera;
  lighting: LightingRig;
  dispose: () => void;
}

export function createScene(canvas: HTMLCanvasElement): SceneHandles {
  const engine = new Engine(canvas, true, { stencil: true, antialias: true });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(0.04, 0.04, 0.08, 1);

  const camera = new ArcRotateCamera(
    "cam",
    -Math.PI / 2,
    Math.PI / 3,
    24,
    Vector3.Zero(),
    scene
  );
  camera.upVector = new Vector3(0, 0, 1);
  camera.setTarget(Vector3.Zero());
  camera.attachControl(canvas, true);
  camera.lowerBetaLimit = 0.1;
  camera.upperBetaLimit = Math.PI / 2 - 0.05;
  camera.lowerRadiusLimit = 5;
  camera.upperRadiusLimit = 200;
  camera.wheelPrecision = 30;
  camera.panningSensibility = 80;

  const sky = buildSky(scene);
  const lighting = buildLighting(scene, sky);
  buildArena(scene, lighting.shadow);
  buildSurrounds(scene);

  engine.runRenderLoop(() => scene.render());
  const onResize = () => engine.resize();
  window.addEventListener("resize", onResize);

  const dispose = () => {
    window.removeEventListener("resize", onResize);
    scene.dispose();
    engine.dispose();
  };

  return { engine, scene, camera, lighting, dispose };
}
