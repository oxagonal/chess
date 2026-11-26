/**
 * Game review: given an engine evaluation for every position of a game, find the moves that lost
 * the most winning chances — the "computer swings" — classed like Lichess does.
 */
import { playUci, startPos, type Color } from './chess';
import { lineWins } from './lineGain';
import type { Position } from 'chessops/chess';

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
  /**
   * second[i] = the evaluation of the engine's second-best move in position i (White's view), when it
   * looked at two (reviews since missed tactics): an only move stands out from it.
   */
  second?: (Score | null)[];
  /**
   * lines[i] = the engine's best line in position i (its first moves, standard UCI), when kept
   * (reviews since tactics are told from positional moves): does it win something?
   */
  lines?: (string[] | null)[];
  /** false while the analysis is still running (or was interrupted): evals cover only the start. */
  complete?: boolean;
  /**
   * played[i] = the move played in position i (standard UCI) — attached when the review is shown, not
   * stored: the engine's own best move is never a mistake, whatever a deeper (or shallower) look at
   * the next position says.
   */
  played?: (string | null)[];
}

export type Judgement = 'inaccuracy' | 'mistake' | 'blunder';

export interface Swing {
  /** Index of the move in the game (0 = White's first move). */
  ply: number;
  mover: Color;
  /** Win chance (0–100, White's view) before and after the move — what judges it. */
  before: number;
  after: number;
  /** The engine's evaluation before and after the move (White's view) — what's shown. */
  scoreBefore: Score;
  scoreAfter: Score;
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
    const drop = mover === 'white' ? before - after : after - before;
    // The engine's best move loses nothing: a drop is just two searches disagreeing (the Stockfish
    // box went deeper before the move than the review did after it, say).
    const best = review.best[ply];
    const loss = best && review.played?.[ply] === best ? Math.min(0, drop) : drop;
    out.push({ ply, mover, before, after, scoreBefore: a, scoreAfter: b, loss, judgement: judge(loss), best: review.best[ply] ?? undefined });
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

/** The live engine's evaluation of one of the game's positions (as you went through it with Stockfish on). */
export interface LiveEval extends Score {
  depth: number;
  /** Its best move (standard UCI). */
  best?: string;
  /** Its second-best move's evaluation (the Stockfish box shows several lines). */
  second?: Score;
  /** Its best line's first moves. */
  line?: string[];
}

/**
 * The computer review with what the live engine found as you went through the game: in each position,
 * whichever looked deeper — so the move list, the judgements and the mistakes match the Stockfish box
 * once it has gone further than the review did. Without a computer review, just the live evaluations
 * (positions you haven't looked at stay empty). `positions`: the game's positions (moves + 1).
 */
export function withLiveEvals(
  review: GameReview | undefined,
  live: Record<string, LiveEval> | undefined,
  positions: number,
  /** The game's moves (standard UCI): judged knowing which were the engine's own. */
  played?: readonly string[],
  /** Best lines worked out on their own (a review from before lines were kept), by position. */
  extraLines?: Record<string, string[]>,
): GameReview | undefined {
  const keys = live ? Object.keys(live) : [];
  const extra = extraLines && Object.keys(extraLines).length ? extraLines : undefined;
  if (!keys.length && !extra) return review && played ? { ...review, played: [...played] } : review;
  const evals: (Score | null)[] = Array.from({ length: Math.max(positions, review?.evals.length ?? 0) }, (_, i) => review?.evals[i] ?? null);
  const best: (string | null)[] = evals.map((_, i) => review?.best[i] ?? null);
  const second: (Score | null)[] = evals.map((_, i) => review?.second?.[i] ?? null);
  const lines: (string[] | null)[] = evals.map((_, i) => review?.lines?.[i] ?? null);
  for (const k of keys) {
    const i = Number(k);
    const l = live![k];
    if (!(i >= 0 && i < evals.length)) continue;
    if (evals[i] && review && review.depth >= l.depth) continue;
    evals[i] = { cp: l.cp, mate: l.mate };
    if (l.best) best[i] = l.best;
    second[i] = l.second ?? null;
    lines[i] = l.line ?? (l.best && l.best === review?.best[i] ? lines[i] : null);
  }
  // A line worked out on its own is for the best move it starts with.
  for (const [k, line] of Object.entries(extra ?? {})) {
    const i = Number(k);
    if (i >= 0 && i < lines.length && !lines[i] && line[0] && line[0] === best[i]) lines[i] = line;
  }
  // Trailing positions nobody has looked at aren't part of an interrupted review.
  let n = evals.length;
  while (n > 0 && !evals[n - 1]) n--;
  return {
    depth: review?.depth ?? 0,
    analyzedAt: review?.analyzedAt ?? 0,
    evals: evals.slice(0, Math.max(n, review?.evals.length ?? 0)),
    best: best.slice(0, Math.max(n, review?.evals.length ?? 0)),
    ...(second.some(Boolean) ? { second: second.slice(0, Math.max(n, review?.evals.length ?? 0)) } : {}),
    ...(lines.some(Boolean) ? { lines: lines.slice(0, Math.max(n, review?.evals.length ?? 0)) } : {}),
    ...(review?.complete === false ? { complete: false } : {}),
    ...(played ? { played: [...played] } : {}),
  };
}

/** A score as the win chance (0–100) of `side`. */
export function winFor(s: Score, side: Color): number {
  const w = winChanceOf(s);
  return side === 'white' ? w : 100 - w;
}

/** How far the best move stands above the second-best (win chance of the side to move), if known. */
export function onlyMoveGap(review: GameReview, ply: number): number | undefined {
  const best = review.evals[ply];
  const second = review.second?.[ply];
  if (!best || !second) return undefined;
  const side: Color = ply % 2 === 0 ? 'white' : 'black';
  return winFor(best, side) - winFor(second, side);
}

/** The best move stands out this much (win chance) from the second-best: there was one move to find. */
export const ONLY_MOVE_GAP = 10;
/** A missed tactic: best play gave the side to move at least this win chance… */
export const TACTIC_WIN = 70;
/** …and the move played lost at least this much of it. */
export const TACTIC_LOSS = 15;

export interface MissedTactic {
  ply: number;
  mover: Color;
  /** The move that was there (standard UCI). */
  best: string;
  /** Win chance (of the mover) with it, and after the move played. */
  withBest: number;
  played: number;
  /** How far it stood out from the second-best move, when known. */
  gap?: number;
  /**
   * A tactic: the engine's line mates or wins material it keeps (lineWins). false: a strong move
   * all the same, but positional (10.h4 wrecking the pawns); undefined: its line isn't known yet.
   */
  tactic?: boolean;
}

/**
 * Missed tactics: positions where the side to move had a strong move (best play gives them at least
 * TACTIC_WIN) that stood out (ONLY_MOVE_GAP above the second-best, when that's known) and played
 * something else that lost at least TACTIC_LOSS of it — a win not taken, a blunder not punished.
 */
export function missedTactics(review: GameReview, ucis: readonly string[]): MissedTactic[] {
  const out: MissedTactic[] = [];
  for (let ply = 0; ply + 1 < review.evals.length && ply < ucis.length; ply++) {
    const before = review.evals[ply];
    const after = review.evals[ply + 1];
    const best = review.best[ply];
    if (!before || !after || !best || best === ucis[ply]) continue;
    const mover: Color = ply % 2 === 0 ? 'white' : 'black';
    const withBest = winFor(before, mover);
    const played = winFor(after, mover);
    const gap = onlyMoveGap(review, ply);
    if (withBest < TACTIC_WIN || withBest - played < TACTIC_LOSS || (gap !== undefined && gap < ONLY_MOVE_GAP)) continue;
    const line = review.lines?.[ply];
    const at = line ? positionAt(ucis, ply) : undefined;
    const tactic = line && at ? lineWins(at, line) : undefined;
    out.push({ ply, mover, best, withBest, played, ...(gap !== undefined ? { gap } : {}), ...(tactic !== undefined ? { tactic } : {}) });
  }
  return out;
}

/** The position before move `ply` of a game given as standard UCI moves. */
function positionAt(ucis: readonly string[], ply: number): Position | undefined {
  let pos: Position = startPos();
  for (let i = 0; i < ply; i++) {
    const r = playUci(pos, ucis[i]);
    if (!r) return undefined;
    pos = r.pos;
  }
  return pos;
}
