import {
  Color3,
  DirectionalLight,
  HemisphericLight,
  Scene,
  ShadowGenerator,
  Vector3,
} from "@babylonjs/core";
import type { SkyHandle, SkyParams } from "./sky";

export interface LightingRig {
  hemi: HemisphericLight;
  sun: DirectionalLight;
  shadow: ShadowGenerator;
  setTimeOfDay: (hour: number) => void;
}

const C3 = (r: number, g: number, b: number) => new Color3(r, g, b);

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function lerpC3(a: Color3, b: Color3, t: number) {
  return new Color3(lerp(a.r, b.r, t), lerp(a.g, b.g, t), lerp(a.b, b.b, t));
}
function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function paletteAt(elev: number) {
  // elev in [-1, 1]
  // Bands: deep night (<-0.2), twilight (-0.2..0.4), day (>0.4)
  let horizon: Color3;
  let zenith: Color3;
  let ground: Color3 = C3(0.1, 0.08, 0.06);
  let sun: Color3;
  let cloudiness: number;
  let starBrightness: number;

  const NIGHT_HORIZON = C3(0.12, 0.14, 0.22);
  const NIGHT_ZENITH = C3(0.05, 0.07, 0.18);
  const TWILIGHT_HORIZON = C3(1.0, 0.5, 0.22);
  const TWILIGHT_ZENITH = C3(0.22, 0.18, 0.4);
  const DAY_HORIZON = C3(0.78, 0.88, 1.0);
  const DAY_ZENITH = C3(0.16, 0.42, 0.85);

  const SUN_HIGH = C3(1.0, 0.97, 0.88);
  const SUN_LOW = C3(1.0, 0.55, 0.18);
  const MOON = C3(0.85, 0.88, 0.98);

  if (elev > 0.4) {
    const k = clamp01((elev - 0.4) / 0.6);
    horizon = lerpC3(C3(0.95, 0.88, 0.7), DAY_HORIZON, k);
    zenith = lerpC3(C3(0.4, 0.6, 0.92), DAY_ZENITH, k);
    sun = lerpC3(C3(1.0, 0.85, 0.55), SUN_HIGH, k);
    cloudiness = 0.55;
    starBrightness = 0;
  } else if (elev > 0) {
    const k = clamp01(elev / 0.4);
    horizon = lerpC3(TWILIGHT_HORIZON, C3(0.95, 0.88, 0.7), k);
    zenith = lerpC3(TWILIGHT_ZENITH, C3(0.4, 0.6, 0.92), k);
    sun = lerpC3(SUN_LOW, C3(1.0, 0.85, 0.55), k);
    cloudiness = lerp(0.6, 0.55, k);
    starBrightness = 0;
  } else if (elev > -0.2) {
    const k = clamp01((elev + 0.2) / 0.2);
    horizon = lerpC3(NIGHT_HORIZON, TWILIGHT_HORIZON, k);
    zenith = lerpC3(NIGHT_ZENITH, TWILIGHT_ZENITH, k);
    sun = lerpC3(MOON, SUN_LOW, k);
    cloudiness = lerp(0.2, 0.6, k);
    starBrightness = lerp(0.9, 0.0, k);
  } else {
    horizon = NIGHT_HORIZON;
    zenith = NIGHT_ZENITH;
    sun = MOON;
    cloudiness = 0.18;
    starBrightness = 1.0;
  }

  return { horizon, zenith, ground, sun, cloudiness, starBrightness };
}

export function buildLighting(scene: Scene, sky: SkyHandle): LightingRig {
  const hemi = new HemisphericLight("hemi", new Vector3(0, 0, 1), scene);
  const sun = new DirectionalLight("sun", new Vector3(0, 0, -1), scene);
  sun.position = new Vector3(0, 0, 30);

  const shadow = new ShadowGenerator(1024, sun);
  shadow.useBlurExponentialShadowMap = true;
  shadow.blurScale = 2;

  const setTimeOfDay = (hour: number) => {
    const h = ((hour % 24) + 24) % 24;
    const t = ((h - 6) / 12) * Math.PI;
    const cosT = Math.cos(t);
    const sinT = Math.sin(t);
    const sunUp = sinT > 0;
    const sunVis = Math.max(0, sinT);

    const sunDirVec = new Vector3(cosT, 0, sinT).normalize();
    const palette = paletteAt(sinT);

    if (sunUp) {
      sun.direction = sunDirVec.scale(-1);
      sun.position = sunDirVec.scale(30);
      sun.intensity = 0.15 + sunVis * 1.2;
      sun.shadowEnabled = true;
      sun.diffuse = palette.sun;
    } else {
      const moonDir = new Vector3(-0.3, 0.2, -1).normalize();
      sun.direction = moonDir;
      sun.position = moonDir.scale(-30);
      sun.intensity = 0.55;
      sun.shadowEnabled = false;
      sun.diffuse = palette.sun;
    }
    sun.specular = sun.diffuse;

    if (sunUp) {
      hemi.intensity = 0.35 + sunVis * 0.4;
      hemi.diffuse = lerpC3(C3(0.6, 0.75, 1.0), C3(1.0, 1.0, 1.0), sunVis);
      hemi.groundColor = C3(0.22, 0.18, 0.15);
    } else {
      hemi.intensity = 0.42;
      hemi.diffuse = C3(0.45, 0.55, 0.78);
      hemi.groundColor = C3(0.13, 0.16, 0.24);
    }

    const skyParams: SkyParams = {
      sunDir: sunDirVec,
      horizon: palette.horizon,
      zenith: palette.zenith,
      ground: palette.ground,
      sun: palette.sun,
      cloudiness: palette.cloudiness,
      starBrightness: palette.starBrightness,
    };
    sky.setParams(skyParams);
  };

  setTimeOfDay(12);
  return { hemi, sun, shadow, setTimeOfDay };
}
