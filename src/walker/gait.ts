/**
 * Gait math, ported from walking-triangle.html.
 * Coordinate convention here matches the source: walker-local frame
 * with x = forward, y = lateral, z = vertical. Translation to Babylon's
 * (X = lateral, Y = up, Z = forward) happens in driver.ts.
 */

export type ContactPattern = "alternating" | "skip";
export type BobShape = "walk" | "run" | "skip";

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
  skip: {
    stanceFrac: 0.30,
    cadence: 1.1,
    stride: 1.2,
    lift: 1.5,
    bob: 2.5,
    bobShape: "skip",
    leanOffset: 0.05,
    contactPattern: "skip",
    hopRatio: 0.15,
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

const SKIP_HOP_LIFT = 0.55;

export function skipFoot(
  phi: number,
  f: number,
  A: number,
  D: number,
  h: number,
  liftAmp: number,
): FootSample {
  const half = f / 2;
  const xStep0 = A;
  const xStep1 = A - half * D;
  const xHop0 = A - (0.25 - h) * D;
  const xHop1 = xHop0 - half * D;
  const xCycle = A;

  if (phi < half) {
    const tau = phi / half;
    return { x: xStep0 + (xStep1 - xStep0) * tau, z: 0, lifted: false };
  }
  if (phi < 0.25) {
    const tau = (phi - half) / (0.25 - half);
    const eased = (1 - Math.cos(Math.PI * tau)) / 2;
    return {
      x: xStep1 + (xHop0 - xStep1) * eased,
      z: Math.sin(Math.PI * tau) * liftAmp * SKIP_HOP_LIFT,
      lifted: true,
    };
  }
  if (phi < 0.25 + half) {
    const tau = (phi - 0.25) / half;
    return { x: xHop0 + (xHop1 - xHop0) * tau, z: 0, lifted: false };
  }
  const tau = (phi - 0.25 - half) / (1 - 0.25 - half);
  const eased = (1 - Math.cos(Math.PI * tau)) / 2;
  return {
    x: xHop1 + (xCycle - xHop1) * eased,
    z: Math.sin(Math.PI * tau) * liftAmp,
    lifted: true,
  };
}

export function computeBob(phi: number, f: number, shape: BobShape): number {
  if (shape === "skip") {
    return -Math.cos(8 * Math.PI * (phi - f / 4));
  }
  const arg = 4 * Math.PI * (phi - f / 2);
  return shape === "walk" ? Math.max(0, Math.cos(arg)) : -Math.cos(arg);
}
