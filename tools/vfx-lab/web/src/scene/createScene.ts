import {
  ArcRotateCamera,
  Color4,
  Engine,
  Scene,
  Vector3,
} from "@babylonjs/core";
import { buildArena, type Arena } from "./arena";
import { buildSky } from "./sky";
import { buildSun } from "./sun";
import {
  disposeModel,
  getModel,
  loadModel,
  type LoadedModel,
} from "./environment";
import { buildLighting, type LightingRig } from "./lighting";

export interface SceneHandles {
  engine: Engine;
  scene: Scene;
  camera: ArcRotateCamera;
  lighting: LightingRig;
  arena: Arena;
  setEnvironment: (id: string | null) => Promise<void>;
  dispose: () => void;
}

export function createScene(canvas: HTMLCanvasElement): SceneHandles {
  const engine = new Engine(canvas, true, { stencil: true, antialias: true });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(0.07, 0.08, 0.11, 1);

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
  camera.upperRadiusLimit = 400;
  camera.wheelPrecision = 30;
  camera.panningSensibility = 80;

  buildSky(scene);
  buildSun(scene);
  const lighting = buildLighting(scene);
  const arena = buildArena(scene, lighting.shadow);

  let currentEnv: LoadedModel | null = null;
  let pendingEnvId: string | null = null;

  const setEnvironment = async (id: string | null) => {
    pendingEnvId = id;
    if (currentEnv) {
      disposeModel(currentEnv);
      currentEnv = null;
    }
    if (!id) {
      arena.root.position.copyFrom(Vector3.Zero());
      camera.setTarget(Vector3.Zero());
      return;
    }
    const model = getModel(id);
    if (!model) return;

    camera.radius = model.cameraRadius;

    const loaded = await loadModel(scene, model);
    if (scene.isDisposed || pendingEnvId !== id) {
      // Scene torn down or user switched envs while loading; discard.
      if (loaded) disposeModel(loaded);
      return;
    }
    if (loaded) {
      // Auto-fit playfield to top-center of the model's bounding box, with a
      // small lift so the pad doesn't z-fight with the model surface.
      const playfieldPos = new Vector3(
        loaded.bounds.center.x,
        loaded.bounds.center.y,
        loaded.bounds.max.z + 0.5
      );
      arena.root.position.copyFrom(playfieldPos);
      camera.setTarget(playfieldPos.clone());
    }
    currentEnv = loaded;
  };

  engine.runRenderLoop(() => scene.render());
  const onResize = () => engine.resize();
  window.addEventListener("resize", onResize);

  const dispose = () => {
    window.removeEventListener("resize", onResize);
    if (currentEnv) disposeModel(currentEnv);
    scene.dispose();
    engine.dispose();
  };

  return { engine, scene, camera, lighting, arena, setEnvironment, dispose };
}
