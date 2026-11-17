import { useEffect, useRef, useState, type ReactNode } from 'react';
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
  /** The move's note, shown inline after it like a PGN comment. */
  note?: string;
}

/** Clickable "1. e4 c5 2. Nf3" rendering. `current` = number of plies shown (0 = start). */
export function LineView({
  items,
  current,
  onSelect,
  startPly = 0,
  editor,
}: {
  items: LineItem[];
  current?: number;
  onSelect?: (plies: number) => void;
  startPly?: number;
  /** Rendered after the current move, in place of its note (the builder's inline note editor). */
  editor?: ReactNode;
}) {
  if (!items.length) return <span className="muted">Starting position</span>;
  return (
    <div className="line">
      {items.map((it, i) => {
        const ply = startPly + i;
        // After a note, Black's move gets its number again ("2... Nf6"), as in PGN.
        const prefix = moveNumberPrefix(ply, i === 0 || (!!items[i - 1].note && current !== i));
        const isCurrent = current === i + 1;
        return (
          <span key={i} style={{ display: 'contents' }}>
            {prefix && <span className="num">{prefix}</span>}
            <span className={`mv ${isCurrent ? 'current' : ''} ${it.className ?? ''}`} title={it.title} onClick={() => onSelect?.(i + 1)}>
              {it.san}
            </span>
            {isCurrent && editor
              ? editor
              : it.note && (
                  <span className="mv-note" title="Click to edit" onClick={() => onSelect?.(i + 1)}>
                    {it.note}
                  </span>
                )}
          </span>
        );
      })}
    </div>
  );
}

/** Percentage with more precision for small values: 40.0%, 4.25%, 0.43%. */
export function fmtPct(p: number): string {
  const x = p * 100;
  if (x >= 99.95) return '100%';
  if (x >= 10) return `${x.toFixed(1)}%`;
  if (x >= 1) return `${x.toFixed(2)}%`;
  if (x <= 0) return '0%';
  return `${x.toPrecision(2)}%`;
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

/** Lets a wide table scroll sideways inside its panel instead of widening the whole page (phones). */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="table-wrap">{children}</div>;
}

/** A "⋯" button that opens a small menu of less-used actions. */
export function MoreMenu({ children, label = 'More actions' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className="small menu-trigger" aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open && (
        <div className="menu-pop" role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}
