import { formatLine } from '../lib/chess';

/**
 * "12 games reached 1. e4 c5 2. Nf3 and went on 2... d6 (any move order)", with a link to every game.
 * `path` is how one of the games got there.
 */
export function PositionFilterNote({ path, move, count, clearHref, whose }: { path?: string[]; move?: string; count: number; clearHref: string; whose?: string }) {
  return (
    <div className="note row position-filter">
      <span style={{ flex: 1, minWidth: 0 }}>
        {whose ? `${count} of ${whose} games` : `${count} game${count === 1 ? '' : 's'}`} reached{' '}
        {path ? <b>{formatLine(path) || 'the starting position'}</b> : 'this position'}
        {move && (
          <>
            {' '}
            and went on <b>{formatLine([move], path?.length ?? 0)}</b>
          </>
        )}
        {path && path.length > 0 && <span className="muted"> (any move order)</span>}
      </span>
      <a className="btn small" href={clearHref}>
        ✕ Show all
      </a>
    </div>
  );
}
