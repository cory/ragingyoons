/**
 * Standalone flocking benchmark — no Babylon, runs in Node.
 *
 *   node bench/flockBench.mjs
 *
 * Tests variants of the per-frame flocking algorithm at fixed scale
 * (default 8000 boids on a 100×100m field) so we can iterate without
 * the browser. Each variant is structurally equivalent (same forces,
 * same outputs) but uses a different spatial-data layout.
 */

const N_BOIDS = parseInt(process.env.N || "8000", 10);
const BOUNDS = parseInt(process.env.BOUNDS || "50", 10); // half-extent
const FACTIONS = 6;
const ARCHETYPES = 6; // Warden, Striker, Caster, Beast, Construct, Specter
const RUNS = parseInt(process.env.RUNS || "50", 10);
const WARMUP = 5;

// ── Trait tables (mirrors src/sim/rules.ts) ──────────────────────────
//   maxSpeed, minSpeed, alignR, cohereR, separateR, chaseR,
//   alignW, cohereW, separateW, chaseW
const TRAITS = [
  // Warden
  [1.4, 0.6, 4, 6, 1.6, 0,  0.6, 0.5, 1.8, 0],
  // Striker
  [3.5, 1.5, 3, 4, 1.0, 10, 0.8, 0.3, 1.4, 2.0],
  // Caster
  [2.0, 0.8, 3, 3, 2.5, 6,  0.4, 0.2, 2.0, 0.8],
  // Beast
  [2.6, 1.0, 2.5, 3.5, 1.2, 8,  0.7, 0.6, 1.4, 1.4],
  // Construct
  [0.7, 0.2, 5, 5, 1.8, 0,  0.4, 0.3, 1.2, 0],
  // Specter
  [2.8, 1.2, 2, 2, 0.5, 12, 0.3, 0.2, 0.6, 1.6],
];

// Faction relation matrix (a > 0: a pursues b; a < 0: a flees b).
// Order: ember, azure, jade, amethyst, bone, void.
const REL = new Float32Array(FACTIONS * FACTIONS);
function setRel(a, b, v) { REL[a * FACTIONS + b] = v; }
setRel(0, 4, 1.0);  // ember chases bone
setRel(0, 2, 0.5);  // ember chases jade
setRel(2, 0, -1.0); // jade flees ember
setRel(4, 0, -1.0);
setRel(4, 5, -1.0);
setRel(5, 0, 1.0);  // void chases all
setRel(5, 1, 1.0);
setRel(5, 2, 1.0);
setRel(5, 3, 1.0);
setRel(5, 4, 1.0);
setRel(3, 5, -1.0);
setRel(1, 5, -1.0);

const CHASED_SPEED_BONUS = 1.4;

// ── Boid state in SoA Float32Arrays for cache locality ──────────────
function spawnState(n) {
  const posX = new Float32Array(n);
  const posY = new Float32Array(n);
  const velX = new Float32Array(n);
  const velY = new Float32Array(n);
  const archetype = new Uint8Array(n);
  const faction = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    posX[i] = (Math.random() * 2 - 1) * BOUNDS;
    posY[i] = (Math.random() * 2 - 1) * BOUNDS;
    const heading = Math.random() * Math.PI * 2;
    const arch = (Math.random() * ARCHETYPES) | 0;
    archetype[i] = arch;
    const speed = (TRAITS[arch][0] + TRAITS[arch][1]) * 0.5;
    velX[i] = speed * Math.cos(heading);
    velY[i] = speed * Math.sin(heading);
    faction[i] = (Math.random() * FACTIONS) | 0;
  }
  return { n, posX, posY, velX, velY, archetype, faction };
}

// Pre-square radii by archetype for hot-path comparisons.
const ALIGN_R2 = new Float32Array(ARCHETYPES);
const COHERE_R2 = new Float32Array(ARCHETYPES);
const SEP_R2 = new Float32Array(ARCHETYPES);
const SEP_R = new Float32Array(ARCHETYPES);
const CHASE_R2 = new Float32Array(ARCHETYPES);
const ALIGN_W = new Float32Array(ARCHETYPES);
const COHERE_W = new Float32Array(ARCHETYPES);
const SEP_W = new Float32Array(ARCHETYPES);
const CHASE_W = new Float32Array(ARCHETYPES);
const MAX_SPEED = new Float32Array(ARCHETYPES);
const MIN_SPEED = new Float32Array(ARCHETYPES);
const CHASE_ENABLED = new Uint8Array(ARCHETYPES);
for (let a = 0; a < ARCHETYPES; a++) {
  const t = TRAITS[a];
  MAX_SPEED[a] = t[0]; MIN_SPEED[a] = t[1];
  ALIGN_R2[a] = t[2] * t[2];
  COHERE_R2[a] = t[3] * t[3];
  SEP_R[a] = t[4]; SEP_R2[a] = t[4] * t[4];
  CHASE_R2[a] = t[5] * t[5];
  ALIGN_W[a] = t[6]; COHERE_W[a] = t[7];
  SEP_W[a] = t[8]; CHASE_W[a] = t[9];
  CHASE_ENABLED[a] = t[5] > 0 ? 1 : 0;
}

// ───────────────────────────────────────────────────────────────────────
//  VARIANT A: cellSize=6, field aggregates for align/cohere, per-pair
//  separation in 3×3 cells, per-faction-cell aggregates for chase 5×5.
//  Mirrors the current InstancedBoidsField.stepFlock implementation.
// ───────────────────────────────────────────────────────────────────────
function makeFieldA(state) {
  const cellSize = 6;
  const N = Math.ceil((BOUNDS * 2) / cellSize);
  const NN = N * N;
  return {
    cellSize, N,
    cellLists: Array.from({ length: NN }, () => []),
    count: new Int32Array(NN),
    sumVx: new Float32Array(NN),
    sumVy: new Float32Array(NN),
    sumPx: new Float32Array(NN),
    sumPy: new Float32Array(NN),
    factionCount: new Int32Array(NN * FACTIONS),
    factionSumPx: new Float32Array(NN * FACTIONS),
    factionSumPy: new Float32Array(NN * FACTIONS),
  };
}
function rebuildA(state, F) {
  const { cellLists, count, sumVx, sumVy, sumPx, sumPy } = F;
  const { factionCount, factionSumPx, factionSumPy, cellSize, N } = F;
  for (const c of cellLists) c.length = 0;
  count.fill(0); sumVx.fill(0); sumVy.fill(0); sumPx.fill(0); sumPy.fill(0);
  factionCount.fill(0); factionSumPx.fill(0); factionSumPy.fill(0);
  const { posX, posY, velX, velY, faction, n } = state;
  for (let i = 0; i < n; i++) {
    let ci = ((posX[i] + BOUNDS) / cellSize) | 0;
    let cj = ((posY[i] + BOUNDS) / cellSize) | 0;
    if (ci < 0) ci = 0; else if (ci >= N) ci = N - 1;
    if (cj < 0) cj = 0; else if (cj >= N) cj = N - 1;
    const idx = cj * N + ci;
    cellLists[idx].push(i);
    count[idx]++;
    sumVx[idx] += velX[i]; sumVy[idx] += velY[i];
    sumPx[idx] += posX[i]; sumPy[idx] += posY[i];
    const f = faction[i];
    const fIdx = idx * FACTIONS + f;
    factionCount[fIdx]++;
    factionSumPx[fIdx] += posX[i];
    factionSumPy[fIdx] += posY[i];
  }
}
function stepA(state, dt, F) {
  rebuildA(state, F);
  const { posX, posY, velX, velY, archetype, faction, n } = state;
  const { cellSize, N, cellLists, count, sumVx, sumVy, sumPx, sumPy } = F;
  const { factionCount, factionSumPx, factionSumPy } = F;
  const dtCl = Math.min(dt, 0.05);

  for (let i = 0; i < n; i++) {
    const a = archetype[i];
    const fid = faction[i];
    const fidRow = fid * FACTIONS;
    const bx = posX[i], by = posY[i];
    let ci = ((bx + BOUNDS) / cellSize) | 0;
    let cj = ((by + BOUNDS) / cellSize) | 0;
    if (ci < 0) ci = 0; else if (ci >= N) ci = N - 1;
    if (cj < 0) cj = 0; else if (cj >= N) cj = N - 1;

    let aggC = 0, aggVx = 0, aggVy = 0, aggPx = 0, aggPy = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const cy = cj + dy; if (cy < 0 || cy >= N) continue;
      const row = cy * N;
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ci + dx; if (cx < 0 || cx >= N) continue;
        const idx = row + cx;
        aggC += count[idx];
        aggVx += sumVx[idx]; aggVy += sumVy[idx];
        aggPx += sumPx[idx]; aggPy += sumPy[idx];
      }
    }
    aggC -= 1; aggVx -= velX[i]; aggVy -= velY[i];
    aggPx -= bx; aggPy -= by;

    let fx = 0, fy = 0;
    if (aggC > 0) {
      const inv = 1 / aggC;
      fx += (aggVx * inv - velX[i]) * ALIGN_W[a];
      fy += (aggVy * inv - velY[i]) * ALIGN_W[a];
      fx += (aggPx * inv - bx) * COHERE_W[a];
      fy += (aggPy * inv - by) * COHERE_W[a];
    }

    let sx = 0, sy = 0;
    let isChased = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const cy = cj + dy; if (cy < 0 || cy >= N) continue;
      const row = cy * N;
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ci + dx; if (cx < 0 || cx >= N) continue;
        const list = cellLists[row + cx];
        for (let k = 0, kn = list.length; k < kn; k++) {
          const j = list[k]; if (j === i) continue;
          const ox = posX[j] - bx, oy = posY[j] - by;
          const od2 = ox * ox + oy * oy;
          if (od2 < 1e-6) continue;
          if (od2 < SEP_R2[a]) {
            const dist = Math.sqrt(od2);
            const den = dist > 0.05 ? dist : 0.05;
            const k2 = (SEP_R[a] - dist) / den;
            sx -= ox * k2; sy -= oy * k2;
          }
          // Being-chased
          const oa = archetype[j];
          if (CHASE_R2[oa] > 0 && od2 < CHASE_R2[oa]) {
            if (REL[faction[j] * FACTIONS + fid] > 0) isChased = 1;
          }
        }
      }
    }
    fx += sx * SEP_W[a]; fy += sy * SEP_W[a];

    if (CHASE_ENABLED[a]) {
      let hx = 0, hy = 0;
      const chaseR2 = CHASE_R2[a];
      for (let dy = -2; dy <= 2; dy++) {
        const cy = cj + dy; if (cy < 0 || cy >= N) continue;
        const row = cy * N;
        for (let dx = -2; dx <= 2; dx++) {
          const cx = ci + dx; if (cx < 0 || cx >= N) continue;
          const baseFIdx = (row + cx) * FACTIONS;
          for (let f = 0; f < FACTIONS; f++) {
            const cnt = factionCount[baseFIdx + f]; if (cnt === 0) continue;
            const rel = REL[fidRow + f]; if (rel === 0) continue;
            const cxw = factionSumPx[baseFIdx + f] / cnt;
            const cyw = factionSumPy[baseFIdx + f] / cnt;
            const ddx = cxw - bx, ddy = cyw - by;
            const dd2 = ddx * ddx + ddy * ddy;
            if (dd2 < 1e-6 || dd2 > chaseR2) continue;
            const dd = Math.sqrt(dd2);
            const k2 = (rel * cnt) / dd;
            hx += ddx * k2; hy += ddy * k2;
          }
        }
      }
      fx += hx * CHASE_W[a]; fy += hy * CHASE_W[a];
    }

    velX[i] += fx * dtCl;
    velY[i] += fy * dtCl;
    const maxS = MAX_SPEED[a] * (isChased ? CHASED_SPEED_BONUS : 1);
    const sp = Math.hypot(velX[i], velY[i]);
    if (sp > maxS) { const k = maxS / sp; velX[i] *= k; velY[i] *= k; }
    else if (sp < MIN_SPEED[a]) { const k = MIN_SPEED[a] / Math.max(sp, 1e-4); velX[i] *= k; velY[i] *= k; }
    posX[i] += velX[i] * dtCl;
    posY[i] += velY[i] * dtCl;
    if (posX[i] > BOUNDS) posX[i] -= 2 * BOUNDS;
    else if (posX[i] < -BOUNDS) posX[i] += 2 * BOUNDS;
    if (posY[i] > BOUNDS) posY[i] -= 2 * BOUNDS;
    else if (posY[i] < -BOUNDS) posY[i] += 2 * BOUNDS;
  }
}

// ───────────────────────────────────────────────────────────────────────
//  VARIANT B: cellSize=2, drop per-faction aggregates entirely. All
//  pair-wise: separation+being-chased in 3×3 (covers ~6m), chase per-pair
//  in 7×7 (covers ~14m). Far fewer candidates per cell since cells are
//  tiny, so per-pair iteration over a small window is cheap.
// ───────────────────────────────────────────────────────────────────────
function makeFieldB(state) {
  const cellSize = 2;
  const N = Math.ceil((BOUNDS * 2) / cellSize);
  const NN = N * N;
  return {
    cellSize, N,
    cellLists: Array.from({ length: NN }, () => []),
    count: new Int32Array(NN),
    sumVx: new Float32Array(NN),
    sumVy: new Float32Array(NN),
    sumPx: new Float32Array(NN),
    sumPy: new Float32Array(NN),
  };
}
function rebuildB(state, F) {
  const { cellLists, count, sumVx, sumVy, sumPx, sumPy, cellSize, N } = F;
  for (const c of cellLists) c.length = 0;
  count.fill(0); sumVx.fill(0); sumVy.fill(0); sumPx.fill(0); sumPy.fill(0);
  const { posX, posY, velX, velY, n } = state;
  for (let i = 0; i < n; i++) {
    let ci = ((posX[i] + BOUNDS) / cellSize) | 0;
    let cj = ((posY[i] + BOUNDS) / cellSize) | 0;
    if (ci < 0) ci = 0; else if (ci >= N) ci = N - 1;
    if (cj < 0) cj = 0; else if (cj >= N) cj = N - 1;
    const idx = cj * N + ci;
    cellLists[idx].push(i);
    count[idx]++;
    sumVx[idx] += velX[i]; sumVy[idx] += velY[i];
    sumPx[idx] += posX[i]; sumPy[idx] += posY[i];
  }
}
function stepB(state, dt, F) {
  rebuildB(state, F);
  const { posX, posY, velX, velY, archetype, faction, n } = state;
  const { cellSize, N, cellLists, count, sumVx, sumVy, sumPx, sumPy } = F;
  const dtCl = Math.min(dt, 0.05);

  // Sample radii in cells. cellSize=2:
  //   align/cohere reach ≤ 6m → 3×3 cells (radius 1).
  //   chase reach ≤ 12m → 7×7 cells (radius 3).
  const LOC = 3; // align/cohere half-window in cells (3 → 7×7 covers 6m radius at cell=2). Actually cell=2*3=6m ≥ alignR/cohereR.

  for (let i = 0; i < n; i++) {
    const a = archetype[i];
    const fid = faction[i];
    const fidRow = fid * FACTIONS;
    const bx = posX[i], by = posY[i];
    let ci = ((bx + BOUNDS) / cellSize) | 0;
    let cj = ((by + BOUNDS) / cellSize) | 0;
    if (ci < 0) ci = 0; else if (ci >= N) ci = N - 1;
    if (cj < 0) cj = 0; else if (cj >= N) cj = N - 1;

    // Aggregate align/cohere from a window covering cohereR.
    let aggC = 0, aggVx = 0, aggVy = 0, aggPx = 0, aggPy = 0;
    for (let dy = -LOC; dy <= LOC; dy++) {
      const cy = cj + dy; if (cy < 0 || cy >= N) continue;
      const row = cy * N;
      for (let dx = -LOC; dx <= LOC; dx++) {
        const cx = ci + dx; if (cx < 0 || cx >= N) continue;
        const idx = row + cx;
        aggC += count[idx];
        aggVx += sumVx[idx]; aggVy += sumVy[idx];
        aggPx += sumPx[idx]; aggPy += sumPy[idx];
      }
    }
    aggC -= 1; aggVx -= velX[i]; aggVy -= velY[i];
    aggPx -= bx; aggPy -= by;

    let fx = 0, fy = 0;
    if (aggC > 0) {
      const inv = 1 / aggC;
      fx += (aggVx * inv - velX[i]) * ALIGN_W[a];
      fy += (aggVy * inv - velY[i]) * ALIGN_W[a];
      fx += (aggPx * inv - bx) * COHERE_W[a];
      fy += (aggPy * inv - by) * COHERE_W[a];
    }

    // Per-pair separation + being-chased + chase, in unified window.
    let sx = 0, sy = 0;
    let hx = 0, hy = 0;
    let isChased = 0;
    const chaseEnabled = CHASE_ENABLED[a] !== 0;
    const sepR2 = SEP_R2[a]; const sepR = SEP_R[a];
    const chaseR2 = CHASE_R2[a];
    const win = chaseEnabled ? 6 : 1; // 13×13 covers 12m chase; 3×3 otherwise
    for (let dy = -win; dy <= win; dy++) {
      const cy = cj + dy; if (cy < 0 || cy >= N) continue;
      const row = cy * N;
      for (let dx = -win; dx <= win; dx++) {
        const cx = ci + dx; if (cx < 0 || cx >= N) continue;
        const list = cellLists[row + cx];
        for (let k = 0, kn = list.length; k < kn; k++) {
          const j = list[k]; if (j === i) continue;
          const ox = posX[j] - bx, oy = posY[j] - by;
          const od2 = ox * ox + oy * oy;
          if (od2 < 1e-6) continue;
          if (od2 < sepR2) {
            const dist = Math.sqrt(od2);
            const den = dist > 0.05 ? dist : 0.05;
            const k2 = (sepR - dist) / den;
            sx -= ox * k2; sy -= oy * k2;
          }
          if (chaseEnabled && od2 < chaseR2) {
            const rel = REL[fidRow + faction[j]];
            if (rel !== 0) {
              const dist = Math.sqrt(od2);
              const k2 = rel / dist;
              hx += ox * k2; hy += oy * k2;
            }
          }
          const oa = archetype[j];
          if (CHASE_R2[oa] > 0 && od2 < CHASE_R2[oa]) {
            if (REL[faction[j] * FACTIONS + fid] > 0) isChased = 1;
          }
        }
      }
    }
    fx += sx * SEP_W[a]; fy += sy * SEP_W[a];
    fx += hx * CHASE_W[a]; fy += hy * CHASE_W[a];

    velX[i] += fx * dtCl;
    velY[i] += fy * dtCl;
    const maxS = MAX_SPEED[a] * (isChased ? CHASED_SPEED_BONUS : 1);
    const sp = Math.hypot(velX[i], velY[i]);
    if (sp > maxS) { const k = maxS / sp; velX[i] *= k; velY[i] *= k; }
    else if (sp < MIN_SPEED[a]) { const k = MIN_SPEED[a] / Math.max(sp, 1e-4); velX[i] *= k; velY[i] *= k; }
    posX[i] += velX[i] * dtCl;
    posY[i] += velY[i] * dtCl;
    if (posX[i] > BOUNDS) posX[i] -= 2 * BOUNDS;
    else if (posX[i] < -BOUNDS) posX[i] += 2 * BOUNDS;
    if (posY[i] > BOUNDS) posY[i] -= 2 * BOUNDS;
    else if (posY[i] < -BOUNDS) posY[i] += 2 * BOUNDS;
  }
}

// ───────────────────────────────────────────────────────────────────────
//  VARIANT C: A's structure but toroidal — cell sampling wraps modularly
//  and per-pair distance vectors choose the shortest-wrap direction so
//  edges don't accumulate artificial density spikes.
// ───────────────────────────────────────────────────────────────────────
function stepC(state, dt, F) {
  rebuildA(state, F);
  const { posX, posY, velX, velY, archetype, faction, n } = state;
  const { cellSize, N, cellLists, count, sumVx, sumVy, sumPx, sumPy } = F;
  const { factionCount, factionSumPx, factionSumPy } = F;
  const dtCl = Math.min(dt, 0.05);
  const W = BOUNDS * 2;

  for (let i = 0; i < n; i++) {
    const a = archetype[i];
    const fid = faction[i];
    const fidRow = fid * FACTIONS;
    const bx = posX[i], by = posY[i];
    let ci = ((bx + BOUNDS) / cellSize) | 0;
    let cj = ((by + BOUNDS) / cellSize) | 0;
    if (ci < 0) ci = 0; else if (ci >= N) ci = N - 1;
    if (cj < 0) cj = 0; else if (cj >= N) cj = N - 1;

    let aggC = 0, aggVx = 0, aggVy = 0, aggPx = 0, aggPy = 0;
    for (let dy = -1; dy <= 1; dy++) {
      let cy = cj + dy; if (cy < 0) cy += N; else if (cy >= N) cy -= N;
      const row = cy * N;
      for (let dx = -1; dx <= 1; dx++) {
        let cx = ci + dx; if (cx < 0) cx += N; else if (cx >= N) cx -= N;
        const idx = row + cx;
        aggC += count[idx];
        aggVx += sumVx[idx]; aggVy += sumVy[idx];
        aggPx += sumPx[idx]; aggPy += sumPy[idx];
      }
    }
    aggC -= 1; aggVx -= velX[i]; aggVy -= velY[i];
    aggPx -= bx; aggPy -= by;

    let fx = 0, fy = 0;
    if (aggC > 0) {
      const inv = 1 / aggC;
      fx += (aggVx * inv - velX[i]) * ALIGN_W[a];
      fy += (aggVy * inv - velY[i]) * ALIGN_W[a];
      fx += (aggPx * inv - bx) * COHERE_W[a];
      fy += (aggPy * inv - by) * COHERE_W[a];
    }

    let sx = 0, sy = 0;
    let isChased = 0;
    for (let dy = -1; dy <= 1; dy++) {
      let cy = cj + dy; if (cy < 0) cy += N; else if (cy >= N) cy -= N;
      const row = cy * N;
      for (let dx = -1; dx <= 1; dx++) {
        let cx = ci + dx; if (cx < 0) cx += N; else if (cx >= N) cx -= N;
        const list = cellLists[row + cx];
        for (let k = 0, kn = list.length; k < kn; k++) {
          const j = list[k]; if (j === i) continue;
          let ox = posX[j] - bx;
          let oy = posY[j] - by;
          // Toroidal shortest-wrap delta.
          if (ox > BOUNDS) ox -= W; else if (ox < -BOUNDS) ox += W;
          if (oy > BOUNDS) oy -= W; else if (oy < -BOUNDS) oy += W;
          const od2 = ox * ox + oy * oy;
          if (od2 < 1e-6) continue;
          if (od2 < SEP_R2[a]) {
            const dist = Math.sqrt(od2);
            const den = dist > 0.05 ? dist : 0.05;
            const k2 = (SEP_R[a] - dist) / den;
            sx -= ox * k2; sy -= oy * k2;
          }
          const oa = archetype[j];
          if (CHASE_R2[oa] > 0 && od2 < CHASE_R2[oa]) {
            if (REL[faction[j] * FACTIONS + fid] > 0) isChased = 1;
          }
        }
      }
    }
    fx += sx * SEP_W[a]; fy += sy * SEP_W[a];

    if (CHASE_ENABLED[a]) {
      let hx = 0, hy = 0;
      const chaseR2 = CHASE_R2[a];
      for (let dy = -2; dy <= 2; dy++) {
        let cy = cj + dy; if (cy < 0) cy += N; else if (cy >= N) cy -= N;
        const row = cy * N;
        for (let dx = -2; dx <= 2; dx++) {
          let cx = ci + dx; if (cx < 0) cx += N; else if (cx >= N) cx -= N;
          const baseFIdx = (row + cx) * FACTIONS;
          for (let f = 0; f < FACTIONS; f++) {
            const cnt = factionCount[baseFIdx + f]; if (cnt === 0) continue;
            const rel = REL[fidRow + f]; if (rel === 0) continue;
            const cxw = factionSumPx[baseFIdx + f] / cnt;
            const cyw = factionSumPy[baseFIdx + f] / cnt;
            let ddx = cxw - bx; let ddy = cyw - by;
            if (ddx > BOUNDS) ddx -= W; else if (ddx < -BOUNDS) ddx += W;
            if (ddy > BOUNDS) ddy -= W; else if (ddy < -BOUNDS) ddy += W;
            const dd2 = ddx * ddx + ddy * ddy;
            if (dd2 < 1e-6 || dd2 > chaseR2) continue;
            const dd = Math.sqrt(dd2);
            const k2 = (rel * cnt) / dd;
            hx += ddx * k2; hy += ddy * k2;
          }
        }
      }
      fx += hx * CHASE_W[a]; fy += hy * CHASE_W[a];
    }

    velX[i] += fx * dtCl;
    velY[i] += fy * dtCl;
    const maxS = MAX_SPEED[a] * (isChased ? CHASED_SPEED_BONUS : 1);
    const sp = Math.hypot(velX[i], velY[i]);
    if (sp > maxS) { const k = maxS / sp; velX[i] *= k; velY[i] *= k; }
    else if (sp < MIN_SPEED[a]) { const k = MIN_SPEED[a] / Math.max(sp, 1e-4); velX[i] *= k; velY[i] *= k; }
    posX[i] += velX[i] * dtCl;
    posY[i] += velY[i] * dtCl;
    if (posX[i] > BOUNDS) posX[i] -= W;
    else if (posX[i] < -BOUNDS) posX[i] += W;
    if (posY[i] > BOUNDS) posY[i] -= W;
    else if (posY[i] < -BOUNDS) posY[i] += W;
  }
}

// ── Bench harness ─────────────────────────────────────────────────────
function bench(name, makeF, stepFn) {
  const state = spawnState(N_BOIDS);
  const F = makeF(state);
  for (let i = 0; i < WARMUP; i++) stepFn(state, 0.016, F);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < RUNS; i++) stepFn(state, 0.016, F);
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1_000_000;
  const perFrame = totalMs / RUNS;
  console.log(`  ${name.padEnd(32)} ${perFrame.toFixed(2)} ms/frame  (${(1000/perFrame).toFixed(0)} fps)`);
}

// ───────────────────────────────────────────────────────────────────────
//  VARIANT D: Dual grid + toroidal wrap.
//    - Fine grid (cellSize=2) for separation + per-pair detection.
//    - Coarse grid (cellSize=6) for align/cohere aggregates and per-faction
//      chase aggregates.
//  Idea: separation only cares about 1–2 m, finer cells means each
//  per-pair window only iterates a handful of candidates. Chase wants
//  long-range aggregates, coarse cells make 5×5 windows tiny to walk.
// ───────────────────────────────────────────────────────────────────────
function makeFieldD(state) {
  const fine = 2, coarse = 6;
  const fN = Math.ceil((BOUNDS * 2) / fine);
  const cN = Math.ceil((BOUNDS * 2) / coarse);
  const fNN = fN * fN, cNN = cN * cN;
  return {
    fine, coarse, fN, cN,
    fineLists: Array.from({ length: fNN }, () => []),
    cCount: new Int32Array(cNN),
    cSumVx: new Float32Array(cNN),
    cSumVy: new Float32Array(cNN),
    cSumPx: new Float32Array(cNN),
    cSumPy: new Float32Array(cNN),
    cFCount: new Int32Array(cNN * FACTIONS),
    cFSumPx: new Float32Array(cNN * FACTIONS),
    cFSumPy: new Float32Array(cNN * FACTIONS),
  };
}
function rebuildD(state, F) {
  const { fineLists, cCount, cSumVx, cSumVy, cSumPx, cSumPy } = F;
  const { cFCount, cFSumPx, cFSumPy, fine, coarse, fN, cN } = F;
  for (const c of fineLists) c.length = 0;
  cCount.fill(0); cSumVx.fill(0); cSumVy.fill(0); cSumPx.fill(0); cSumPy.fill(0);
  cFCount.fill(0); cFSumPx.fill(0); cFSumPy.fill(0);
  const { posX, posY, velX, velY, faction, n } = state;
  for (let i = 0; i < n; i++) {
    let fci = ((posX[i] + BOUNDS) / fine) | 0;
    let fcj = ((posY[i] + BOUNDS) / fine) | 0;
    if (fci < 0) fci = 0; else if (fci >= fN) fci = fN - 1;
    if (fcj < 0) fcj = 0; else if (fcj >= fN) fcj = fN - 1;
    fineLists[fcj * fN + fci].push(i);

    let cci = ((posX[i] + BOUNDS) / coarse) | 0;
    let ccj = ((posY[i] + BOUNDS) / coarse) | 0;
    if (cci < 0) cci = 0; else if (cci >= cN) cci = cN - 1;
    if (ccj < 0) ccj = 0; else if (ccj >= cN) ccj = cN - 1;
    const cIdx = ccj * cN + cci;
    cCount[cIdx]++;
    cSumVx[cIdx] += velX[i]; cSumVy[cIdx] += velY[i];
    cSumPx[cIdx] += posX[i]; cSumPy[cIdx] += posY[i];
    const f = faction[i];
    const fIdx = cIdx * FACTIONS + f;
    cFCount[fIdx]++;
    cFSumPx[fIdx] += posX[i];
    cFSumPy[fIdx] += posY[i];
  }
}
function stepD(state, dt, F) {
  rebuildD(state, F);
  const { posX, posY, velX, velY, archetype, faction, n } = state;
  const { fine, coarse, fN, cN, fineLists } = F;
  const { cCount, cSumVx, cSumVy, cSumPx, cSumPy } = F;
  const { cFCount, cFSumPx, cFSumPy } = F;
  const dtCl = Math.min(dt, 0.05);
  const W = BOUNDS * 2;

  for (let i = 0; i < n; i++) {
    const a = archetype[i];
    const fid = faction[i];
    const fidRow = fid * FACTIONS;
    const bx = posX[i], by = posY[i];

    let cci = ((bx + BOUNDS) / coarse) | 0;
    let ccj = ((by + BOUNDS) / coarse) | 0;
    if (cci < 0) cci = 0; else if (cci >= cN) cci = cN - 1;
    if (ccj < 0) ccj = 0; else if (ccj >= cN) ccj = cN - 1;

    // Coarse-grid 3×3 aggregate for align/cohere (covers ~9 m).
    let aggC = 0, aggVx = 0, aggVy = 0, aggPx = 0, aggPy = 0;
    for (let dy = -1; dy <= 1; dy++) {
      let cy = ccj + dy; if (cy < 0) cy += cN; else if (cy >= cN) cy -= cN;
      const row = cy * cN;
      for (let dx = -1; dx <= 1; dx++) {
        let cx = cci + dx; if (cx < 0) cx += cN; else if (cx >= cN) cx -= cN;
        const idx = row + cx;
        aggC += cCount[idx];
        aggVx += cSumVx[idx]; aggVy += cSumVy[idx];
        aggPx += cSumPx[idx]; aggPy += cSumPy[idx];
      }
    }
    aggC -= 1; aggVx -= velX[i]; aggVy -= velY[i];
    aggPx -= bx; aggPy -= by;

    let fx = 0, fy = 0;
    if (aggC > 0) {
      const inv = 1 / aggC;
      fx += (aggVx * inv - velX[i]) * ALIGN_W[a];
      fy += (aggVy * inv - velY[i]) * ALIGN_W[a];
      fx += (aggPx * inv - bx) * COHERE_W[a];
      fy += (aggPy * inv - by) * COHERE_W[a];
    }

    // Fine-grid 3×3 (covers ~3 m radius) for per-pair separation +
    // is-chased detection. Few candidates per cell at fine resolution.
    let fci = ((bx + BOUNDS) / fine) | 0;
    let fcj = ((by + BOUNDS) / fine) | 0;
    if (fci < 0) fci = 0; else if (fci >= fN) fci = fN - 1;
    if (fcj < 0) fcj = 0; else if (fcj >= fN) fcj = fN - 1;
    let sx = 0, sy = 0;
    let isChased = 0;
    for (let dy = -1; dy <= 1; dy++) {
      let cy = fcj + dy; if (cy < 0) cy += fN; else if (cy >= fN) cy -= fN;
      const row = cy * fN;
      for (let dx = -1; dx <= 1; dx++) {
        let cx = fci + dx; if (cx < 0) cx += fN; else if (cx >= fN) cx -= fN;
        const list = fineLists[row + cx];
        for (let k = 0, kn = list.length; k < kn; k++) {
          const j = list[k]; if (j === i) continue;
          let ox = posX[j] - bx, oy = posY[j] - by;
          if (ox > BOUNDS) ox -= W; else if (ox < -BOUNDS) ox += W;
          if (oy > BOUNDS) oy -= W; else if (oy < -BOUNDS) oy += W;
          const od2 = ox * ox + oy * oy;
          if (od2 < 1e-6) continue;
          if (od2 < SEP_R2[a]) {
            const dist = Math.sqrt(od2);
            const den = dist > 0.05 ? dist : 0.05;
            const k2 = (SEP_R[a] - dist) / den;
            sx -= ox * k2; sy -= oy * k2;
          }
          // is-chased: only fine-grid neighbors can detect close chasers.
          // For long-range chasers (Specter at 12 m), they detect us via
          // their own chase aggregate force pulling them in; we just react
          // when they get close. This is an acceptable trade-off.
          const oa = archetype[j];
          if (CHASE_R2[oa] > 0 && od2 < CHASE_R2[oa]) {
            if (REL[faction[j] * FACTIONS + fid] > 0) isChased = 1;
          }
        }
      }
    }
    fx += sx * SEP_W[a]; fy += sy * SEP_W[a];

    // Coarse-grid 5×5 per-faction chase aggregate (covers ~15 m).
    if (CHASE_ENABLED[a]) {
      let hx = 0, hy = 0;
      const chaseR2 = CHASE_R2[a];
      for (let dy = -2; dy <= 2; dy++) {
        let cy = ccj + dy; if (cy < 0) cy += cN; else if (cy >= cN) cy -= cN;
        const row = cy * cN;
        for (let dx = -2; dx <= 2; dx++) {
          let cx = cci + dx; if (cx < 0) cx += cN; else if (cx >= cN) cx -= cN;
          const baseFIdx = (row + cx) * FACTIONS;
          for (let f = 0; f < FACTIONS; f++) {
            const cnt = cFCount[baseFIdx + f]; if (cnt === 0) continue;
            const rel = REL[fidRow + f]; if (rel === 0) continue;
            const cxw = cFSumPx[baseFIdx + f] / cnt;
            const cyw = cFSumPy[baseFIdx + f] / cnt;
            let ddx = cxw - bx, ddy = cyw - by;
            if (ddx > BOUNDS) ddx -= W; else if (ddx < -BOUNDS) ddx += W;
            if (ddy > BOUNDS) ddy -= W; else if (ddy < -BOUNDS) ddy += W;
            const dd2 = ddx * ddx + ddy * ddy;
            if (dd2 < 1e-6 || dd2 > chaseR2) continue;
            const dd = Math.sqrt(dd2);
            const k2 = (rel * cnt) / dd;
            hx += ddx * k2; hy += ddy * k2;
          }
        }
      }
      fx += hx * CHASE_W[a]; fy += hy * CHASE_W[a];
    }

    velX[i] += fx * dtCl;
    velY[i] += fy * dtCl;
    const maxS = MAX_SPEED[a] * (isChased ? CHASED_SPEED_BONUS : 1);
    const sp = Math.hypot(velX[i], velY[i]);
    if (sp > maxS) { const k = maxS / sp; velX[i] *= k; velY[i] *= k; }
    else if (sp < MIN_SPEED[a]) { const k = MIN_SPEED[a] / Math.max(sp, 1e-4); velX[i] *= k; velY[i] *= k; }
    posX[i] += velX[i] * dtCl;
    posY[i] += velY[i] * dtCl;
    if (posX[i] > BOUNDS) posX[i] -= W;
    else if (posX[i] < -BOUNDS) posX[i] += W;
    if (posY[i] > BOUNDS) posY[i] -= W;
    else if (posY[i] < -BOUNDS) posY[i] += W;
  }
}

console.log(`flock benchmark: ${N_BOIDS} boids, ${BOUNDS}m half-extent, ${RUNS} runs each`);
bench("A: cellSize=6 + agg chase",       makeFieldA, stepA);
bench("B: cellSize=2 + per-pair",        makeFieldB, stepB);
bench("C: A + toroidal wrap",            makeFieldA, stepC);
bench("D: dual grid + toroidal",         makeFieldD, stepD);
