import { useState, useMemo, useEffect, useRef } from "react";
import * as THREE from "three";

/* ============================================================================
   GEO FORGE — Procedural geometric unit generator
   Stacks of primitives → totem creatures for an auto-chess battler.
   ============================================================================ */

// ---------- RNG ----------
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeRNG(seedStr) {
  const seedFn = xmur3(String(seedStr));
  return mulberry32(seedFn());
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const range = (rng, a, b) => a + rng() * (b - a);
const irange = (rng, a, b) => Math.floor(range(rng, a, b + 1));
const chance = (rng, p) => rng() < p;
function weightedPick(rng, items, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

// ---------- SHAPE PRIMITIVES ----------
function starPts(cx, cy, n, ro, ri, rot = -Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? ro : ri;
    const a = rot + (i * Math.PI) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}
function ptsToPath(pts) {
  if (!pts.length) return "";
  return "M " + pts.map((p) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(" L ") + " Z";
}

// ---------- COLOR ----------
const hsl = (h, s, l, a = 1) => a === 1 ? `hsl(${h} ${s}% ${l}%)` : `hsla(${h} ${s}% ${l}% / ${a})`;

const FACTIONS = {
  ember:    { name: "EMBER",    hue: 14,  shift: 38,   sat: 78, lit: 56 },
  azure:    { name: "AZURE",    hue: 212, shift: -28,  sat: 70, lit: 56 },
  jade:     { name: "JADE",     hue: 152, shift: 56,   sat: 60, lit: 48 },
  amethyst: { name: "AMETHYST", hue: 285, shift: -50,  sat: 58, lit: 56 },
  bone:     { name: "BONE",     hue: 38,  shift: 178,  sat: 28, lit: 76 },
  void:     { name: "VOID",     hue: 248, shift: 92,   sat: 48, lit: 32 },
};

function makePalette(rng, factionKey) {
  const f = FACTIONS[factionKey];
  const h = (f.hue + range(rng, -8, 8) + 360) % 360;
  const s = Math.max(20, Math.min(95, f.sat + range(rng, -10, 8)));
  const l = Math.max(20, Math.min(85, f.lit + range(rng, -6, 6)));
  const accentH = (h + f.shift + 360) % 360;
  return {
    primary:      hsl(h, s, l),
    primaryMid:   hsl(h, s * 0.92, l * 0.8),
    primaryDark:  hsl(h, s * 0.8, Math.max(10, l * 0.45)),
    primaryLight: hsl(h, s * 0.7, Math.min(90, l * 1.35)),
    accent:       hsl(accentH, Math.min(95, s * 1.05), 62),
    accentDark:   hsl(accentH, s, 32),
    accentLight:  hsl(accentH, Math.min(95, s * 1.05), 78),
    shadow:       hsl(h, s * 0.4, 8),
    glow:         hsl(accentH, 92, 70),
    h, s, l, accentH,
  };
}

// ---------- NAMES ----------
const SYL = {
  pre: ["Vex", "Krell", "Lum", "Mor", "Drak", "Ny", "Tor", "Vyr", "Och", "Zal", "Skry", "Pyl", "Fen", "Gar", "Hes", "Iv", "Kor", "Vol", "Xen", "Ar", "Bel", "Cor", "Em", "Nox", "Quor", "Rhae", "Suv", "Thal", "Umb", "Wre"],
  mid: ["e", "or", "u", "a", "i", "y", "ae", "ou", "ar", "el"],
  suf: ["mire", "tor", "drix", "nax", "vex", "rune", "morn", "vail", "scar", "thal", "kar", "zar", "lyn", "fen", "rok", "gard", "uun", "phix", "tred", "shen", "vor", "lith", "moth", "ric", "wynn", "stor"],
};
const EPITHETS = [
  "the Sundered", "the Vow-keeper", "of the Deep Hex", "the Quiet Edict", "the Ninth Gate",
  "the Faceted", "of Cold Light", "the Recurrent", "the Iron Choir", "the Auger",
  "the Last Seal", "the Slow Star", "the Edge-walker", "the Glass-eyed", "the Mire-born",
  "the Spire", "the Numbered", "the Gilded Wound", "the Hollow Crown", "the Returner",
  "the Shaper", "of Lost Octaves", "the Brittle King", "the Soft Knife", "the Long Wait",
];
function genName(rng) {
  const a = pick(rng, SYL.pre);
  const b = chance(rng, 0.35) ? pick(rng, SYL.mid) : "";
  const c = pick(rng, SYL.suf);
  return a + b + c;
}

// ---------- ARCHETYPES ----------
const ARCHETYPES = {
  Warden: {
    factions: ["azure", "bone", "jade"],
    base:   ["hexagon", "octagon", "trapezoidI", "disk"],
    body:   ["hexagon", "octagon", "shield", "square", "trapezoidI"],
    crown:  ["pentagon", "shield", "diamond", "hexagonV"],
    profile:["tower", "obelisk", "pyramid"],
    layers: [4, 5],
    bias:   [0.5, 0.3, 0.2],
  },
  Striker: {
    factions: ["ember", "amethyst", "void"],
    base:   ["pentagon", "hexagon", "trapezoidI"],
    body:   ["triangle", "diamond", "rhombusFlat", "pentagon"],
    crown:  ["triangle", "blade", "diamond", "star5"],
    profile:["pyramid", "totem"],
    layers: [3, 5],
    bias:   [0.25, 0.55, 0.2],
  },
  Caster: {
    factions: ["amethyst", "azure", "void"],
    base:   ["hexagon", "disk", "octagon"],
    body:   ["star6", "diamond", "circle", "hexagonV"],
    crown:  ["star5", "star8", "circle", "crescent"],
    profile:["vase", "drone", "totem"],
    layers: [3, 5],
    bias:   [0.25, 0.2, 0.55],
  },
  Beast: {
    factions: ["jade", "ember", "bone"],
    base:   ["disk", "circle", "trapezoidI"],
    body:   ["circle", "rhombusFlat", "pentagon", "hexagonV"],
    crown:  ["triangle", "diamond", "star5", "circle"],
    profile:["totem", "vase", "tower"],
    layers: [3, 5],
    bias:   [0.42, 0.4, 0.18],
  },
  Construct: {
    factions: ["bone", "azure", "void"],
    base:   ["square", "octagon", "trapezoidI"],
    body:   ["square", "octagon", "trapezoid", "hexagonV"],
    crown:  ["square", "triangle", "diamond", "obelisk"],
    profile:["obelisk", "tower", "pyramid"],
    layers: [4, 6],
    bias:   [0.45, 0.4, 0.15],
  },
  Specter: {
    factions: ["void", "amethyst", "azure"],
    base:   ["disk", "circle"],
    body:   ["circle", "diamond", "crescent"],
    crown:  ["star8", "circle", "crescent"],
    profile:["vase", "drone"],
    layers: [3, 4],
    bias:   [0.2, 0.3, 0.5],
    floating: true,
  },
};

function profileSizes(profile, n, rng, baseR) {
  const sizes = [];
  for (let i = 0; i < n; i++) {
    const t = i / Math.max(1, n - 1);
    let mul;
    switch (profile) {
      case "tower":   mul = 1.0 - t * 0.18; break;
      case "pyramid": mul = 1.05 - t * 0.62; break;
      case "vase":    mul = 0.78 + Math.sin(t * Math.PI) * 0.42 - t * 0.22; break;
      case "obelisk": mul = i === 0 ? 1.12 : (i === n - 1 ? 0.42 : 0.78 - t * 0.18); break;
      case "totem":   mul = 0.92 + (i % 2 === 0 ? 0.16 : -0.12); break;
      case "drone":   mul = 0.55 + t * 0.55; break;
      default: mul = 1.0;
    }
    mul *= 1 + range(rng, -0.04, 0.04);
    sizes.push(Math.max(8, baseR * mul));
  }
  return sizes;
}

function generateUnit(rng, opts = {}) {
  const archetypeKey = opts.archetype ?? pick(rng, Object.keys(ARCHETYPES));
  const A = ARCHETYPES[archetypeKey];
  const factionKey = opts.faction ?? pick(rng, A.factions);
  const palette = makePalette(rng, factionKey);
  const profile = pick(rng, A.profile);
  const layerCount = irange(rng, A.layers[0], A.layers[1]);
  const baseR = 46;
  const sizes = profileSizes(profile, layerCount, rng, baseR);

  const layers = [];
  for (let i = 0; i < layerCount; i++) {
    const isTop = i === layerCount - 1;
    const isBottom = i === 0;
    const role = isBottom ? "base" : isTop ? "crown" : "body";
    const pool = role === "base" ? A.base : role === "crown" ? A.crown : A.body;
    const shape = pick(rng, pool);
    const r = sizes[i];
    const thickness = r * range(rng, 0.36, 0.66);
    const xOffset = chance(rng, 0.18) ? range(rng, -2.5, 2.5) : 0;
    const useAccent = chance(rng, role === "crown" ? 0.55 : role === "base" ? 0.15 : 0.22);
    const inset = chance(rng, role === "body" ? 0.35 : 0.15);
    layers.push({ shape, r, thickness, x: xOffset, role, tone: useAccent ? "accent" : "primary", inset });
  }

  // eyes — placed on a body layer, prefer upper-mid
  const eyeOptions = ["double", "single", "triple", "none"];
  const eyeWeights = [0.55, 0.18, 0.10, 0.17];
  const eyes = weightedPick(rng, eyeOptions, eyeWeights);
  const candidateLayers = [];
  for (let i = 1; i < layerCount; i++) candidateLayers.push(i);
  const eyeLayer = pick(rng, candidateLayers.length ? candidateLayers : [Math.max(0, layerCount - 1)]);

  // protrusions
  const protrusions = weightedPick(rng, ["none", "horns", "blades", "spikes", "antennae"], [0.4, 0.18, 0.18, 0.12, 0.12]);

  // aura
  const aura = chance(rng, 0.32);

  // tier
  const tier = weightedPick(rng, [1, 2, 3], [0.55, 0.30, 0.15]);

  // stats
  const totalPoints = 16 + tier * 5;
  const bias = A.bias;
  const stats = {
    hp:  Math.max(1, Math.round(totalPoints * bias[0] * range(rng, 0.85, 1.2))),
    atk: Math.max(1, Math.round(totalPoints * bias[1] * range(rng, 0.85, 1.2))),
    mag: Math.max(1, Math.round(totalPoints * bias[2] * range(rng, 0.85, 1.2))),
  };

  const id = "u" + Math.floor(rng() * 1e9).toString(36);
  const name = genName(rng);
  const epithet = pick(rng, EPITHETS);
  const floating = !!A.floating;

  return {
    id, name, epithet,
    archetype: archetypeKey,
    faction: FACTIONS[factionKey].name,
    factionKey,
    palette,
    profile,
    layers,
    eyes, eyeLayer,
    protrusions,
    aura,
    tier,
    stats,
    floating,
  };
}

function generateRoster(seedStr, count = 12) {
  const rng = makeRNG(seedStr);
  const units = [];
  for (let i = 0; i < count; i++) units.push(generateUnit(rng));
  return units;
}

// ---------- SVG RENDERER ----------
// ---------- WEBGL RENDERER (Three.js, real depth buffer) ----------
// Same generator output → real 3D meshes. ExtrudeGeometry handles concave
// shapes via earcut, the depth buffer handles all draw order. Continuous
// rotation comes free.
// ---------- SDF RAYMARCH RENDERER ----------
// Renders the unit by raymarching a signed-distance field built from per-layer
// primitives, smoothly unioned. Layer junctions blend into a single organic
// silhouette. Single fullscreen quad + ShaderMaterial.

const SHAPE_CYL = 0;
const SHAPE_HEX = 1;
const SHAPE_BOX = 2;
const SHAPE_OCT = 3;
const SHAPE_STAR5 = 4;
const SHAPE_STAR6 = 5;
const SHAPE_STAR8 = 6;
const SHAPE_PENT = 7;
const SHAPE_TRI = 8;
const SHAPE_CRESCENT = 9;
const SHAPE_DIAMOND = 10;
const SHAPE_RHOMBUS_FLAT = 11;
const SHAPE_BLADE = 12;
const SHAPE_TRAP = 13;
function shapeToSDFCode(shape) {
  if (shape === "hexagon" || shape === "hexagonV") return SHAPE_HEX;
  if (shape === "square") return SHAPE_BOX;
  if (shape === "octagon") return SHAPE_OCT;
  if (shape === "star5") return SHAPE_STAR5;
  if (shape === "star6") return SHAPE_STAR6;
  if (shape === "star8") return SHAPE_STAR8;
  if (shape === "pentagon" || shape === "obelisk") return SHAPE_PENT;
  if (shape === "triangle") return SHAPE_TRI;
  if (shape === "crescent") return SHAPE_CRESCENT;
  if (shape === "diamond") return SHAPE_DIAMOND;
  if (shape === "rhombusFlat") return SHAPE_RHOMBUS_FLAT;
  if (shape === "blade") return SHAPE_BLADE;
  if (shape === "trapezoid" || shape === "trapezoidI") return SHAPE_TRAP;
  // circle, disk, shield, anything else → cylinder
  return SHAPE_CYL;
}

const SDF_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

const SDF_FRAG = `
precision highp float;
#define MAX_LAYERS 8
#define MAX_CONES 6
#define MAX_SPHERES 4
#define PI 3.14159265359

uniform int   numLayers;
uniform float layerY[MAX_LAYERS];
uniform float layerH[MAX_LAYERS];
uniform float layerR[MAX_LAYERS];
uniform float layerX[MAX_LAYERS];
uniform float layerShape[MAX_LAYERS];
uniform float layerTone[MAX_LAYERS];

// Protrusions: cones (capped, with end radii) and spheres
// coneA.xyz = base position, coneA.w = base radius (r1)
// coneB.xyz = tip position,  coneB.w = tip radius (r2)
// sphereA.xyz = center,      sphereA.w = radius
uniform int  numCones;
uniform vec4 coneA[MAX_CONES];
uniform vec4 coneB[MAX_CONES];
uniform int  numSpheres;
uniform vec4 sphereA[MAX_SPHERES];

uniform vec3  primaryColor;
uniform vec3  accentColor;
uniform vec3  glowColor;

uniform float yawRad;
uniform float pitch;
uniform float viewSize;
uniform vec2  resolution;
uniform float smoothK;     // for layer-layer blend
uniform float smoothKProt; // for protrusion-body blend (tighter so thin features survive)
uniform float auraStrength; // 0 = no aura, 0.4 normal, 0.55 featured
uniform vec3  lightDir;

varying vec2 vUv;

// =================================================================
// 2D SDFs (operate in XZ plane; y is the prism axis)
// All return true Euclidean distance, so they raymarch and smin cleanly.
// Sources: iquilezles.org/articles/distfunctions2d
// =================================================================
float sdCircle2D(vec2 p, float r) { return length(p) - r; }

float sdBox2D(vec2 p, vec2 b) {
  vec2 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

float sdHexagon2D(vec2 p, float r) {
  const vec3 k = vec3(-0.8660254, 0.5, 0.57735);
  p = abs(p);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}

float sdOctagon2D(vec2 p, float r) {
  const vec3 k = vec3(-0.9238795325, 0.3826834323, 0.4142135624);
  p = abs(p);
  p -= 2.0 * min(dot(p, k.xy), 0.0) * k.xy;
  p -= 2.0 * min(dot(p, vec2(-k.x, k.y)), 0.0) * vec2(-k.x, k.y);
  p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}

float sdPentagon2D(vec2 p, float r) {
  const vec3 k = vec3(0.809016994, 0.587785252, 0.726542528);
  p.x = abs(p.x);
  p -= 2.0 * min(dot(vec2(-k.x, k.y), p), 0.0) * vec2(-k.x, k.y);
  p -= 2.0 * min(dot(vec2( k.x, k.y), p), 0.0) * vec2( k.x, k.y);
  p -= vec2(clamp(p.x, -r * k.z, r * k.z), r);
  return length(p) * sign(p.y);
}

float sdTriangle2D(vec2 p, float r) {
  const float k = 1.7320508; // sqrt(3)
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) * 0.5;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}

// N-pointed star. n=points, m=concavity (>2; lower = pointier)
float sdStar2D(vec2 p, float r, float n, float m) {
  float an = PI / n;
  float en = PI / m;
  vec2 acs = vec2(cos(an), sin(an));
  vec2 ecs = vec2(cos(en), sin(en));
  float bn = mod(atan(p.x, p.y), 2.0 * an) - an;
  p = length(p) * vec2(cos(bn), abs(sin(bn)));
  p -= r * acs;
  p += ecs * clamp(-dot(p, ecs), 0.0, r * acs.y / ecs.y);
  return length(p) * sign(p.x);
}

// Crescent. d = offset of cutout disc, ra = outer radius, rb = inner cutout radius
float sdMoon2D(vec2 p, float d, float ra, float rb) {
  p.y = abs(p.y);
  float a = (ra * ra - rb * rb + d * d) / (2.0 * d);
  float b = sqrt(max(ra * ra - a * a, 0.0));
  if (d * (p.x * b - p.y * a) > d * d * max(b - p.y, 0.0))
    return length(p - vec2(a, b));
  return max(length(p) - ra, -(length(p - vec2(d, 0.0)) - rb));
}

float ndot(vec2 a, vec2 b) { return a.x * b.x - a.y * b.y; }
float sdRhombus2D(vec2 p, vec2 b) {
  p = abs(p);
  float h = clamp(ndot(b - 2.0 * p, b) / dot(b, b), -1.0, 1.0);
  float d = length(p - 0.5 * b * vec2(1.0 - h, 1.0 + h));
  return d * sign(p.x * b.y + p.y * b.x - b.x * b.y);
}

float sdTrapezoid2D(vec2 p, float r1, float r2, float he) {
  vec2 k1 = vec2(r2, he);
  vec2 k2 = vec2(r2 - r1, 2.0 * he);
  p.x = abs(p.x);
  vec2 ca = vec2(p.x - min(p.x, (p.y < 0.0) ? r1 : r2), abs(p.y) - he);
  vec2 cb = p - k1 + k2 * clamp(dot(k1 - p, k2) / dot(k2, k2), 0.0, 1.0);
  float s = (cb.x < 0.0 && ca.y < 0.0) ? -1.0 : 1.0;
  return s * sqrt(min(dot(ca, ca), dot(cb, cb)));
}

// Extrude a 2D SDF into a 3D prism along Y
float prism(float d2d, float py, float h) {
  vec2 d = vec2(d2d, abs(py) - h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

// =================================================================
// 3D primitives for protrusions
// =================================================================
// Capped cone with arbitrary endpoints and end radii (true Euclidean distance)
float sdCappedCone(vec3 p, vec3 a, vec3 b, float ra, float rb) {
  float rba  = rb - ra;
  float baba = dot(b - a, b - a);
  float papa = dot(p - a, p - a);
  float paba = dot(p - a, b - a) / baba;
  float x    = sqrt(max(0.0, papa - paba * paba * baba));
  float cax  = max(0.0, x - ((paba < 0.5) ? ra : rb));
  float cay  = abs(paba - 0.5) - 0.5;
  float k    = rba * rba + baba;
  float f    = clamp((rba * (x - ra) + paba * baba) / k, 0.0, 1.0);
  float cbx  = x - ra - f * rba;
  float cby  = paba - f;
  float s    = (cbx < 0.0 && cay < 0.0) ? -1.0 : 1.0;
  return s * sqrt(min(cax * cax + cay * cay * baba,
                      cbx * cbx + cby * cby * baba));
}

float sdLayer(vec3 p, int idx) {
  vec3 lp = p - vec3(layerX[idx], layerY[idx], 0.0);
  int sh = int(layerShape[idx] + 0.5);
  float r = layerR[idx];
  float h = layerH[idx];
  vec2 xz = lp.xz;
  float py = lp.y;

  if (sh == 1)  return prism(sdHexagon2D(xz, r), py, h);
  if (sh == 2)  return prism(sdBox2D(xz, vec2(r * 0.78)), py, h);
  if (sh == 3)  return prism(sdOctagon2D(xz, r), py, h);
  if (sh == 4)  return prism(sdStar2D(xz, r, 5.0, 3.0), py, h);
  if (sh == 5)  return prism(sdStar2D(xz, r, 6.0, 3.5), py, h);
  if (sh == 6)  return prism(sdStar2D(xz, r * 1.04, 8.0, 3.0), py, h);
  if (sh == 7)  return prism(sdPentagon2D(xz, r), py, h);
  if (sh == 8)  return prism(sdTriangle2D(xz, r), py, h);
  if (sh == 9)  return prism(sdMoon2D(xz, r * 0.34, r, r * 0.85), py, h);
  if (sh == 10) return prism(sdRhombus2D(xz, vec2(r * 0.72, r)), py, h);
  if (sh == 11) return prism(sdRhombus2D(xz, vec2(r, r * 0.55)), py, h);
  if (sh == 12) return prism(sdRhombus2D(xz, vec2(r * 1.45, r * 0.22)), py, h);
  if (sh == 13) return prism(sdTrapezoid2D(xz, r, r * 0.6, r * 0.6), py, h);
  return prism(sdCircle2D(xz, r), py, h); // default cylinder
}

// Smooth-min returning (distance, blend factor h ∈ [0,1])
// h = 1 → result == a; h = 0 → result == b
vec2 sminH(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  float d = mix(b, a, h) - k * h * (1.0 - h);
  return vec2(d, h);
}

void sdScene(vec3 p, out float d, out vec3 col) {
  d = 1e9;
  col = primaryColor;
  // Body layers — wide smin for blob junctions between cake levels
  for (int i = 0; i < MAX_LAYERS; i++) {
    if (i >= numLayers) break;
    float ld = sdLayer(p, i);
    vec3 lc = (layerTone[i] > 0.5) ? accentColor : primaryColor;
    vec2 sm = sminH(d, ld, smoothK);
    d = sm.x;
    col = mix(lc, col, sm.y);
  }
  // Protrusion cones (horns, spikes, antenna stems, blade fins)
  for (int i = 0; i < MAX_CONES; i++) {
    if (i >= numCones) break;
    vec4 ca = coneA[i];
    vec4 cb = coneB[i];
    float cd = sdCappedCone(p, ca.xyz, cb.xyz, ca.w, cb.w);
    vec2 sm = sminH(d, cd, smoothKProt);
    d = sm.x;
    col = mix(accentColor, col, sm.y);
  }
  // Protrusion spheres (antenna tip bulbs)
  for (int i = 0; i < MAX_SPHERES; i++) {
    if (i >= numSpheres) break;
    vec4 sa = sphereA[i];
    float sd = length(p - sa.xyz) - sa.w;
    vec2 sm = sminH(d, sd, smoothKProt);
    d = sm.x;
    col = mix(accentColor, col, sm.y);
  }
}

vec3 calcNormal(vec3 p) {
  const float eps = 0.5;
  float dxp, dxm, dyp, dym, dzp, dzm; vec3 cdummy;
  sdScene(p + vec3(eps, 0.0, 0.0), dxp, cdummy);
  sdScene(p - vec3(eps, 0.0, 0.0), dxm, cdummy);
  sdScene(p + vec3(0.0, eps, 0.0), dyp, cdummy);
  sdScene(p - vec3(0.0, eps, 0.0), dym, cdummy);
  sdScene(p + vec3(0.0, 0.0, eps), dzp, cdummy);
  sdScene(p - vec3(0.0, 0.0, eps), dzm, cdummy);
  return normalize(vec3(dxp - dxm, dyp - dym, dzp - dzm));
}

void main() {
  // Camera matches GL pane: orthographic, distance 600, looking at origin.
  float dist = 600.0;
  vec3 camPos = vec3(
    dist * sin(yawRad) * cos(pitch),
    dist * sin(pitch),
    dist * cos(yawRad) * cos(pitch)
  );
  vec3 camFwd = -normalize(camPos);
  vec3 camRight = normalize(cross(vec3(0.0, 1.0, 0.0), camFwd));
  vec3 camUp = cross(camFwd, camRight);

  float aspect = resolution.x / resolution.y;
  float worldH = viewSize;
  float worldW = viewSize * aspect;
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 ro = camPos + camRight * (ndc.x * worldW * 0.5) + camUp * (ndc.y * worldH * 0.5);
  vec3 rd = camFwd;

  float t = 0.0;
  bool hit = false;
  vec3 hitColor = vec3(0.5);
  // 96 steps with 0.92 step factor — concave star tips and smin junctions
  // need conservative steps to avoid ray overshoot.
  for (int i = 0; i < 96; i++) {
    vec3 p = ro + rd * t;
    float d; vec3 col;
    sdScene(p, d, col);
    if (d < 0.05) {
      hit = true;
      hitColor = col;
      break;
    }
    if (t > 1500.0) break;
    t += d * 0.92;
  }

  if (hit) {
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p);
    float diffuse = max(0.0, dot(n, normalize(lightDir)));
    float ambient = 0.32;
    vec3 finalCol = hitColor * (ambient + diffuse * 0.85);
    gl_FragColor = vec4(finalCol, 1.0);
  } else {
    // Miss: render the aura as a radial gradient centered on the canvas
    // (where the unit silhouette also projects). Three.js uses premultiplied
    // alpha by default, so output rgb pre-multiplied by alpha.
    if (auraStrength > 0.001) {
      vec2 c = (vUv - 0.5) * vec2(aspect, 1.0);
      float r = length(c);
      // Softer, wider falloff so the glow extends further from the silhouette
      float glow = smoothstep(0.55, 0.0, r);
      glow = pow(glow, 1.2);
      float a = glow * auraStrength;
      gl_FragColor = vec4(glowColor * a, a);
    } else {
      gl_FragColor = vec4(0.0);
    }
  }
}
`;

function UnitSDF({ unit, size = 300, yawDeg = 0, featured = false }) {
  const mountRef = useRef(null);
  const stateRef = useRef({});

  // ---- SETUP / TEAR DOWN ----
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const W = size;
    const H = Math.round(size * 1.1);

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    mount.appendChild(renderer.domElement);

    const geo = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.ShaderMaterial({
      transparent: true,
      vertexShader: SDF_VERT,
      fragmentShader: SDF_FRAG,
      uniforms: {
        numLayers:    { value: 0 },
        layerY:       { value: new Array(8).fill(0) },
        layerH:       { value: new Array(8).fill(0) },
        layerR:       { value: new Array(8).fill(0) },
        layerX:       { value: new Array(8).fill(0) },
        layerShape:   { value: new Array(8).fill(0) },
        layerTone:    { value: new Array(8).fill(0) },
        numCones:     { value: 0 },
        coneA:        { value: Array.from({ length: 6 }, () => new THREE.Vector4()) },
        coneB:        { value: Array.from({ length: 6 }, () => new THREE.Vector4()) },
        numSpheres:   { value: 0 },
        sphereA:      { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
        primaryColor: { value: new THREE.Color(1, 1, 1) },
        accentColor:  { value: new THREE.Color(1, 1, 1) },
        glowColor:    { value: new THREE.Color(1, 1, 1) },
        yawRad:       { value: 0 },
        pitch:        { value: Math.PI / 6 },
        viewSize:     { value: 220 },
        resolution:   { value: new THREE.Vector2(W, H) },
        smoothK:      { value: 14.0 },
        smoothKProt:  { value: 4.0 },
        auraStrength: { value: 0.0 },
        lightDir:     { value: new THREE.Vector3(-0.4, 0.85, 0.3).normalize() },
      },
    });
    const mesh = new THREE.Mesh(geo, material);
    scene.add(mesh);

    stateRef.current = { scene, camera, renderer, material, mount, W, H };

    return () => {
      geo.dispose();
      material.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      stateRef.current = {};
    };
  }, [size]);

  // ---- UPDATE UNIT DATA ----
  useEffect(() => {
    const s = stateRef.current;
    if (!s.material) return;
    const u = s.material.uniforms;
    const p = unit.palette;

    const N = Math.min(8, unit.layers.length);
    const layerY = new Array(8).fill(0);
    const layerH = new Array(8).fill(0);
    const layerR = new Array(8).fill(0);
    const layerX = new Array(8).fill(0);
    const layerShape = new Array(8).fill(0);
    const layerTone = new Array(8).fill(0);
    let yy = 0;
    for (let i = 0; i < N; i++) {
      const L = unit.layers[i];
      const slabH = Math.max(L.thickness * 1.5, L.r * 0.42);
      layerY[i] = yy + slabH * 0.5;   // center y
      layerH[i] = slabH * 0.5;        // half-height
      layerR[i] = L.r;
      layerX[i] = L.x;
      layerShape[i] = shapeToSDFCode(L.shape);
      layerTone[i] = L.tone === "accent" ? 1 : 0;
      yy += slabH;
    }
    // Compute protrusion top extension (max upward extent above the head layer top)
    // so we can include it in the visual centering. Without this, units with
    // tall horns/spikes/antennae are visually top-heavy because the bare-layer
    // center sits below the silhouette's true midpoint.
    let protrTop = 0;
    if (N > 0 && unit.protrusions !== "none") {
      const tr = unit.layers[N - 1].r;
      if (unit.protrusions === "horns") protrTop = Math.cos(Math.PI / 7) * 0.95 * tr;
      else if (unit.protrusions === "spikes") protrTop = 1.10 * tr;
      else if (unit.protrusions === "antennae") protrTop = 1.05 * tr + 0.13 * tr;
      // blades: 0 (horizontal extension only)
    }
    // Center vertically: shift so the FULL silhouette (layers + protrusions)
    // has its midpoint at world y=0.
    const totalH = yy;
    const visualMid = (totalH + protrTop) * 0.5;
    for (let i = 0; i < N; i++) layerY[i] -= visualMid;

    u.numLayers.value = N;
    u.layerY.value = layerY;
    u.layerH.value = layerH;
    u.layerR.value = layerR;
    u.layerX.value = layerX;
    u.layerShape.value = layerShape;
    u.layerTone.value = layerTone;

    const accentS = Math.min(95, p.s * 1.05);
    u.primaryColor.value.setHSL(p.h / 360, p.s / 100, p.l / 100);
    u.accentColor.value.setHSL(p.accentH / 360, accentS / 100, 0.62);
    // Glow: brighter, more saturated than accent — matches what GL/SVG aura used
    u.glowColor.value.setHSL(p.accentH / 360, 0.92, 0.70);
    u.auraStrength.value = featured ? 0.75 : (unit.aura ? 0.5 : 0.0);

    // Per-unit viewSize: scale the camera's ortho frustum so the unit fits the
    // canvas with margin. Without this, tall tower+protrusion units clip
    // top/bottom because the default viewSize only sees ±110 world units.
    const visualH = totalH + protrTop;
    let maxLayerR = 0;
    for (let i = 0; i < N; i++) maxLayerR = Math.max(maxLayerR, unit.layers[i].r);
    let visualW = 2 * maxLayerR;
    if (unit.protrusions === "blades" && N >= 2) {
      visualW = Math.max(visualW, 2 * 1.45 * unit.layers[Math.max(1, N - 2)].r);
    }
    const aspect = u.resolution.value.x / u.resolution.value.y;
    const margin = 1.18;
    u.viewSize.value = Math.max(visualH * margin, (visualW * margin) / aspect, 220);

    // ---- Protrusions: compute cones + spheres in unit-centered coords ----
    const cones = [];
    const spheres = [];
    if (N > 0 && unit.protrusions !== "none") {
      const topIdx = N - 1;
      const top = unit.layers[topIdx];
      const tr = top.r;
      const tx = top.x;
      const headTopY = layerY[topIdx] + layerH[topIdx]; // top of head layer in centered coords
      const bIdx = Math.max(1, N - 2);
      const bL = unit.layers[bIdx];
      const bMidY = layerY[bIdx];
      const bx = bL.x;
      const br = bL.r;

      if (unit.protrusions === "horns") {
        const len = tr * 0.95;
        const angle = Math.PI / 7;
        const dx = Math.sin(angle) * len;
        const dy = Math.cos(angle) * len;
        const offset = tr * 0.5;
        // Sink the base slightly below the head top so smin makes a clean root
        const baseY = headTopY - tr * 0.05;
        for (const sign of [-1, 1]) {
          cones.push({
            base: [tx + sign * offset, baseY, 0],
            tip:  [tx + sign * (offset + dx), baseY + dy, 0],
            r1: tr * 0.18,
            r2: 0.5, // small but non-zero to avoid singular cone math
          });
        }
      } else if (unit.protrusions === "spikes") {
        const baseY = headTopY - tr * 0.02;
        cones.push({ base: [tx, baseY, 0], tip: [tx, baseY + tr * 1.10, 0], r1: tr * 0.13, r2: 0.5 });
        for (const sign of [-1, 1]) {
          cones.push({
            base: [tx + sign * tr * 0.55, baseY, 0],
            tip:  [tx + sign * tr * 0.55, baseY + tr * 0.85, 0],
            r1: tr * 0.13,
            r2: 0.5,
          });
        }
      } else if (unit.protrusions === "antennae") {
        const baseY = headTopY - tr * 0.02;
        const stemH = tr * 1.05;
        const stemR = Math.max(1.0, tr * 0.05);
        const tipR = tr * 0.13;
        for (const sign of [-1, 1]) {
          const baseX = tx + sign * tr * 0.4;
          const tipX = tx + sign * tr * 0.5;
          const tipY = baseY + stemH;
          cones.push({
            base: [baseX, baseY, 0],
            tip:  [tipX, tipY, 0],
            r1: stemR,
            r2: stemR,
          });
          spheres.push({ c: [tipX, tipY, 0], r: tipR });
        }
      } else if (unit.protrusions === "blades") {
        // Blades = horizontal "fins" tapering outward from body
        for (const sign of [-1, 1]) {
          cones.push({
            base: [bx + sign * br * 0.45, bMidY, 0],
            tip:  [bx + sign * br * 1.45, bMidY, 0],
            r1: br * 0.20,
            r2: 0.5,
          });
        }
      }
    }

    // Upload cones (clear unused slots)
    const cA = u.coneA.value;
    const cB = u.coneB.value;
    for (let i = 0; i < cA.length; i++) { cA[i].set(0, 0, 0, 0); cB[i].set(0, 0, 0, 0); }
    for (let i = 0; i < cones.length && i < cA.length; i++) {
      cA[i].set(cones[i].base[0], cones[i].base[1], cones[i].base[2], cones[i].r1);
      cB[i].set(cones[i].tip[0],  cones[i].tip[1],  cones[i].tip[2],  cones[i].r2);
    }
    u.numCones.value = Math.min(cones.length, cA.length);

    // Upload spheres
    const sA = u.sphereA.value;
    for (let i = 0; i < sA.length; i++) sA[i].set(0, 0, 0, 0);
    for (let i = 0; i < spheres.length && i < sA.length; i++) {
      sA[i].set(spheres[i].c[0], spheres[i].c[1], spheres[i].c[2], spheres[i].r);
    }
    u.numSpheres.value = Math.min(spheres.length, sA.length);
  }, [unit, featured]);

  // ---- RENDER LOOP ----
  useEffect(() => {
    const s = stateRef.current;
    if (!s.material) return;
    let raf;
    const animate = () => {
      s.material.uniforms.yawRad.value = (yawDeg * Math.PI) / 180;
      s.renderer.render(s.scene, s.camera);
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, [yawDeg, featured, unit]);

  return <div ref={mountRef} style={{ width: size, height: Math.round(size * 1.1), display: "block" }} />;
}

// ---------- UI BITS ----------
function StatRow({ label, val, max = 16, color }) {
  const pct = Math.min(1, val / max);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "'VT323', monospace", fontSize: 18 }}>
      <span style={{ width: 38, color: "#7a8190", letterSpacing: "0.08em" }}>{label}</span>
      <div style={{ flex: 1, height: 8, background: "#1a1d24", border: "1px solid #2a2f3a", position: "relative" }}>
        <div style={{ position: "absolute", inset: 0, width: `${pct * 100}%`, background: color, boxShadow: `0 0 8px ${color}` }} />
        {Array.from({ length: max }).map((_, i) => (
          <div key={i} style={{ position: "absolute", left: `${(i / max) * 100}%`, top: 0, bottom: 0, width: 1, background: "#0a0c10", opacity: 0.5 }} />
        ))}
      </div>
      <span style={{ width: 24, textAlign: "right", color: "#cdd2dc" }}>{val}</span>
    </div>
  );
}

function TierStars({ tier, color }) {
  return (
    <span style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
      {Array.from({ length: 3 }).map((_, i) => (
        <svg key={i} viewBox="-10 -10 20 20" width="14" height="14">
          <path d={ptsToPath(starPts(0, 0, 5, 9, 4))} fill={i < tier ? color : "#262a32"} stroke={i < tier ? "#fff5" : "#333"} strokeWidth="0.5" />
        </svg>
      ))}
    </span>
  );
}

function UnitCard({ unit, yawDeg = 0, selected, onClick }) {
  const p = unit.palette;
  return (
    <button
      onClick={onClick}
      style={{
        position: "relative",
        background: selected
          ? `linear-gradient(180deg, ${hsl(p.h, p.s * 0.4, 14)} 0%, #0d1015 100%)`
          : "linear-gradient(180deg, #131720 0%, #0c0f15 100%)",
        border: `1px solid ${selected ? p.accent : "#1f2430"}`,
        boxShadow: selected ? `0 0 0 1px ${p.accent}, 0 0 22px ${hsl(p.accentH, 80, 50, 0.35)}` : "none",
        padding: 0,
        cursor: "pointer",
        overflow: "hidden",
        borderRadius: 2,
        transition: "border-color 120ms ease, box-shadow 200ms ease, transform 120ms ease",
        transform: selected ? "translateY(-1px)" : "none",
      }}
    >
      {/* corner ticks */}
      <div style={{ position: "absolute", top: 4, left: 4, width: 8, height: 8, borderTop: `1px solid ${selected ? p.accent : "#3a4150"}`, borderLeft: `1px solid ${selected ? p.accent : "#3a4150"}` }} />
      <div style={{ position: "absolute", top: 4, right: 4, width: 8, height: 8, borderTop: `1px solid ${selected ? p.accent : "#3a4150"}`, borderRight: `1px solid ${selected ? p.accent : "#3a4150"}` }} />
      <div style={{ position: "absolute", bottom: 4, left: 4, width: 8, height: 8, borderBottom: `1px solid ${selected ? p.accent : "#3a4150"}`, borderLeft: `1px solid ${selected ? p.accent : "#3a4150"}` }} />
      <div style={{ position: "absolute", bottom: 4, right: 4, width: 8, height: 8, borderBottom: `1px solid ${selected ? p.accent : "#3a4150"}`, borderRight: `1px solid ${selected ? p.accent : "#3a4150"}` }} />

      <div style={{ aspectRatio: "1 / 1.1", padding: 8, paddingBottom: 0 }}>
        <UnitSDF unit={unit} size={140} yawDeg={yawDeg} />
      </div>
      <div style={{ padding: "4px 8px 8px 8px", textAlign: "left", borderTop: "1px solid #1a1f29" }}>
        <div style={{ fontFamily: "'Bowlby One SC', serif", fontSize: 13, color: "#e6e8ee", letterSpacing: "0.02em", lineHeight: 1.05, textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {unit.name}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 3 }}>
          <div style={{ fontFamily: "'VT323', monospace", fontSize: 13, color: p.accent, letterSpacing: "0.1em" }}>
            {unit.archetype.toUpperCase()}·{unit.faction}
          </div>
          <TierStars tier={unit.tier} color={p.accent} />
        </div>
      </div>
    </button>
  );
}

// ---------- FEATURED PANEL ----------
function FeaturedPanel({ unit, yawDeg = 0, onReroll, onVary, onExport }) {
  if (!unit) return null;
  const p = unit.palette;
  return (
    <div style={{
      background: `linear-gradient(180deg, ${hsl(p.h, p.s * 0.3, 10)} 0%, #0a0c10 60%)`,
      border: `1px solid ${p.accentDark}`,
      borderRadius: 2,
      position: "relative",
      overflow: "hidden",
    }}>
      {/* decorative scanlines */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", backgroundImage: "repeating-linear-gradient(0deg, rgba(255,255,255,0.018) 0 1px, transparent 1px 3px)" }} />

      {/* corner brackets */}
      {["tl", "tr", "bl", "br"].map((pos) => (
        <div key={pos} style={{
          position: "absolute",
          [pos.includes("t") ? "top" : "bottom"]: 8,
          [pos.includes("l") ? "left" : "right"]: 8,
          width: 16, height: 16,
          [pos.includes("t") ? "borderTop" : "borderBottom"]: `1.5px solid ${p.accent}`,
          [pos.includes("l") ? "borderLeft" : "borderRight"]: `1.5px solid ${p.accent}`,
        }} />
      ))}

      <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14, height: "100%", position: "relative" }}>
        {/* header line */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: `1px solid ${p.accentDark}`, paddingBottom: 10 }}>
          <div style={{ fontFamily: "'VT323', monospace", fontSize: 14, color: p.accent, letterSpacing: "0.18em" }}>
            ◇ ENTRY {unit.id.toUpperCase()}
          </div>
          <TierStars tier={unit.tier} color={p.accent} />
        </div>

        {/* big art */}
        <div data-featured-art style={{ flex: "1 1 auto", minHeight: 240, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: "100%", maxWidth: 320 }}>
            <UnitSDF unit={unit} size={300} yawDeg={yawDeg} featured />
          </div>
        </div>

        {/* name */}
        <div style={{ borderTop: `1px solid ${p.accentDark}`, paddingTop: 12 }}>
          <div style={{
            fontFamily: "'Bowlby One SC', serif",
            fontSize: 28,
            color: "#f3f5fa",
            letterSpacing: "0.01em",
            lineHeight: 1.0,
            textShadow: `0 0 18px ${hsl(p.accentH, 80, 60, 0.25)}`,
          }}>
            {unit.name.toUpperCase()}
          </div>
          <div style={{ fontFamily: "'VT323', monospace", fontSize: 18, color: "#9aa3b3", letterSpacing: "0.06em", marginTop: 2 }}>
            {unit.epithet}
          </div>
          <div style={{ fontFamily: "'VT323', monospace", fontSize: 17, marginTop: 8, display: "flex", gap: 14 }}>
            <span style={{ color: p.accent, letterSpacing: "0.1em" }}>{unit.archetype.toUpperCase()}</span>
            <span style={{ color: "#5a6273" }}>/</span>
            <span style={{ color: "#cdd2dc", letterSpacing: "0.1em" }}>{unit.faction}</span>
            <span style={{ color: "#5a6273" }}>/</span>
            <span style={{ color: "#7c8497", letterSpacing: "0.1em" }}>{unit.profile.toUpperCase()}</span>
          </div>
        </div>

        {/* stats */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <StatRow label="HP" val={unit.stats.hp} color={hsl(0, 70, 55)} />
          <StatRow label="ATK" val={unit.stats.atk} color={hsl(35, 90, 55)} />
          <StatRow label="MAG" val={unit.stats.mag} color={hsl(220, 80, 65)} />
        </div>

        {/* actions */}
        <div style={{ display: "flex", gap: 8 }}>
          <ForgeButton onClick={onReroll} accent={p.accent}>RE-ROLL</ForgeButton>
          <ForgeButton onClick={onVary} accent={p.accent}>VARY</ForgeButton>
          <ForgeButton onClick={onExport} accent={p.accent}>EXPORT PNG</ForgeButton>
        </div>
      </div>
    </div>
  );
}

function ForgeButton({ children, onClick, accent = "#cccccc", small = false, active = false }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        background: active ? `${accent}22` : "#11141b",
        border: `1px solid ${active ? accent : "#2a2f3a"}`,
        color: active ? accent : "#cdd2dc",
        fontFamily: "'VT323', monospace",
        fontSize: small ? 14 : 16,
        letterSpacing: "0.18em",
        padding: small ? "4px 8px" : "8px 12px",
        cursor: "pointer",
        textTransform: "uppercase",
        transition: "all 100ms ease",
        boxShadow: active ? `0 0 12px ${accent}55` : "none",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = accent;
        e.currentTarget.style.color = accent;
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.borderColor = "#2a2f3a";
          e.currentTarget.style.color = "#cdd2dc";
        }
      }}
    >
      {children}
    </button>
  );
}

// ---------- MAIN APP ----------
const FONT_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bowlby+One+SC&family=VT323&display=swap');

* { box-sizing: border-box; }
body { margin: 0; }
`;

export default function App() {
  const [seed, setSeed] = useState("forge-001");
  const [seedDraft, setSeedDraft] = useState("forge-001");
  const [selected, setSelected] = useState(0);
  const [yawDeg, setYawDeg] = useState(0);   // iso yaw (8 directions: 0/45/90/...)
  const [filter, setFilter] = useState("ALL"); // ALL or one of archetype keys
  const [overrides, setOverrides] = useState({}); // index -> regenerated unit

  const baseRoster = useMemo(() => generateRoster(seed, 12), [seed]);
  const roster = useMemo(
    () => baseRoster.map((u, i) => overrides[i] || u),
    [baseRoster, overrides]
  );
  const visible = useMemo(
    () => roster.map((u, i) => ({ u, i })).filter(({ u }) => filter === "ALL" || u.archetype === filter),
    [roster, filter]
  );

  // make sure selection is valid given filter
  useEffect(() => {
    if (!visible.find((v) => v.i === selected) && visible.length > 0) {
      setSelected(visible[0].i);
    }
  }, [visible, selected]);

  const featured = roster[selected] ?? roster[0];

  // actions
  const newRoster = () => {
    const newSeed = "forge-" + Math.floor(Math.random() * 100000).toString().padStart(3, "0");
    setSeed(newSeed);
    setSeedDraft(newSeed);
    setOverrides({});
    setSelected(0);
  };
  const applySeed = () => {
    setSeed(seedDraft);
    setOverrides({});
    setSelected(0);
  };
  const reroll = () => {
    const rng = makeRNG(seed + ":r:" + selected + ":" + Math.random());
    const next = generateUnit(rng);
    setOverrides((o) => ({ ...o, [selected]: next }));
  };
  const vary = () => {
    const rng = makeRNG(seed + ":v:" + selected + ":" + Math.random());
    const cur = roster[selected];
    const next = generateUnit(rng, { archetype: cur.archetype, faction: cur.factionKey });
    setOverrides((o) => ({ ...o, [selected]: next }));
  };
  const exportPNG = () => {
    const canvas = document.querySelector(`[data-export-id="${featured.id}"] [data-featured-art] canvas`);
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${featured.name}-${featured.archetype}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  };

  const archetypeKeys = ["ALL", ...Object.keys(ARCHETYPES)];

  return (
    <>
      <style>{FONT_CSS}</style>
      <div style={{
        minHeight: "100vh",
        background: "radial-gradient(ellipse at top, #14171f 0%, #07090c 70%)",
        color: "#e6e8ee",
        fontFamily: "'VT323', monospace",
        padding: "20px",
      }}>
        {/* HEADER */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid #1f2430", paddingBottom: 12, marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
            <div style={{ fontFamily: "'Bowlby One SC', serif", fontSize: 28, letterSpacing: "0.04em", color: "#f3f5fa", textShadow: "0 0 18px #ff8a3a55" }}>
              GEO·FORGE
            </div>
            <div style={{ fontFamily: "'VT323', monospace", fontSize: 16, color: "#7a8190", letterSpacing: "0.18em" }}>
              UNIT GENERATOR · v0.1
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 16, color: "#5a6273", letterSpacing: "0.18em" }}>SEED</span>
            <input
              value={seedDraft}
              onChange={(e) => setSeedDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applySeed()}
              onBlur={applySeed}
              style={{
                fontFamily: "'VT323', monospace",
                fontSize: 16,
                letterSpacing: "0.1em",
                background: "#0d1015",
                color: "#cdd2dc",
                border: "1px solid #2a2f3a",
                padding: "6px 10px",
                width: 140,
                outline: "none",
              }}
            />
            <ForgeButton onClick={newRoster} accent="#ff8a3a">↻ NEW BATCH</ForgeButton>
            <div style={{ display: "flex", border: "1px solid #2a2f3a", alignItems: "stretch" }}>
              <ForgeButton onClick={() => setYawDeg((y) => (y - 45 + 360) % 360)} accent="#9bd2ff" small>◀</ForgeButton>
              <div style={{
                fontFamily: "VT323, monospace",
                fontSize: 14,
                letterSpacing: "0.08em",
                color: "#9bd2ff",
                background: "#0d1015",
                padding: "0 10px",
                display: "flex",
                alignItems: "center",
                borderLeft: "1px solid #2a2f3a",
                borderRight: "1px solid #2a2f3a",
                minWidth: 44,
                justifyContent: "center",
              }}>
                {yawDeg}°
              </div>
              <ForgeButton onClick={() => setYawDeg((y) => (y + 45) % 360)} accent="#9bd2ff" small>▶</ForgeButton>
            </div>
          </div>
        </div>

        {/* ARCHETYPE FILTER */}
        <div style={{ display: "flex", gap: 6, marginBottom: 18, flexWrap: "wrap" }}>
          {archetypeKeys.map((k) => {
            const active = filter === k;
            return (
              <button
                key={k}
                onClick={() => setFilter(k)}
                style={{
                  background: active ? "#ff8a3a22" : "transparent",
                  border: `1px solid ${active ? "#ff8a3a" : "#1f2430"}`,
                  color: active ? "#ff8a3a" : "#7a8190",
                  fontFamily: "'VT323', monospace",
                  fontSize: 16,
                  letterSpacing: "0.16em",
                  padding: "4px 10px",
                  cursor: "pointer",
                  textTransform: "uppercase",
                  transition: "all 120ms ease",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "#ff8a3a"; e.currentTarget.style.borderColor = "#ff8a3a"; }}
                onMouseLeave={(e) => { if (!active) { e.currentTarget.style.color = "#7a8190"; e.currentTarget.style.borderColor = "#1f2430"; } }}
              >
                {k}
              </button>
            );
          })}
        </div>

        {/* MAIN GRID */}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 380px) 1fr", gap: 18, alignItems: "start" }}>
          {/* FEATURED */}
          <div style={{ position: "sticky", top: 18 }} data-export-id={featured.id}>
            <FeaturedPanel
              unit={featured}
              yawDeg={yawDeg}
              onReroll={reroll}
              onVary={vary}
              onExport={exportPNG}
            />
          </div>

          {/* ROSTER */}
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 16, color: "#7a8190", letterSpacing: "0.18em" }}>
                ROSTER · {visible.length} / {roster.length} UNITS
              </div>
              <div style={{ fontSize: 14, color: "#454c5b", letterSpacing: "0.16em" }}>
                CLICK TO INSPECT · RE-ROLL TO REGENERATE
              </div>
            </div>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(155px, 1fr))",
              gap: 10,
            }}>
              {visible.map(({ u, i }) => (
                <UnitCard
                  key={u.id + i}
                  unit={u}
                  yawDeg={yawDeg}
                  selected={i === selected}
                  onClick={() => setSelected(i)}
                />
              ))}
            </div>

            {/* legend */}
            <div style={{ marginTop: 24, padding: 12, border: "1px solid #1f2430", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
              <div style={{ fontSize: 14, color: "#7a8190", letterSpacing: "0.16em", gridColumn: "1 / -1", borderBottom: "1px solid #1f2430", paddingBottom: 6, marginBottom: 4 }}>
                ◇ FACTION INDEX
              </div>
              {Object.entries(FACTIONS).map(([key, f]) => {
                const swatch = makePalette(makeRNG(`${key}-swatch`), key);
                return (
                  <div key={key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 22, height: 22, background: swatch.primary, border: `1px solid ${swatch.accent}`, position: "relative" }}>
                      <div style={{ position: "absolute", right: -2, bottom: -2, width: 6, height: 6, background: swatch.accent }} />
                    </div>
                    <div style={{ fontSize: 16, color: "#cdd2dc", letterSpacing: "0.12em" }}>{f.name}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* FOOTER NOTE */}
        <div style={{ marginTop: 24, fontSize: 14, color: "#454c5b", letterSpacing: "0.16em", textAlign: "center" }}>
          PROCEDURAL · 6 ARCHETYPES × 6 FACTIONS · STACK-BASED COMPOSITION · DETERMINISTIC FROM SEED
        </div>
      </div>
    </>
  );
}
