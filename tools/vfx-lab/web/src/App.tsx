import { useEffect, useRef, useState } from "react";
import { Vector3, type AbstractMesh } from "@babylonjs/core";
import { createScene, type SceneHandles } from "./scene/createScene";
import { pickGround } from "./scene/picker";
import { spawnFx } from "./fx/runtime";
import { getPreset, listPresets } from "./fx/registry";
import { SidePanel, actionForPreset } from "./ui/SidePanel";
import { FpsOverlay } from "./ui/FpsOverlay";
import { MODELS, NONE_ENV_ID } from "./scene/environment";
import type { FxHandle } from "./fx/types";

function getPawnWorldPos(handles: SceneHandles): Vector3 {
  handles.arena.pawn.computeWorldMatrix(true);
  return handles.arena.pawn.absolutePosition.clone();
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handlesRef = useRef<SceneHandles | null>(null);
  const activeRef = useRef<Map<string, FxHandle>>(new Map());
  const [engine, setEngine] = useState<SceneHandles["engine"] | null>(null);
  const [selectedId, setSelectedId] = useState<string>(
    listPresets()[0]?.id ?? ""
  );
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set());
  const [envId, setEnvId] = useState<string>(NONE_ENV_ID);

  useEffect(() => {
    if (!canvasRef.current) return;
    const handles = createScene(canvasRef.current);
    handlesRef.current = handles;
    setEngine(handles.engine);
    return () => {
      activeRef.current.forEach((h) => h.dispose());
      activeRef.current.clear();
      handles.dispose();
    };
  }, []);

  useEffect(() => {
    const handles = handlesRef.current;
    if (!handles) return;
    handles.setEnvironment(envId === NONE_ENV_ID ? null : envId);
  }, [envId]);

  const fireAtPoint = (presetId: string, point: Vector3) => {
    const handles = handlesRef.current;
    if (!handles) return;
    const preset = getPreset(presetId);
    if (!preset) return;
    if (preset.kind === "projectile") {
      spawnFx(handles.scene, preset, {
        origin: getPawnWorldPos(handles),
        target: point,
      });
    } else {
      spawnFx(handles.scene, preset, { origin: point });
    }
  };

  const toggle = (presetId: string) => {
    const handles = handlesRef.current;
    if (!handles) return;
    const preset = getPreset(presetId);
    if (!preset) return;

    const existing = activeRef.current.get(presetId);
    if (existing) {
      existing.dispose();
      activeRef.current.delete(presetId);
      setActiveIds(new Set(activeRef.current.keys()));
      return;
    }

    const action = actionForPreset(preset);
    const pawn = handles.arena.pawn as AbstractMesh;
    const handle = spawnFx(handles.scene, preset, {
      origin:
        action === "toggle-pawn"
          ? getPawnWorldPos(handles)
          : Vector3.Zero(),
      attachTo: action === "toggle-pawn" ? pawn : undefined,
    });
    activeRef.current.set(presetId, handle);
    setActiveIds(new Set(activeRef.current.keys()));
  };

  const onCanvasClick = () => {
    const handles = handlesRef.current;
    if (!handles) return;
    const preset = getPreset(selectedId);
    if (!preset) return;
    if (actionForPreset(preset) !== "fire") return;
    const point = pickGround(handles.scene);
    if (!point) return;
    fireAtPoint(selectedId, point);
  };

  return (
    <div className="app">
      <div className="viewport">
        <canvas ref={canvasRef} onClick={onCanvasClick} />
        <FpsOverlay engine={engine} />
      </div>
      <SidePanel
        selectedId={selectedId}
        onSelect={setSelectedId}
        onFire={(id) =>
          fireAtPoint(
            id,
            handlesRef.current
              ? getPawnWorldPos(handlesRef.current)
              : Vector3.Zero()
          )
        }
        onToggle={toggle}
        activeIds={activeIds}
        envId={envId}
        envOptions={[
          { id: NONE_ENV_ID, name: "None" },
          ...MODELS.map((m) => ({ id: m.id, name: m.name })),
        ]}
        onEnvChange={setEnvId}
      />
    </div>
  );
}
