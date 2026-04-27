import type { CSSProperties } from "react";
import { archByid, CURIOSITIES, ENVIRONMENTS, ROLES } from "../data";
import type { ShopOffer } from "../types";
import { RaccoonAvatar } from "./RaccoonAvatar";

interface Props {
  slot: ShopOffer | null;
  idx: number;
  trash: number;
  onBuy: (idx: number) => void;
}

export function ShopCard({ slot, idx, trash, onBuy }: Props) {
  if (!slot) {
    return (
      <div className="shop-card sold">
        <div className="shop-sold-x">SOLD</div>
      </div>
    );
  }
  const a = archByid(slot.archetype);
  if (!a) return <div className="shop-card sold"><div className="shop-sold-x">?</div></div>;
  const env = ENVIRONMENTS[a.env];
  const cur = CURIOSITIES[a.cur];
  const role = ROLES[a.role];
  const canAfford = trash >= slot.cost;
  return (
    <button
      className={`shop-card ${canAfford ? "" : "broke"}`}
      onClick={() => canAfford && onBuy(idx)}
      style={{ "--env-color": env.color } as CSSProperties}
    >
      <div className="shop-card-bg" style={{ background: `linear-gradient(180deg, ${env.color}22, transparent 60%)` }} />
      <div className="shop-tier">T{a.tier}</div>
      <div className="shop-avatar">
        <RaccoonAvatar archetype={slot.archetype} size={68} />
      </div>
      <div className="shop-name">{a.name}</div>
      <div className="shop-traits">
        <span style={{ color: env.color }}>{env.glyph} {env.short}</span>
        <span style={{ color: cur.color }}>{cur.glyph} {cur.name.slice(0, 4)}</span>
        <span style={{ color: role.color }}>{role.glyph} {role.name.slice(0, 4)}</span>
      </div>
      <div className="shop-cost">
        <span className="gold-glyph">¢</span> {slot.cost}
      </div>
    </button>
  );
}
