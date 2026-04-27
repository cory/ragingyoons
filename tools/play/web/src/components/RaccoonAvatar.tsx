// Procedurally drawn raccoon avatar — placeholder until the real
// 3D character renderer lands. Reads role for shape (tank=big,
// archer=tiny, infantry=narrow+tall, cavalry=tall+wider) and tints
// the eye glow by environment.
import { archByid, ENVIRONMENTS, ROLES, CURIOSITIES } from "../data";
import type { RoleId } from "../types";

interface Props {
  archetype: string;
  size?: number;
  raging?: boolean;
}

const SHAPES: Record<RoleId, { w: number; h: number; ears: number; eyeY: number }> = {
  tank:     { w: 0.92, h: 0.78, ears: 0.18, eyeY: 0.46 },
  infantry: { w: 0.62, h: 0.92, ears: 0.22, eyeY: 0.42 },
  archer:   { w: 0.56, h: 0.62, ears: 0.26, eyeY: 0.48 },
  cavalry:  { w: 0.86, h: 0.88, ears: 0.20, eyeY: 0.44 },
};

export function RaccoonAvatar({ archetype, size = 56, raging = false }: Props) {
  const a = archByid(archetype);
  if (!a) return null;
  const env = ENVIRONMENTS[a.env];
  const role = ROLES[a.role];
  const cur = CURIOSITIES[a.cur];
  const shape = SHAPES[a.role];

  const pad = (1 - shape.w) / 2;
  const padT = (1 - shape.h) / 2 + 0.06;
  const fur = "#2a2820";
  const lightFur = "#4a4638";
  const mask = "#0a0908";
  const eye = raging ? "#ff3a2a" : env.color;
  const nose = "#1a1814";

  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ display: "block", overflow: "visible" }}>
      {/* ears */}
      <ellipse cx={pad * 100 + 10} cy={padT * 100 + 4} rx={shape.ears * 50} ry={shape.ears * 60} fill={fur} />
      <ellipse cx={(1 - pad) * 100 - 10} cy={padT * 100 + 4} rx={shape.ears * 50} ry={shape.ears * 60} fill={fur} />
      <ellipse cx={pad * 100 + 10} cy={padT * 100 + 7} rx={shape.ears * 30} ry={shape.ears * 36} fill="#5a3030" />
      <ellipse cx={(1 - pad) * 100 - 10} cy={padT * 100 + 7} rx={shape.ears * 30} ry={shape.ears * 36} fill="#5a3030" />
      {/* head */}
      <ellipse cx={50} cy={50 + (shape.h - 0.78) * 10} rx={shape.w * 50} ry={shape.h * 50} fill={fur} />
      {/* light fur snout */}
      <ellipse cx={50} cy={62} rx={shape.w * 28} ry={shape.h * 22} fill={lightFur} />
      {/* mask band */}
      <path
        d={`M ${pad * 100 + 6} ${shape.eyeY * 100}
            Q 50 ${shape.eyeY * 100 - 10} ${(1 - pad) * 100 - 6} ${shape.eyeY * 100}
            L ${(1 - pad) * 100 - 4} ${shape.eyeY * 100 + 16}
            Q 50 ${shape.eyeY * 100 + 26} ${pad * 100 + 4} ${shape.eyeY * 100 + 16} Z`}
        fill={mask}
      />
      {/* eyes */}
      <circle cx={36} cy={shape.eyeY * 100 + 6} r={4} fill={eye} />
      <circle cx={64} cy={shape.eyeY * 100 + 6} r={4} fill={eye} />
      <circle cx={36} cy={shape.eyeY * 100 + 6} r={1.4} fill="#000" />
      <circle cx={64} cy={shape.eyeY * 100 + 6} r={1.4} fill="#000" />
      {/* nose */}
      <ellipse cx={50} cy={70} rx={3} ry={2.2} fill={nose} />
      {/* fangs when raging */}
      {raging && (
        <g>
          <path d="M 46 73 L 47.5 79 L 49 73 Z" fill="#fff" />
          <path d="M 51 73 L 52.5 79 L 54 73 Z" fill="#fff" />
        </g>
      )}
      {/* item glyph */}
      <text x={50} y={94} textAnchor="middle" fontSize="10" fontFamily="JetBrains Mono, monospace" fill={role.color} opacity="0.85">
        {cur.glyph}
      </text>
    </svg>
  );
}
