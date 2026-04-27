interface Props {
  tier: number;
}

export function TierDots({ tier }: Props) {
  return (
    <span style={{ display: "inline-flex", gap: 2 }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          style={{
            width: 5,
            height: 5,
            borderRadius: 1,
            background: i < tier ? "var(--accent)" : "rgba(255,255,255,0.12)",
            boxShadow: i < tier ? "0 0 4px var(--accent)" : "none",
          }}
        />
      ))}
    </span>
  );
}
