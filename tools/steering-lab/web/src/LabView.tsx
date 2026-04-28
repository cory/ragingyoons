import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadContentFromApi } from "./sim-bridge.js";
import type { ContentBundle } from "@sim/content.js";
import { FORMATIONS, type FormationId } from "@sim/formations.js";
import { DOCTRINES, doctrineFor, squadSizeFor } from "@sim/doctrines.js";
import { runLabBattle, type LabFrame, type LabRunResult } from "./runBattle.js";

type OverlayKey =
  | "slotTarget"
  | "velocityArrow"
  | "flankProbes"
  | "behaviorColor"
  | "attackRange";

const ALL_OVERLAYS: { key: OverlayKey; label: string }[] = [
  { key: "slotTarget", label: "slot target (formation)" },
  { key: "velocityArrow", label: "velocity arrow" },
  { key: "flankProbes", label: "cavalry flank probes" },
  { key: "behaviorColor", label: "color by behavior" },
  { key: "attackRange", label: "attack-range rings" },
];

interface SideConfig {
  unitId: string;
  count: number;
  formation: FormationId | "default";
  maxPlatoonSize: number;
  platoonStride: number;
}

interface CellConfig {
  blue: SideConfig;
  enemyBin: string;
  /** When true, red side spawns real units instead of the punching-bag bin. */
  redEnabled: boolean;
  red: SideConfig;
  seed: number;
  ticks: number;
  overlays: Record<OverlayKey, boolean>;
  breakAtTick: number;
}

const DEFAULT_OVERLAYS: Record<OverlayKey, boolean> = {
  slotTarget: false,
  velocityArrow: false,
  flankProbes: false,
  behaviorColor: false,
  attackRange: false,
};

export function LabView() {
  const [content, setContent] = useState<ContentBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cfg, setCfg] = useState<CellConfig>({
    blue: { unitId: "", count: 12, formation: "default", maxPlatoonSize: 20, platoonStride: 6 },
    enemyBin: "",
    redEnabled: false,
    red: { unitId: "", count: 12, formation: "default", maxPlatoonSize: 20, platoonStride: 6 },
    seed: 1,
    ticks: 1500, // 100 s at 15 Hz; loop also breaks on win condition
    overlays: DEFAULT_OVERLAYS,
    breakAtTick: 0,
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
        setCfg((p) => ({
          ...p,
          blue: { ...p.blue, unitId: firstUnit },
          red: { ...p.red, unitId: firstUnit },
          enemyBin: firstUnit,
        }));
      })
      .catch((e) => setError(String(e)));
  }, []);

  const unitIds = useMemo(() => (content ? [...content.units.keys()].sort() : []), [content]);

  const formationOptionsFor = useCallback(
    (unitId: string): (FormationId | "default")[] => {
      if (!content || !unitId) return ["default"];
      const u = content.units.get(unitId);
      if (!u) return ["default"];
      const list: (FormationId | "default")[] = ["default"];
      for (const f of FORMATIONS) if (f.role === u.role) list.push(f.id);
      return list;
    },
    [content],
  );

  const doctrineInfoFor = useCallback(
    (unitId: string) => {
      if (!content || !unitId) return null;
      const u = content.units.get(unitId);
      if (!u) return null;
      const docId = doctrineFor(u.environment, u.curiosity);
      const docDef = DOCTRINES.find((d) => d.id === docId);
      const sSize = docDef ? squadSizeFor(u.role, docDef) : 0;
      const stdOrder = docDef?.standingOrder ?? "advance";
      return { docId, sSize, role: u.role, stdOrder };
    },
    [content],
  );

  const run = useCallback(() => {
    if (!content || !cfg.blue.unitId) return;
    if (!cfg.redEnabled && !cfg.enemyBin) return;
    if (cfg.redEnabled && !cfg.red.unitId) return;
    setRunning(true);
    setError(null);
    try {
      const r = runLabBattle(content, {
        seed: cfg.seed,
        unitId: cfg.blue.unitId,
        count: cfg.blue.count,
        formationId: cfg.blue.formation === "default" ? undefined : cfg.blue.formation,
        enemyBinUnitId: cfg.enemyBin,
        ticks: cfg.ticks,
        bounds: { w: 120, h: 80 },
        maxPlatoonSize: cfg.blue.maxPlatoonSize,
        platoonStride: cfg.blue.platoonStride,
        breakAtTick: cfg.breakAtTick,
        redSide: cfg.redEnabled
          ? {
              unitId: cfg.red.unitId,
              count: cfg.red.count,
              formationId: cfg.red.formation === "default" ? undefined : cfg.red.formation,
              maxPlatoonSize: cfg.red.maxPlatoonSize,
              platoonStride: cfg.red.platoonStride,
            }
          : undefined,
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
            <SidePanel
              title="blue (side A)"
              accent="#6cf"
              side={cfg.blue}
              unitIds={unitIds}
              formationOptions={formationOptionsFor(cfg.blue.unitId)}
              doctrine={doctrineInfoFor(cfg.blue.unitId)}
              onChange={(s) => setCfg({ ...cfg, blue: s })}
            />
            <Group title="opponent">
              <Toggle
                label="vs real units (red side)"
                checked={cfg.redEnabled}
                onChange={(v) => setCfg({ ...cfg, redEnabled: v })}
              />
              {!cfg.redEnabled && (
                <Field label="enemy bin">
                  <Select
                    value={cfg.enemyBin}
                    options={unitIds}
                    onChange={(v) => setCfg({ ...cfg, enemyBin: v })}
                  />
                </Field>
              )}
            </Group>
            {cfg.redEnabled && (
              <SidePanel
                title="red (side B)"
                accent="#f88"
                side={cfg.red}
                unitIds={unitIds}
                formationOptions={formationOptionsFor(cfg.red.unitId)}
                doctrine={doctrineInfoFor(cfg.red.unitId)}
                onChange={(s) => setCfg({ ...cfg, red: s })}
              />
            )}
            <Group title="run">
              <Field label="seed"><Num value={cfg.seed} onChange={(n) => setCfg({ ...cfg, seed: n })} /></Field>
              <Field label="ticks"><Num value={cfg.ticks} min={10} max={2000} onChange={(n) => setCfg({ ...cfg, ticks: n })} /></Field>
              <Field label="break tick"><Num value={cfg.breakAtTick} min={0} max={2000} onChange={(n) => setCfg({ ...cfg, breakAtTick: n })} /></Field>
              <button
                onClick={() => {
                  setCfg({ ...cfg, breakAtTick: Math.max(1, tickIdx) });
                  setTimeout(run, 0);
                }}
                disabled={running || !result}
                style={{ background: "#742", color: "#fde" }}
              >
                break now (tick {Math.max(1, tickIdx)})
              </button>
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
          {hoverRac && frame && <HoverPanel rac={hoverRac} />}
        </div>
      </div>
    </div>
  );
}

// ---- Tiny UI primitives (lab-local; no shared design system) ----

function SidePanel(props: {
  title: string;
  accent: string;
  side: SideConfig;
  unitIds: string[];
  formationOptions: (FormationId | "default")[];
  doctrine: { docId: string; sSize: number; role: string; stdOrder: string } | null;
  onChange: (s: SideConfig) => void;
}) {
  const { title, accent, side, unitIds, formationOptions, doctrine, onChange } = props;
  return (
    <div>
      <div style={{ fontSize: 11, color: accent, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 6, borderLeft: `2px solid ${accent}` }}>
        <Field label="unit"><Select value={side.unitId} options={unitIds} onChange={(v) => onChange({ ...side, unitId: v })} /></Field>
        <Field label="count"><Num value={side.count} min={1} max={500} onChange={(n) => onChange({ ...side, count: n })} /></Field>
        <Field label="form"><Select value={side.formation} options={formationOptions} onChange={(v) => onChange({ ...side, formation: v as FormationId | "default" })} /></Field>
        <Field label="platoon"><Num value={side.maxPlatoonSize} min={1} max={500} onChange={(n) => onChange({ ...side, maxPlatoonSize: n })} /></Field>
        <Field label="stride"><Num value={side.platoonStride} min={1} max={50} step={0.5} onChange={(n) => onChange({ ...side, platoonStride: n })} /></Field>
        {doctrine && (
          <div style={{ fontSize: 11, color: accent, paddingLeft: 76 }}>
            doctrine <span style={{ color: "#fc6" }}>{doctrine.docId}</span> · squad <span style={{ color: "#fc6" }}>{doctrine.sSize}</span> · order <span style={{ color: "#fc6" }}>{doctrine.stdOrder}</span> ({doctrine.role})
          </div>
        )}
      </div>
    </div>
  );
}

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
const BEHAVIOR_LABEL = ["march", "engage", "rout", "kite", "flank", "rally"];
const BEHAVIOR_COLOR = ["#9cf", "#fc6", "#f88", "#bef", "#fbd", "#cf8"];
const STANDING_ORDER_LABEL = ["hold", "slow", "advance", "charge", "skirmish"];

function HoverPanel({ rac }: { rac: { id: number; x: number; y: number; vx: number; vy: number; groupId: number; doctrineIdx: number; contact: 0 | 1; slotDx: number; slotDy: number; squadId: number; squadLeaderId: number; isLeader: boolean; hp: number; hpMax: number; morale: number; broken: boolean; behavior: number; pinned: boolean; squadThreat: number; standingOrder: number } }) {
  const speed = Math.hypot(rac.vx, rac.vy);
  return (
    <div style={{ position: "absolute", right: 8, top: 8, background: "#000c", padding: 8, borderRadius: 3, fontSize: 11, color: "#ddd", minWidth: 200 }}>
      <div>
        rac #{rac.id} {rac.isLeader ? <span style={{ color: "#fc6" }}>[leader]</span> : null} {rac.contact ? "[contact]" : ""} {rac.broken ? <span style={{ color: "#f88" }}>[broken]</span> : null} {rac.pinned ? <span style={{ color: "#fa6" }}>[pinned]</span> : null} {rac.squadThreat === 2 ? <span style={{ color: "#f88" }}>[rear-attack]</span> : rac.squadThreat === 1 ? <span style={{ color: "#fa6" }}>[flanked]</span> : null}
      </div>
      <div>
        state <span style={{ color: BEHAVIOR_COLOR[rac.behavior] ?? "#ddd" }}>
          {BEHAVIOR_LABEL[rac.behavior] ?? "?"}
        </span>
        <span style={{ color: "#888" }}> · order </span>
        <span style={{ color: "#cc8" }}>{STANDING_ORDER_LABEL[rac.standingOrder] ?? "?"}</span>
      </div>
      <div style={{ color: "#888" }}>squad {rac.squadId} → leader #{rac.squadLeaderId}</div>
      <div style={{ color: "#888" }}>
        hp <span style={{ color: "#dfd" }}>{Math.max(0, Math.round(rac.hp))}</span>/<span>{Math.round(rac.hpMax)}</span>
      </div>
      <div style={{ color: "#888" }}>
        morale <span style={{ color: rac.broken ? "#f88" : "#cc8" }}>{rac.morale.toFixed(2)}</span>
      </div>
      <div style={{ color: "#888" }}>pos ({rac.x.toFixed(1)}, {rac.y.toFixed(1)})  v {speed.toFixed(2)}m/s</div>
      <div style={{ color: "#888" }}>slot ({rac.slotDx.toFixed(2)}, {rac.slotDy.toFixed(2)})</div>
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

  // Cavalry FLANK probes — show what the edge-finding search is
  // actually finding. Each cavalry rac in BEHAVIOR_FLANK gets:
  //  - 8 probe dots along the chosen perpendicular direction.
  //  - A line from the rac to the chosen aim point (where they're
  //    heading laterally).
  //  - The probe that found the edge is highlighted yellow; others
  //    are grey. If no edge was found in range, no highlight.
  if (cfg.overlays.flankProbes) {
    for (const r of frame.racs) {
      if (!r.alive) continue;
      const fl = r.flankDebug;
      if (!fl || fl[0] !== 1) continue; // not in flank
      const [rx, ry] = worldToPx(r.x, r.y);
      const aimX = fl[2];
      const aimY = fl[3];
      const edgeStep = fl[1]; // -1 if no edge in range
      // Aim line: rac → chosen aim point.
      const [ax, ay] = worldToPx(aimX, aimY);
      ctx.strokeStyle = "#fc6"; // amber for the chosen lateral
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      ctx.lineTo(ax, ay);
      ctx.stroke();
      // Probe dots: 8 points along the perpendicular.
      for (let k = 0; k < 8; k++) {
        const px = fl[8 + k * 2];
        const py = fl[8 + k * 2 + 1];
        if (px === 0 && py === 0) continue; // unwritten slot
        const [dx, dy] = worldToPx(px, py);
        const isEdge = (k + 1) === edgeStep;
        ctx.fillStyle = isEdge ? "#fe8" : "#666";
        ctx.beginPath();
        ctx.arc(dx, dy, isEdge ? 4 : 2, 0, Math.PI * 2);
        ctx.fill();
      }
      // Aim point marker.
      ctx.fillStyle = "#fc6";
      ctx.beginPath();
      ctx.arc(ax, ay, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Attack-range rings — faint circle at each rac's effRange so the
  // melee/projectile boundary is visible. Drawn before the rac body
  // so the ring sits beneath the squares.
  if (cfg.overlays.attackRange) {
    ctx.lineWidth = 1;
    for (const r of frame.racs) {
      if (!r.alive) continue;
      if (r.effRange <= 0) continue;
      const [px, py] = worldToPx(r.x, r.y);
      // Tiny melee circles are barely visible; bump alpha slightly
      // so they still register at small radii.
      ctx.strokeStyle = r.effRange >= 3 ? "#fff3" : "#fff5";
      ctx.beginPath();
      ctx.arc(px, py, r.effRange * s, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Racs — default color is squadId hash (squads are distinct), but
  // the "color by behavior" overlay overrides with the state palette
  // (march/engage/rout/kite/flank/rally) so the whole field reads at
  // a glance. Leaders get a white ring; broken racs (rout) get a red
  // outline regardless of color overlay.
  for (const r of frame.racs) {
    if (!r.alive) continue;
    const [px, py] = worldToPx(r.x, r.y);
    if (r.id === hoverId) {
      ctx.fillStyle = "#fff";
    } else if (cfg.overlays.behaviorColor) {
      ctx.fillStyle = BEHAVIOR_COLOR[r.behavior] ?? "#888";
    } else if (r.broken) {
      ctx.fillStyle = "#666";
    } else {
      ctx.fillStyle = squadColor(r.squadId, r.contact === 1);
    }
    ctx.fillRect(px - 3, py - 3, 6, 6);
    if (r.isLeader) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.2;
      ctx.strokeRect(px - 4.5, py - 4.5, 9, 9);
    } else if (r.broken) {
      ctx.strokeStyle = "#f88";
      ctx.lineWidth = 1;
      ctx.strokeRect(px - 4.5, py - 4.5, 9, 9);
    }
    // HP bar: drawn above the rac when hp < hpMax. Wider racs (those
    // with the leader/broken outline) get the bar pushed slightly
    // higher so it doesn't overlap the ring.
    if (r.hpMax > 0 && r.hp < r.hpMax) {
      const frac = Math.max(0, Math.min(1, r.hp / r.hpMax));
      const barW = 8;
      const barH = 1.5;
      const barY = py - 7;
      ctx.fillStyle = "#000a";
      ctx.fillRect(px - barW / 2 - 0.5, barY - 0.5, barW + 1, barH + 1);
      ctx.fillStyle = frac > 0.5 ? "#7dd97d" : frac > 0.25 ? "#d9c87d" : "#d97d7d";
      ctx.fillRect(px - barW / 2, barY, barW * frac, barH);
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
