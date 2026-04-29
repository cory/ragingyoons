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

/**
 * Flat CSR layout: instead of one Int32Array per cell, all entries
 * live in a single `entries` buffer; `cellStart[c]` is the start
 * offset into `entries` for cell c, and `cellStart[c+1]` is the end.
 * No per-cell allocations per tick — buffers grow only when bounds
 * or rac count outgrow the previous high-water mark.
 */
export interface SpatialGrid {
  cellSize: number;
  cols: number;
  rows: number;
  /** Half-extents of the world (canvas centered at origin). */
  halfW: number;
  halfH: number;
  /** Flat entries indexed by cellStart[c]..cellStart[c+1]-1. */
  entries: Int32Array;
  /** Length = cols*rows + 1. */
  cellStart: Int32Array;
}

/** Per-state reusable scratch so we don't allocate on every build. */
interface GridScratch {
  cellSize: number;
  cols: number;
  rows: number;
  halfW: number;
  halfH: number;
  entries: Int32Array;
  cellStart: Int32Array;
  cellFill: Int32Array;
}

function getRacScratch(state: BattleState, cellSize: number): GridScratch {
  const halfW = state.bounds.w * 0.5;
  const halfH = state.bounds.h * 0.5;
  const cols = Math.max(1, Math.ceil(state.bounds.w / cellSize));
  const rows = Math.max(1, Math.ceil(state.bounds.h / cellSize));
  const total = cols * rows;
  const cap = state.rac.x.length;
  let s = state._racGridScratch as GridScratch | undefined;
  if (
    !s ||
    s.cols !== cols ||
    s.rows !== rows ||
    s.cellSize !== cellSize ||
    s.entries.length < cap
  ) {
    s = {
      cellSize,
      cols,
      rows,
      halfW,
      halfH,
      entries: new Int32Array(cap),
      cellStart: new Int32Array(total + 1),
      cellFill: new Int32Array(total),
    };
    state._racGridScratch = s;
  } else {
    s.halfW = halfW;
    s.halfH = halfH;
    s.cellStart.fill(0);
    s.cellFill.fill(0);
  }
  return s;
}

function getBinScratch(state: BattleState, cellSize: number): GridScratch {
  const halfW = state.bounds.w * 0.5;
  const halfH = state.bounds.h * 0.5;
  const cols = Math.max(1, Math.ceil(state.bounds.w / cellSize));
  const rows = Math.max(1, Math.ceil(state.bounds.h / cellSize));
  const total = cols * rows;
  const cap = state.bin.x.length;
  let s = state._binGridScratch as GridScratch | undefined;
  if (
    !s ||
    s.cols !== cols ||
    s.rows !== rows ||
    s.cellSize !== cellSize ||
    s.entries.length < cap
  ) {
    s = {
      cellSize,
      cols,
      rows,
      halfW,
      halfH,
      entries: new Int32Array(cap),
      cellStart: new Int32Array(total + 1),
      cellFill: new Int32Array(total),
    };
    state._binGridScratch = s;
  } else {
    s.halfW = halfW;
    s.halfH = halfH;
    s.cellStart.fill(0);
    s.cellFill.fill(0);
  }
  return s;
}

/** Build a fresh grid over the alive raccoons. Reuses scratch across
 *  ticks; only the prefix-sum + fill passes run per tick. */
export function buildRacGrid(state: BattleState, cellSize: number): SpatialGrid {
  const s = getRacScratch(state, cellSize);
  const cols = s.cols;
  const rows = s.rows;
  const total = cols * rows;
  const halfW = s.halfW;
  const halfH = s.halfH;
  const cellStart = s.cellStart;
  const cellFill = s.cellFill;
  const entries = s.entries;
  const racX = state.rac.x;
  const racY = state.rac.y;
  const alive = state.rac.alive;
  const n = state.rac.count;
  // Pass 1: count per cell.
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    let cx = Math.floor((racX[i] + halfW) / cellSize);
    let cy = Math.floor((racY[i] + halfH) / cellSize);
    if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1;
    if (cy < 0) cy = 0; else if (cy >= rows) cy = rows - 1;
    cellStart[cy * cols + cx + 1]++;
  }
  // Pass 2: prefix sum to turn counts into start offsets.
  for (let c = 1; c <= total; c++) cellStart[c] += cellStart[c - 1];
  // Pass 3: scatter into entries[].
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    let cx = Math.floor((racX[i] + halfW) / cellSize);
    let cy = Math.floor((racY[i] + halfH) / cellSize);
    if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1;
    if (cy < 0) cy = 0; else if (cy >= rows) cy = rows - 1;
    const idx = cy * cols + cx;
    entries[cellStart[idx] + cellFill[idx]++] = i;
  }
  return {
    cellSize,
    cols,
    rows,
    halfW,
    halfH,
    entries,
    cellStart,
  };
}

/** Build a fresh grid over the alive bins. */
export function buildBinGrid(state: BattleState, cellSize: number): SpatialGrid {
  const s = getBinScratch(state, cellSize);
  const cols = s.cols;
  const rows = s.rows;
  const total = cols * rows;
  const halfW = s.halfW;
  const halfH = s.halfH;
  const cellStart = s.cellStart;
  const cellFill = s.cellFill;
  const entries = s.entries;
  const bx = state.bin.x;
  const by = state.bin.y;
  const alive = state.bin.alive;
  const n = state.bin.count;
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    let cx = Math.floor((bx[i] + halfW) / cellSize);
    let cy = Math.floor((by[i] + halfH) / cellSize);
    if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1;
    if (cy < 0) cy = 0; else if (cy >= rows) cy = rows - 1;
    cellStart[cy * cols + cx + 1]++;
  }
  for (let c = 1; c <= total; c++) cellStart[c] += cellStart[c - 1];
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    let cx = Math.floor((bx[i] + halfW) / cellSize);
    let cy = Math.floor((by[i] + halfH) / cellSize);
    if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1;
    if (cy < 0) cy = 0; else if (cy >= rows) cy = rows - 1;
    const idx = cy * cols + cx;
    entries[cellStart[idx] + cellFill[idx]++] = i;
  }
  return { cellSize, cols, rows, halfW, halfH, entries, cellStart };
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
  const cols = grid.cols;
  const cellStart = grid.cellStart;
  const entries = grid.entries;
  for (let cy = minCy; cy <= maxCy; cy++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      const c = cy * cols + cx;
      const start = cellStart[c];
      const end = cellStart[c + 1];
      for (let k = start; k < end; k++) fn(entries[k]);
    }
  }
}

/** Cell size that satisfies all subsystem queries. Pick the largest
 *  neighbor radius any subsystem uses. Currently: cohesion 4m, archer
 *  range up to 7m. We use 4m as the cell size — radius queries larger
 *  than that just visit more cells, no correctness issue. */
export const DEFAULT_CELL_SIZE = 4.0;
