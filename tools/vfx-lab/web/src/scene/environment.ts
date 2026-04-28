import {
  type AbstractMesh,
  Scene,
  SceneLoader,
  Vector3,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";

// Registry of swappable 3D environment models. glTF native is RH Y-up; we
// rotate +π/2 around X on import so the model stands upright in our Z-up
// world. After load we measure the bounding box and use it to auto-fit the
// playfield (top-center of the model + small lift) — no per-model position
// constants to maintain.

export interface EnvironmentModel {
  id: string;
  name: string;
  rootUrl: string;
  file: string;
  scale: number;
  cameraRadius: number;
}

export const NONE_ENV_ID = "none";

export const MODELS: EnvironmentModel[] = [
  {
    id: "postwar-city",
    name: "Postwar City",
    rootUrl: "/models/",
    file: "postwar_city_-_exterior_scene.glb",
    scale: 1,
    cameraRadius: 30,
  },
  {
    id: "trailer-park",
    name: "Trailer Park",
    rootUrl: "/models/",
    file: "trailer_park.glb",
    scale: 1,
    cameraRadius: 30,
  },
  {
    id: "island",
    name: "Rock Reef Island",
    rootUrl: "/models/",
    file: "rock_reef_beaches_seaside_small_island.glb",
    scale: 1,
    cameraRadius: 30,
  },
  {
    id: "lobn",
    name: "LOBN Far",
    rootUrl: "/models/",
    file: "lobn_far_600k.glb",
    scale: 1,
    cameraRadius: 30,
  },
];

export function getModel(id: string): EnvironmentModel | undefined {
  return MODELS.find((m) => m.id === id);
}

export interface ModelBounds {
  min: Vector3;
  max: Vector3;
  center: Vector3;
}

export interface LoadedModel {
  meshes: AbstractMesh[];
  root: AbstractMesh;
  bounds: ModelBounds;
}

export async function loadModel(
  scene: Scene,
  model: EnvironmentModel
): Promise<LoadedModel | null> {
  try {
    const result = await SceneLoader.ImportMeshAsync(
      "",
      model.rootUrl,
      model.file,
      scene
    );
    const root =
      result.meshes.find((m) => m.name === "__root__") ?? result.meshes[0];
    if (!root) {
      console.warn(`[vfx-lab] ${model.name}: no root mesh in import`);
      return null;
    }

    root.rotation.x = Math.PI / 2;
    root.scaling.setAll(model.scale);

    let min = new Vector3(Infinity, Infinity, Infinity);
    let max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const m of result.meshes) {
      if (m.getTotalVertices() === 0) continue;
      m.computeWorldMatrix(true);
      const b = m.getBoundingInfo().boundingBox;
      min = Vector3.Minimize(min, b.minimumWorld);
      max = Vector3.Maximize(max, b.maximumWorld);
    }
    const center = min.add(max).scale(0.5);
    const size = max.subtract(min);
    console.log(
      `[vfx-lab] ${model.name} loaded — bounds min=${min.toString()} max=${max.toString()} size=${size.toString()}`
    );

    return { meshes: result.meshes, root, bounds: { min, max, center } };
  } catch (err) {
    console.warn(
      `[vfx-lab] ${model.name} not loaded — drop GLB at tools/vfx-lab/web/public${model.rootUrl}${model.file}`,
      err
    );
    return null;
  }
}

export function disposeModel(model: LoadedModel) {
  for (const mesh of model.meshes) {
    mesh.dispose(false, false);
  }
}
