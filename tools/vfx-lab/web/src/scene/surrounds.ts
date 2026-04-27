import {
  Color3,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";

// Decorations sit between the inner battle pad (16×16, half-width 8) and the
// outer terrain. Mesh primitives are authored Y-up; we bake +π/2 around X so
// their long axis aligns with world +Z.

const INNER_RADIUS = 11;
const OUTER_RADIUS = 80;

export function buildSurrounds(scene: Scene) {
  const rng = lcg(42);
  buildTrees(scene, rng, 90);
  buildRocks(scene, rng, 140);
  buildGrass(scene, rng, 700);
}

function buildTrees(scene: Scene, rng: () => number, count: number) {
  const trunk = MeshBuilder.CreateCylinder(
    "trunkBase",
    { height: 1.6, diameterTop: 0.18, diameterBottom: 0.3, tessellation: 8 },
    scene
  );
  trunk.rotation.x = Math.PI / 2;
  trunk.bakeCurrentTransformIntoVertices();
  const trunkMat = new StandardMaterial("trunkMat", scene);
  trunkMat.diffuseColor = new Color3(0.34, 0.21, 0.12);
  trunkMat.specularColor = Color3.Black();
  trunk.material = trunkMat;
  trunk.isVisible = false;
  trunk.isPickable = false;

  const canopy = MeshBuilder.CreateSphere(
    "canopyBase",
    { diameter: 1.6, segments: 8 },
    scene
  );
  const canopyMat = new StandardMaterial("canopyMat", scene);
  canopyMat.diffuseColor = new Color3(0.22, 0.5, 0.22);
  canopyMat.specularColor = Color3.Black();
  canopy.material = canopyMat;
  canopy.isVisible = false;
  canopy.isPickable = false;

  for (let i = 0; i < count; i++) {
    const pos = ringPos(rng, INNER_RADIUS + 2, OUTER_RADIUS);
    const s = 0.7 + rng() * 0.7;
    const tint = 0.85 + rng() * 0.3;

    const t = trunk.createInstance(`trunk${i}`);
    t.position = new Vector3(pos.x, pos.y, 0.8 * s);
    t.scaling.set(s, s, s);
    t.rotation.z = rng() * Math.PI * 2;

    const c = canopy.createInstance(`canopy${i}`);
    c.position = new Vector3(pos.x, pos.y, 2.05 * s);
    c.scaling.set(s * tint, s * tint, s * (0.8 + rng() * 0.4));
  }
}

function buildRocks(scene: Scene, rng: () => number, count: number) {
  const rock = MeshBuilder.CreateBox("rockBase", { size: 1 }, scene);
  const mat = new StandardMaterial("rockMat", scene);
  mat.diffuseColor = new Color3(0.42, 0.42, 0.45);
  mat.specularColor = Color3.Black();
  rock.material = mat;
  rock.isVisible = false;
  rock.isPickable = false;

  for (let i = 0; i < count; i++) {
    const pos = ringPos(rng, INNER_RADIUS, OUTER_RADIUS);
    const sx = 0.3 + rng() * 0.9;
    const sy = 0.3 + rng() * 0.9;
    const sz = 0.2 + rng() * 0.7;
    const inst = rock.createInstance(`rock${i}`);
    inst.position = new Vector3(pos.x, pos.y, sz / 2);
    inst.scaling.set(sx, sy, sz);
    inst.rotation.z = rng() * Math.PI * 2;
  }
}

function buildGrass(scene: Scene, rng: () => number, count: number) {
  const tuft = MeshBuilder.CreateCylinder(
    "tuftBase",
    { height: 0.4, diameterTop: 0, diameterBottom: 0.2, tessellation: 6 },
    scene
  );
  tuft.rotation.x = Math.PI / 2;
  tuft.bakeCurrentTransformIntoVertices();
  const mat = new StandardMaterial("tuftMat", scene);
  mat.diffuseColor = new Color3(0.35, 0.6, 0.25);
  mat.specularColor = Color3.Black();
  tuft.material = mat;
  tuft.isVisible = false;
  tuft.isPickable = false;

  for (let i = 0; i < count; i++) {
    const pos = ringPos(rng, INNER_RADIUS - 2, OUTER_RADIUS);
    const s = 0.6 + rng() * 0.9;
    const inst = tuft.createInstance(`tuft${i}`);
    inst.position = new Vector3(pos.x, pos.y, 0.2 * s);
    inst.scaling.set(s, s, s);
    inst.rotation.z = rng() * Math.PI * 2;
  }
}

function ringPos(rng: () => number, innerR: number, outerR: number) {
  const r = innerR + rng() * (outerR - innerR);
  const theta = rng() * Math.PI * 2;
  return { x: Math.cos(theta) * r, y: Math.sin(theta) * r };
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
