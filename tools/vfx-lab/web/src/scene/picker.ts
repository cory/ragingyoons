import { Scene, Vector3 } from "@babylonjs/core";

// Pick a point on the ground (XY plane, Z=0) under the cursor.
export function pickGround(scene: Scene): Vector3 | null {
  const result = scene.pick(scene.pointerX, scene.pointerY, (m) => m.name === "ground");
  if (result?.hit && result.pickedPoint) {
    return result.pickedPoint.clone();
  }
  return null;
}
