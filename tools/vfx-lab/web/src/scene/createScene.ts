import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  HemisphericLight,
  MeshBuilder,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { GridMaterial } from "@babylonjs/materials";

// World convention: RH, Z-up, X-forward, Y-left.
// Babylon authors meshes Y-up, so the ground plane (XZ by default) is rotated
// +π/2 around X so its normal aligns with +Z.

export interface SceneHandles {
  engine: Engine;
  scene: Scene;
  camera: ArcRotateCamera;
  shadow: ShadowGenerator;
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
  camera.upperRadiusLimit = 100;
  camera.wheelPrecision = 30;
  camera.panningSensibility = 80;

  const hemi = new HemisphericLight("hemi", new Vector3(0, 0, 1), scene);
  hemi.intensity = 0.6;
  hemi.groundColor = new Color3(0.2, 0.18, 0.25);

  const sun = new DirectionalLight("sun", new Vector3(-0.5, -0.4, -1), scene);
  sun.position = new Vector3(20, 15, 30);
  sun.intensity = 1.1;
  const shadow = new ShadowGenerator(1024, sun);
  shadow.useBlurExponentialShadowMap = true;
  shadow.blurScale = 2;

  buildArena(scene);

  engine.runRenderLoop(() => scene.render());
  const onResize = () => engine.resize();
  window.addEventListener("resize", onResize);

  const dispose = () => {
    window.removeEventListener("resize", onResize);
    scene.dispose();
    engine.dispose();
  };

  return { engine, scene, camera, shadow, dispose };
}

function buildArena(scene: Scene) {
  const size = 16;

  const ground = MeshBuilder.CreateGround(
    "ground",
    { width: size, height: size, subdivisions: 1 },
    scene
  );
  ground.rotation.x = Math.PI / 2;
  const grid = new GridMaterial("grid", scene);
  grid.gridRatio = 1;
  grid.majorUnitFrequency = 8;
  grid.mainColor = new Color3(0.08, 0.09, 0.14);
  grid.lineColor = new Color3(0.35, 0.4, 0.55);
  grid.minorUnitVisibility = 0.45;
  grid.opacity = 0.999;
  ground.material = grid;
  ground.receiveShadows = true;

  const pawn = MeshBuilder.CreateBox("pawn", { size: 1 }, scene);
  pawn.position = new Vector3(0, 0, 0.5);
  const pawnMat = new StandardMaterial("pawnMat", scene);
  pawnMat.diffuseColor = new Color3(0.6, 0.5, 0.4);
  pawn.material = pawnMat;

  const axisLen = 2;
  const axisX = MeshBuilder.CreateLines(
    "axisX",
    { points: [Vector3.Zero(), new Vector3(axisLen, 0, 0)] },
    scene
  );
  axisX.color = new Color3(1, 0.3, 0.3);
  const axisY = MeshBuilder.CreateLines(
    "axisY",
    { points: [Vector3.Zero(), new Vector3(0, axisLen, 0)] },
    scene
  );
  axisY.color = new Color3(0.3, 1, 0.3);
  const axisZ = MeshBuilder.CreateLines(
    "axisZ",
    { points: [Vector3.Zero(), new Vector3(0, 0, axisLen)] },
    scene
  );
  axisZ.color = new Color3(0.3, 0.5, 1);
}
