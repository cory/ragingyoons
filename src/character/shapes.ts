import type { ShapeName } from "./generator";

export interface Vec2 {
  x: number;
  y: number;
}
export type Contour = Vec2[];

function regularPolygon(n: number, r: number, rotation = 0): Contour {
  const pts: Contour = [];
  for (let i = 0; i < n; i++) {
    const a = rotation + (i / n) * Math.PI * 2;
    pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
  }
  return pts;
}

function star(n: number, ro: number, ri: number, rotation = -Math.PI / 2): Contour {
  const pts: Contour = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? ro : ri;
    const a = rotation + (i * Math.PI) / n;
    pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
  }
  return pts;
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number, segs: number): Contour {
  const pts: Contour = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const a = a0 + (a1 - a0) * t;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

export function getContour(shape: ShapeName, r: number): Contour {
  switch (shape) {
    case "hexagon":
      return regularPolygon(6, r, 0);
    case "hexagonV":
      return regularPolygon(6, r, Math.PI / 6);
    case "octagon":
      return regularPolygon(8, r, Math.PI / 8);
    case "square":
      return regularPolygon(4, r, Math.PI / 4);
    case "pentagon":
      return regularPolygon(5, r, -Math.PI / 2);
    case "obelisk":
      // tall pentagon: stretch vertically
      return regularPolygon(5, r, -Math.PI / 2).map((p) => ({ x: p.x * 0.85, y: p.y * 1.05 }));
    case "triangle":
      return regularPolygon(3, r, -Math.PI / 2);
    case "diamond":
      return regularPolygon(4, r, 0);
    case "rhombusFlat":
      return regularPolygon(4, r, 0).map((p) => ({ x: p.x, y: p.y * 0.55 }));
    case "blade": {
      // elongated diamond, point-up biased
      const long = r * 1.05;
      const wide = r * 0.45;
      return [
        { x: 0, y: long },
        { x: wide, y: 0 },
        { x: 0, y: -long * 0.85 },
        { x: -wide, y: 0 },
      ];
    }
    case "trapezoid": {
      // wider at top
      const top = r;
      const bot = r * 0.65;
      const h = r * 0.85;
      return [
        { x: -top, y: h },
        { x: top, y: h },
        { x: bot, y: -h },
        { x: -bot, y: -h },
      ];
    }
    case "trapezoidI": {
      // wider at bottom (the "I" inverted variant)
      const top = r * 0.65;
      const bot = r;
      const h = r * 0.85;
      return [
        { x: -top, y: h },
        { x: top, y: h },
        { x: bot, y: -h },
        { x: -bot, y: -h },
      ];
    }
    case "shield": {
      // flat top, curved bottom
      const w = r;
      const top = r * 0.85;
      const bot = -r;
      const pts: Contour = [];
      pts.push({ x: -w, y: top });
      pts.push({ x: w, y: top });
      // right edge to point
      pts.push({ x: w, y: 0 });
      // arc to bottom point
      const arcPts = arc(0, 0, w, 0, -Math.PI, 12).slice(1, -1);
      // ensure final approach to bot
      for (const p of arcPts) pts.push({ x: p.x, y: p.y });
      pts.push({ x: -w, y: 0 });
      // close back to top-left handled by polygon
      return pts;
    }
    case "star5":
      return star(5, r, r * 0.45);
    case "star6":
      return star(6, r, r * 0.55);
    case "star8":
      return star(8, r, r * 0.62);
    case "circle":
    case "disk":
      return regularPolygon(28, r, 0);
    case "crescent": {
      // CCW-from-above traversal: outer-bottom arc 0 → π (right→top→left),
      // then inner-top arc π → 0 (back across via the inner curve).
      const outer = arc(0, 0, r, 0, Math.PI, 18);
      const innerOffset = r * 0.45;
      const innerR = r * 0.78;
      const inner = arc(0, innerOffset, innerR, Math.PI, 0, 18);
      return [...outer, ...inner];
    }
    default:
      return regularPolygon(20, r, 0);
  }
}
