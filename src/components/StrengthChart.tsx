import { useEffect, useRef, useState } from 'react';
import { STRENGTH_LABEL, type Strength } from '../lib/map';

/** Bottom to top: solid at the base, lapsed on top (lines you haven't learned aren't in rotation yet). */
const STACK: Strength[] = ['solid', 'growing', 'learning', 'lapsed'];
const H = 170;
const PAD = { top: 10, right: 8, bottom: 22, left: 30 };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const fmtDay = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Lines in rotation by strength, one point per day: a stacked area with a hover crosshair. */
export function StrengthChart({ data }: { data: { day: number; counts: Record<Strength, number> }[] }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = data.length;
  const totals = data.map((d) => STACK.reduce((a, s) => a + d.counts[s], 0));
  const max = Math.max(4, ...totals);
  const step = max <= 8 ? 2 : max <= 20 ? 5 : max <= 60 ? 10 : max <= 150 ? 25 : 50;
  const top = Math.ceil(max / step) * step;
  const iw = width - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => PAD.top + ih - (v / top) * ih;

  // Cumulative band edges.
  const lower = data.map(() => 0);
  const bands = STACK.map((s) => {
    const lo = [...lower];
    const hi = data.map((d, i) => (lower[i] += d.counts[s]));
    const path =
      `M${x(0)},${y(hi[0])}` +
      hi.map((v, i) => `L${x(i)},${y(v)}`).join('') +
      lo
        .map((v, i) => [i, v] as const)
        .reverse()
        .map(([i, v]) => `L${x(i)},${y(v)}`)
        .join('') +
      'Z';
    const edge = hi.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('');
    return { s, path, edge };
  });
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const h = hover !== null ? data[hover] : undefined;

  return (
    <div className="strength-chart" ref={box}>
      <svg width={width} height={H} role="img" aria-label="Lines in rotation by strength over the last 30 days">
        <defs>
          <pattern id="sc-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--str-lapsed)" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--panel)" strokeWidth="2" />
          </pattern>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="sc-grid" />
            <text x={PAD.left - 6} y={y(t)} className="sc-axis" textAnchor="end" dominantBaseline="middle">
              {t}
            </text>
          </g>
        ))}
        {bands.map((b) => (
          <path key={b.s} d={b.path} fill={b.s === 'lapsed' ? 'url(#sc-hatch)' : `var(--str-${b.s})`} />
        ))}
        {/* 2px surface gap between the bands. */}
        {bands.map((b) => (
          <path key={`e${b.s}`} d={b.edge} fill="none" stroke="var(--panel)" strokeWidth="2" />
        ))}
        {n > 0 &&
          [0, Math.floor((n - 1) / 2), n - 1].map((i) => (
            <text key={i} x={x(i)} y={H - 6} className="sc-axis" textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
              {fmtDay(data[i].day)}
            </text>
          ))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + ih} className="sc-cross" />}
        <rect
          x={PAD.left}
          y={PAD.top}
          width={iw}
          height={ih}
          fill="transparent"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {h && hover !== null && (
        <div className="sc-tip" style={{ left: Math.min(Math.max(x(hover) + 10, 0), width - 150) }}>
          <b>{fmtDay(h.day)}</b>
          {[...STACK].reverse().map((s) => (
            <div key={s} className="sc-tip-row">
              <span className={`str-swatch str-${s}`} />
              <span>{STRENGTH_LABEL[s]}</span>
              <span className="spacer" />
              <b>{h.counts[s]}</b>
            </div>
          ))}
          <div className="sc-tip-row muted">
            <span>Not learned</span>
            <span className="spacer" />
            <span>{h.counts.new}</span>
          </div>
        </div>
      )}
    </div>
  );
}
