import { useMemo } from "react";
import { listPresets } from "../fx/registry";
import type { FxPreset } from "../fx/types";

export type FxAction = "fire" | "toggle-pawn" | "toggle-ambient";

export function actionForPreset(p: FxPreset): FxAction {
  if (p.kind === "shield") return "toggle-pawn";
  if (p.kind === "particle") {
    if (p.mode === "continuous" && p.attach) return "toggle-pawn";
    if (p.mode === "continuous" && !p.attach) return "toggle-ambient";
  }
  return "fire";
}

const HOUR_PRESETS: Array<{ label: string; hour: number }> = [
  { label: "Dawn", hour: 6.5 },
  { label: "Noon", hour: 12 },
  { label: "Sunset", hour: 18 },
  { label: "Night", hour: 0 },
];

export interface SidePanelProps {
  selectedId: string;
  onSelect: (id: string) => void;
  onFire: (id: string) => void;
  onToggle: (id: string) => void;
  activeIds: Set<string>;
  hour: number;
  onHourChange: (h: number) => void;
}

export function SidePanel({
  selectedId,
  onSelect,
  onFire,
  onToggle,
  activeIds,
  hour,
  onHourChange,
}: SidePanelProps) {
  const presets = useMemo(() => listPresets(), []);
  const selected = presets.find((p) => p.id === selectedId) ?? presets[0];
  if (!selected) return null;
  const action = actionForPreset(selected);
  const isActive = activeIds.has(selected.id);

  return (
    <aside className="panel">
      <h2>VFX Lab</h2>

      <label>Effect</label>
      <select value={selected.id} onChange={(e) => onSelect(e.target.value)}>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      <label>Action</label>
      {action === "fire" && (
        <button className="fire" onClick={() => onFire(selected.id)}>
          Fire at pawn
        </button>
      )}
      {action === "toggle-pawn" && (
        <button className="fire" onClick={() => onToggle(selected.id)}>
          {isActive ? "Remove from pawn" : "Apply to pawn"}
        </button>
      )}
      {action === "toggle-ambient" && (
        <button className="fire" onClick={() => onToggle(selected.id)}>
          {isActive ? "Disable ambient" : "Enable ambient"}
        </button>
      )}

      <div className="hint">
        {action === "fire"
          ? "Click the ground to fire at that point. Projectiles fly from the pawn to the cursor."
          : action === "toggle-pawn"
          ? "Effect is parented to the centered pawn."
          : "Effect plays scene-wide."}
      </div>

      {activeIds.size > 0 && (
        <>
          <label style={{ marginTop: 16 }}>Active</label>
          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: "none",
              fontSize: 12,
              color: "#9a9ab0",
            }}
          >
            {Array.from(activeIds).map((id) => (
              <li key={id} style={{ padding: "2px 0" }}>
                · {presets.find((p) => p.id === id)?.name ?? id}
              </li>
            ))}
          </ul>
        </>
      )}

      <h2 style={{ marginTop: 24 }}>World</h2>
      <label>
        Time of day: {hour.toFixed(1)}h
      </label>
      <input
        type="range"
        min={0}
        max={24}
        step={0.25}
        value={hour}
        onChange={(e) => onHourChange(Number(e.target.value))}
        style={{ width: "100%" }}
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr 1fr",
          gap: 4,
          marginTop: 6,
        }}
      >
        {HOUR_PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => onHourChange(p.hour)}
            style={{ padding: "4px 0", fontSize: 11 }}
          >
            {p.label}
          </button>
        ))}
      </div>
    </aside>
  );
}
