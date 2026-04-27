import {
  Color3,
  MeshBuilder,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { GridMaterial } from "@babylonjs/materials";

// World convention: RH, Z-up. Ground meshes from MeshBuilder are authored
// XZ-plane (Y-up); rotate +π/2 around X so the normal is +Z.

export function buildArena(scene: Scene, shadow: ShadowGenerator) {
  const outer = MeshBuilder.CreateGround(
    "terrain",
    { width: 200, height: 200, subdivisions: 1 },
    scene
  );
  outer.rotation.x = Math.PI / 2;
  outer.position.z = -0.02;
  outer.isPickable = false;
  outer.receiveShadows = true;
  const grass = new StandardMaterial("grassMat", scene);
  grass.diffuseColor = new Color3(0.27, 0.42, 0.22);
  grass.specularColor = Color3.Black();
  outer.material = grass;

  const inner = MeshBuilder.CreateGround(
    "ground",
    { width: 16, height: 16, subdivisions: 1 },
    scene
  );
  inner.rotation.x = Math.PI / 2;
  inner.receiveShadows = true;
  const grid = new GridMaterial("gridMat", scene);
  grid.gridRatio = 1;
  grid.majorUnitFrequency = 8;
  grid.mainColor = new Color3(0.18, 0.32, 0.18);
  grid.lineColor = new Color3(0.85, 0.75, 0.4);
  grid.minorUnitVisibility = 0.5;
  grid.opacity = 0.999;
  inner.material = grid;

  const pawn = MeshBuilder.CreateBox("pawn", { size: 1 }, scene);
  pawn.position = new Vector3(0, 0, 0.5);
  const pawnMat = new StandardMaterial("pawnMat", scene);
  pawnMat.diffuseColor = new Color3(0.6, 0.5, 0.4);
  pawn.material = pawnMat;
  shadow.addShadowCaster(pawn);

  const axisLen = 2;
  buildAxis(scene, "axisX", new Vector3(axisLen, 0, 0), new Color3(1, 0.3, 0.3));
  buildAxis(scene, "axisY", new Vector3(0, axisLen, 0), new Color3(0.3, 1, 0.3));
  buildAxis(scene, "axisZ", new Vector3(0, 0, axisLen), new Color3(0.3, 0.5, 1));
}

function buildAxis(scene: Scene, name: string, end: Vector3, color: Color3) {
  const line = MeshBuilder.CreateLines(
    name,
    { points: [Vector3.Zero(), end] },
    scene
  );
  line.color = color;
  line.isPickable = false;
}
