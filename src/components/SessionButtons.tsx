import { navigate } from '../router';

/** Past today's new-move limit, Learn takes another batch of this many. */
export const EXTRA_BATCH = 10;

const isGroup = (rep: string) => rep === 'all' || rep === 'white' || rep === 'black' || rep.startsWith('set:');

/** Start a session of a scope: review what's due, learn new moves (today's share, or a batch more). */
export function startSession(rep: string, mode: 'review' | 'learn', extra?: number) {
  navigate('train', { rep, mode, extra: extra ? String(extra) : undefined, t: String(Date.now()) });
}

/**
 * Review and Learn for a scope (`rep`: 'all', a color, `set:<id>` or a chapter). `due`, `unlearned`:
 * its counts (db/training); `fresh`: the new moves today's limit still allows. Learn is never greyed
 * out: past the limit it learns another batch anyway, and with every move learned it opens the
 * builder to add more. `compact`: only the buttons that do something, smaller (a chapter's row).
 */
export function SessionButtons({ rep, due, fresh, unlearned, compact = false }: { rep: string; due: number; fresh: number; unlearned: number; compact?: boolean }) {
  const learn = () => {
    if (fresh) startSession(rep, 'learn');
    else if (unlearned) startSession(rep, 'learn', EXTRA_BATCH);
    else navigate(isGroup(rep) ? 'repertoire' : `repertoire/${rep}`);
  };
  const learnLabel = fresh ? `Learn ${fresh}` : unlearned ? `Learn ${Math.min(EXTRA_BATCH, unlearned)} more` : 'Learn';
  const learnTitle = fresh ? undefined : unlearned ? 'Today’s new-move limit is reached — learn more anyway' : 'Every move is learned — add new moves in the builder';
  if (compact)
    return (
      <span className="row session-buttons-compact">
        {due > 0 && (
          <button className="primary small" onClick={() => startSession(rep, 'review')}>
            Review {due}
          </button>
        )}
        {unlearned > 0 && (
          <button className="blue small" onClick={learn} title={learnTitle}>
            {learnLabel}
          </button>
        )}
      </span>
    );
  return (
    <div className="list-buttons">
      <button className="primary small" disabled={!due} onClick={() => startSession(rep, 'review')}>
        Review {due || ''}
      </button>
      <button className="blue small" onClick={learn} title={learnTitle}>
        {learnLabel}
      </button>
    </div>
  );
}
