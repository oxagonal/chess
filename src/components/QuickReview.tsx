import type { ReactNode } from 'react';
import { moveNumberPrefix } from '../lib/chess';
import { clock, crucialThreshold, reviewBudgetMs } from '../lib/quickReview';
import { formatEvalShort, type Swing } from '../lib/review';

/** The review's time against its budget: green, then amber near the end, red when over. */
export function ReviewTimer({ spentMs, timeClass, compact = false }: { spentMs: number; timeClass: string; compact?: boolean }) {
  const budget = reviewBudgetMs(timeClass);
  const state = spentMs > budget ? 'over' : spentMs > budget * 0.8 ? 'near' : 'ok';
  const title = `Time on this review (while it's on screen and you're using it) — ${budget / 60_000} min is plenty for a ${timeClass} game`;
  if (compact)
    return (
      <span className={`review-timer ${state}`} title={title}>
        {clock(spentMs)}
      </span>
    );
  return (
    <span className={`review-timer ${state}`} title={title}>
      ⏱ {clock(spentMs)} <span className="muted">/ {clock(budget)}</span>
    </span>
  );
}

/** Where the game left your prep, in a line: a label, its tone, and what happened. */
export interface PrepSummary {
  label: string;
  tone: 'bad' | 'hint' | 'good';
  text: ReactNode;
  /** Shown while the board is at that move: what to do about it (drill it, prepare an answer, your note). */
  detail?: ReactNode;
}

/**
 * Noël Studer's quick review of a game: where your opening knowledge ended, the crucial moments (the
 * big swings), one takeaway, done — within a few minutes for a fast game. Each step ticks itself off
 * as you do it.
 */
export function QuickReview({
  timeClass,
  spentMs,
  sans,
  prep,
  prepPly,
  atPrep,
  swings,
  visited,
  takeaway,
  done,
  onGo,
}: {
  timeClass: string;
  spentMs: number;
  sans: readonly string[];
  prep: PrepSummary;
  /** Where your prep ended (the move's index), if it did. */
  prepPly?: number;
  /** The board is there now. */
  atPrep: boolean;
  /** The crucial swings; undefined: no computer review yet. */
  swings?: Swing[];
  /** Positions of the game you've been to (move counts). */
  visited: ReadonlySet<number>;
  takeaway: boolean;
  done: boolean;
  onGo: (ply: number) => void;
}) {
  const over = spentMs > reviewBudgetMs(timeClass);
  const moveLabel = (ply: number) => `${moveNumberPrefix(ply, true)}${sans[ply] ?? ''}`;
  const seen = (ply: number) => visited.has(ply) || visited.has(ply + 1);
  const pawns = crucialThreshold(timeClass) / 100;
  return (
    <div className="quick-review col">
      <div className="row">
        <b>Quick review</b>
        <span className="spacer" />
        <ReviewTimer spentMs={spentMs} timeClass={timeClass} />
      </div>
      <ol className="qr-steps">
        <li className={prepPly === undefined || seen(prepPly) ? 'done' : ''}>
          <span className={`qr-chip ${prep.tone}`}>{prep.label}</span>{' '}
          {prepPly !== undefined && (
            <>
              <button className="linklike" onClick={() => onGo(prepPly)} title="Go to the position">
                {moveLabel(prepPly)}
              </button>
              {': '}
            </>
          )}
          {prep.text}
          {atPrep && prep.detail && <div className="qr-detail">{prep.detail}</div>}
        </li>
        <li className={swings && swings.every((s) => seen(s.ply)) ? 'done' : ''}>
          Crucial moments{' '}
          {swings === undefined ? (
            <span className="muted">— run the Computer review to find the big swings</span>
          ) : swings.length === 0 ? (
            <span className="muted">— no swing of {pawns}+ pawns</span>
          ) : (
            <>
              <span className="muted">(swings of {pawns}+ pawns):</span>{' '}
              {swings.map((s, i) => (
                <span key={s.ply}>
                  {i > 0 && ' · '}
                  <button className={`linklike ${seen(s.ply) ? 'qr-seen' : ''}`} onClick={() => onGo(s.ply)} title={`${s.mover === 'white' ? 'White' : 'Black'} to move: what should have been played?`}>
                    {moveLabel(s.ply)} {formatEvalShort(s.scoreAfter)}
                  </button>
                </span>
              ))}
            </>
          )}
        </li>
        <li className={takeaway ? 'done' : ''}>One takeaway, in a sentence (Takeaways)</li>
        <li className={done ? 'done' : ''}>Done reviewing — then on to the next game</li>
      </ol>
      {over && (
        <div className="note warn-note small">
          Over {reviewBudgetMs(timeClass) / 60_000} minutes: write your takeaway and move on — a fast game doesn't need more (Studer reviews 2–6
          games a session).
        </div>
      )}
    </div>
  );
}
