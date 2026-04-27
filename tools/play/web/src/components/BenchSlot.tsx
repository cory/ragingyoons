import type { CSSProperties } from "react";
import { archByid, CURIOSITIES, ENVIRONMENTS, ROLES } from "../data";
import type { BenchUnit } from "../types";
import { RaccoonAvatar } from "./RaccoonAvatar";

interface Props {
  unit?: BenchUnit;
  onClick?: () => void;
  onDragStart?: () => void;
}

export function BenchSlot({ unit, onClick, onDragStart }: Props) {
  if (!unit) return <div className="bench-slot empty" />;
  const a = archByid(unit.archetype);
  if (!a) return <div className="bench-slot empty" />;
  const env = ENVIRONMENTS[a.env];
  return (
    <div
      className="bench-slot"
      style={{ "--env-color": env.color } as CSSProperties}
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      title={`${a.name} · ${env.name} · ${CURIOSITIES[a.cur].name} · ${ROLES[a.role].name}`}
    >
      <div className="bench-tier">
        {Array.from({ length: unit.level || 1 }).map((_, i) => (
          <span key={i} className="dot" />
        ))}
      </div>
      <RaccoonAvatar archetype={unit.archetype} size={44} />
      <div className="bench-name">{a.name}</div>
    </div>
  );
}
