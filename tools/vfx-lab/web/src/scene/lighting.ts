import {
  Color3,
  DirectionalLight,
  HemisphericLight,
  Scene,
  ShadowGenerator,
  Vector3,
} from "@babylonjs/core";
import type { SkyMaterial } from "@babylonjs/materials";

export interface LightingRig {
  hemi: HemisphericLight;
  sun: DirectionalLight;
  shadow: ShadowGenerator;
  setTimeOfDay: (hour: number) => void;
}

// Hour 0–24. Sun rises at 6, peaks at 12, sets at 18.
export function buildLighting(scene: Scene, sky: SkyMaterial): LightingRig {
  const hemi = new HemisphericLight("hemi", new Vector3(0, 0, 1), scene);
  const sun = new DirectionalLight("sun", new Vector3(0, 0, -1), scene);
  sun.position = new Vector3(0, 0, 30);

  const shadow = new ShadowGenerator(1024, sun);
  shadow.useBlurExponentialShadowMap = true;
  shadow.blurScale = 2;

  const setTimeOfDay = (hour: number) => {
    const h = ((hour % 24) + 24) % 24;
    const t = ((h - 6) / 12) * Math.PI; // 0 at sunrise, π at sunset
    const cosT = Math.cos(t);
    const sinT = Math.sin(t);

    const sunUp = sinT > 0;
    const sunVis = Math.max(0, sinT);

    sun.direction = new Vector3(-cosT, 0, -sinT).normalize();
    sun.position = new Vector3(cosT * 30, 0, sinT * 30 + 5);
    sun.intensity = 0.15 + sunVis * 1.15;
    const warmth = 1 - sunVis;
    sun.diffuse = sunUp
      ? new Color3(1, 1 - warmth * 0.45, 1 - warmth * 0.75)
      : new Color3(0.3, 0.4, 0.6);
    sun.specular = sun.diffuse;
    sun.shadowEnabled = sunUp;

    if (sunUp) {
      hemi.intensity = 0.35 + sunVis * 0.4;
      hemi.diffuse = new Color3(
        0.6 + sunVis * 0.4,
        0.75 + sunVis * 0.25,
        1.0
      );
      hemi.groundColor = new Color3(0.22, 0.18, 0.15);
    } else {
      hemi.intensity = 0.18;
      hemi.diffuse = new Color3(0.22, 0.3, 0.5);
      hemi.groundColor = new Color3(0.05, 0.06, 0.12);
    }

    sky.inclination = sinT * 0.5;
    sky.azimuth = 0.25;
    sky.luminance = sunUp ? 0.4 + warmth * 0.5 : 1.0 + Math.abs(sinT) * 0.2;
  };

  setTimeOfDay(12);
  return { hemi, sun, shadow, setTimeOfDay };
}
