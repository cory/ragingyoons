/**
 * Shared color helpers for character mesh builders. Palette strings come
 * out of `generator.ts` as CSS HSL like `hsl(212 70% 56%)`; mesh code
 * needs Babylon Color3.
 */
import { Color3 } from "@babylonjs/core";

export function parseHsl(s: string): Color3 {
  const m = s.match(/hsl\(\s*([\d.\-]+)\s+([\d.\-]+)%\s+([\d.\-]+)%/);
  if (!m) return new Color3(0.6, 0.6, 0.6);
  return hslToRgb(parseFloat(m[1]) / 360, parseFloat(m[2]) / 100, parseFloat(m[3]) / 100);
}

export function hslToRgb(h: number, s: number, l: number): Color3 {
  if (s === 0) return new Color3(l, l, l);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hueToRgb = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return new Color3(hueToRgb(h + 1 / 3), hueToRgb(h), hueToRgb(h - 1 / 3));
}

export function lerpColor(a: Color3, b: Color3, t: number): Color3 {
  return new Color3(
    a.r + (b.r - a.r) * t,
    a.g + (b.g - a.g) * t,
    a.b + (b.b - a.b) * t,
  );
}

export function darken(c: Color3, k: number): Color3 {
  const m = Math.max(0, 1 - k);
  return new Color3(c.r * m, c.g * m, c.b * m);
}
