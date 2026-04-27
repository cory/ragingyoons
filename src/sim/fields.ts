/**
 * Boid influence fields.
 *
 * Instead of asking "who's near me?" (O(N²) or O(N×K) with a grid), we
 * **rasterize** each unit's contribution onto fixed-spacing 2D fields,
 * then each unit reads its local force by sampling those fields. Cost
 * goes from O(N × neighbors) to O(N + cells).
 *
 * Build (per tick): for each alive rac, splat into a 2×2 bilinear
 * footprint of its enclosing cells across 5 fields per (side, role):
 *   density, centroidNumX, centroidNumY, velNumX, velNumY
 * plus a single total-density field used by separation.
 *
 * Sample (per rac): 4-cell bilinear interp at the rac's position. Local
 * centroid = centroidNum / density (after sample), local average
 * velocity = velNum / density. Density gradient = central differences
 * (sample at ±h on each axis).
 *
 * Why this design:
 *   - bilinear splat + bilinear sample = exact reconstruction at unit
 *     positions, with smooth gradients between cells.
 *   - clustering is *naturally* allowed: at the center of a cluster the
 *     density gradient → 0, so separation force → 0. Unlike a per-pair
 *     repulsion which always pushes hard regardless of group geometry.
 *   - per-tick cost is ~26K float zeros + ~10K writes + ~40K reads at
 *     500 racs. No allocations, no closures.
 *
 * Determinism: splat in row-index order (deterministic float sum order).
 *
 * Side/role encoding: 8 channels = side * 4 + role.
 */

import type { BattleState } from "./state.js";

/** Cell size (meters). 4m on a 100m field = 25×25 = 625 cells. Smaller
 *  = sharper gradients but more memory and zeros per tick. */
export const FIELD_CELL_SIZE = 4.0;

export interface BoidFields {
  cellSize: number;
  cols: number;
  rows: number;
  /** Half-extents for world↔cell coords. */
  halfW: number;
  halfH: number;
  /** Total density (any side, any role). For separation. Length = cols*rows. */
  totalDensity: Float32Array;
  /** Per-side density (sum across all roles on that side). Used by
   *  hide-behind to ask "how many friendlies are between me and the
   *  enemy?" without having to sum 4 role channels at sample time. */
  sideDensity: Float32Array[]; // [2], length cols*rows each
  /** Per-(side*4+role) density, length cols*rows. 8 slots. */
  density: Float32Array[];
  /** Per-(side*4+role) sum of x*weight. Same length. */
  centroidNumX: Float32Array[];
  centroidNumY: Float32Array[];
  /** Per-(side*4+role) sum of vx*weight. */
  velNumX: Float32Array[];
  velNumY: Float32Array[];
}

/** Allocate a fresh fields object sized for the given world bounds.
 *  Reused across ticks via `clearBoidFields`. */
export function allocBoidFields(boundsW: number, boundsH: number): BoidFields {
  const cellSize = FIELD_CELL_SIZE;
  const cols = Math.max(1, Math.ceil(boundsW / cellSize));
  const rows = Math.max(1, Math.ceil(boundsH / cellSize));
  const total = cols * rows;
  const density: Float32Array[] = [];
  const centroidNumX: Float32Array[] = [];
  const centroidNumY: Float32Array[] = [];
  const velNumX: Float32Array[] = [];
  const velNumY: Float32Array[] = [];
  for (let i = 0; i < 8; i++) {
    density.push(new Float32Array(total));
    centroidNumX.push(new Float32Array(total));
    centroidNumY.push(new Float32Array(total));
    velNumX.push(new Float32Array(total));
    velNumY.push(new Float32Array(total));
  }
  return {
    cellSize,
    cols,
    rows,
    halfW: boundsW * 0.5,
    halfH: boundsH * 0.5,
    totalDensity: new Float32Array(total),
    sideDensity: [new Float32Array(total), new Float32Array(total)],
    density,
    centroidNumX,
    centroidNumY,
    velNumX,
    velNumY,
  };
}

/** Zero every channel. Cheap with typed-array fill. */
export function clearBoidFields(f: BoidFields): void {
  f.totalDensity.fill(0);
  f.sideDensity[0].fill(0);
  f.sideDensity[1].fill(0);
  for (let i = 0; i < 8; i++) {
    f.density[i].fill(0);
    f.centroidNumX[i].fill(0);
    f.centroidNumY[i].fill(0);
    f.velNumX[i].fill(0);
    f.velNumY[i].fill(0);
  }
}

/** Splat all alive raccoons into the fields. Bilinear footprint = the
 *  2×2 cells whose corners surround the unit's position, with weights
 *  matching the bilinear sample formula so that splat + sample is an
 *  exact reconstruction at the splat location. */
export function buildBoidFields(state: BattleState, f: BoidFields): void {
  clearBoidFields(f);
  const cellSize = f.cellSize;
  const cols = f.cols;
  const rows = f.rows;
  const halfW = f.halfW;
  const halfH = f.halfH;
  for (let i = 0; i < state.rac.count; i++) {
    if (!state.rac.alive[i]) continue;
    const wx = state.rac.x[i];
    const wy = state.rac.y[i];
    const vx = state.rac.vx[i];
    const vy = state.rac.vy[i];
    const role = state.rac.role[i];
    const owner = state.rac.owner[i];
    const ch = owner * 4 + role;

    // Convert world → continuous cell coords. Cell (0,0)'s center is at
    // (-halfW + cellSize/2, -halfH + cellSize/2). We want the 2×2 cells
    // whose grid origin is at floor(cx, cy) where cx,cy is in
    // cell-corner space — so subtract 0.5 cell to align corners.
    const cxF = (wx + halfW) / cellSize - 0.5;
    const cyF = (wy + halfH) / cellSize - 0.5;
    let cx0 = Math.floor(cxF);
    let cy0 = Math.floor(cyF);
    let fx = cxF - cx0;
    let fy = cyF - cy0;
    // Clamp to grid; if a unit is at the world edge, fold the splat
    // into the boundary cells (no out-of-bounds writes).
    if (cx0 < 0) {
      cx0 = 0;
      fx = 0;
    } else if (cx0 >= cols - 1) {
      cx0 = cols - 2 < 0 ? 0 : cols - 2;
      fx = 1;
    }
    if (cy0 < 0) {
      cy0 = 0;
      fy = 0;
    } else if (cy0 >= rows - 1) {
      cy0 = rows - 2 < 0 ? 0 : rows - 2;
      fy = 1;
    }
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    const i00 = cy0 * cols + cx0;
    const i10 = cy0 * cols + cx0 + 1;
    const i01 = (cy0 + 1) * cols + cx0;
    const i11 = (cy0 + 1) * cols + cx0 + 1;

    f.totalDensity[i00] += w00;
    f.totalDensity[i10] += w10;
    f.totalDensity[i01] += w01;
    f.totalDensity[i11] += w11;

    const sideD = f.sideDensity[owner];
    sideD[i00] += w00;
    sideD[i10] += w10;
    sideD[i01] += w01;
    sideD[i11] += w11;

    const dens = f.density[ch];
    const cnx = f.centroidNumX[ch];
    const cny = f.centroidNumY[ch];
    const vnx = f.velNumX[ch];
    const vny = f.velNumY[ch];

    dens[i00] += w00;
    dens[i10] += w10;
    dens[i01] += w01;
    dens[i11] += w11;

    cnx[i00] += w00 * wx;
    cnx[i10] += w10 * wx;
    cnx[i01] += w01 * wx;
    cnx[i11] += w11 * wx;

    cny[i00] += w00 * wy;
    cny[i10] += w10 * wy;
    cny[i01] += w01 * wy;
    cny[i11] += w11 * wy;

    vnx[i00] += w00 * vx;
    vnx[i10] += w10 * vx;
    vnx[i01] += w01 * vx;
    vnx[i11] += w11 * vx;

    vny[i00] += w00 * vy;
    vny[i10] += w10 * vy;
    vny[i01] += w01 * vy;
    vny[i11] += w11 * vy;
  }
}

/** Bilinear sample of a single channel at world position (wx, wy).
 *  Returns 0 outside the grid (caller can guard if it cares). */
export function sampleField(f: BoidFields, field: Float32Array, wx: number, wy: number): number {
  const cellSize = f.cellSize;
  const cols = f.cols;
  const rows = f.rows;
  const cxF = (wx + f.halfW) / cellSize - 0.5;
  const cyF = (wy + f.halfH) / cellSize - 0.5;
  let cx0 = Math.floor(cxF);
  let cy0 = Math.floor(cyF);
  let fx = cxF - cx0;
  let fy = cyF - cy0;
  if (cx0 < 0) {
    cx0 = 0;
    fx = 0;
  } else if (cx0 >= cols - 1) {
    cx0 = cols - 2 < 0 ? 0 : cols - 2;
    fx = 1;
  }
  if (cy0 < 0) {
    cy0 = 0;
    fy = 0;
  } else if (cy0 >= rows - 1) {
    cy0 = rows - 2 < 0 ? 0 : rows - 2;
    fy = 1;
  }
  const i00 = cy0 * cols + cx0;
  const i10 = cy0 * cols + cx0 + 1;
  const i01 = (cy0 + 1) * cols + cx0;
  const i11 = (cy0 + 1) * cols + cx0 + 1;
  const v00 = field[i00];
  const v10 = field[i10];
  const v01 = field[i01];
  const v11 = field[i11];
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  return v00 * w00 + v10 * w10 + v01 * w01 + v11 * w11;
}
