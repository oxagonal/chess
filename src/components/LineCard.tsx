import type { ReactNode } from 'react';
import { compactLine, type Color } from '../lib/chess';
import { STRENGTH_LABEL, type MapLine } from '../lib/map';
import { formatInterval } from '../lib/srs';
import { MiniBoard } from './MiniBoard';

const HOUR = 3_600_000;

/** Where a line stands: not learned, due (or overdue), or when it's next due. */
export function lineStatus(line: MapLine, now = Date.now()): string {
  if (line.strength === 'new' && !line.due) return 'Not learned';
  if (line.due) return line.overdueDays > 0 ? `Overdue ${line.overdueDays}d` : 'Due today';
  const next = line.cards.filter((c) => c.state !== 0).reduce((a, c) => Math.min(a, c.due), Infinity);
  return Number.isFinite(next) ? `Due in ${formatInterval(next - now)}` : '—';
}

/**
 * One line at a glance: its moves, the position it ends in, and how well you know it (its weakest
 * move). Used in the map's hover card and at the end of a training session.
 */
export function LineCard({ eyebrow, title, line, color, actions, className = '' }: { eyebrow: ReactNode; title: ReactNode; line: MapLine; color: Color; actions?: ReactNode; className?: string }) {
  const end = line.path[line.path.length - 1];
  return (
    <div className={`line-card ${className}`}>
      <div className="map-eyebrow">{eyebrow}</div>
      <div className="map-pop-title">{title}</div>
      <div className="map-pop-moves">{compactLine(line.path.map((m) => m.san))}</div>
      <div className="map-pop-body">
        <MiniBoard fen={end.toKey} orientation={color} size={148} />
        <dl className="map-pop-stats">
          <dt>Strength</dt>
          <dd>
            <span className={`str-swatch str-${line.strength}`} /> {STRENGTH_LABEL[line.strength]}
          </dd>
          <dt>Interval</dt>
          <dd>{line.interval !== undefined ? formatInterval(Math.max(HOUR, line.interval)) : '—'}</dd>
          <dt>Status</dt>
          <dd className={line.due ? 'warn' : ''}>{lineStatus(line)}</dd>
          <dt>Reviews</dt>
          <dd>{line.reviews}</dd>
          <dt>Length</dt>
          <dd>{Math.ceil(line.path.length / 2)} moves</dd>
        </dl>
      </div>
      {actions && <div className="row map-pop-actions">{actions}</div>}
    </div>
  );
}
