/**
 * Uniform spatial grid for "find raccoons / bins within radius R of
 * (x, y)" queries. Used by boids, target.ts, combat.ts, and rage.ts
 * to convert O(N²) entity-pair scans into O(N × local_density).
 *
 * Build cost: O(N) per tick (rebuilt fresh each tick because positions
 * move). Per-query cost: O(visited_cells × occupants).
 *
 * Cell size is chosen at build time as ceil of the largest neighbor
 * radius any subsystem cares about. With 4m queries and 4m cells, a
 * radius query touches at most 3×3 = 9 cells.
 *
 * Two grids per tick: one for raccoons, one for bins. Bins are static
 * but we rebuild for simplicity (8 bins is trivially cheap).
 */

import type { BattleState } from "./state.js";

export interface SpatialGrid {
  cellSize: number;
  cols: number;
  rows: number;
  /** Half-extents of the world (canvas centered at origin). */
  halfW: number;
  halfH: number;
  /** cells[cellIdx] = array of entity ROW indices in that cell. */
  cells: Int32Array[];
}

/** Build a fresh grid over the alive raccoons. */
export function buildRacGrid(state: BattleState, cellSize: number): SpatialGrid {
  const halfW = state.bounds.w * 0.5;
  const halfH = state.bounds.h * 0.5;
  const cols = Math.max(1, Math.ceil(state.bounds.w / cellSize));
  const rows = Math.max(1, Math.ceil(state.bounds.h / cellSize));
  const total = cols * rows;
  // First pass: count per cell.
  const counts = new Int32Array(total);
  for (let i = 0; i < state.rac.count; i++) {
    if (!state.rac.alive[i]) continue;
    const cx = Math.min(cols - 1, Math.max(0, Math.floor((state.rac.x[i] + halfW) / cellSize)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor((state.rac.y[i] + halfH) / cellSize)));
    counts[cy * cols + cx]++;
  }
  // Allocate per-cell arrays.
  const cells: Int32Array[] = new Array(total);
  const offsets = new Int32Array(total);
  for (let c = 0; c < total; c++) {
    cells[c] = new Int32Array(counts[c]);
  }
  // Second pass: fill.
  for (let i = 0; i < state.rac.count; i++) {
    if (!state.rac.alive[i]) continue;
    const cx = Math.min(cols - 1, Math.max(0, Math.floor((state.rac.x[i] + halfW) / cellSize)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor((state.rac.y[i] + halfH) / cellSize)));
    const idx = cy * cols + cx;
    cells[idx][offsets[idx]++] = i;
  }
  return { cellSize, cols, rows, halfW, halfH, cells };
}

/** Build a fresh grid over the alive bins. */
export function buildBinGrid(state: BattleState, cellSize: number): SpatialGrid {
  const halfW = state.bounds.w * 0.5;
  const halfH = state.bounds.h * 0.5;
  const cols = Math.max(1, Math.ceil(state.bounds.w / cellSize));
  const rows = Math.max(1, Math.ceil(state.bounds.h / cellSize));
  const total = cols * rows;
  const counts = new Int32Array(total);
  for (let i = 0; i < state.bin.count; i++) {
    if (!state.bin.alive[i]) continue;
    const cx = Math.min(cols - 1, Math.max(0, Math.floor((state.bin.x[i] + halfW) / cellSize)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor((state.bin.y[i] + halfH) / cellSize)));
    counts[cy * cols + cx]++;
  }
  const cells: Int32Array[] = new Array(total);
  const offsets = new Int32Array(total);
  for (let c = 0; c < total; c++) cells[c] = new Int32Array(counts[c]);
  for (let i = 0; i < state.bin.count; i++) {
    if (!state.bin.alive[i]) continue;
    const cx = Math.min(cols - 1, Math.max(0, Math.floor((state.bin.x[i] + halfW) / cellSize)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor((state.bin.y[i] + halfH) / cellSize)));
    const idx = cy * cols + cx;
    cells[idx][offsets[idx]++] = i;
  }
  return { cellSize, cols, rows, halfW, halfH, cells };
}

/** Iterate every entity row whose cell overlaps the (x, y, radius)
 *  query disc. The CALLER must do the precise distance check — this
 *  function only narrows the candidate set. */
export function forEachNear(
  grid: SpatialGrid,
  x: number,
  y: number,
  radius: number,
  fn: (row: number) => void,
): void {
  const cellsAcross = Math.ceil(radius / grid.cellSize);
  const baseCx = Math.floor((x + grid.halfW) / grid.cellSize);
  const baseCy = Math.floor((y + grid.halfH) / grid.cellSize);
  const minCx = Math.max(0, baseCx - cellsAcross);
  const maxCx = Math.min(grid.cols - 1, baseCx + cellsAcross);
  const minCy = Math.max(0, baseCy - cellsAcross);
  const maxCy = Math.min(grid.rows - 1, baseCy + cellsAcross);
  for (let cy = minCy; cy <= maxCy; cy++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      const occupants = grid.cells[cy * grid.cols + cx];
      for (let i = 0; i < occupants.length; i++) fn(occupants[i]);
    }
  }
}

/** Cell size that satisfies all subsystem queries. Pick the largest
 *  neighbor radius any subsystem uses. Currently: cohesion 4m, archer
 *  range up to 7m. We use 4m as the cell size — radius queries larger
 *  than that just visit more cells, no correctness issue. */
export const DEFAULT_CELL_SIZE = 4.0;
