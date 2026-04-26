/**
 * Gait math, ported from walking-triangle.html.
 * Coordinate convention here matches the source: walker-local frame
 * with x = forward, y = lateral, z = vertical. Translation to Babylon's
 * (X = lateral, Y = up, Z = forward) happens in driver.ts.
 */

export type ContactPattern = "alternating";
export type BobShape = "walk" | "run";

export interface Gait {
  stanceFrac: number;
  cadence: number;
  stride: number;
  lift: number;
  bob: number;
  bobShape: BobShape;
  leanOffset: number;
  contactPattern: ContactPattern;
  hopRatio?: number;
}

export const GAITS: Record<string, Gait> = {
  walk: {
    stanceFrac: 0.55,
    cadence: 1.0,
    stride: 1.0,
    lift: 1.0,
    bob: 1.0,
    bobShape: "walk",
    leanOffset: 0,
    contactPattern: "alternating",
  },
  run: {
    stanceFrac: 0.30,
    cadence: 1.4,
    stride: 1.7,
    lift: 1.6,
    bob: 2.5,
    bobShape: "run",
    leanOffset: -0.18,
    contactPattern: "alternating",
  },
  shuffle: {
    stanceFrac: 0.75,
    cadence: 0.7,
    stride: 0.4,
    lift: 0.1,
    bob: 0.3,
    bobShape: "walk",
    leanOffset: -0.10,
    contactPattern: "alternating",
  },
};

export interface FootSample {
  x: number; // forward stride offset (walker x)
  z: number; // vertical lift (walker z, ≥ 0)
  lifted: boolean;
}

export function walkFoot(phi: number, f: number, A: number, liftAmp: number): FootSample {
  if (phi < f) {
    const tau = phi / f;
    return { x: A * (1 - 2 * tau), z: 0, lifted: false };
  }
  const tau = (phi - f) / (1 - f);
  return {
    x: -A * Math.cos(Math.PI * tau),
    z: Math.sin(Math.PI * tau) * liftAmp,
    lifted: true,
  };
}

export function computeBob(phi: number, f: number, shape: BobShape): number {
  const arg = 4 * Math.PI * (phi - f / 2);
  return shape === "walk" ? Math.max(0, Math.cos(arg)) : -Math.cos(arg);
}
