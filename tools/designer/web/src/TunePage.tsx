/**
 * Tune page — watch the autotuner evolve.
 *
 * Polls /api/autotune/iterations every 1s. Renders:
 *   - N×N winrate heatmap of the current iteration's matrix
 *   - Loss curve (one line for current iter loss, one for best-so-far)
 *   - Per-knob value timeline (multi-line chart, one line per knob)
 *   - Start/Stop buttons that drive the autotune script via the
 *     designer server.
 *
 * The autotune writes to lab/autotune/latest.ndjson; the server
 * exposes parsed iterations at /api/autotune/iterations.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

interface Iteration {
  /** Generation index (0 = initial random pop). */
  gen: number;
  /** Within-generation rank (0 = best). */
  rank: number;
  wallTimeS: number;
  knobs: Record<string, number>;
  matrix: Record<string, Record<string, number>>;
  loss: number;
  bestLoss: number;
  popSize: number;
}

interface GenSummary {
  gen: number;
  best: number;
  mean: number;
  worst: number;
  eliteIter: Iteration;
  losses: number[];
  wallTimeS: number;
}

interface AutotuneState {
  iterations: Iteration[];
  running: boolean;
}

const POLL_MS = 1000;

export function TunePage() {
  const [state, setState] = useState<AutotuneState>({ iterations: [], running: false });
  const [duration, setDuration] = useState(300);
  const [seeds, setSeeds] = useState(20);
  const [ticks, setTicks] = useState(1500);
  const [workers, setWorkers] = useState(4);
  const [error, setError] = useState<string | null>(null);

  // Poll
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch("/api/autotune/iterations");
        if (!r.ok) throw new Error(`status ${r.status}`);
        const data = (await r.json()) as AutotuneState;
        if (!cancelled) setState(data);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };
    void poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const start = useCallback(async () => {
    setError(null);
    const r = await fetch("/api/autotune/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duration, seeds, ticks, workers }),
    });
    if (!r.ok) {
      const body = await r.text();
      setError(`start failed: ${body}`);
    }
  }, [duration, seeds, ticks, workers]);

  const stop = useCallback(async () => {
    await fetch("/api/autotune/stop", { method: "POST" });
  }, []);

  // Group iterations by generation; compute per-gen summary.
  const generations = useMemo<GenSummary[]>(() => {
    const byGen = new Map<number, Iteration[]>();
    for (const it of state.iterations) {
      const arr = byGen.get(it.gen) ?? [];
      arr.push(it);
      byGen.set(it.gen, arr);
    }
    const gens: GenSummary[] = [];
    for (const [g, arr] of byGen) {
      arr.sort((a, b) => a.rank - b.rank);
      const losses = arr.map((it) => it.loss);
      const best = Math.min(...losses);
      const mean = losses.reduce((a, b) => a + b, 0) / losses.length;
      const worst = Math.max(...losses);
      const elite = arr.find((it) => it.rank === 0) ?? arr[0];
      gens.push({ gen: g, best, mean, worst, eliteIter: elite, losses, wallTimeS: elite.wallTimeS });
    }
    gens.sort((a, b) => a.gen - b.gen);
    return gens;
  }, [state.iterations]);

  // Best individual of the latest fully-evaluated generation.
  const latestBest = generations.length > 0 ? generations[generations.length - 1].eliteIter : null;
  // Best individual EVER (lowest loss across all generations).
  const bestEver = useMemo<Iteration | null>(() => {
    if (state.iterations.length === 0) return null;
    let best = state.iterations[0];
    for (const it of state.iterations) {
      if (it.loss < best.loss) best = it;
    }
    return best;
  }, [state.iterations]);

  const comps = bestEver ? Object.keys(bestEver.matrix) : [];

  return (
    <div style={{ padding: "16px 20px", color: "#ddd", fontFamily: "ui-sans-serif, system-ui" }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Doctrine autotuner</h2>
      <Controls
        running={state.running}
        duration={duration}
        seeds={seeds}
        ticks={ticks}
        workers={workers}
        setDuration={setDuration}
        setSeeds={setSeeds}
        setTicks={setTicks}
        setWorkers={setWorkers}
        onStart={start}
        onStop={stop}
      />
      {error && <div style={{ color: "#f99", marginTop: 8 }}>{error}</div>}
      {state.iterations.length === 0 || !bestEver ? (
        <p style={{ color: "#888", marginTop: 24 }}>
          No iterations yet. Hit Start to launch the autotuner.
        </p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 32%) 1fr", gap: 24, marginTop: 16 }}>
          <div>
            <h3 style={{ fontSize: 13, color: "#aaa", margin: "0 0 6px" }}>
              Best ever (gen {bestEver.gen}, loss {bestEver.loss.toFixed(3)})
            </h3>
            <Heatmap comps={comps} matrix={bestEver.matrix} />
            <h3 style={{ fontSize: 13, color: "#aaa", margin: "16px 0 6px" }}>
              Best knobs ({Object.keys(bestEver.knobs).length})
            </h3>
            <KnobTable knobs={bestEver.knobs} />
          </div>
          <div>
            <h3 style={{ fontSize: 13, color: "#aaa", margin: "0 0 6px" }}>
              Loss per generation ({generations.length} gens, {state.iterations.length} evals)
            </h3>
            <GenLossChart generations={generations} />
            <h3 style={{ fontSize: 13, color: "#aaa", margin: "16px 0 6px" }}>
              Knob trajectories (elite per gen)
            </h3>
            <KnobTimeline generations={generations} />
            {latestBest && (
              <p style={{ fontSize: 11, color: "#888", marginTop: 10 }}>
                Latest gen {latestBest.gen}: best {generations[generations.length - 1].best.toFixed(3)},
                mean {generations[generations.length - 1].mean.toFixed(3)},
                worst {generations[generations.length - 1].worst.toFixed(3)}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Controls(props: {
  running: boolean;
  duration: number;
  seeds: number;
  ticks: number;
  workers: number;
  setDuration: (n: number) => void;
  setSeeds: (n: number) => void;
  setTicks: (n: number) => void;
  setWorkers: (n: number) => void;
  onStart: () => void;
  onStop: () => void;
}) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <NumField label="duration (s)" value={props.duration} onChange={props.setDuration} />
      <NumField label="seeds/cell" value={props.seeds} onChange={props.setSeeds} />
      <NumField label="ticks" value={props.ticks} onChange={props.setTicks} />
      <NumField label="workers" value={props.workers} onChange={props.setWorkers} />
      {props.running ? (
        <button onClick={props.onStop} style={btnStyle("#933")}>Stop</button>
      ) : (
        <button onClick={props.onStart} style={btnStyle("#393")}>Start</button>
      )}
      <span style={{ color: props.running ? "#7d7" : "#888" }}>
        {props.running ? "● running" : "○ idle"}
      </span>
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#aaa" }}>
      {label}
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: 70, padding: "3px 5px", background: "#1a1a1a", color: "#ddd", border: "1px solid #333", borderRadius: 3 }}
      />
    </label>
  );
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    padding: "5px 16px",
    background: bg,
    color: "#fff",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
  };
}

function Heatmap({ comps, matrix }: { comps: string[]; matrix: Record<string, Record<string, number>> }) {
  // Cell color scaled from blue (0%) to red (100%) through neutral
  // (50%). 50% = grey.
  const cellPx = 56;
  return (
    <table style={{ borderCollapse: "collapse", fontSize: 11, color: "#ddd" }}>
      <thead>
        <tr>
          <th style={{ textAlign: "right", padding: "2px 6px", color: "#888", fontWeight: 400 }}>A \ B</th>
          {comps.map((b) => (
            <th key={b} style={{ writingMode: "vertical-rl", padding: "2px 4px", color: "#aaa", fontWeight: 400, height: 80, fontSize: 10 }}>
              {labelComp(b)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {comps.map((a) => (
          <tr key={a}>
            <th style={{ textAlign: "right", padding: "2px 8px", color: "#aaa", fontWeight: 400, fontSize: 10 }}>{labelComp(a)}</th>
            {comps.map((b) => {
              const v = matrix[a]?.[b] ?? 0.5;
              return (
                <td
                  key={b}
                  style={{
                    width: cellPx,
                    height: 30,
                    background: heatColor(v),
                    color: Math.abs(v - 0.5) > 0.2 ? "#fff" : "#222",
                    textAlign: "center",
                    border: "1px solid #1a1a1a",
                    fontWeight: 500,
                  }}
                  title={`${a} vs ${b}: ${(v * 100).toFixed(0)}%`}
                >
                  {(v * 100).toFixed(0)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function labelComp(s: string): string {
  return s.startsWith("doc-") ? s.slice(4) : s;
}

/** Map [0,1] to a blue-grey-red gradient. */
function heatColor(v: number): string {
  const c = Math.max(0, Math.min(1, v));
  // 0 → blue (#3a6db8), 0.5 → grey (#666), 1 → red (#b83a3a)
  if (c < 0.5) {
    const t = c / 0.5;
    return rgb(blendComponent(0x3a, 0x66, t), blendComponent(0x6d, 0x66, t), blendComponent(0xb8, 0x66, t));
  }
  const t = (c - 0.5) / 0.5;
  return rgb(blendComponent(0x66, 0xb8, t), blendComponent(0x66, 0x3a, t), blendComponent(0x66, 0x3a, t));
}
function blendComponent(a: number, b: number, t: number): number {
  return Math.round(a * (1 - t) + b * t);
}
function rgb(r: number, g: number, b: number): string {
  return `rgb(${r}, ${g}, ${b})`;
}

function KnobTable({ knobs }: { knobs: Record<string, number> }) {
  return (
    <table style={{ width: "100%", fontSize: 11, color: "#ddd" }}>
      <tbody>
        {Object.entries(knobs).map(([k, v]) => (
          <tr key={k}>
            <td style={{ color: "#888", padding: "2px 6px 2px 0" }}>{k}</td>
            <td style={{ textAlign: "right", padding: "2px 0", fontFamily: "ui-monospace, monospace" }}>
              {typeof v === "number" ? v.toFixed(2) : String(v)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GenLossChart({ generations }: { generations: GenSummary[] }) {
  const W = 540;
  const H = 200;
  const PAD = 30;
  if (generations.length === 0)
    return <svg width={W} height={H} style={{ background: "#161616", border: "1px solid #2a2a2a", borderRadius: 4 }} />;

  const allLosses = generations.flatMap((g) => [g.best, g.mean, g.worst]);
  const maxLoss = Math.max(...allLosses, 0.1);
  const minLoss = Math.min(...allLosses.filter((v) => isFinite(v)), 0);

  const xAt = (i: number) =>
    generations.length <= 1 ? PAD : PAD + (i / (generations.length - 1)) * (W - 2 * PAD);
  const yAt = (v: number) =>
    H - PAD - ((v - minLoss) / Math.max(maxLoss - minLoss, 1e-6)) * (H - 2 * PAD);

  const buildPath = (key: "best" | "mean" | "worst") =>
    generations.map((g, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(g[key]).toFixed(1)}`).join("");

  return (
    <svg width={W} height={H} style={{ background: "#161616", border: "1px solid #2a2a2a", borderRadius: 4 }}>
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#333" />
      <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="#333" />
      <text x={4} y={PAD + 4} fontSize={9} fill="#888">{maxLoss.toFixed(2)}</text>
      <text x={4} y={H - PAD} fontSize={9} fill="#888">{minLoss.toFixed(2)}</text>
      {/* worst (dim red) */}
      <path d={buildPath("worst")} stroke="#c05a5a" fill="none" strokeWidth="1" opacity="0.5" />
      {/* mean (orange) */}
      <path d={buildPath("mean")} stroke="#d1a05c" fill="none" strokeWidth="1.2" opacity="0.8" />
      {/* best (bright green) */}
      <path d={buildPath("best")} stroke="#7dd97d" fill="none" strokeWidth="2" />
      {/* per-individual losses as small dots, lightly colored */}
      {generations.map((g, gi) => g.losses.map((loss, li) => (
        <circle key={`${gi}-${li}`} cx={xAt(gi)} cy={yAt(loss)} r={1.2} fill="#666" opacity="0.4" />
      )))}
      <text x={W - PAD} y={H - 6} fontSize={9} fill="#888" textAnchor="end">
        gen {generations.length - 1}
      </text>
      {/* legend */}
      <g transform={`translate(${PAD + 6}, ${PAD - 16})`}>
        <line x1={0} y1={4} x2={14} y2={4} stroke="#7dd97d" strokeWidth="2" /><text x={18} y={7} fontSize={9} fill="#aaa">best</text>
        <line x1={50} y1={4} x2={64} y2={4} stroke="#d1a05c" strokeWidth="1.2" /><text x={68} y={7} fontSize={9} fill="#aaa">mean</text>
        <line x1={102} y1={4} x2={116} y2={4} stroke="#c05a5a" strokeWidth="1" /><text x={120} y={7} fontSize={9} fill="#aaa">worst</text>
      </g>
    </svg>
  );
}

function KnobTimeline({ generations }: { generations: GenSummary[] }) {
  // Track only the elite (rank-0) individual per generation.
  const elites = generations.map((g) => g.eliteIter);
  const W = 540;
  const H = 220;
  const PAD = 30;
  const LEGEND_W = 160;
  if (elites.length === 0)
    return (
      <div style={{ width: W, height: H, background: "#161616", color: "#888", display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid #2a2a2a", borderRadius: 4 }}>
        no generations yet
      </div>
    );
  const knobKeys = Object.keys(elites[0].knobs);
  const ranges: Record<string, { min: number; max: number }> = {};
  for (const k of knobKeys) {
    let mn = Infinity;
    let mx = -Infinity;
    for (const it of elites) {
      const v = it.knobs[k];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    ranges[k] = { min: mn, max: mx === mn ? mn + 1 : mx };
  }
  const plotW = W - LEGEND_W;
  const xAt = (i: number) => (elites.length <= 1 ? PAD : PAD + (i / (elites.length - 1)) * (plotW - 2 * PAD));
  const yAt = (k: string, v: number) => {
    const r = ranges[k];
    const span = r.max - r.min || 1;
    return H - PAD - ((v - r.min) / span) * (H - 2 * PAD);
  };
  const colors = ["#5cd1a0", "#d1a05c", "#c05cd1", "#5cb0d1", "#d1d15c", "#d15c5c", "#5c5cd1", "#a05cd1", "#5cd17a", "#d17a5c"];
  return (
    <svg width={W} height={H} style={{ background: "#161616", border: "1px solid #2a2a2a", borderRadius: 4 }}>
      <line x1={PAD} y1={H - PAD} x2={plotW - PAD} y2={H - PAD} stroke="#333" />
      {knobKeys.map((k, ki) => {
        const path = elites.map((it, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(k, it.knobs[k]).toFixed(1)}`).join("");
        return <path key={k} d={path} stroke={colors[ki % colors.length]} fill="none" strokeWidth="1" opacity="0.7" />;
      })}
      {/* Legend on the right */}
      {knobKeys.map((k, ki) => (
        <g key={k}>
          <rect x={plotW + 4} y={8 + ki * 9} width={8} height={3} fill={colors[ki % colors.length]} />
          <text x={plotW + 16} y={11 + ki * 9} fontSize={8} fill="#aaa" fontFamily="ui-monospace, monospace">
            {k}
          </text>
        </g>
      ))}
    </svg>
  );
}
