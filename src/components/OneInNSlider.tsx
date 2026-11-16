import { useEffect, useState } from 'react';
import { ONE_IN_N_MAX, ONE_IN_N_MIN, updateSettings } from '../db/settings';

const STEPS = 1000;

/** Log-scale position (0..STEPS) ↔ N, rounded to 2 significant figures so values stay readable. */
function toN(t: number): number {
  const raw = ONE_IN_N_MIN * Math.pow(ONE_IN_N_MAX / ONE_IN_N_MIN, t / STEPS);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)) - 1);
  return Math.min(ONE_IN_N_MAX, Math.max(ONE_IN_N_MIN, Math.round(raw / mag) * mag));
}
function toT(n: number): number {
  return Math.round((STEPS * Math.log(n / ONE_IN_N_MIN)) / Math.log(ONE_IN_N_MAX / ONE_IN_N_MIN));
}

/**
 * Rough size of a complete repertoire at this depth. Every required line ends at a position reached
 * in ≥ 1/N of games and no two lines can occur in the same game, so there are at most N lines per
 * colour; in practice, with the mass lost to rare moves, about a quarter to a half of that.
 */
export function linesEstimate(n: number): string {
  const lo = Math.round(n / 4);
  const hi = Math.round(n / 2);
  const f = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(x >= 10000 ? 0 : 1)}k` : `${x}`);
  return `≈ ${f(lo)}–${f(hi)} lines per colour`;
}

/** "1 in N games" slider; saves when you let go so coverage doesn't recompute on every pixel. */
export function OneInNSlider({ value, label = 'Study positions seen in at least' }: { value: number; label?: string }) {
  const [t, setT] = useState(toT(value));
  useEffect(() => setT(toT(value)), [value]);
  const n = toN(t);
  const commit = () => {
    if (n !== value) updateSettings({ oneInN: n });
  };
  return (
    <label className="field" style={{ minWidth: 260, flex: 1 }}>
      <span>{label}</span>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input
          type="range"
          min={0}
          max={STEPS}
          value={t}
          onChange={(e) => setT(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          style={{ flex: 1, padding: 0 }}
        />
        <b style={{ color: 'var(--text)', minWidth: 120, textAlign: 'right' }}>1 in {n.toLocaleString()} games</b>
      </div>
      <span className="small" style={{ textTransform: 'none', letterSpacing: 0 }}>
        {linesEstimate(n)}
      </span>
    </label>
  );
}
