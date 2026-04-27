import type { CSSProperties } from "react";
import { CURIOSITIES, ENVIRONMENTS, NAMED } from "../data";
import type { Player } from "../types";
import { RaccoonAvatar } from "./RaccoonAvatar";

interface Props {
  player: Player;
  onHover?: () => void;
  onLeave?: () => void;
  isHovered?: boolean;
  isYou?: boolean;
}

export function PlayerRow({ player, onHover, onLeave, isHovered, isYou }: Props) {
  const env = ENVIRONMENTS[player.env];
  const cur = CURIOSITIES[player.cur]; // referenced in title only
  void cur;
  const hpPct = player.hp / 100;
  const dead = !player.alive;
  const repr = NAMED.find((n) => n.env === player.env && n.cur === player.cur)?.id ?? "splinter";

  return (
    <div
      className={`player-row ${dead ? "dead" : ""} ${isYou ? "you" : ""} ${isHovered ? "hovered" : ""}`}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
    >
      <div className="player-rank">#{player.rank}</div>
      <div className="player-av" style={{ "--env-color": env.color } as CSSProperties}>
        <div className="player-av-inner">
          <RaccoonAvatar archetype={repr} size={28} />
        </div>
      </div>
      <div className="player-mid">
        <div className="player-name">
          {player.name}
          {isYou && <span className="you-tag"> · YOU</span>}
        </div>
        <div className="player-hpbar">
          <div
            className="player-hpbar-fill"
            style={{
              width: `${hpPct * 100}%`,
              background: hpPct > 0.5 ? "#4ade80" : hpPct > 0.25 ? "#facc15" : "#ef4444",
            }}
          />
        </div>
      </div>
      <div className="player-stats">
        <div className="player-hp">{player.hp}</div>
        <div
          className="player-streak"
          style={{ color: player.streak.startsWith("W") ? "#4ade80" : player.streak.startsWith("L") ? "#ef4444" : "#666" }}
        >
          {player.streak}
        </div>
      </div>
    </div>
  );
}
