// 2D hex board placeholder. Same chrome wraps the 3D Babylon view
// when that lands — this component will be swapped behind the same
// position/size contract. Pointy-top axial coords (q, r), odd-r offset.
import type { ReactNode } from "react";
import { archByid, ITEMS } from "../data";
import type { BoardUnit } from "../types";
import { RaccoonAvatar } from "./RaccoonAvatar";

export const HEX_SIZE = 46;
export const HEX_W = Math.sqrt(3) * HEX_SIZE;
export const HEX_H = 2 * HEX_SIZE;

export function hexToPx(q: number, r: number) {
  const x = HEX_W * (q + 0.5 * (r & 1));
  const y = HEX_H * 0.75 * r;
  return { x, y };
}

interface HexShapeProps {
  x: number;
  y: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  glow?: boolean;
  dim?: boolean;
  dashed?: boolean;
  children?: ReactNode;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onClick?: () => void;
}

export function HexShape({
  x, y, fill, stroke, strokeWidth = 1, glow = false, children,
  onMouseEnter, onMouseLeave, onClick, dim = false, dashed = false,
}: HexShapeProps) {
  const s = HEX_SIZE;
  const points = [
    [0, -s],
    [s * Math.sqrt(3) / 2, -s / 2],
    [s * Math.sqrt(3) / 2,  s / 2],
    [0, s],
    [-s * Math.sqrt(3) / 2, s / 2],
    [-s * Math.sqrt(3) / 2, -s / 2],
  ].map((p) => p.join(",")).join(" ");

  return (
    <g
      transform={`translate(${x},${y})`}
      style={{ cursor: onClick ? "pointer" : "default", opacity: dim ? 0.35 : 1 }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
    >
      {glow && (
        <polygon points={points} fill="none" stroke={stroke} strokeWidth={6} opacity={0.35} style={{ filter: "blur(4px)" }} />
      )}
      <polygon
        points={points}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={dashed ? "4 4" : undefined}
      />
      {children}
    </g>
  );
}

interface HexUnitProps {
  unit: BoardUnit;
  friendly?: boolean;
  raging?: boolean;
  onHover?: () => void;
  onLeave?: () => void;
}

export function HexUnit({ unit, friendly = true, raging = false, onHover, onLeave }: HexUnitProps) {
  const a = archByid(unit.archetype);
  if (!a) return null;
  const hpPct = unit.hpPct ?? 1;
  const ragePct = unit.ragePct ?? a.rage / 100;
  const level = unit.level || 1;

  return (
    <g onMouseEnter={onHover} onMouseLeave={onLeave} style={{ cursor: "pointer" }}>
      <foreignObject x={-22} y={-30} width={44} height={44} style={{ overflow: "visible" }}>
        <div style={{ width: 44, height: 44, position: "relative" }}>
          <RaccoonAvatar archetype={unit.archetype} size={44} raging={raging} />
        </div>
      </foreignObject>
      {/* tier stars */}
      <g transform="translate(0,-36)">
        {Array.from({ length: level }).map((_, i) => (
          <polygon
            key={i}
            points="0,-3 1,0 4,0 1.5,2 2.5,5 0,3 -2.5,5 -1.5,2 -4,0 -1,0"
            transform={`translate(${(i - (level - 1) / 2) * 9},0)`}
            fill="#ffd14a"
          />
        ))}
      </g>
      {/* HP bar */}
      <g transform="translate(-20,18)">
        <rect width={40} height={4} fill="rgba(0,0,0,0.6)" rx={1} />
        <rect width={40 * hpPct} height={4} fill={friendly ? "#4ade80" : "#ef4444"} rx={1} />
      </g>
      {/* Rage bar */}
      <g transform="translate(-20,23)">
        <rect width={40} height={3} fill="rgba(0,0,0,0.6)" rx={1} />
        <rect width={40 * ragePct} height={3} fill="#ff6a2a" rx={1} />
      </g>
      {unit.items && unit.items.length > 0 && (
        <g transform="translate(-18,28)">
          {unit.items.slice(0, 3).map((it, i) => {
            const item = ITEMS[it];
            return (
              <g key={i} transform={`translate(${i * 11},0)`}>
                <rect width={9} height={9} fill="#1a1814" stroke="#ff6a2a" strokeWidth={0.5} rx={1} />
                <text x={4.5} y={7} textAnchor="middle" fontSize="6" fill="#ff6a2a" fontFamily="JetBrains Mono">
                  {item?.glyph ?? "?"}
                </text>
              </g>
            );
          })}
        </g>
      )}
    </g>
  );
}

interface HexBoardProps {
  rows?: number;
  cols?: number;
  board?: BoardUnit[];
  side?: "mine" | "enemy" | "other";
  highlightedCells?: Set<string>;
  onCellEnter?: (q: number, r: number) => void;
  onCellClick?: (q: number, r: number) => void;
  hoveredUid?: string | null;
  setHoveredUid?: (uid: string | null) => void;
  raging?: Set<string>;
}

export function HexBoard({
  rows = 4,
  cols = 7,
  board = [],
  side = "mine",
  highlightedCells = new Set<string>(),
  onCellEnter,
  onCellClick,
  setHoveredUid,
  raging = new Set<string>(),
}: HexBoardProps) {
  const cells: { q: number; r: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let q = 0; q < cols; q++) {
      cells.push({ q, r });
    }
  }

  const lastQ = cols - 1;
  const lastR = rows - 1;
  const minX = -HEX_W / 2;
  const maxX = hexToPx(lastQ, 1).x + HEX_W / 2;
  const minY = -HEX_SIZE - 4;
  const maxY = hexToPx(0, lastR).y + HEX_SIZE + 4;
  const w = maxX - minX;
  const h = maxY - minY;

  return (
    <svg
      viewBox={`${minX} ${minY} ${w} ${h}`}
      style={{ width: "100%", height: "100%", display: "block" }}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <pattern id="asphalt" patternUnits="userSpaceOnUse" width="120" height="120">
          <rect width="120" height="120" fill="#161412" />
          <circle cx="20" cy="30" r="0.6" fill="#332f28" />
          <circle cx="80" cy="60" r="0.5" fill="#2a2722" />
          <circle cx="50" cy="90" r="0.4" fill="#332f28" />
          <circle cx="100" cy="20" r="0.5" fill="#2a2722" />
        </pattern>
      </defs>
      {cells.map(({ q, r }) => {
        const { x, y } = hexToPx(q, r);
        const cellId = `${q},${r}`;
        const highlighted = highlightedCells.has(cellId);
        return (
          <HexShape
            key={cellId}
            x={x}
            y={y}
            fill={highlighted ? "rgba(255, 106, 42, 0.18)" : "rgba(20,18,16,0.55)"}
            stroke={highlighted ? "#ff6a2a" : "rgba(255,255,255,0.06)"}
            strokeWidth={highlighted ? 1.5 : 1}
            dashed={!highlighted}
            onMouseEnter={onCellEnter ? () => onCellEnter(q, r) : undefined}
            onClick={onCellClick ? () => onCellClick(q, r) : undefined}
          />
        );
      })}
      {board.map((u) => {
        const { x, y } = hexToPx(u.q, u.r);
        return (
          <g key={u.uid} transform={`translate(${x},${y})`}>
            <HexUnit
              unit={u}
              friendly={side === "mine"}
              onHover={() => setHoveredUid?.(u.uid)}
              onLeave={() => setHoveredUid?.(null)}
              raging={raging.has(u.uid)}
            />
          </g>
        );
      })}
    </svg>
  );
}
