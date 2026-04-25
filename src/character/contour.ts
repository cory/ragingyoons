/**
 * Contour utilities for shape resampling and SDF-style smooth blending
 * between adjacent layers. Lets a hexagon "morph" into a square at a
 * seam without a hard step in silhouette.
 */
import type { Contour } from "./shapes";

/** All shapes are angularly resampled to this many points so they're
 *  index-aligned for blending. */
export const COMMON_N = 32;

/**
 * Resample a closed contour to `n` points via angular ray-cast from origin.
 * Each output[i] is the farthest intersection of the ray at angle 2π·i/n
 * with the contour. Convex shapes round-trip cleanly; concave shapes
 * (crescent) collapse onto their outer hull.
 */
export function resampleByAngle(contour: Contour, n: number): Contour {
  const out: Contour = [];
  for (let i = 0; i < n; i++) {
    const theta = (i / n) * Math.PI * 2;
    const dx = Math.cos(theta);
    const dy = Math.sin(theta);
    let bestT = 0;
    for (let j = 0; j < contour.length; j++) {
      const p1 = contour[j];
      const p2 = contour[(j + 1) % contour.length];
      const ex = p2.x - p1.x;
      const ey = p2.y - p1.y;
      const det = ex * dy - ey * dx;
      if (Math.abs(det) < 1e-12) continue;
      const t = (ex * p1.y - ey * p1.x) / det;
      const s = (dx * p1.y - dy * p1.x) / det;
      if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9 && t > bestT) {
        bestT = t;
      }
    }
    out.push({ x: dx * bestT, y: dy * bestT });
  }
  return out;
}

/** Hermite smoothstep on [0,1]. */
export function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/**
 * Blend two angularly-resampled contours (same length, same angle order).
 * Smoothstep interpolates radii; an optional small bulge near t=0.5
 * approximates an SDF smin so the joint reads as merged geometry rather
 * than a linear lerp.
 */
export function blendContours(
  a: Contour,
  b: Contour,
  t: number,
  bulgeFactor = 0.15,
): Contour {
  const s = smoothstep(t);
  const bulge = bulgeFactor * (1 - (2 * t - 1) * (2 * t - 1));
  const N = a.length;
  const out: Contour = [];
  for (let i = 0; i < N; i++) {
    const theta = (i / N) * Math.PI * 2;
    const rA = Math.hypot(a[i].x, a[i].y);
    const rB = Math.hypot(b[i].x, b[i].y);
    const r = (1 - s) * rA + s * rB + bulge * Math.abs(rA - rB);
    out.push({ x: r * Math.cos(theta), y: r * Math.sin(theta) });
  }
  return out;
}
