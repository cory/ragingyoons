import {
  AbstractMesh,
  ParticleHelper,
  type ParticleSystemSet,
  Scene,
  Vector3,
} from "@babylonjs/core";

// Babylon's ParticleHelper "sun" preset ships with its own emitterNode (a
// sphere mesh acting as the visible sun body) plus particle systems emitting
// around it. Move the emitterNode to a fixed afternoon-y position — overriding
// sys.emitter alone leaves the helper's mesh stranded at the world origin.

const SUN_DISTANCE = 200;
const PARTICLE_SCALE = 15;
const EMITTER_SCALE = 10;
// Fixed: low and in front of the default camera (matches an early-afternoon
// look against the space sky).
const SUN_DIRECTION = new Vector3(0, 0.99, 0.13).normalize();

export interface SunHandle {
  setVisible: (visible: boolean) => void;
}

export function buildSun(scene: Scene): SunHandle {
  const emitterPos = SUN_DIRECTION.scale(SUN_DISTANCE);
  let particleSet: ParticleSystemSet | null = null;
  let visibleTarget = true;

  ParticleHelper.CreateAsync("sun", scene)
    .then((set) => {
      if (scene.isDisposed) {
        set.dispose();
        return;
      }
      particleSet = set;
      if (set.emitterNode instanceof AbstractMesh) {
        set.emitterNode.position.copyFrom(emitterPos);
        set.emitterNode.scaling.setAll(EMITTER_SCALE);
      }
      for (const sys of set.systems) {
        sys.minSize *= PARTICLE_SCALE;
        sys.maxSize *= PARTICLE_SCALE;
      }
      if (visibleTarget) set.start();
    })
    .catch((err) => {
      console.error("[vfx-lab] failed to load sun particle set:", err);
    });

  return {
    setVisible: (visible) => {
      visibleTarget = visible;
      if (!particleSet) return;
      if (visible) {
        particleSet.start();
      } else {
        for (const sys of particleSet.systems) sys.stop();
      }
    },
  };
}
