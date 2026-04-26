/**
 * Raccoon mesh — body stack soft-skinned to spine bones, head stack
 * rigid-skinned to the head bone (which sits ABOVE the body so it can
 * yaw independently of the body's heading). Ears + eyes are also rigid
 * to the head bone. Legs are reused from the existing cylinder build.
 *
 * Coordinates: walker units → babylon meters via UNIT_SCALE. RH, X-fwd,
 * Y-left, Z-up.
 */
import {
  Color3,
  Mesh,
  type Scene,
  StandardMaterial,
  VertexData,
} from "@babylonjs/core";
import earcut from "earcut";
import { BONE, createRig, rigLayout, type Rig, type RigLayout } from "../rig/skeleton";
import { UNIT_SCALE } from "../scale";
import { darken, lerpColor, parseHsl } from "./color";
import type { Unit } from "./generator";
import type { CharacterMesh } from "./mesh";
import type { RaccoonBand, RaccoonSpec } from "./raccoon";
import { blendContours, COMMON_N, smoothstep } from "./contour";
import type { Contour } from "./shapes";

const TRANSITION_FRAC = 0.22;
const TRANSITION_K = 3;
const BULGE = 0.18;

function ellipseContour(rx: number, ry: number, n: number): Contour {
  const pts: Contour = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: rx * Math.cos(a), y: ry * Math.sin(a) });
  }
  return pts;
}

function shadeColor(palette: Unit["palette"], key: RaccoonBand["shadeKey"]): Color3 {
  return parseHsl(palette[key]);
}

interface BuildBuffers {
  positions: number[];
  indices: number[];
  colors: number[];
  bIdx: number[]; // matrices indices, packed [b0,b1,0,0]
  bWt: number[];  // matrices weights
}

function newBuffers(): BuildBuffers {
  return { positions: [], indices: [], colors: [], bIdx: [], bWt: [] };
}

function pushVert(
  buf: BuildBuffers,
  x: number,
  y: number,
  z: number,
  c: Color3,
  i0: number, w0: number,
  i1: number, w1: number,
): number {
  const idx = buf.positions.length / 3;
  buf.positions.push(x, y, z);
  buf.colors.push(c.r, c.g, c.b, 1);
  buf.bIdx.push(i0, i1, 0, 0);
  buf.bWt.push(w0, w1, 0, 0);
  return idx;
}

/** Body-only soft skin: hip → spineLow → spineHigh. Caps at spineHigh
 *  so head yaw never drags body verts. */
function bodySkin(z: number, layout: RigLayout): { i0: number; w0: number; i1: number; w1: number } {
  const { zHip, zLow, zHigh } = layout;
  if (z <= zHip) return { i0: BONE.hip, w0: 1, i1: 0, w1: 0 };
  if (z >= zHigh) return { i0: BONE.spineHigh, w0: 1, i1: 0, w1: 0 };
  if (z < zLow) {
    const t = (z - zHip) / Math.max(1e-6, zLow - zHip);
    return { i0: BONE.hip, w0: 1 - t, i1: BONE.spineLow, w1: t };
  }
  const t = (z - zLow) / Math.max(1e-6, zHigh - zLow);
  return { i0: BONE.spineLow, w0: 1 - t, i1: BONE.spineHigh, w1: t };
}

interface RingDef {
  z: number;       // world (babylon) z
  contour: Contour; // walker units
  color: Color3;
  xOffset: number; // walker units
}

interface BandResolved {
  contour: Contour;       // resampled ellipse
  thickness: number;       // walker units
  xOffset: number;         // walker units
  color: Color3;
}

// Blending tuning. Smoothness and ring count are global; overlap is
// per-stack (body uses spec.bodyOverlap, head uses HEAD_OVERLAP).
const BODY_SMOOTH_K = 3.0;        // walker units. larger = softer joins
const BODY_RING_COUNT = 56;
const HEAD_RING_COUNT = 40;
/** Top and bottom head bands each overlap 50% into the mask band. */
export const HEAD_OVERLAP = 0.5;

/** Center z (walker units) of each band under smoothMax blending, given
 *  thicknesses and overlap. centers[0] = halves[0] so the stack starts
 *  at z=0 (bottom of the bottommost ellipsoid). */
export function bandCenters(thicknesses: number[], overlap: number): number[] {
  if (thicknesses.length === 0) return [];
  const halves = thicknesses.map((t) => t / 2);
  const centers: number[] = [halves[0]];
  for (let i = 1; i < halves.length; i++) {
    centers.push(centers[i - 1] + (halves[i - 1] + halves[i]) * (1 - overlap));
  }
  return centers;
}

/** Z extent (walker units) of a smoothMax-blended stack. */
export function blendedExtent(thicknesses: number[], overlap: number): number {
  if (thicknesses.length === 0) return 0;
  const centers = bandCenters(thicknesses, overlap);
  return centers[centers.length - 1] + thicknesses[thicknesses.length - 1] / 2;
}

/** Build a smoothly blended body as the smooth-max union of overlapping
 *  3D ellipsoids — one per band. Each band ellipsoid has half-height
 *  thickness/2 in Z and radius (rx,ry) in XY at its center. Centers are
 *  packed with `BODY_OVERLAP` so adjacent ellipsoids share Z extent; the
 *  smooth-max yields a continuous bulgy silhouette (the reference look).
 *
 *  The first band uses a half-ellipsoid profile (flat bottom) so legs
 *  attach to a real disc rather than a degenerate apex. */
function buildBlendedChain(
  bands: BandResolved[],
  zBaseWorld: number,
  overlap: number,
  flatBottom: boolean,
  ringCount: number,
): RingDef[] {
  const N = bands.length;
  if (N === 0) return [];

  const halves: number[] = bands.map((b) => b.thickness / 2);
  const centers = bandCenters(bands.map((b) => b.thickness), overlap);
  const zMin = 0;
  const zMax = centers[N - 1] + halves[N - 1];

  // Radius of band `bi` along angular index `a` at z. -1 = out of range.
  // When flatBottom, band 0 stays at full radius for z below its center
  // so the bottom of the stack is a real disc (legs attach there).
  function bandRadius(bi: number, z: number, a: number): number {
    const dz = z - centers[bi];
    const h = halves[bi];
    if (dz < -h || dz > h) return -1;
    let factor: number;
    if (flatBottom && bi === 0 && dz < 0) factor = 1;
    else factor = Math.sqrt(1 - (dz / h) * (dz / h));
    const c = bands[bi].contour[a];
    return factor * Math.hypot(c.x, c.y);
  }

  // Z weight (0..1) of band `bi` at z. Same as bandRadius's factor² —
  // used for color/xOffset blending without an angular sweep.
  function bandZWeight(bi: number, z: number): number {
    const dz = z - centers[bi];
    const h = halves[bi];
    if (dz < -h || dz > h) return 0;
    if (flatBottom && bi === 0 && dz < 0) return 1;
    const u = dz / h;
    return Math.max(0, 1 - u * u);
  }

  function smoothMax(values: number[], k: number): number {
    if (values.length === 0) return 0;
    let m = -Infinity;
    for (const v of values) if (v > m) m = v;
    let s = 0;
    for (const v of values) s += Math.exp((v - m) / k);
    return m + k * Math.log(s);
  }

  const rings: RingDef[] = [];
  for (let r = 0; r < ringCount; r++) {
    const t = r / (ringCount - 1);
    const z = zMin + t * (zMax - zMin);

    const contour: Contour = [];
    for (let a = 0; a < COMMON_N; a++) {
      const radii: number[] = [];
      for (let bi = 0; bi < N; bi++) {
        const rb = bandRadius(bi, z, a);
        if (rb >= 0) radii.push(rb);
      }
      const mr = smoothMax(radii, BODY_SMOOTH_K);
      const theta = (a / COMMON_N) * Math.PI * 2;
      contour.push({ x: Math.cos(theta) * mr, y: Math.sin(theta) * mr });
    }

    let totalW = 0;
    let cR = 0, cG = 0, cB = 0, xO = 0;
    for (let bi = 0; bi < N; bi++) {
      const w = bandZWeight(bi, z);
      if (w <= 0) continue;
      totalW += w;
      cR += bands[bi].color.r * w;
      cG += bands[bi].color.g * w;
      cB += bands[bi].color.b * w;
      xO += bands[bi].xOffset * w;
    }
    if (totalW > 0) { cR /= totalW; cG /= totalW; cB /= totalW; xO /= totalW; }

    rings.push({
      z: z * UNIT_SCALE + zBaseWorld,
      contour,
      color: new Color3(cR, cG, cB),
      xOffset: xO,
    });
  }
  return rings;
}

/** Build a smoothly blended ring chain across a stack of bands.
 *  Returns rings in ascending z (world units). */
function buildRingChain(
  bands: BandResolved[],
  zBaseWorld: number,
): RingDef[] {
  const rings: RingDef[] = [];
  let zWalker = 0;
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];
    const zBotW = zWalker;
    const zTopW = zWalker + band.thickness;
    const δLow = i > 0
      ? TRANSITION_FRAC * Math.min(band.thickness, bands[i - 1].thickness)
      : 0;
    const δHigh = i < bands.length - 1
      ? TRANSITION_FRAC * Math.min(band.thickness, bands[i + 1].thickness)
      : 0;
    const pureBotW = zBotW + δLow;
    const pureTopW = zTopW - δHigh;
    const toWorld = (zw: number): number => zw * UNIT_SCALE + zBaseWorld;
    rings.push({ z: toWorld(pureBotW), contour: band.contour, color: band.color, xOffset: band.xOffset });
    if (pureTopW > pureBotW) {
      rings.push({ z: toWorld(pureTopW), contour: band.contour, color: band.color, xOffset: band.xOffset });
    }
    if (i < bands.length - 1) {
      const next = bands[i + 1];
      const span = 2 * δHigh;
      for (let k = 1; k <= TRANSITION_K; k++) {
        const t = k / (TRANSITION_K + 1);
        const ringZW = pureTopW + t * span;
        const blended = blendContours(band.contour, next.contour, t, BULGE);
        const blendedColor = lerpColor(band.color, next.color, smoothstep(t));
        const blendedX = band.xOffset + (next.xOffset - band.xOffset) * smoothstep(t);
        rings.push({
          z: toWorld(ringZW),
          contour: blended,
          color: blendedColor,
          xOffset: blendedX,
        });
      }
    }
    zWalker = zTopW;
  }
  return rings;
}

function emitRingsAndSides(
  buf: BuildBuffers,
  rings: RingDef[],
  skinAt: (worldZ: number) => { i0: number; w0: number; i1: number; w1: number },
  capTop: boolean,
  capBottom: boolean,
): void {
  const ringStarts: number[] = [];
  for (const ring of rings) {
    ringStarts.push(buf.positions.length / 3);
    for (let i = 0; i < COMMON_N; i++) {
      const p = ring.contour[i];
      const wx = (p.x + ring.xOffset) * UNIT_SCALE;
      const wy = p.y * UNIT_SCALE;
      const w = skinAt(ring.z);
      pushVert(buf, wx, wy, ring.z, ring.color, w.i0, w.w0, w.i1, w.w1);
    }
  }
  for (let r = 0; r < rings.length - 1; r++) {
    const a = ringStarts[r];
    const b = ringStarts[r + 1];
    for (let i = 0; i < COMMON_N; i++) {
      const j = (i + 1) % COMMON_N;
      buf.indices.push(a + i, b + i, b + j);
      buf.indices.push(a + i, b + j, a + j);
    }
  }
  function emitCap(ring: RingDef, ringStart: number, reverse: boolean): void {
    const flat: number[] = [];
    for (const p of ring.contour) flat.push(p.x + ring.xOffset, p.y);
    const tris = earcut(flat);
    for (let k = 0; k < tris.length; k += 3) {
      const ia = tris[k];
      const ib = tris[k + 1];
      const ic = tris[k + 2];
      if (reverse) buf.indices.push(ringStart + ic, ringStart + ib, ringStart + ia);
      else buf.indices.push(ringStart + ia, ringStart + ib, ringStart + ic);
    }
  }
  if (capTop) emitCap(rings[rings.length - 1], ringStarts[ringStarts.length - 1], false);
  if (capBottom) emitCap(rings[0], ringStarts[0], true);
}

function pushCone(
  buf: BuildBuffers,
  bx: number, by: number, bz: number,
  dirX: number, dirY: number, dirZ: number,
  length: number,
  baseRadius: number,
  segments: number,
  color: Color3,
  boneIdx: number,
): void {
  const dlen = Math.hypot(dirX, dirY, dirZ) || 1;
  const dx = dirX / dlen, dy = dirY / dlen, dz = dirZ / dlen;
  const hx = Math.abs(dz) < 0.9 ? 0 : 1;
  const hy = 0;
  const hz = Math.abs(dz) < 0.9 ? 1 : 0;
  let ux = dy * hz - dz * hy;
  let uy = dz * hx - dx * hz;
  let uz = dx * hy - dy * hx;
  const ulen = Math.hypot(ux, uy, uz) || 1;
  ux /= ulen; uy /= ulen; uz /= ulen;
  const vx = dy * uz - dz * uy;
  const vy = dz * ux - dx * uz;
  const vz = dx * uy - dy * ux;
  const tip = pushVert(buf, bx + dx * length, by + dy * length, bz + dz * length, color, boneIdx, 1, 0, 0);
  const ring: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const ca = Math.cos(a) * baseRadius;
    const sa = Math.sin(a) * baseRadius;
    ring.push(
      pushVert(
        buf,
        bx + ux * ca + vx * sa,
        by + uy * ca + vy * sa,
        bz + uz * ca + vz * sa,
        color, boneIdx, 1, 0, 0,
      ),
    );
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    buf.indices.push(tip, ring[i], ring[j]);
  }
  for (let i = 1; i < segments - 1; i++) {
    buf.indices.push(ring[0], ring[i], ring[i + 1]);
  }
}

/** Forward-facing white disc, rigid-skinned to head bone. World coords. */
function pushEye(
  buf: BuildBuffers,
  cx: number, cy: number, cz: number,
  radius: number,
  color: Color3,
  boneIdx: number,
): void {
  const segs = 14;
  // Disc lies in the YZ plane (normal = +X), offset slightly forward.
  const center = pushVert(buf, cx, cy, cz, color, boneIdx, 1, 0, 0);
  const ring: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const dy = Math.cos(a) * radius;
    const dz = Math.sin(a) * radius;
    ring.push(pushVert(buf, cx, cy + dy, cz + dz, color, boneIdx, 1, 0, 0));
  }
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % segs;
    // Wind so the front face (+X) is outward.
    buf.indices.push(center, ring[j], ring[i]);
  }
}

function buildLegs(
  buf: BuildBuffers,
  layout: RigLayout,
  footLateral: number,
  legColor: Color3,
): void {
  const legR = footLateral * 0.5;
  const legSegs = 10;
  function pushLegVert(x: number, y: number, z: number, boneIdx: number): number {
    return pushVert(buf, x, y, z, legColor, boneIdx, 1, 0, 0);
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
    for (let i = 0; i < legSegs; i++) {
      const j = (i + 1) % legSegs;
      buf.indices.push(ringBot[i], ringTop[i], ringTop[j]);
      buf.indices.push(ringBot[i], ringTop[j], ringBot[j]);
    }
    for (let i = 1; i < legSegs - 1; i++) {
      buf.indices.push(ringTop[0], ringTop[i], ringTop[i + 1]);
      buf.indices.push(ringBot[0], ringBot[i + 1], ringBot[i]);
    }
  }
  buildLeg(+1, BONE.footL);
  buildLeg(-1, BONE.footR);
}

function resolveBands(bands: RaccoonBand[], palette: Unit["palette"]): BandResolved[] {
  return bands.map((b) => ({
    contour: ellipseContour(b.rx, b.ry, COMMON_N),
    thickness: b.thickness,
    xOffset: b.xOffset,
    color: shadeColor(palette, b.shadeKey),
  }));
}

// ── Shared raccoon mesh assembly ───────────────────────────────────

interface RaccoonLayout {
  layout: RigLayout;
  footLateral: number;
  headHeightWorld: number;
}

function computeRaccoonLayout(spec: RaccoonSpec): RaccoonLayout {
  const bodyHeightW = blendedExtent(spec.body.map((b) => b.thickness), spec.bodyOverlap);
  const headHeightW = blendedExtent(spec.head.map((b) => b.thickness), HEAD_OVERLAP);
  const bodyHeightWorld = bodyHeightW * UNIT_SCALE;
  const headHeightWorld = headHeightW * UNIT_SCALE;
  const headOffsetWorld = spec.headOffset * UNIT_SCALE;
  const legHeightWorld = bodyHeightWorld * 0.55;
  const layout = rigLayout(legHeightWorld, bodyHeightWorld);
  layout.zLow = layout.zHip + bodyHeightWorld * 0.4;
  layout.zHigh = layout.zHip + bodyHeightWorld;
  layout.zHead = layout.zHigh + headOffsetWorld;
  layout.height = layout.zHead + headHeightWorld;
  const avgBodyRy = spec.body.reduce((s, b) => s + b.ry, 0) / Math.max(1, spec.body.length);
  const footLateral = Math.max(avgBodyRy * 0.5, 14) * UNIT_SCALE;
  return { layout, footLateral, headHeightWorld };
}

function emitBodyToBuf(
  buf: BuildBuffers,
  spec: RaccoonSpec,
  palette: Unit["palette"],
  layout: RigLayout,
): void {
  const bodyBands = resolveBands(spec.body, palette);
  const bodyRings = buildBlendedChain(
    bodyBands,
    layout.zHip,
    spec.bodyOverlap,
    /* flatBottom */ true,
    BODY_RING_COUNT,
  );
  emitRingsAndSides(
    buf,
    bodyRings,
    (z) => bodySkin(z, layout),
    /* capTop */ false,
    /* capBottom */ true,
  );
}

/** Emit head bands, eyes, and ears. `headBaseZ` is the world z of the
 *  head bone's rest position — pass `layout.zHead` for the combined
 *  in-world mesh, or `0` for a head-local mesh that gets per-instance
 *  positioned by the caller. `boneIdx` is what the head verts skin
 *  to (BONE.head for skinned; arbitrary for rigid since no skeleton). */
function emitHeadToBuf(
  buf: BuildBuffers,
  spec: RaccoonSpec,
  palette: Unit["palette"],
  headBaseZ: number,
  boneIdx: number,
): void {
  const headBands = resolveBands(spec.head, palette);
  if (
    spec.maskStrength > 0 &&
    spec.eyes.bandIdx >= 0 &&
    spec.eyes.bandIdx < headBands.length
  ) {
    const dark = parseHsl(palette.shadow);
    const idx = spec.eyes.bandIdx;
    headBands[idx].color = lerpColor(headBands[idx].color, dark, spec.maskStrength);
  }
  const headRings = buildBlendedChain(
    headBands,
    headBaseZ,
    HEAD_OVERLAP,
    /* flatBottom */ false,
    HEAD_RING_COUNT,
  );
  emitRingsAndSides(
    buf,
    headRings,
    () => ({ i0: boneIdx, w0: 1, i1: 0, w1: 0 }),
    /* capTop */ false,
    /* capBottom */ false,
  );

  const headCenters = bandCenters(spec.head.map((b) => b.thickness), HEAD_OVERLAP);
  const eyeBandMidW = headCenters[spec.eyes.bandIdx];
  const eyeBand = spec.head[spec.eyes.bandIdx];
  const eyeX = eyeBand.xOffset * UNIT_SCALE + eyeBand.rx * spec.eyes.forward * UNIT_SCALE;
  const eyeYmag = eyeBand.ry * spec.eyes.spread * UNIT_SCALE;
  const eyeZ = headBaseZ + eyeBandMidW * UNIT_SCALE;
  const eyeR = spec.eyes.size * UNIT_SCALE;
  const eyeWhite = new Color3(0.97, 0.96, 0.93);
  const pupil = darken(eyeWhite, 0.95);
  pushEye(buf, eyeX, +eyeYmag, eyeZ, eyeR, eyeWhite, boneIdx);
  pushEye(buf, eyeX, -eyeYmag, eyeZ, eyeR, eyeWhite, boneIdx);
  const pr = eyeR * 0.55;
  const pf = eyeR * 0.18;
  pushEye(buf, eyeX + pf, +eyeYmag, eyeZ, pr, pupil, boneIdx);
  pushEye(buf, eyeX + pf, -eyeYmag, eyeZ, pr, pupil, boneIdx);

  const lastIdx = spec.head.length - 1;
  const lastHalfW = spec.head[lastIdx].thickness / 2;
  const EAR_UP_FRAC = 0.4;
  const earZWalker = headCenters[lastIdx] + lastHalfW * EAR_UP_FRAC;
  const earFactor = Math.sqrt(Math.max(0, 1 - EAR_UP_FRAC * EAR_UP_FRAC));
  const earBaseZ = headBaseZ + earZWalker * UNIT_SCALE;
  const earBaseY = spec.head[lastIdx].ry * earFactor * spec.ears.spread * UNIT_SCALE;
  const earLen = spec.ears.size * UNIT_SCALE;
  const earBaseR = spec.ears.size * 0.45 * UNIT_SCALE;
  const earColor = shadeColor(palette, spec.ears.shadeKey);
  const tilt = spec.ears.tilt;
  pushCone(buf, 0, +earBaseY, earBaseZ, 0, +Math.sin(tilt), Math.cos(tilt), earLen, earBaseR, 5, earColor, boneIdx);
  pushCone(buf, 0, -earBaseY, earBaseZ, 0, -Math.sin(tilt), Math.cos(tilt), earLen, earBaseR, 5, earColor, boneIdx);
}

function makeRaccoonMaterial(scene: Scene, name: string): StandardMaterial {
  const mat = new StandardMaterial(`mat_${name}`, scene);
  mat.diffuseColor = new Color3(1, 1, 1);
  mat.specularColor = new Color3(0, 0, 0);
  mat.emissiveColor = new Color3(0, 0, 0);
  mat.backFaceCulling = false;
  return mat;
}

function finalizeSkinnedMesh(
  scene: Scene,
  name: string,
  buf: BuildBuffers,
  skeleton: import("@babylonjs/core").Skeleton,
): Mesh {
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = buf.positions;
  vd.indices = buf.indices;
  vd.colors = buf.colors;
  vd.matricesIndices = buf.bIdx;
  vd.matricesWeights = buf.bWt;
  VertexData.ComputeNormals(buf.positions, buf.indices, (vd.normals = []));
  vd.applyToMesh(mesh, true);
  mesh.skeleton = skeleton;
  mesh.numBoneInfluencers = 2;
  mesh.material = makeRaccoonMaterial(scene, name);
  mesh.useVertexColors = true;
  mesh.hasVertexAlpha = false;
  return mesh;
}

function finalizeRigidMesh(scene: Scene, name: string, buf: BuildBuffers): Mesh {
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = buf.positions;
  vd.indices = buf.indices;
  vd.colors = buf.colors;
  VertexData.ComputeNormals(buf.positions, buf.indices, (vd.normals = []));
  vd.applyToMesh(mesh, true);
  mesh.material = makeRaccoonMaterial(scene, name);
  mesh.useVertexColors = true;
  mesh.hasVertexAlpha = false;
  return mesh;
}

/** Body+legs (skinned, with skeleton) + head (rigid, in head-local
 *  frame) — boids drive the head per-instance for independent yaw,
 *  while the body is VAT-bakeable. */
export interface DecomposedRaccoon {
  body: Mesh;
  head: Mesh;
  rig: Rig;
  unit: Unit;
  height: number;
  footLateral: number;
  /** World z (in body-root local frame) of the head bone's rest position. */
  headOffsetZ: number;
  /** Z extent of the head stack in world units. */
  headHeightWorld: number;
}

export function buildRaccoonDecomposed(unit: Unit, scene: Scene): DecomposedRaccoon {
  const spec = unit.raccoon!;
  const palette = unit.palette;
  const { layout, footLateral, headHeightWorld } = computeRaccoonLayout(spec);
  const rig = createRig(scene, layout, footLateral);

  const bodyBuf = newBuffers();
  emitBodyToBuf(bodyBuf, spec, palette, layout);
  buildLegs(bodyBuf, layout, footLateral, parseHsl(palette.primaryDark));
  const body = finalizeSkinnedMesh(scene, `rcn_body_${unit.id}`, bodyBuf, rig.skeleton);

  const headBuf = newBuffers();
  emitHeadToBuf(headBuf, spec, palette, /* headBaseZ */ 0, /* boneIdx */ 0);
  const head = finalizeRigidMesh(scene, `rcn_head_${unit.id}`, headBuf);

  return {
    body,
    head,
    rig,
    unit,
    height: layout.height,
    footLateral,
    headOffsetZ: layout.zHead,
    headHeightWorld,
  };
}

export function buildRaccoon(unit: Unit, scene: Scene): CharacterMesh {
  const spec = unit.raccoon!;
  const palette = unit.palette;
  const { layout, footLateral } = computeRaccoonLayout(spec);
  const rig = createRig(scene, layout, footLateral);

  const buf = newBuffers();
  emitBodyToBuf(buf, spec, palette, layout);
  emitHeadToBuf(buf, spec, palette, /* headBaseZ */ layout.zHead, /* boneIdx */ BONE.head);
  buildLegs(buf, layout, footLateral, parseHsl(palette.primaryDark));

  const mesh = finalizeSkinnedMesh(scene, `raccoon_${unit.id}`, buf, rig.skeleton);
  return { root: mesh, rig, unit, height: layout.height, footLateral };
}
