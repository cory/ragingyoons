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

export interface SidePanelProps {
  selectedId: string;
  onSelect: (id: string) => void;
  onFire: (id: string) => void;
  onToggle: (id: string) => void;
  activeIds: Set<string>;
  envId: string;
  envOptions: Array<{ id: string; name: string }>;
  onEnvChange: (id: string) => void;
}

export function SidePanel({
  selectedId,
  onSelect,
  onFire,
  onToggle,
  activeIds,
  envId,
  envOptions,
  onEnvChange,
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

      <label>Environment</label>
      <select value={envId} onChange={(e) => onEnvChange(e.target.value)}>
        {envOptions.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </aside>
  );
}
