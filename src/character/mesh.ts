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
import { UNIT_SCALE } from "../scale";

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

  // ── Protrusions ───────────────────────────────────────────────
  // Emitted as additional cone meshes inside the same skinned Mesh,
  // bound 100% to the head bone so they pitch with mood and follow
  // the character's heading.
  const topLayer = unit.layers[unit.layers.length - 1];
  const topRWorld = topLayer.r * UNIT_SCALE;
  const topZ = layout.height;
  const protrusionColor = parseHsl(unit.palette.accent);

  function pushPVert(x: number, y: number, z: number): number {
    const idx = positions.length / 3;
    positions.push(x, y, z);
    colors.push(protrusionColor.r, protrusionColor.g, protrusionColor.b, 1);
    matricesIndices.push(BONE.head, 0, 0, 0);
    matricesWeights.push(1, 0, 0, 0);
    return idx;
  }

  function pushCone(
    bx: number, by: number, bz: number,
    dirX: number, dirY: number, dirZ: number,
    length: number,
    baseRadius: number,
    segments: number,
  ): void {
    // Normalize direction.
    const dlen = Math.hypot(dirX, dirY, dirZ) || 1;
    const dx = dirX / dlen;
    const dy = dirY / dlen;
    const dz = dirZ / dlen;
    // Pick a helper vector not parallel to d.
    const hx = Math.abs(dz) < 0.9 ? 0 : 1;
    const hy = 0;
    const hz = Math.abs(dz) < 0.9 ? 1 : 0;
    // u = normalize(d × h)
    let ux = dy * hz - dz * hy;
    let uy = dz * hx - dx * hz;
    let uz = dx * hy - dy * hx;
    const ulen = Math.hypot(ux, uy, uz) || 1;
    ux /= ulen; uy /= ulen; uz /= ulen;
    // v = d × u  (already unit since d, u are unit perpendicular)
    const vx = dy * uz - dz * uy;
    const vy = dz * ux - dx * uz;
    const vz = dx * uy - dy * ux;

    const tipIdx = pushPVert(bx + dx * length, by + dy * length, bz + dz * length);
    const ring: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const ca = Math.cos(a) * baseRadius;
      const sa = Math.sin(a) * baseRadius;
      ring.push(
        pushPVert(
          bx + ux * ca + vx * sa,
          by + uy * ca + vy * sa,
          bz + uz * ca + vz * sa,
        ),
      );
    }
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      indices.push(tipIdx, ring[i], ring[j]);
    }
    for (let i = 1; i < segments - 1; i++) {
      indices.push(ring[0], ring[i], ring[i + 1]);
    }
  }

  switch (unit.protrusions) {
    case "none":
      break;
    case "horns": {
      // Two horns, one per side, angled outward and up.
      const baseY = topRWorld * 0.45;
      const length = topRWorld * 1.0;
      const baseR = topRWorld * 0.13;
      pushCone(0, +baseY, topZ, 0, +0.45, 1, length, baseR, 6);
      pushCone(0, -baseY, topZ, 0, -0.45, 1, length, baseR, 6);
      break;
    }
    case "blades": {
      // Two elongated blade-like cones (4-sided base for a flat look).
      const baseY = topRWorld * 0.35;
      const length = topRWorld * 1.5;
      const baseR = topRWorld * 0.10;
      pushCone(0, +baseY, topZ, 0.2, +0.3, 1, length, baseR, 4);
      pushCone(0, -baseY, topZ, 0.2, -0.3, 1, length, baseR, 4);
      break;
    }
    case "spikes": {
      // A row of short spikes across the head, pointing straight up.
      const SPIKE_COUNT = 5;
      const length = topRWorld * 0.45;
      const baseR = topRWorld * 0.09;
      const span = topRWorld * 1.1;
      for (let i = 0; i < SPIKE_COUNT; i++) {
        const t = i / (SPIKE_COUNT - 1) - 0.5;
        pushCone(0, t * span, topZ, 0, 0, 1, length, baseR, 5);
      }
      break;
    }
    case "antennae": {
      // Two thin tall cones, slight outward tilt.
      const baseY = topRWorld * 0.25;
      const length = topRWorld * 1.7;
      const baseR = topRWorld * 0.045;
      pushCone(0, +baseY, topZ, 0, +0.18, 1, length, baseR, 5);
      pushCone(0, -baseY, topZ, 0, -0.18, 1, length, baseR, 5);
      break;
    }
  }

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
