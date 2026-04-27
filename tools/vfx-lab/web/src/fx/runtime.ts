import {
  Animation,
  Color3,
  Color4,
  FresnelParameters,
  GPUParticleSystem,
  MeshBuilder,
  ParticleSystem,
  Scene,
  StandardMaterial,
  Texture,
  Vector3,
} from "@babylonjs/core";
import type {
  AoEPreset,
  FxHandle,
  FxPreset,
  ParticlePreset,
  ProjectilePreset,
  ShieldPreset,
  SpawnOpts,
} from "./types";
import { getPreset } from "./registry";

let counter = 0;

export function spawnFx(
  scene: Scene,
  preset: FxPreset,
  opts: SpawnOpts
): FxHandle {
  switch (preset.kind) {
    case "particle":
      return spawnParticle(scene, preset, opts);
    case "projectile":
      return spawnProjectile(scene, preset, opts);
    case "shield":
      return spawnShield(scene, preset, opts);
    case "aoe":
      return spawnAoE(scene, preset, opts);
  }
}

function spawnParticle(
  scene: Scene,
  preset: ParticlePreset,
  opts: SpawnOpts
): FxHandle {
  const id = `${preset.id}#${counter++}`;
  const useGPU = GPUParticleSystem.IsSupported;
  const sys: ParticleSystem | GPUParticleSystem = useGPU
    ? new GPUParticleSystem(id, { capacity: preset.capacity }, scene)
    : new ParticleSystem(id, preset.capacity, scene);

  sys.particleTexture = defaultFlare(scene);
  sys.emitter =
    preset.attach && opts.attachTo ? opts.attachTo : opts.origin.clone();

  sys.minEmitBox = new Vector3(
    -preset.emitBox[0],
    -preset.emitBox[1],
    -preset.emitBox[2]
  );
  sys.maxEmitBox = new Vector3(
    preset.emitBox[0],
    preset.emitBox[1],
    preset.emitBox[2]
  );

  sys.minLifeTime = preset.lifetime.min;
  sys.maxLifeTime = preset.lifetime.max;
  sys.minSize = preset.size.min;
  sys.maxSize = preset.size.max;
  sys.minEmitPower = preset.speed.min;
  sys.maxEmitPower = preset.speed.max;
  sys.gravity = new Vector3(...preset.gravity);

  sys.color1 = new Color4(...preset.colorStart);
  sys.color2 = new Color4(...preset.colorStart);
  sys.colorDead = new Color4(...preset.colorEnd);

  sys.direction1 = new Vector3(...preset.direction1);
  sys.direction2 = new Vector3(...preset.direction2);

  sys.blendMode =
    preset.blendMode === "additive"
      ? ParticleSystem.BLENDMODE_ADD
      : ParticleSystem.BLENDMODE_STANDARD;

  if (preset.mode === "burst") {
    sys.emitRate = 0;
    sys.targetStopDuration = 0;
    sys.start();
    if (preset.burst && preset.burst > 0) {
      sys.manualEmitCount = preset.burst;
    }
    const ttlMs = preset.lifetime.max * 1000 + 100;
    setTimeout(() => sys.dispose(false), ttlMs);
  } else {
    sys.emitRate = preset.emitRate;
    sys.start();
    if (preset.duration) {
      setTimeout(() => sys.stop(), preset.duration * 1000);
      setTimeout(
        () => sys.dispose(false),
        preset.duration * 1000 + preset.lifetime.max * 1000 + 100
      );
    }
  }

  let disposed = false;
  return {
    id,
    preset,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      sys.stop();
      setTimeout(() => sys.dispose(false), preset.lifetime.max * 1000 + 100);
    },
  };
}

function spawnProjectile(
  scene: Scene,
  preset: ProjectilePreset,
  opts: SpawnOpts
): FxHandle {
  const id = `${preset.id}#${counter++}`;
  if (!opts.target) {
    throw new Error(`Projectile ${preset.id} requires opts.target`);
  }

  const ball = MeshBuilder.CreateSphere(
    `${id}-mesh`,
    { diameter: preset.meshRadius * 2, segments: 12 },
    scene
  );
  ball.position.copyFrom(opts.origin);
  ball.isPickable = false;
  const mat = new StandardMaterial(`${id}-mat`, scene);
  mat.emissiveColor = new Color3(...preset.meshColor);
  mat.disableLighting = true;
  ball.material = mat;

  const trailPreset = getPreset(preset.trailPresetId);
  let trail: FxHandle | null = null;
  if (trailPreset && trailPreset.kind === "particle") {
    trail = spawnFx(scene, trailPreset, {
      origin: opts.origin,
      attachTo: ball,
    });
  }

  const distance = opts.target.subtract(opts.origin).length();
  const fps = 60;
  const totalFrames = Math.max(1, Math.round((distance / preset.speed) * fps));

  const flight = new Animation(
    `${id}-flight`,
    "position",
    fps,
    Animation.ANIMATIONTYPE_VECTOR3,
    Animation.ANIMATIONLOOPMODE_CONSTANT
  );
  flight.setKeys([
    { frame: 0, value: opts.origin.clone() },
    { frame: totalFrames, value: opts.target.clone() },
  ]);
  ball.animations = [flight];

  let disposed = false;
  const finishAndImpact = () => {
    if (disposed) return;
    disposed = true;
    const impact = getPreset(preset.impactPresetId);
    if (impact) {
      spawnFx(scene, impact, { origin: opts.target!.clone() });
    }
    trail?.dispose();
    ball.dispose();
    mat.dispose();
  };

  scene.beginAnimation(ball, 0, totalFrames, false, 1, finishAndImpact);

  return {
    id,
    preset,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      scene.stopAnimation(ball);
      trail?.dispose();
      ball.dispose();
      mat.dispose();
    },
  };
}

function spawnShield(
  scene: Scene,
  preset: ShieldPreset,
  opts: SpawnOpts
): FxHandle {
  const id = `${preset.id}#${counter++}`;
  const sphere = MeshBuilder.CreateSphere(
    `${id}-mesh`,
    { diameter: preset.radius * 2, segments: 24 },
    scene
  );
  sphere.isPickable = false;

  if (opts.attachTo) {
    sphere.parent = opts.attachTo;
    sphere.position = Vector3.Zero();
  } else {
    sphere.position.copyFrom(opts.origin);
  }

  const mat = new StandardMaterial(`${id}-mat`, scene);
  mat.diffuseColor = new Color3(...preset.color);
  mat.emissiveColor = new Color3(...preset.color);
  mat.specularColor = Color3.Black();
  mat.alpha = preset.rimAlpha;
  mat.disableLighting = true;
  mat.backFaceCulling = false;

  const opacityFresnel = new FresnelParameters();
  opacityFresnel.bias = 0.25;
  opacityFresnel.power = 2.5;
  opacityFresnel.leftColor = Color3.White();
  opacityFresnel.rightColor = Color3.Black();
  mat.opacityFresnelParameters = opacityFresnel;

  const emissiveFresnel = new FresnelParameters();
  emissiveFresnel.bias = 0.2;
  emissiveFresnel.power = 2.0;
  emissiveFresnel.leftColor = new Color3(...preset.rimColor);
  emissiveFresnel.rightColor = new Color3(...preset.color).scale(0.4);
  mat.emissiveFresnelParameters = emissiveFresnel;
  sphere.material = mat;

  const omega = preset.pulseHz * Math.PI * 2;
  const t0 = performance.now() / 1000;
  const observer = scene.onBeforeRenderObservable.add(() => {
    const t = performance.now() / 1000 - t0;
    const pulse01 = (Math.sin(t * omega) + 1) * 0.5;
    mat.alpha =
      preset.baseAlpha + pulse01 * (preset.rimAlpha - preset.baseAlpha);
  });

  let disposed = false;
  const disposeAll = () => {
    if (disposed) return;
    disposed = true;
    scene.onBeforeRenderObservable.remove(observer);
    sphere.dispose();
    mat.dispose();
  };

  if (preset.duration) {
    setTimeout(disposeAll, preset.duration * 1000);
  }

  return { id, preset, dispose: disposeAll };
}

function spawnAoE(
  scene: Scene,
  preset: AoEPreset,
  opts: SpawnOpts
): FxHandle {
  const id = `${preset.id}#${counter++}`;
  const center = opts.origin.clone();

  const burst = getPreset(preset.burstPresetId);
  const burstHandle =
    burst != null
      ? spawnFx(scene, burst, { origin: center.clone() })
      : null;

  const ring = MeshBuilder.CreateDisc(
    `${id}-ring`,
    { radius: 1, tessellation: 64 },
    scene
  );
  ring.position = center.clone();
  ring.position.z += 0.005;
  ring.rotation.x = Math.PI / 2;
  ring.isPickable = false;
  const ringMat = new StandardMaterial(`${id}-ring-mat`, scene);
  ringMat.emissiveColor = new Color3(...preset.ringColor);
  ringMat.disableLighting = true;
  ringMat.alpha = 0.85;
  ring.material = ringMat;
  ring.scaling.setAll(0.01);

  const dome = MeshBuilder.CreateSphere(
    `${id}-dome`,
    { diameter: preset.domeRadius * 2, segments: 24, slice: 0.5 },
    scene
  );
  dome.position = center.clone();
  dome.position.z += 0.01;
  dome.rotation.x = Math.PI / 2;
  dome.isPickable = false;
  const domeMat = new StandardMaterial(`${id}-dome-mat`, scene);
  domeMat.emissiveColor = new Color3(...preset.domeColor);
  domeMat.disableLighting = true;
  domeMat.alpha = 0.55;
  domeMat.backFaceCulling = false;
  const domeFresnel = new FresnelParameters();
  domeFresnel.bias = 0.1;
  domeFresnel.power = 1.6;
  domeFresnel.leftColor = Color3.White();
  domeFresnel.rightColor = Color3.Black();
  domeMat.opacityFresnelParameters = domeFresnel;
  dome.material = domeMat;
  dome.scaling.setAll(0.3);

  const t0 = performance.now() / 1000;
  let disposed = false;
  const observer = scene.onBeforeRenderObservable.add(() => {
    const t = (performance.now() / 1000 - t0) / preset.duration;
    if (t >= 1 || disposed) {
      disposeAll();
      return;
    }
    const ringScale = 0.01 + t * preset.ringRadius;
    ring.scaling.setAll(ringScale);
    ringMat.alpha = (1 - t) * 0.85;
    const domeT = Math.min(1, t * 2);
    dome.scaling.setAll(0.3 + domeT * 0.7);
    domeMat.alpha = (1 - domeT) * 0.55;
  });

  const disposeAll = () => {
    if (disposed) return;
    disposed = true;
    scene.onBeforeRenderObservable.remove(observer);
    ring.dispose();
    ringMat.dispose();
    dome.dispose();
    domeMat.dispose();
  };

  return {
    id,
    preset,
    dispose: () => {
      burstHandle?.dispose();
      disposeAll();
    },
  };
}

let cachedFlare: Texture | null = null;
function defaultFlare(scene: Scene): Texture {
  if (cachedFlare) return cachedFlare;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2
  );
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.4, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  cachedFlare = Texture.CreateFromBase64String(
    canvas.toDataURL(),
    "fx-flare",
    scene
  );
  return cachedFlare;
}
