import React from "react";

/** Number input that lets the user fully clear the field while typing.
 *  Plain `<input type="number" value={n} onChange={Number(e.target.value)}>`
 *  snaps an empty string to 0, which makes it impossible to e.g. delete
 *  "30" and type "5" — the field jumps to 0 the moment you backspace
 *  the second digit. We hold the live text in local state, only push a
 *  parsed number up when it parses, and restore from `value` on blur if
 *  the user left the field empty or invalid. */
export function NumField(props: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  /** Integer-only. Floors on parse. */
  int?: boolean;
  step?: number;
  style?: React.CSSProperties;
  className?: string;
  disabled?: boolean;
}) {
  const { value, onChange, min, max, int, step, style, className, disabled } = props;
  const [text, setText] = React.useState<string>(String(value));

  // Sync from external value changes (e.g. parent reset) when not focused.
  // While focused, the user's text wins until blur.
  const focused = React.useRef(false);
  React.useEffect(() => {
    if (!focused.current && Number(text) !== value) setText(String(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  function clamp(n: number): number {
    if (int) n = Math.floor(n);
    if (typeof min === "number") n = Math.max(min, n);
    if (typeof max === "number") n = Math.min(max, n);
    return n;
  }

  return (
    <input
      type="number"
      value={text}
      step={step}
      disabled={disabled}
      onFocus={() => { focused.current = true; }}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        if (t === "" || t === "-") return; // mid-edit — don't push yet
        const n = Number(t);
        if (Number.isFinite(n)) onChange(clamp(n));
      }}
      onBlur={() => {
        focused.current = false;
        const n = Number(text);
        if (text === "" || !Number.isFinite(n)) {
          setText(String(value)); // revert
          return;
        }
        const c = clamp(n);
        setText(String(c));
        if (c !== value) onChange(c);
      }}
      style={style}
      className={className}
    />
  );
}
