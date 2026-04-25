/**
 * Character mesh — RH, Z-up. Slabs (2D contours from `shapes.ts`) lie in
 * the XY plane and extrude along +Z. Body sits on top of the legs at
 * z = legHeight; legs occupy z ∈ [0, legHeight].
 */
import {
  Color3,
  Mesh,
  type Scene,
  StandardMaterial,
  VertexData,
} from "@babylonjs/core";
import earcut from "earcut";
import type { Layer, Unit } from "./generator";
import { getContour } from "./shapes";
import { BONE, createRig, rigLayout, skinWeightsAtZ, type Rig } from "../rig/skeleton";

const UNIT_SCALE = 0.04;

export interface CharacterMesh {
  root: Mesh;
  rig: Rig;
  unit: Unit;
  height: number;
  footLateral: number;
}

interface SlabHeights {
  zBot: number;
  zTop: number;
}

function slabHeights(unit: Unit): SlabHeights[] {
  const out: SlabHeights[] = [];
  let z = 0;
  for (const layer of unit.layers) {
    const t = layer.thickness;
    out.push({ zBot: z, zTop: z + t });
    z += t;
  }
  return out;
}

function parseHsl(s: string): Color3 {
  const m = s.match(/hsl\(\s*([\d.\-]+)\s+([\d.\-]+)%\s+([\d.\-]+)%/);
  if (!m) return new Color3(0.6, 0.6, 0.6);
  return hslToRgb(parseFloat(m[1]) / 360, parseFloat(m[2]) / 100, parseFloat(m[3]) / 100);
}

function hslToRgb(h: number, s: number, l: number): Color3 {
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

function layerColor(unit: Unit, layer: Layer): Color3 {
  const p = unit.palette;
  if (layer.tone === "accent") return parseHsl(layer.inset ? p.accentDark : p.accent);
  if (layer.role === "base") return parseHsl(p.primaryDark);
  if (layer.role === "crown") return parseHsl(layer.inset ? p.primaryMid : p.primaryLight);
  return parseHsl(layer.inset ? p.primaryMid : p.primary);
}

export function buildCharacter(unit: Unit, scene: Scene): CharacterMesh {
  const slabs = slabHeights(unit);

  const bodyHeightLocal = slabs[slabs.length - 1].zTop;
  const bodyHeightWorld = bodyHeightLocal * UNIT_SCALE;
  const legHeightWorld = bodyHeightWorld * 0.55;
  const layout = rigLayout(legHeightWorld, bodyHeightWorld);
  const footLateral = 22 * UNIT_SCALE;

  const rig = createRig(scene, layout, footLateral);

  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  const matricesIndices: number[] = [];
  const matricesWeights: number[] = [];

  function pushBodyVert(x: number, y: number, z: number, color: Color3): number {
    const idx = positions.length / 3;
    positions.push(x, y, z);
    colors.push(color.r, color.g, color.b, 1);
    const w = skinWeightsAtZ(z, layout);
    matricesIndices.push(w.i0, w.i1, 0, 0);
    matricesWeights.push(w.w0, w.w1, 0, 0);
    return idx;
  }

  // ── Body slabs ────────────────────────────────────────────────
  for (let li = 0; li < unit.layers.length; li++) {
    const layer = unit.layers[li];
    const slab = slabs[li];
    const color = layerColor(unit, layer);

    const contour = getContour(layer.shape, layer.r);
    const N = contour.length;

    const zBot = slab.zBot * UNIT_SCALE + legHeightWorld;
    const zTop = slab.zTop * UNIT_SCALE + legHeightWorld;
    const dx = layer.x * UNIT_SCALE;

    const ringBot: number[] = [];
    const ringTop: number[] = [];
    for (let i = 0; i < N; i++) {
      const p = contour[i];
      const wx = p.x * UNIT_SCALE + dx;
      const wy = p.y * UNIT_SCALE; // contour y → world Y (lateral)
      ringBot.push(pushBodyVert(wx, wy, zBot, color));
      ringTop.push(pushBodyVert(wx, wy, zTop, color));
    }

    // Sides — winding doesn't matter for visibility (culling disabled).
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      indices.push(ringBot[i], ringTop[i], ringTop[j]);
      indices.push(ringBot[i], ringTop[j], ringBot[j]);
    }

    // Caps — earcut triangulation handles concave contours (crescent)
    // correctly. Earcut takes a flat [x0,y0,x1,y1,...] and returns
    // triangle indices into that array.
    const flat: number[] = [];
    for (const p of contour) {
      flat.push(p.x, p.y);
    }
    const capTris = earcut(flat);
    for (let k = 0; k < capTris.length; k += 3) {
      const a = capTris[k];
      const b = capTris[k + 1];
      const c = capTris[k + 2];
      // Top cap: keep earcut order. Bottom cap: reverse.
      indices.push(ringTop[a], ringTop[b], ringTop[c]);
      indices.push(ringBot[c], ringBot[b], ringBot[a]);
    }
  }

  // ── Legs ──────────────────────────────────────────────────────
  // Each leg is an N-sided column from z=0 (foot) to z=zHip (hip-attach),
  // lateral on ±Y. Top → 100% hip, bottom → 100% foot bone.
  const legColor = parseHsl(unit.palette.primaryDark);
  const legR = footLateral * 0.5;
  const legSegs = 10;

  function pushLegVert(x: number, y: number, z: number, boneIdx: number): number {
    const idx = positions.length / 3;
    positions.push(x, y, z);
    colors.push(legColor.r, legColor.g, legColor.b, 1);
    matricesIndices.push(boneIdx, 0, 0, 0);
    matricesWeights.push(1, 0, 0, 0);
    return idx;
  }

  function buildLeg(sign: 1 | -1, footBoneIdx: number): void {
    const lateralY = sign * footLateral;
    const zTop = layout.zHip;
    const zBot = 0;
    const ringTop: number[] = [];
    const ringBot: number[] = [];
    for (let i = 0; i < legSegs; i++) {
      const a = (i / legSegs) * Math.PI * 2;
      const dx = legR * Math.cos(a);
      const dy = legR * Math.sin(a);
      ringTop.push(pushLegVert(dx, lateralY + dy, zTop, BONE.hip));
      ringBot.push(pushLegVert(dx, lateralY + dy, zBot, footBoneIdx));
    }
    // Leg cross-section is a regular polygon (always convex), so a fan
    // from the first ring vert works fine; no earcut needed.
    for (let i = 0; i < legSegs; i++) {
      const j = (i + 1) % legSegs;
      indices.push(ringBot[i], ringTop[i], ringTop[j]);
      indices.push(ringBot[i], ringTop[j], ringBot[j]);
    }
    for (let i = 1; i < legSegs - 1; i++) {
      indices.push(ringTop[0], ringTop[i], ringTop[i + 1]);
      indices.push(ringBot[0], ringBot[i + 1], ringBot[i]);
    }
  }
  buildLeg(+1, BONE.footL);
  buildLeg(-1, BONE.footR);

  const mesh = new Mesh(`character_${unit.id}`, scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.colors = colors;
  vd.matricesIndices = matricesIndices;
  vd.matricesWeights = matricesWeights;
  VertexData.ComputeNormals(positions, indices, (vd.normals = []));
  vd.applyToMesh(mesh, true);

  mesh.skeleton = rig.skeleton;
  mesh.numBoneInfluencers = 2;

  const mat = new StandardMaterial(`mat_${unit.id}`, scene);
  mat.diffuseColor = new Color3(1, 1, 1);
  mat.specularColor = new Color3(0, 0, 0);
  mat.emissiveColor = new Color3(0, 0, 0);
  // v1 escape hatch — disable culling so winding ambiguity doesn't drop
  // any faces. Revisit when we move to a proper NPR shader.
  mat.backFaceCulling = false;
  mesh.useVertexColors = true;
  mesh.hasVertexAlpha = false;
  mesh.material = mat;

  return {
    root: mesh,
    rig,
    unit,
    height: layout.height,
    footLateral,
  };
}
