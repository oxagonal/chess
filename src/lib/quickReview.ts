/**
 * A quick game review, the way Noël Studer does it: where your opening knowledge ended, the crucial
 * mistakes (the big swings — small ones don't matter yet in fast games), one takeaway — and on to the
 * next game: a few minutes for a fast game, not an hour. Pure.
 */
import { swings, type GameReview, type Swing } from './review';

/** How long a review should take, by the game's speed (minutes): 5 for bullet and blitz. */
export const REVIEW_BUDGET_MIN: Record<string, number> = { bullet: 5, blitz: 5, rapid: 15, classical: 30, daily: 30, correspondence: 30 };

export function reviewBudgetMs(timeClass: string): number {
  return (REVIEW_BUDGET_MIN[timeClass] ?? 15) * 60_000;
}

/** A swing worth looking at: the evaluation moves at least this much (centipawns) — 2 pawns in fast games. */
export function crucialThreshold(timeClass: string): number {
  return timeClass === 'bullet' || timeClass === 'blitz' ? 200 : 100;
}

const asCp = (s: { cp?: number; mate?: number }) => (s.mate !== undefined ? (s.mate > 0 ? 1000 : -1000) : Math.max(-1000, Math.min(1000, s.cp ?? 0)));

/** The crucial moments: swings of at least the threshold (either side's), biggest first, a few at most. */
export function crucialSwings(review: GameReview, timeClass: string, count = 4): Swing[] {
  const min = crucialThreshold(timeClass);
  return swings(review)
    .filter((s) => s.loss > 1 && Math.abs(asCp(s.scoreAfter) - asCp(s.scoreBefore)) >= min)
    .sort((a, b) => b.loss - a.loss)
    .slice(0, count)
    .sort((a, b) => a.ply - b.ply);
}

/** "4:05" */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
