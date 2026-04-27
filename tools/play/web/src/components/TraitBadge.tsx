import type { CSSProperties } from "react";
import { CURIOSITIES, ENVIRONMENTS, ROLES, TRAIT_BREAKS } from "../data";
import type { CurId, EnvId, RoleId, TraitKind } from "../types";

interface Props {
  kind: TraitKind;
  traitId: string;
  count: number;
  tier: number;
}

export function TraitBadge({ kind, traitId, count, tier }: Props) {
  const t = lookupTrait(kind, traitId);
  if (!t) return null;
  const breaks = TRAIT_BREAKS[kind];
  const nextBreak = breaks.find((b) => b > count);
  const active = tier > 0;

  return (
    <div
      className={`trait-badge ${active ? "active" : ""}`}
      style={{ "--trait-color": t.color, opacity: active ? 1 : 0.42 } as CSSProperties}
    >
      <span className="trait-glyph" style={{ color: active ? t.color : "#777" }}>{t.glyph}</span>
      <span className="trait-meta">
        <span className="trait-name">{t.name}</span>
        <span className="trait-count">
          <b>{count}</b>
          {nextBreak ? <span className="muted">/{nextBreak}</span> : null}
        </span>
      </span>
      <span className="trait-tier">
        {[0, 1, 2].map((i) => (
          <span key={i} className="tier-pip" style={{ background: i < tier ? t.color : "rgba(255,255,255,0.12)" }} />
        ))}
      </span>
    </div>
  );
}

function lookupTrait(kind: TraitKind, id: string) {
  if (kind === "env") return ENVIRONMENTS[id as EnvId];
  if (kind === "cur") return CURIOSITIES[id as CurId];
  return ROLES[id as RoleId];
}
