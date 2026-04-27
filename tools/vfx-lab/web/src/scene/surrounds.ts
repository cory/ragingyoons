import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
} from "@babylonjs/core";

const INNER_RADIUS = 11;
const OUTER_RADIUS = 80;

export function buildSurrounds(scene: Scene) {
  const rng = lcg(42);
  buildTrees(scene, rng, 110);
  buildRocks(scene, rng, 160);
  buildGrass(scene, rng, 800);
}

interface PrefabSet {
  pineTrunk: Mesh;
  pineLayer: Mesh;
  leafyTrunk: Mesh;
  leafyBlobA: Mesh;
  leafyBlobB: Mesh;
}

function buildTreePrefabs(scene: Scene): PrefabSet {
  const pineTrunk = MeshBuilder.CreateCylinder(
    "pineTrunkBase",
    { height: 2.4, diameterTop: 0.1, diameterBottom: 0.22, tessellation: 8 },
    scene
  );
  pineTrunk.rotation.x = Math.PI / 2;
  pineTrunk.bakeCurrentTransformIntoVertices();
  const trunkDarkMat = new StandardMaterial("trunkDarkMat", scene);
  trunkDarkMat.diffuseColor = new Color3(0.32, 0.2, 0.1);
  trunkDarkMat.specularColor = Color3.Black();
  pineTrunk.material = trunkDarkMat;
  pineTrunk.isVisible = false;
  pineTrunk.isPickable = false;

  const pineLayer = MeshBuilder.CreateCylinder(
    "pineLayerBase",
    { height: 1.3, diameterTop: 0, diameterBottom: 0.95, tessellation: 10 },
    scene
  );
  pineLayer.rotation.x = Math.PI / 2;
  pineLayer.bakeCurrentTransformIntoVertices();
  const pineMat = new StandardMaterial("pineCanopyMat", scene);
  pineMat.diffuseColor = new Color3(0.18, 0.42, 0.22);
  pineMat.specularColor = Color3.Black();
  pineLayer.material = pineMat;
  pineLayer.isVisible = false;
  pineLayer.isPickable = false;

  const leafyTrunk = MeshBuilder.CreateCylinder(
    "leafyTrunkBase",
    { height: 1.6, diameterTop: 0.18, diameterBottom: 0.32, tessellation: 8 },
    scene
  );
  leafyTrunk.rotation.x = Math.PI / 2;
  leafyTrunk.bakeCurrentTransformIntoVertices();
  const trunkLightMat = new StandardMaterial("trunkLightMat", scene);
  trunkLightMat.diffuseColor = new Color3(0.38, 0.24, 0.13);
  trunkLightMat.specularColor = Color3.Black();
  leafyTrunk.material = trunkLightMat;
  leafyTrunk.isVisible = false;
  leafyTrunk.isPickable = false;

  const leafyBlobA = MeshBuilder.CreateSphere(
    "leafyBlobA",
    { diameter: 1.2, segments: 6 },
    scene
  );
  const leafyMatA = new StandardMaterial("leafyMatA", scene);
  leafyMatA.diffuseColor = new Color3(0.26, 0.55, 0.22);
  leafyMatA.specularColor = Color3.Black();
  leafyBlobA.material = leafyMatA;
  leafyBlobA.isVisible = false;
  leafyBlobA.isPickable = false;

  const leafyBlobB = MeshBuilder.CreateSphere(
    "leafyBlobB",
    { diameter: 1.4, segments: 6 },
    scene
  );
  const leafyMatB = new StandardMaterial("leafyMatB", scene);
  leafyMatB.diffuseColor = new Color3(0.34, 0.5, 0.18);
  leafyMatB.specularColor = Color3.Black();
  leafyBlobB.material = leafyMatB;
  leafyBlobB.isVisible = false;
  leafyBlobB.isPickable = false;

  return { pineTrunk, pineLayer, leafyTrunk, leafyBlobA, leafyBlobB };
}

function buildTrees(scene: Scene, rng: () => number, count: number) {
  const p = buildTreePrefabs(scene);

  for (let i = 0; i < count; i++) {
    const pos = ringPos(rng, INNER_RADIUS + 2, OUTER_RADIUS);
    const isPine = rng() < 0.4;
    const s = 0.7 + rng() * 0.7;
    const rotZ = rng() * Math.PI * 2;

    if (isPine) {
      const t = p.pineTrunk.createInstance(`pT${i}`);
      t.position.set(pos.x, pos.y, 1.2 * s);
      t.scaling.set(s, s, s);
      t.rotation.z = rotZ;

      const layers: Array<{ z: number; r: number }> = [
        { z: 1.55, r: 1.0 },
        { z: 2.2, r: 0.72 },
        { z: 2.75, r: 0.46 },
      ];
      for (let k = 0; k < layers.length; k++) {
        const c = p.pineLayer.createInstance(`pL${i}_${k}`);
        const lr = layers[k];
        c.position.set(pos.x, pos.y, lr.z * s);
        c.scaling.set(lr.r * s, lr.r * s, lr.r * s * 1.1);
        c.rotation.z = rotZ + k * 0.4;
      }
    } else {
      const trunkScale = s * (0.9 + rng() * 0.3);
      const t = p.leafyTrunk.createInstance(`lT${i}`);
      t.position.set(pos.x, pos.y, 0.8 * trunkScale);
      t.scaling.set(trunkScale, trunkScale, trunkScale);
      t.rotation.z = rotZ;

      const top = 1.6 * trunkScale;
      const blobs: Array<{ dx: number; dy: number; dz: number; sc: number; alt: boolean }> = [
        { dx: 0, dy: 0, dz: 0.4, sc: 1.0, alt: rng() < 0.5 },
        { dx: 0.5, dy: 0.05, dz: 0.2, sc: 0.7, alt: rng() < 0.5 },
        { dx: -0.35, dy: 0.4, dz: 0.3, sc: 0.78, alt: rng() < 0.5 },
        { dx: 0.05, dy: -0.45, dz: 0.45, sc: 0.66, alt: rng() < 0.5 },
        { dx: 0.0, dy: 0.05, dz: 0.85, sc: 0.55, alt: rng() < 0.5 },
      ];
      for (let k = 0; k < blobs.length; k++) {
        const b = blobs[k];
        const base = b.alt ? p.leafyBlobB : p.leafyBlobA;
        const c = base.createInstance(`lB${i}_${k}`);
        const ws = b.sc * s * (0.85 + rng() * 0.3);
        c.position.set(
          pos.x + b.dx * s,
          pos.y + b.dy * s,
          top + b.dz * s
        );
        c.scaling.set(ws, ws, ws * (0.9 + rng() * 0.2));
      }
    }
  }
}

function buildRocks(scene: Scene, rng: () => number, count: number) {
  const rock = MeshBuilder.CreateBox("rockBase", { size: 1 }, scene);
  const matA = new StandardMaterial("rockMatA", scene);
  matA.diffuseColor = new Color3(0.42, 0.42, 0.45);
  matA.specularColor = Color3.Black();
  rock.material = matA;
  rock.isVisible = false;
  rock.isPickable = false;

  const rockDark = MeshBuilder.CreateBox("rockDarkBase", { size: 1 }, scene);
  const matB = new StandardMaterial("rockMatB", scene);
  matB.diffuseColor = new Color3(0.32, 0.3, 0.32);
  matB.specularColor = Color3.Black();
  rockDark.material = matB;
  rockDark.isVisible = false;
  rockDark.isPickable = false;

  for (let i = 0; i < count; i++) {
    const pos = ringPos(rng, INNER_RADIUS, OUTER_RADIUS);
    const sx = 0.3 + rng() * 0.9;
    const sy = 0.3 + rng() * 0.9;
    const sz = 0.2 + rng() * 0.7;
    const dark = rng() < 0.35;
    const inst = (dark ? rockDark : rock).createInstance(`rock${i}`);
    inst.position.set(pos.x, pos.y, sz / 2);
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
  mat.diffuseColor = new Color3(0.38, 0.62, 0.25);
  mat.specularColor = Color3.Black();
  tuft.material = mat;
  tuft.isVisible = false;
  tuft.isPickable = false;

  for (let i = 0; i < count; i++) {
    const pos = ringPos(rng, INNER_RADIUS - 2, OUTER_RADIUS);
    const s = 0.6 + rng() * 0.9;
    const inst = tuft.createInstance(`tuft${i}`);
    inst.position.set(pos.x, pos.y, 0.2 * s);
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
