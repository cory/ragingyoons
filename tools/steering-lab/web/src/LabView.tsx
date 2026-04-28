import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadContentFromApi } from "./sim-bridge.js";
import type { ContentBundle } from "@sim/content.js";
import type { ForceFlag } from "@sim/state.js";
import { FORCE_COMPONENT_INDEX } from "@sim/state.js";
import { FORMATIONS, type FormationId } from "@sim/formations.js";
import { runLabBattle, type LabFrame, type LabRunResult, type ForceFlagMap } from "./runBattle.js";

type OverlayKey =
  | "forceArrows"
  | "groupCentroid"
  | "slotTarget"
  | "distanceRing"
  | "velocityArrow";

const ALL_FORCES: ForceFlag[] = [
  "separation",
  "closeRange",
  "cohesion",
  "alignment",
  "seek",
  "hide",
  "avoid",
  "envelopment",
  "doctrineMod",
  "slotOffset",
];

const ALL_OVERLAYS: { key: OverlayKey; label: string }[] = [
  { key: "forceArrows", label: "force arrows" },
  { key: "groupCentroid", label: "group centroid" },
  { key: "slotTarget", label: "slot target (cohesion)" },
  { key: "distanceRing", label: "envelop ring (R=15)" },
  { key: "velocityArrow", label: "velocity arrow" },
];

const COMPONENT_COLORS: Record<keyof typeof FORCE_COMPONENT_INDEX, string> = {
  separation: "#e07a7a", // red
  cohesion: "#7adde0", // cyan
  alignment: "#cce07a", // yellow-green
  seek: "#7ae07a", // green
  hide: "#b07ae0", // purple
  avoid: "#e0b07a", // orange
};

interface CellConfig {
  unitId: string;
  count: number;
  formation: FormationId | "default";
  enemyBin: string;
  seed: number;
  ticks: number;
  flags: ForceFlagMap;
  overlays: Record<OverlayKey, boolean>;
  /** Force-arrow scale multiplier (drawn in meters per force-unit). */
  arrowScale: number;
  /** Max racs per platoon (column of platoons stacked behind the front). */
  maxPlatoonSize: number;
  /** Spacing between platoon centers along march axis (meters). */
  platoonStride: number;
}

const DEFAULT_FLAGS: ForceFlagMap = {
  separation: true,
  closeRange: true,
  cohesion: true,
  alignment: true,
  seek: true,
  hide: true,
  avoid: true,
  envelopment: true,
  doctrineMod: true,
  slotOffset: true,
};

const DEFAULT_OVERLAYS: Record<OverlayKey, boolean> = {
  forceArrows: true,
  groupCentroid: true,
  slotTarget: false,
  distanceRing: false,
  velocityArrow: false,
};

export function LabView() {
  const [content, setContent] = useState<ContentBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cfg, setCfg] = useState<CellConfig>({
    unitId: "",
    count: 12,
    formation: "default",
    enemyBin: "",
    seed: 1,
    ticks: 240,
    flags: DEFAULT_FLAGS,
    overlays: DEFAULT_OVERLAYS,
    arrowScale: 1.5,
    maxPlatoonSize: 20,
    platoonStride: 6,
  });
  const [result, setResult] = useState<LabRunResult | null>(null);
  const [tickIdx, setTickIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [running, setRunning] = useState(false);
  const [hoverRacId, setHoverRacId] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Load content once.
  useEffect(() => {
    loadContentFromApi()
      .then((c) => {
        setContent(c);
        const firstUnit = [...c.units.keys()].sort()[0] ?? "";
        setCfg((p) => ({ ...p, unitId: firstUnit, enemyBin: firstUnit }));
      })
      .catch((e) => setError(String(e)));
  }, []);

  const unitIds = useMemo(() => (content ? [...content.units.keys()].sort() : []), [content]);

  const formationOptions = useMemo<(FormationId | "default")[]>(() => {
    if (!content || !cfg.unitId) return ["default"];
    const u = content.units.get(cfg.unitId);
    if (!u) return ["default"];
    const list: (FormationId | "default")[] = ["default"];
    for (const f of FORMATIONS) if (f.role === u.role) list.push(f.id);
    return list;
  }, [content, cfg.unitId]);

  const run = useCallback(() => {
    if (!content || !cfg.unitId || !cfg.enemyBin) return;
    setRunning(true);
    setError(null);
    try {
      const r = runLabBattle(content, {
        seed: cfg.seed,
        unitId: cfg.unitId,
        count: cfg.count,
        formationId: cfg.formation === "default" ? undefined : cfg.formation,
        enemyBinUnitId: cfg.enemyBin,
        ticks: cfg.ticks,
        flags: cfg.flags,
        bounds: { w: 120, h: 80 },
        maxPlatoonSize: cfg.maxPlatoonSize,
        platoonStride: cfg.platoonStride,
      });
      setResult(r);
      setTickIdx(0);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }, [cfg, content]);

  // Auto-play loop
  useEffect(() => {
    if (!playing || !result) return;
    const id = setInterval(() => {
      setTickIdx((t) => (t + 1 >= result.frames.length ? 0 : t + 1));
    }, 50);
    return () => clearInterval(id);
  }, [playing, result]);

  // Render the current frame
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result) return;
    drawFrame(canvas, result, tickIdx, cfg, hoverRacId);
  }, [result, tickIdx, cfg, hoverRacId]);

  const handleCanvasMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !result) return;
      const rect = canvas.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
      const py = ((e.clientY - rect.top) / rect.height) * canvas.height;
      const frame = result.frames[tickIdx];
      if (!frame) return;
      const { worldToPx } = makeTransform(canvas, result.bounds);
      let best = -1;
      let bestD2 = Infinity;
      for (const r of frame.racs) {
        if (!r.alive) continue;
        const [rx, ry] = worldToPx(r.x, r.y);
        const dx = rx - px;
        const dy = ry - py;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2 && d2 < 16 * 16) {
          bestD2 = d2;
          best = r.id;
        }
      }
      setHoverRacId(best === -1 ? null : best);
    },
    [result, tickIdx],
  );

  const frame = result?.frames[tickIdx] ?? null;
  const hoverRac = frame?.racs.find((r) => r.id === hoverRacId) ?? null;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", height: "100vh" }}>
      {/* Left config panel */}
      <div style={{ borderRight: "1px solid #2a2e36", padding: 12, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15, color: "#ddd" }}>Steering Lab</h2>
        {error && <div style={{ background: "#3a1818", color: "#fdd", padding: 6, borderRadius: 3 }}>{error}</div>}
        {!content && !error && <div style={{ color: "#888" }}>loading content…</div>}
        {content && (
          <>
            <Group title="setup">
              <Field label="unit"><Select value={cfg.unitId} options={unitIds} onChange={(v) => setCfg({ ...cfg, unitId: v })} /></Field>
              <Field label="count"><Num value={cfg.count} min={1} max={500} onChange={(n) => setCfg({ ...cfg, count: n })} /></Field>
              <Field label="form"><Select value={cfg.formation} options={formationOptions} onChange={(v) => setCfg({ ...cfg, formation: v as FormationId | "default" })} /></Field>
              <Field label="enemy bin"><Select value={cfg.enemyBin} options={unitIds} onChange={(v) => setCfg({ ...cfg, enemyBin: v })} /></Field>
              <Field label="seed"><Num value={cfg.seed} onChange={(n) => setCfg({ ...cfg, seed: n })} /></Field>
              <Field label="ticks"><Num value={cfg.ticks} min={10} max={2000} onChange={(n) => setCfg({ ...cfg, ticks: n })} /></Field>
              <Field label="platoon"><Num value={cfg.maxPlatoonSize} min={1} max={500} onChange={(n) => setCfg({ ...cfg, maxPlatoonSize: n })} /></Field>
              <Field label="stride"><Num value={cfg.platoonStride} min={1} max={50} step={0.5} onChange={(n) => setCfg({ ...cfg, platoonStride: n })} /></Field>
            </Group>
            <Group title="forces">
              {ALL_FORCES.map((f) => (
                <Toggle
                  key={f}
                  label={f}
                  checked={cfg.flags[f] !== false}
                  onChange={(v) => setCfg({ ...cfg, flags: { ...cfg.flags, [f]: v } })}
                />
              ))}
              <button style={{ marginTop: 4 }} onClick={() => setCfg({ ...cfg, flags: { ...DEFAULT_FLAGS } })}>reset all</button>
              <button onClick={() => setCfg({ ...cfg, flags: Object.fromEntries(ALL_FORCES.map((k) => [k, false])) as ForceFlagMap })}>all off</button>
            </Group>
            <Group title="overlays">
              {ALL_OVERLAYS.map(({ key, label }) => (
                <Toggle
                  key={key}
                  label={label}
                  checked={cfg.overlays[key]}
                  onChange={(v) => setCfg({ ...cfg, overlays: { ...cfg.overlays, [key]: v } })}
                />
              ))}
              <Field label="arrow scale"><Num value={cfg.arrowScale} step={0.1} onChange={(n) => setCfg({ ...cfg, arrowScale: n })} /></Field>
            </Group>
            <button onClick={run} disabled={running} style={{ background: "#264", color: "#dfd", padding: "6px 12px" }}>
              {running ? "running…" : "run"}
            </button>
          </>
        )}
      </div>

      {/* Right viz panel */}
      <div style={{ display: "flex", flexDirection: "column", padding: 12, gap: 8, overflow: "hidden" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button onClick={() => setPlaying((p) => !p)} disabled={!result}>{playing ? "pause" : "play"}</button>
          <input
            type="range"
            min={0}
            max={result ? result.frames.length - 1 : 0}
            value={tickIdx}
            onChange={(e) => setTickIdx(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span style={{ color: "#888", width: 100, textAlign: "right" }}>
            tick {tickIdx} / {result?.frames.length ?? 0}
          </span>
        </div>
        <div style={{ flex: 1, position: "relative", background: "#08090c", borderRadius: 4 }}>
          <canvas
            ref={canvasRef}
            width={1200}
            height={900}
            onMouseMove={handleCanvasMove}
            onMouseLeave={() => setHoverRacId(null)}
            style={{ width: "100%", height: "100%", display: "block" }}
          />
          <Legend />
          {hoverRac && frame && <HoverPanel rac={hoverRac} />}
        </div>
      </div>
    </div>
  );
}

// ---- Tiny UI primitives (lab-local; no shared design system) ----

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "#6cf", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{children}</div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 6, alignItems: "center" }}>
      <span style={{ color: "#888" }}>{label}</span>
      {children}
    </label>
  );
}
function Select({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ width: "100%" }}>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
function Num({ value, onChange, min, max, step }: { value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number }) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(String(value)); }, [value]);
  return (
    <input
      type="number"
      value={text}
      step={step}
      onFocus={() => { focused.current = true; }}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value === "") return;
        const n = Number(e.target.value);
        if (!Number.isFinite(n)) return;
        const clamped = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n));
        onChange(clamped);
      }}
      onBlur={() => { focused.current = false; setText(String(value)); }}
      style={{ width: "100%" }}
    />
  );
}
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span style={{ color: checked ? "#ddd" : "#666" }}>{label}</span>
    </label>
  );
}
function Legend() {
  return (
    <div style={{ position: "absolute", left: 8, bottom: 8, background: "#000a", padding: 6, borderRadius: 3, fontSize: 11 }}>
      {(Object.keys(COMPONENT_COLORS) as Array<keyof typeof FORCE_COMPONENT_INDEX>).map((k) => (
        <div key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 10, background: COMPONENT_COLORS[k], display: "inline-block", borderRadius: 2 }} />
          <span style={{ color: "#aaa" }}>{k}</span>
        </div>
      ))}
    </div>
  );
}
function HoverPanel({ rac }: { rac: { id: number; x: number; y: number; vx: number; vy: number; groupId: number; doctrineIdx: number; contact: 0 | 1; slotDx: number; slotDy: number; squadId: number; squadLeaderId: number; isLeader: boolean; forces: Float32Array } }) {
  const { forces } = rac;
  const speed = Math.hypot(rac.vx, rac.vy);
  return (
    <div style={{ position: "absolute", right: 8, top: 8, background: "#000c", padding: 8, borderRadius: 3, fontSize: 11, color: "#ddd", minWidth: 200 }}>
      <div>
        rac #{rac.id} {rac.isLeader ? <span style={{ color: "#fc6" }}>[leader]</span> : null} {rac.contact ? "[contact]" : ""}
      </div>
      <div style={{ color: "#888" }}>squad {rac.squadId} → leader #{rac.squadLeaderId}</div>
      <div style={{ color: "#888" }}>pos ({rac.x.toFixed(1)}, {rac.y.toFixed(1)})  v {speed.toFixed(2)}m/s</div>
      <div style={{ color: "#888" }}>slot ({rac.slotDx.toFixed(2)}, {rac.slotDy.toFixed(2)})</div>
      <div style={{ marginTop: 4, borderTop: "1px solid #333", paddingTop: 4 }}>
        {(Object.keys(FORCE_COMPONENT_INDEX) as Array<keyof typeof FORCE_COMPONENT_INDEX>).map((k) => {
          const idx = FORCE_COMPONENT_INDEX[k];
          const fx = forces[idx * 2 + 0];
          const fy = forces[idx * 2 + 1];
          const m = Math.hypot(fx, fy);
          return (
            <div key={k} style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 4 }}>
              <span style={{ color: COMPONENT_COLORS[k] }}>{k}</span>
              <span>{m.toFixed(2)}  ({fx.toFixed(2)}, {fy.toFixed(2)})</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Canvas drawing ----

function makeTransform(canvas: HTMLCanvasElement, bounds: { w: number; h: number }) {
  // Map [-w/2..w/2] × [-h/2..h/2] into the canvas, preserving aspect.
  const padding = 24;
  const cw = canvas.width - padding * 2;
  const ch = canvas.height - padding * 2;
  const sx = cw / bounds.w;
  const sy = ch / bounds.h;
  const s = Math.min(sx, sy);
  const ox = canvas.width / 2;
  const oy = canvas.height / 2;
  const worldToPx = (x: number, y: number): [number, number] => [ox + x * s, oy - y * s];
  return { s, ox, oy, worldToPx };
}

function drawFrame(
  canvas: HTMLCanvasElement,
  result: LabRunResult,
  tickIdx: number,
  cfg: CellConfig,
  hoverId: number | null,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const frame = result.frames[tickIdx];
  if (!frame) return;
  const { s, worldToPx } = makeTransform(canvas, result.bounds);

  // Bounds box
  const [bx0, by0] = worldToPx(-result.bounds.w / 2, result.bounds.h / 2);
  const [bx1, by1] = worldToPx(result.bounds.w / 2, -result.bounds.h / 2);
  ctx.strokeStyle = "#1a1d23";
  ctx.lineWidth = 1;
  ctx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);

  // Bins
  for (const b of frame.bins) {
    if (!b.alive) continue;
    const [px, py] = worldToPx(b.x, b.y);
    ctx.fillStyle = "#c33";
    ctx.fillRect(px - 6, py - 6, 12, 12);
  }

  // Group centroids
  if (cfg.overlays.groupCentroid) {
    const groups = new Map<number, { sx: number; sy: number; n: number }>();
    for (const r of frame.racs) {
      if (!r.alive) continue;
      const g = groups.get(r.groupId) ?? { sx: 0, sy: 0, n: 0 };
      g.sx += r.x; g.sy += r.y; g.n++;
      groups.set(r.groupId, g);
    }
    ctx.strokeStyle = "#cc8";
    ctx.lineWidth = 1.5;
    for (const g of groups.values()) {
      if (g.n < 2) continue;
      const [px, py] = worldToPx(g.sx / g.n, g.sy / g.n);
      ctx.beginPath();
      ctx.moveTo(px - 6, py); ctx.lineTo(px + 6, py);
      ctx.moveTo(px, py - 6); ctx.lineTo(px, py + 6);
      ctx.stroke();
    }
  }

  // Distance ring around target (envelopment R=15m)
  if (cfg.overlays.distanceRing) {
    const target = frame.bins.find((b) => b.alive);
    if (target) {
      const [px, py] = worldToPx(target.x, target.y);
      ctx.strokeStyle = "#445";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(px, py, 15 * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Force arrows
  if (cfg.overlays.forceArrows) {
    for (const r of frame.racs) {
      if (!r.alive) continue;
      const [px, py] = worldToPx(r.x, r.y);
      for (const k of Object.keys(FORCE_COMPONENT_INDEX) as Array<keyof typeof FORCE_COMPONENT_INDEX>) {
        const idx = FORCE_COMPONENT_INDEX[k];
        const fx = r.forces[idx * 2 + 0];
        const fy = r.forces[idx * 2 + 1];
        const m = Math.hypot(fx, fy);
        if (m < 0.05) continue;
        const len = m * cfg.arrowScale * s;
        const dx = (fx / m) * len;
        const dy = -(fy / m) * len; // y is flipped in screen
        ctx.strokeStyle = COMPONENT_COLORS[k];
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + dx, py + dy);
        ctx.stroke();
      }
    }
  }

  // Velocity arrow
  if (cfg.overlays.velocityArrow) {
    for (const r of frame.racs) {
      if (!r.alive) continue;
      const [px, py] = worldToPx(r.x, r.y);
      const m = Math.hypot(r.vx, r.vy);
      if (m < 0.01) continue;
      const len = m * 1.5 * s;
      const dx = (r.vx / m) * len;
      const dy = -(r.vy / m) * len;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + dx, py + dy);
      ctx.stroke();
    }
  }

  // Slot-target markers — each rac's (leaderPos + slot) cohesion target.
  if (cfg.overlays.slotTarget) {
    const leaderPos = new Map<number, { x: number; y: number }>();
    for (const r of frame.racs) {
      if (!r.alive) continue;
      if (r.isLeader) leaderPos.set(r.id, { x: r.x, y: r.y });
    }
    ctx.fillStyle = "#7adde0";
    for (const r of frame.racs) {
      if (!r.alive || r.isLeader) continue;
      const lp = leaderPos.get(r.squadLeaderId);
      if (!lp) continue;
      const tx = lp.x + r.slotDx;
      const ty = lp.y + r.slotDy;
      const [px, py] = worldToPx(tx, ty);
      ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
    }
  }

  // Racs — color by squadId hash so squads are visually distinct.
  // Leaders get a white ring so the senior member of each squad stands
  // out at a glance.
  for (const r of frame.racs) {
    if (!r.alive) continue;
    const [px, py] = worldToPx(r.x, r.y);
    ctx.fillStyle = r.id === hoverId ? "#fff" : squadColor(r.squadId, r.contact === 1);
    ctx.fillRect(px - 3, py - 3, 6, 6);
    if (r.isLeader) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.2;
      ctx.strokeRect(px - 4.5, py - 4.5, 9, 9);
    }
  }
}

function squadColor(sid: number, contact: boolean): string {
  // Hash squadId → hue; saturation/lightness vary slightly with contact.
  const h = ((sid * 2654435761) >>> 0) / 4294967296;
  const hue = Math.floor(h * 360);
  const sat = contact ? 80 : 65;
  const lit = contact ? 70 : 60;
  return `hsl(${hue}, ${sat}%, ${lit}%)`;
}
