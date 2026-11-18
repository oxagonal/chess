/**
 * Game review: given an engine evaluation for every position of a game, find the moves that lost
 * the most winning chances — the "computer swings" — classed like Lichess does.
 */
import type { Color } from './chess';

/** Engine score, White's point of view. */
export interface Score {
  cp?: number;
  mate?: number;
}

export interface GameReview {
  depth: number;
  analyzedAt: number;
  /** evals[i] = position before move i (evals[n] = final position). null = not evaluated. */
  evals: (Score | null)[];
  /** best[i] = engine's best move in position i (standard UCI). */
  best: (string | null)[];
  /** false while the analysis is still running (or was interrupted): evals cover only the start. */
  complete?: boolean;
}

export type Judgement = 'inaccuracy' | 'mistake' | 'blunder';

export interface Swing {
  /** Index of the move in the game (0 = White's first move). */
  ply: number;
  mover: Color;
  /** Win chance (0–100, White's view) before and after the move. */
  before: number;
  after: number;
  /** Win chance lost by the player who moved. */
  loss: number;
  judgement?: Judgement;
  best?: string;
}

/** A score the way Lichess prints it beside a move: +1.2, −0.4, 0.0, #3, #−2. */
export function formatEvalShort(s: Score): string {
  if (s.mate !== undefined) return `#${s.mate < 0 ? '−' : ''}${Math.abs(s.mate)}`;
  const v = Math.round((s.cp ?? 0) / 10) / 10;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;
}

/** Lichess's win-chance curve, 0–100 for White. */
export function winChanceOf(s: Score): number {
  if (s.mate !== undefined) return s.mate > 0 ? 100 : s.mate < 0 ? 0 : 50;
  const cp = Math.max(-1000, Math.min(1000, s.cp ?? 0));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/** Lichess thresholds (0.1 / 0.2 / 0.3 on its −1…1 scale = 5 / 10 / 15 points here). */
export function judge(loss: number): Judgement | undefined {
  if (loss >= 15) return 'blunder';
  if (loss >= 10) return 'mistake';
  if (loss >= 5) return 'inaccuracy';
  return undefined;
}

export const JUDGEMENT_GLYPH: Record<Judgement, string> = { inaccuracy: '?!', mistake: '?', blunder: '??' };

/** Every move's swing (moves next to an unevaluated position are skipped). */
export function swings(review: GameReview): Swing[] {
  const out: Swing[] = [];
  for (let ply = 0; ply + 1 < review.evals.length; ply++) {
    const a = review.evals[ply];
    const b = review.evals[ply + 1];
    if (!a || !b) continue;
    const before = winChanceOf(a);
    const after = winChanceOf(b);
    const mover: Color = ply % 2 === 0 ? 'white' : 'black';
    const loss = mover === 'white' ? before - after : after - before;
    out.push({ ply, mover, before, after, loss, judgement: judge(loss), best: review.best[ply] ?? undefined });
  }
  return out;
}

/** One side's biggest swings, largest first (only real losses). */
export function biggestSwingsFor(review: GameReview, side: Color, count = 3): Swing[] {
  return swings(review)
    .filter((s) => s.mover === side && s.loss > 1)
    .sort((a, b) => b.loss - a.loss)
    .slice(0, count);
}

/** The biggest swings of the game, largest first (only real losses). */
export function biggestSwings(review: GameReview, count = 3): Swing[] {
  return swings(review)
    .filter((s) => s.loss > 1)
    .sort((a, b) => b.loss - a.loss)
    .slice(0, count);
}
