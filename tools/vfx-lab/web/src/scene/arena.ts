import {
  type AbstractMesh,
  Color3,
  MeshBuilder,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { GridMaterial } from "@babylonjs/materials";

// World convention: RH, Z-up. The playfield (grid pad + pawn + axes) lives
// under one TransformNode so we can reposition the whole thing per-environment.

export interface Arena {
  root: TransformNode;
  pawn: AbstractMesh;
}

export function buildArena(scene: Scene, shadow: ShadowGenerator): Arena {
  const root = new TransformNode("playfieldRoot", scene);

  const inner = MeshBuilder.CreateGround(
    "ground",
    { width: 16, height: 16, subdivisions: 1 },
    scene
  );
  inner.parent = root;
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
  pawn.parent = root;
  pawn.position = new Vector3(0, 0, 0.5);
  const pawnMat = new StandardMaterial("pawnMat", scene);
  pawnMat.diffuseColor = new Color3(0.6, 0.5, 0.4);
  pawn.material = pawnMat;
  shadow.addShadowCaster(pawn);

  const axes: Array<{ name: string; end: Vector3; color: Color3 }> = [
    { name: "axisX", end: new Vector3(2, 0, 0), color: new Color3(1, 0.3, 0.3) },
    { name: "axisY", end: new Vector3(0, 2, 0), color: new Color3(0.3, 1, 0.3) },
    { name: "axisZ", end: new Vector3(0, 0, 2), color: new Color3(0.3, 0.5, 1) },
  ];
  for (const axis of axes) {
    const line = MeshBuilder.CreateLines(
      axis.name,
      { points: [Vector3.Zero(), axis.end] },
      scene
    );
    line.parent = root;
    line.color = axis.color;
    line.isPickable = false;
  }

  return { root, pawn };
}
