/**
 * Pencil-on-vellum scene dressing — RH, Z-up.
 * Ground lies on the XY plane (z=0), with the track ring at the same
 * height. Hemispheric light comes from +Z (sky).
 */
import {
  Color3,
  Color4,
  HemisphericLight,
  MeshBuilder,
  type Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import type { CharacterMesh } from "../character/mesh";

const PAPER = new Color3(0.937, 0.914, 0.863); // #EFE9DC
const INK = new Color4(0.10, 0.094, 0.082, 1);
const RULE = new Color3(0.78, 0.74, 0.66);

export interface VellumOpts {
  worldR: number;
}

export function applyVellum(scene: Scene, opts: VellumOpts): void {
  scene.clearColor = new Color4(PAPER.r, PAPER.g, PAPER.b, 1);
  scene.ambientColor = new Color3(1, 1, 1);

  // Sky-up hemispheric fill (+Z = up in our Z-up world).
  const key = new HemisphericLight("key", new Vector3(0.3, 0.4, 1), scene);
  key.intensity = 1.05;
  key.diffuse = new Color3(1, 0.99, 0.96);
  key.groundColor = new Color3(0.85, 0.82, 0.74);

  // Ground disc lies in the XY plane natively — no rotation needed.
  const groundR = opts.worldR * 1.6;
  const ground = MeshBuilder.CreateDisc(
    "ground",
    { radius: groundR, tessellation: 96 },
    scene,
  );
  const gm = new StandardMaterial("groundMat", scene);
  gm.diffuseColor = new Color3(PAPER.r * 0.97, PAPER.g * 0.97, PAPER.b * 0.97);
  gm.specularColor = new Color3(0, 0, 0);
  gm.emissiveColor = new Color3(0, 0, 0);
  ground.material = gm;
  ground.position.z = -0.001;

  // Track ring on the XY plane.
  const trackR = opts.worldR;
  const trackPts: Vector3[] = [];
  const SEG = 128;
  for (let i = 0; i <= SEG; i++) {
    const a = (i / SEG) * Math.PI * 2;
    trackPts.push(new Vector3(trackR * Math.cos(a), trackR * Math.sin(a), 0.001));
  }
  const trackLine = MeshBuilder.CreateLines("track", { points: trackPts }, scene);
  trackLine.color = RULE;
  trackLine.alpha = 0.45;
}

export function applyInkEdges(ch: CharacterMesh): void {
  const mesh = ch.root;
  mesh.enableEdgesRendering(0.92);
  mesh.edgesWidth = 6.0;
  mesh.edgesColor = INK;
}
