import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ONE_IN_N_MAX, ONE_IN_N_MIN, updateSettings, useSettings } from '../db/settings';
import { getDepthProfile, measureDepth, sourceLabel } from '../services/coverage';
import type { Color } from '../lib/chess';

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

/** "1 in N games" slider; saves when you let go so coverage doesn't recompute on every pixel. */
export function OneInNSlider({ value, label = 'Study positions seen in at least' }: { value: number; label?: string }) {
  const [t, setT] = useState(toT(value));
  useEffect(() => setT(toT(value)), [value]);
  const n = toN(t);
  const commit = () => {
    if (n !== value) updateSettings({ oneInN: n });
  };
  return (
    <div className="field" style={{ minWidth: 280, flex: 1 }}>
      <span>{label}</span>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input
          type="range"
          min={0}
          max={STEPS}
          value={t}
          aria-label="1 in N games"
          onChange={(e) => setT(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          style={{ flex: 1, padding: 0 }}
        />
        <b style={{ color: 'var(--text)', minWidth: 120, textAlign: 'right' }}>1 in {n.toLocaleString()} games</b>
      </div>
      {n === value && <DepthReadout n={n} />}
    </div>
  );
}

/**
 * Measured from the database at your rating: how long lines get before positions become rarer than
 * 1 in N, and how many lines a repertoire needs, if you play the most popular move on your turns.
 */
function DepthReadout({ n }: { n: number }) {
  const settings = useSettings();
  const src = sourceLabel(settings);
  const profiles = useLiveQuery(
    async () => ({ white: await getDepthProfile(settings, 'white', n), black: await getDepthProfile(settings, 'black', n) }),
    [n, src, settings.loaded],
  );
  const [busy, setBusy] = useState<{ color: Color; queried: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);

  const measure = async () => {
    setError(null);
    ctrl.current = new AbortController();
    try {
      for (const color of ['white', 'black'] as Color[]) {
        setBusy({ color, queried: 0 });
        await measureDepth(color, n, { signal: ctrl.current.signal, onProgress: (q) => setBusy({ color, queried: q }) });
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const fmt = (c: Color) => {
    const p = profiles?.[c];
    if (!p) return null;
    return (
      <div key={c}>
        As {c}: <b style={{ color: 'var(--text)' }}>{p.lines.toLocaleString()} lines</b>
        {p.myMoves !== undefined && (
          <>
            , <b style={{ color: 'var(--text)' }}>{p.myMoves.toLocaleString()} moves to learn</b>
          </>
        )}{' '}
        · average {p.avgMoves.toFixed(1)} moves deep, longest {Math.ceil(p.maxMoves)}
      </div>
    );
  };

  // Profiles saved before the move count existed lack it; offer to measure again.
  const have = profiles?.white?.myMoves !== undefined && profiles?.black?.myMoves !== undefined;
  return (
    <div className="small" style={{ textTransform: 'none', letterSpacing: 0, marginTop: 2 }}>
      {fmt('white')}
      {fmt('black')}
      {have && <div>if you play the most popular move on your turns · {src}</div>}
      {!have && !busy && (
        <button className="small" style={{ marginTop: 4 }} onClick={measure} title="Walks the opening database to this depth. The first time can take a few minutes; results are saved.">
          Measure depth at 1 in {n.toLocaleString()}
        </button>
      )}
      {busy && (
        <div className="row" style={{ marginTop: 4 }}>
          <span>
            Measuring as {busy.color}… {busy.queried} positions looked up
          </span>
          <button className="small" onClick={() => ctrl.current?.abort()}>
            Stop
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
