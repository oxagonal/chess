import type { ReactNode } from 'react';
import type { Color } from '../lib/chess';
import { moveNumberPrefix } from '../lib/chess';

export function ColorPill({ color }: { color: Color }) {
  return <span className={`pill ${color}`}>{color === 'white' ? 'White' : 'Black'}</span>;
}

export function Stat({ value, label, hint }: { value: ReactNode; label: string; hint?: string }) {
  return (
    <div className="stat" title={hint}>
      <div className="v">{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

export function WdlBar({ white, draws, black }: { white: number; draws: number; black: number }) {
  const total = white + draws + black || 1;
  const w = (white / total) * 100;
  const d = (draws / total) * 100;
  const b = (black / total) * 100;
  const label = (x: number) => (x >= 12 ? `${Math.round(x)}%` : '');
  return (
    <div className="wdl" title={`White ${w.toFixed(0)}% · Draw ${d.toFixed(0)}% · Black ${b.toFixed(0)}%`}>
      <div className="w" style={{ width: `${w}%` }}>{label(w)}</div>
      <div className="d" style={{ width: `${d}%` }}>{label(d)}</div>
      <div className="b" style={{ width: `${b}%` }}>{label(b)}</div>
    </div>
  );
}

export interface LineItem {
  san: string;
  className?: string;
  title?: string;
}

/** Clickable "1. e4 c5 2. Nf3" rendering. `current` = number of plies shown (0 = start). */
export function LineView({
  items,
  current,
  onSelect,
  startPly = 0,
}: {
  items: LineItem[];
  current?: number;
  onSelect?: (plies: number) => void;
  startPly?: number;
}) {
  if (!items.length) return <span className="muted">Starting position</span>;
  return (
    <div className="line">
      {items.map((it, i) => {
        const ply = startPly + i;
        const prefix = moveNumberPrefix(ply, i === 0);
        return (
          <span key={i} style={{ display: 'contents' }}>
            {prefix && <span className="num">{prefix}</span>}
            <span
              className={`mv ${current === i + 1 ? 'current' : ''} ${it.className ?? ''}`}
              title={it.title}
              onClick={() => onSelect?.(i + 1)}
            >
              {it.san}
            </span>
          </span>
        );
      })}
    </div>
  );
}

export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function timeAgo(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="progress">
      <div style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
