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
  iter: number;
  wallTimeS: number;
  knobs: Record<string, number>;
  matrix: Record<string, Record<string, number>>;
  loss: number;
  accepted: boolean;
  bestLoss: number;
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

  const latestAccepted = useMemo(() => {
    for (let i = state.iterations.length - 1; i >= 0; i--) {
      if (state.iterations[i].accepted) return state.iterations[i];
    }
    return state.iterations[state.iterations.length - 1] ?? null;
  }, [state.iterations]);

  const comps = latestAccepted ? Object.keys(latestAccepted.matrix) : [];

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
      {state.iterations.length === 0 ? (
        <p style={{ color: "#888", marginTop: 24 }}>
          No iterations yet. Hit Start to launch the autotuner.
        </p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 30%) 1fr", gap: 24, marginTop: 16 }}>
          <div>
            <h3 style={{ fontSize: 13, color: "#aaa", margin: "0 0 6px" }}>
              Best matrix (iter {latestAccepted!.iter}, loss {latestAccepted!.loss.toFixed(3)})
            </h3>
            <Heatmap comps={comps} matrix={latestAccepted!.matrix} />
            <h3 style={{ fontSize: 13, color: "#aaa", margin: "16px 0 6px" }}>Best knobs</h3>
            <KnobTable knobs={latestAccepted!.knobs} />
          </div>
          <div>
            <h3 style={{ fontSize: 13, color: "#aaa", margin: "0 0 6px" }}>
              Loss over iterations ({state.iterations.length} total)
            </h3>
            <LossChart iterations={state.iterations} />
            <h3 style={{ fontSize: 13, color: "#aaa", margin: "16px 0 6px" }}>Knob trajectories (best-only)</h3>
            <KnobTimeline iterations={state.iterations} />
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

function LossChart({ iterations }: { iterations: Iteration[] }) {
  const W = 540;
  const H = 200;
  const PAD = 30;
  const losses = iterations.map((it) => it.loss);
  const bestLosses = iterations.map((it) => it.bestLoss);
  const maxLoss = Math.max(...losses, ...bestLosses, 0.1);
  const minLoss = Math.min(...bestLosses, 0);

  const xAt = (i: number) =>
    iterations.length <= 1 ? PAD : PAD + (i / (iterations.length - 1)) * (W - 2 * PAD);
  const yAt = (v: number) =>
    H - PAD - ((v - minLoss) / Math.max(maxLoss - minLoss, 1e-6)) * (H - 2 * PAD);

  const lossPath = iterations.map((it, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(it.loss).toFixed(1)}`).join("");
  const bestPath = iterations.map((it, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(it.bestLoss).toFixed(1)}`).join("");

  return (
    <svg width={W} height={H} style={{ background: "#161616", border: "1px solid #2a2a2a", borderRadius: 4 }}>
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#333" />
      <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="#333" />
      <text x={4} y={PAD + 4} fontSize={9} fill="#888">{maxLoss.toFixed(2)}</text>
      <text x={4} y={H - PAD} fontSize={9} fill="#888">{minLoss.toFixed(2)}</text>
      {/* per-iter loss (dim) */}
      <path d={lossPath} stroke="#5a86c0" fill="none" strokeWidth="1" opacity="0.7" />
      {/* best-so-far (bright) */}
      <path d={bestPath} stroke="#7dd97d" fill="none" strokeWidth="2" />
      {/* dots: green if accepted, dim if rejected */}
      {iterations.map((it, i) => (
        <circle
          key={i}
          cx={xAt(i)}
          cy={yAt(it.loss)}
          r={it.accepted ? 2.5 : 1.2}
          fill={it.accepted ? "#7dd97d" : "#666"}
        />
      ))}
      <text x={W - PAD} y={H - 6} fontSize={9} fill="#888" textAnchor="end">
        iter {iterations.length - 1}
      </text>
    </svg>
  );
}

function KnobTimeline({ iterations }: { iterations: Iteration[] }) {
  // Show only the BEST trajectory (knobs at each accepted iteration).
  const accepted = iterations.filter((it) => it.accepted);
  const W = 540;
  const H = 200;
  const PAD = 30;
  if (accepted.length === 0)
    return (
      <div style={{ width: W, height: H, background: "#161616", color: "#888", display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid #2a2a2a", borderRadius: 4 }}>
        no accepted iterations yet
      </div>
    );
  const knobKeys = Object.keys(accepted[0].knobs);
  // Per-knob, normalize to its observed range so all lines fit in
  // the same plot.
  const ranges: Record<string, { min: number; max: number }> = {};
  for (const k of knobKeys) {
    let mn = Infinity;
    let mx = -Infinity;
    for (const it of accepted) {
      const v = it.knobs[k];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    ranges[k] = { min: mn, max: mx };
  }
  const xAt = (i: number) => (accepted.length <= 1 ? PAD : PAD + (i / (accepted.length - 1)) * (W - 2 * PAD));
  const yAt = (k: string, v: number) => {
    const r = ranges[k];
    const span = r.max - r.min || 1;
    return H - PAD - ((v - r.min) / span) * (H - 2 * PAD);
  };
  const colors = ["#5cd1a0", "#d1a05c", "#c05cd1", "#5cb0d1", "#d1d15c", "#d15c5c", "#5c5cd1", "#a05cd1"];
  return (
    <svg width={W} height={H} style={{ background: "#161616", border: "1px solid #2a2a2a", borderRadius: 4 }}>
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#333" />
      {knobKeys.map((k, ki) => {
        const path = accepted.map((it, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(k, it.knobs[k]).toFixed(1)}`).join("");
        return <path key={k} d={path} stroke={colors[ki % colors.length]} fill="none" strokeWidth="1" opacity="0.7" />;
      })}
      {/* Legend */}
      {knobKeys.map((k, ki) => (
        <g key={k}>
          <rect x={W - 130} y={8 + ki * 11} width={8} height={3} fill={colors[ki % colors.length]} />
          <text x={W - 118} y={11 + ki * 11} fontSize={8} fill="#aaa" fontFamily="ui-monospace, monospace">
            {k}
          </text>
        </g>
      ))}
    </svg>
  );
}
