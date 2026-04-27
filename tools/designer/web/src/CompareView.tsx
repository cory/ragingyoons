/**
 * Compare view — run up to 4 battles side-by-side with different
 * knobsets / comps / seeds. Useful for "start of tuning vs end of
 * tuning" visual diffs.
 *
 * Each cell has its own (compA, compB, seed, knobsetId). Hitting
 * "Run all" pre-computes every cell's frame buffer in sequence
 * (mutating DOCTRINE_KNOBS between runs). A shared scrubber drives
 * playback synchronized across cells.
 *
 * The renderer is intentionally minimal — colored circles + bin
 * squares — so 4 small canvases stay legible.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  resolveTimeout,
  setupBattle,
  setupShapeBattle,
  tick,
  type BattleConfig,
  type BattleState,
  type ContentBundle,
  type ShapeBattleConfig,
} from "@sim/index.js";
import { FORMATIONS, type FormationId } from "@sim/formations.js";
import { MemoryLogger } from "@sim/log.js";
import { DOCTRINE_KNOBS, type DoctrineKnobs } from "@sim/doctrines.js";
import { loadContentFromApi } from "./sim-bridge.js";

interface Knobset {
  id: string;
  label: string;
  knobs: Partial<DoctrineKnobs> | null;
}

type CellMode = "comp" | "shape";

interface CellConfig {
  mode: CellMode;
  // comp mode
  compA: string;
  compB: string;
  // shape mode
  shapeUnit: string;
  shapeCount: number;
  shapeFormation: FormationId | "default";
  shapeEnemyBin: string;
  // shared
  knobsetId: string;
  seed: number;
}

interface CellFrame {
  tick: number;
  bins: Array<{ owner: 0 | 1; x: number; y: number; alive: 0 | 1 }>;
  racs: Array<{ owner: 0 | 1; x: number; y: number; role: number }>;
}

interface CellResult {
  frames: CellFrame[];
  winner: -1 | 0 | 1;
  reason: string;
  finalTick: number;
}

const MAX_CELLS = 4;
const TICKS = 1500;
const BOUNDS_W = 100;
const BOUNDS_H = 100;
const CANVAS_PX = 420;
const PX_PER_M = CANVAS_PX / Math.max(BOUNDS_W, BOUNDS_H);

const DEFAULT_KNOBS: DoctrineKnobs = { ...DOCTRINE_KNOBS };

function uuidv4(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  a[6] = (a[6] & 0x0f) | 0x40;
  a[8] = (a[8] & 0x3f) | 0x80;
  const h = [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function captureFrame(state: BattleState): CellFrame {
  const bins: CellFrame["bins"] = [];
  for (let i = 0; i < state.bin.count; i++) {
    bins.push({
      owner: state.bin.owner[i] as 0 | 1,
      x: state.bin.x[i],
      y: state.bin.y[i],
      alive: state.bin.alive[i] as 0 | 1,
    });
  }
  const racs: CellFrame["racs"] = [];
  for (let i = 0; i < state.rac.count; i++) {
    if (!state.rac.alive[i]) continue;
    racs.push({
      owner: state.rac.owner[i] as 0 | 1,
      x: state.rac.x[i],
      y: state.rac.y[i],
      role: state.rac.role[i],
    });
  }
  return { tick: state.tick, bins, racs };
}

function runOneBattle(content: ContentBundle, cfg: CellConfig, knobs: Partial<DoctrineKnobs> | null): CellResult {
  // Apply knobs by mutating the shared DOCTRINE_KNOBS (the sim reads
  // from there). We restore defaults after the battle so subsequent
  // cells / standalone BattleViewer aren't poisoned.
  const original = { ...DOCTRINE_KNOBS };
  if (knobs) Object.assign(DOCTRINE_KNOBS, knobs);
  else Object.assign(DOCTRINE_KNOBS, DEFAULT_KNOBS);

  try {
    const battleId = uuidv4();
    const log = new MemoryLogger({
      battle_id: battleId,
      seed: cfg.seed,
      service_version: "compare",
      content_version: content.version,
    });
    let state: BattleState;
    if (cfg.mode === "shape") {
      const shapeCfg: ShapeBattleConfig = {
        seed: cfg.seed,
        battleId,
        bounds: { w: BOUNDS_W, h: BOUNDS_H },
        unitId: cfg.shapeUnit,
        count: cfg.shapeCount,
        formationId: cfg.shapeFormation === "default" ? undefined : cfg.shapeFormation,
        enemyBinUnitId: cfg.shapeEnemyBin,
      };
      state = setupShapeBattle(content, shapeCfg);
    } else {
      const battleCfg: BattleConfig = {
        seed: cfg.seed,
        battleId,
        compA: cfg.compA,
        compB: cfg.compB,
        bounds: { w: BOUNDS_W, h: BOUNDS_H },
        verbosity: "events",
      };
      state = setupBattle(content, battleCfg);
    }
    log.setTickReader(() => state.tick);
    log.drain();
    const frames: CellFrame[] = [captureFrame(state)];
    for (let t = 0; t < TICKS; t++) {
      tick(state, content, log);
      log.drain();
      frames.push(captureFrame(state));
      if (state.winner !== -1 || state.endReason !== null) break;
    }
    if (state.winner === -1 && state.endReason === null) resolveTimeout(state);
    return {
      frames,
      winner: state.winner,
      reason: state.endReason ?? "timeout",
      finalTick: state.tick,
    };
  } finally {
    // Restore module defaults so leaving Compare doesn't leak knob
    // state into the standalone BattleViewer.
    Object.assign(DOCTRINE_KNOBS, DEFAULT_KNOBS);
    void original;
  }
}

const SIDE_FILL = ["#7da9e6", "#e67d7d"];
const SIDE_BIN = ["#3a6db8", "#b83a3a"];

function worldToCanvas(x: number, y: number): [number, number] {
  return [CANVAS_PX * 0.5 + x * PX_PER_M, CANVAS_PX * 0.5 - y * PX_PER_M];
}

function drawCell(ctx: CanvasRenderingContext2D, frame: CellFrame): void {
  ctx.fillStyle = "#161616";
  ctx.fillRect(0, 0, CANVAS_PX, CANVAS_PX);
  ctx.strokeStyle = "#2a2a2a";
  ctx.strokeRect(0, 0, CANVAS_PX, CANVAS_PX);
  // Center line
  ctx.beginPath();
  ctx.moveTo(CANVAS_PX * 0.5, 0);
  ctx.lineTo(CANVAS_PX * 0.5, CANVAS_PX);
  ctx.stroke();

  // Bins
  for (const b of frame.bins) {
    const [cx, cy] = worldToCanvas(b.x, b.y);
    if (b.alive) {
      ctx.fillStyle = SIDE_BIN[b.owner];
      ctx.fillRect(cx - 4, cy - 4, 8, 8);
    } else {
      ctx.strokeStyle = "#444";
      ctx.beginPath();
      ctx.moveTo(cx - 3, cy - 3);
      ctx.lineTo(cx + 3, cy + 3);
      ctx.moveTo(cx + 3, cy - 3);
      ctx.lineTo(cx - 3, cy + 3);
      ctx.stroke();
    }
  }
  // Racs (dots — too small to render shapes legibly)
  for (const r of frame.racs) {
    const [cx, cy] = worldToCanvas(r.x, r.y);
    ctx.fillStyle = SIDE_FILL[r.owner];
    ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3);
  }
  // Tick label
  ctx.fillStyle = "#888";
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "left";
  ctx.fillText(`t=${frame.tick}`, 6, 12);
  // Counts
  let na = 0, nb = 0;
  for (const r of frame.racs) (r.owner === 0 ? na++ : nb++);
  ctx.fillStyle = "#9bc4f0";
  ctx.fillText(`${na}`, 6, CANVAS_PX - 6);
  ctx.fillStyle = "#f09b9b";
  ctx.textAlign = "right";
  ctx.fillText(`${nb}`, CANVAS_PX - 6, CANVAS_PX - 6);
}

export function CompareView() {
  const [content, setContent] = useState<ContentBundle | null>(null);
  const [knobsets, setKnobsets] = useState<Knobset[]>([]);
  // Default to "default vs all-time-best" so the page is immediately
  // useful — that's the common comparison after a tune run. If
  // all-time-best doesn't exist yet, both cells fall back to default
  // and the user picks something else.
  const [cells, setCells] = useState<CellConfig[]>([
    {
      mode: "comp",
      compA: "doc-fire-team", compB: "doc-phalanx",
      shapeUnit: "suburban-barbarian-infantry-smasher",
      shapeCount: 20,
      shapeFormation: "default",
      shapeEnemyBin: "city-barbarian-tank-brick",
      knobsetId: "default", seed: 0xcafe,
    },
    {
      mode: "comp",
      compA: "doc-fire-team", compB: "doc-phalanx",
      shapeUnit: "suburban-barbarian-infantry-smasher",
      shapeCount: 20,
      shapeFormation: "default",
      shapeEnemyBin: "city-barbarian-tank-brick",
      knobsetId: "all-time-best", seed: 0xcafe,
    },
  ]);
  const [results, setResults] = useState<(CellResult | null)[]>([]);
  const [tickIdx, setTickIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);

  // Load content + knobsets on mount
  useEffect(() => {
    void (async () => {
      try {
        const [c, ksRes] = await Promise.all([
          loadContentFromApi(),
          fetch("/api/autotune/knobsets").then((r) => r.json()),
        ]);
        setContent(c);
        setKnobsets(ksRes.knobsets ?? []);
      } catch (e) {
        setError(`load: ${String(e)}`);
      }
    })();
  }, []);

  // Refresh knobsets after autotune runs (poll every 5s — light)
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const r = await fetch("/api/autotune/knobsets");
        if (r.ok) {
          const j = await r.json();
          setKnobsets(j.knobsets ?? []);
        }
      } catch {}
    }, 5000);
    return () => clearInterval(id);
  }, []);

  const compIds = useMemo(() => {
    if (!content) return [];
    return [...content.comps.keys()].sort();
  }, [content]);
  const unitIds = useMemo(() => {
    if (!content) return [];
    return [...content.units.keys()].sort();
  }, [content]);

  const runAll = useCallback(async () => {
    if (!content) return;
    setError(null);
    setRunning(true);
    setResults(cells.map(() => null));
    try {
      const next: (CellResult | null)[] = [];
      for (const cell of cells) {
        const knobset = knobsets.find((k) => k.id === cell.knobsetId);
        // Allow the browser to repaint between battles.
        await new Promise((r) => setTimeout(r, 0));
        const result = runOneBattle(content, cell, knobset?.knobs ?? null);
        next.push(result);
      }
      setResults(next);
      setTickIdx(0);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }, [cells, content, knobsets]);

  // Determine maximum tick across all results for the scrubber
  const maxTick = useMemo(() => {
    let m = 0;
    for (const r of results) {
      if (r && r.frames.length - 1 > m) m = r.frames.length - 1;
    }
    return m;
  }, [results]);

  // Auto-play loop
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setTickIdx((t) => (t + 1 > maxTick ? 0 : t + 1));
    }, 50); // 20fps
    return () => clearInterval(id);
  }, [playing, maxTick]);

  // Render frames
  useEffect(() => {
    for (let i = 0; i < cells.length; i++) {
      const canvas = canvasRefs.current[i];
      if (!canvas) continue;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      const result = results[i];
      if (!result || result.frames.length === 0) {
        ctx.fillStyle = "#161616";
        ctx.fillRect(0, 0, CANVAS_PX, CANVAS_PX);
        ctx.fillStyle = "#444";
        ctx.font = "12px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText("no battle yet", CANVAS_PX * 0.5, CANVAS_PX * 0.5);
        continue;
      }
      const f = result.frames[Math.min(tickIdx, result.frames.length - 1)];
      drawCell(ctx, f);
    }
  }, [results, tickIdx, cells.length]);

  const updateCell = (idx: number, patch: Partial<CellConfig>) => {
    setCells((prev) => {
      const next = prev.slice();
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  };

  const addCell = () => {
    if (cells.length >= MAX_CELLS) return;
    setCells((prev) => [...prev, { ...prev[prev.length - 1] }]);
  };

  const removeCell = (idx: number) => {
    if (cells.length <= 1) return;
    setCells((prev) => prev.filter((_, i) => i !== idx));
    setResults((prev) => prev.filter((_, i) => i !== idx));
  };

  /** Force every cell to share cell 0's seed (so we can compare
   *  knobsets/comps without seed variance confounding the result).
   *  Common workflow: change one knob between cells, run, compare. */
  const syncSeeds = () => {
    if (cells.length === 0) return;
    const s = cells[0].seed;
    setCells((prev) => prev.map((c) => ({ ...c, seed: s })));
  };

  /** Force every cell to share cell 0's comps too. Useful when you
   *  want pure "knobset diff" comparisons. */
  const syncComps = () => {
    if (cells.length === 0) return;
    const { compA, compB } = cells[0];
    setCells((prev) => prev.map((c) => ({ ...c, compA, compB })));
  };

  return (
    <div style={{ padding: "16px 20px", color: "#ddd", fontFamily: "ui-sans-serif, system-ui" }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Compare battles</h2>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <button onClick={runAll} disabled={running || !content} style={btnStyle("#393")}>
          {running ? "running…" : "Run all"}
        </button>
        <button onClick={() => setPlaying((p) => !p)} disabled={results.length === 0} style={btnStyle("#444")}>
          {playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min={0}
          max={maxTick}
          value={tickIdx}
          onChange={(e) => setTickIdx(Number(e.target.value))}
          style={{ flexGrow: 1, minWidth: 200 }}
        />
        <span style={{ color: "#888", fontFamily: "ui-monospace, monospace", fontSize: 12, width: 100 }}>
          tick {tickIdx} / {maxTick}
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16, flexWrap: "wrap", fontSize: 12, color: "#aaa" }}>
        <button onClick={syncSeeds} title="Set every cell's seed to cell 0's" style={btnStyle("#345")}>
          sync seeds
        </button>
        <button onClick={syncComps} title="Set every cell's comps to cell 0's" style={btnStyle("#345")}>
          sync comps
        </button>
        {cells.length < MAX_CELLS && (
          <button onClick={addCell} style={btnStyle("#345")}>+ cell</button>
        )}
        <span style={{ marginLeft: 12, color: "#666", fontSize: 11 }}>
          tip: same seed + same comps + different knobsets = pure knob-diff comparison
        </span>
      </div>
      {error && <div style={{ color: "#f99", marginBottom: 8 }}>{error}</div>}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cells.length}, ${CANVAS_PX}px)`, gap: 12 }}>
        {cells.map((cell, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }}>
              <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 2 }}>
                <button
                  onClick={() => updateCell(i, { mode: "comp" })}
                  style={modeBtnStyle(cell.mode === "comp")}
                  title="full comp-vs-comp battle"
                >comp</button>
                <button
                  onClick={() => updateCell(i, { mode: "shape" })}
                  style={modeBtnStyle(cell.mode === "shape")}
                  title="N units of one type vs one enemy bin (no other forces)"
                >shape</button>
                {cells.length > 1 && (
                  <button onClick={() => removeCell(i)} title="remove cell" style={{ background: "transparent", border: "none", color: "#777", cursor: "pointer", fontSize: 16, marginLeft: "auto" }}>×</button>
                )}
              </div>
              {cell.mode === "comp" ? (
                <>
                  <SelectField label="A" value={cell.compA} options={compIds}
                    onChange={(v) => updateCell(i, { compA: v })} />
                  <SelectField label="B" value={cell.compB} options={compIds}
                    onChange={(v) => updateCell(i, { compB: v })} />
                </>
              ) : (
                <>
                  <SelectField label="unit" value={cell.shapeUnit} options={unitIds}
                    onChange={(v) => updateCell(i, { shapeUnit: v })} />
                  <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <span style={{ width: 40, color: "#aaa" }}>count</span>
                    <input type="number" value={cell.shapeCount}
                      onChange={(e) => updateCell(i, { shapeCount: Math.max(1, Math.min(500, Number(e.target.value))) })}
                      style={{ flexGrow: 1, background: "#1a1a1a", color: "#ddd", border: "1px solid #333", borderRadius: 3, padding: "2px 4px" }} />
                  </label>
                  <SelectField label="form" value={cell.shapeFormation}
                    options={["default", ...FORMATIONS.filter((f) => {
                      const u = content?.units.get(cell.shapeUnit);
                      return u && f.role === u.role;
                    }).map((f) => f.id)]}
                    onChange={(v) => updateCell(i, { shapeFormation: v as FormationId | "default" })} />
                  <SelectField label="bin" value={cell.shapeEnemyBin} options={unitIds}
                    onChange={(v) => updateCell(i, { shapeEnemyBin: v })} />
                </>
              )}
              <SelectField
                label="knobs"
                value={cell.knobsetId}
                options={knobsets.map((k) => k.id)}
                labels={Object.fromEntries(knobsets.map((k) => [k.id, k.label]))}
                onChange={(v) => updateCell(i, { knobsetId: v })}
              />
              <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <span style={{ width: 40, color: "#aaa" }}>seed</span>
                <input
                  type="number"
                  value={cell.seed}
                  onChange={(e) => updateCell(i, { seed: Number(e.target.value) })}
                  style={{ flexGrow: 1, background: "#1a1a1a", color: "#ddd", border: "1px solid #333", borderRadius: 3, padding: "2px 4px" }}
                />
              </label>
            </div>
            <canvas
              ref={(el) => { canvasRefs.current[i] = el; }}
              width={CANVAS_PX}
              height={CANVAS_PX}
              style={{ width: CANVAS_PX, height: CANVAS_PX, background: "#0a0a0a" }}
            />
            {results[i] && (
              <div style={{ fontSize: 11, color: "#888", textAlign: "center" }}>
                winner: {results[i]!.winner === 0 ? "A" : results[i]!.winner === 1 ? "B" : "—"} ({results[i]!.reason}) @ tick {results[i]!.finalTick}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  labels,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  labels?: Record<string, string>;
  onChange: (v: string) => void;
}) {
  return (
    <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <span style={{ width: 40, color: "#aaa" }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ flexGrow: 1, background: "#1a1a1a", color: "#ddd", border: "1px solid #333", borderRadius: 3, padding: "2px 4px" }}
      >
        {options.map((o) => (
          <option key={o} value={o}>{labels?.[o] ?? o}</option>
        ))}
      </select>
    </label>
  );
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    padding: "5px 14px",
    background: bg,
    color: "#fff",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
  };
}

function modeBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: "2px 10px",
    background: active ? "#446" : "#222",
    color: active ? "#fff" : "#888",
    border: "1px solid #333",
    borderRadius: 3,
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 500,
  };
}
