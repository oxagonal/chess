/**
 * Sharp positions: where only one or two of your moves hold. A quiet position has about three moves
 * the engine rates roughly equal (QUIET_MOVES within EQUAL_MARGIN of the best); with fewer, not
 * knowing the move can lose on the spot — so a line is prepared past the coverage goal until it
 * calms down (see coverage). Pure: the engine lines come from services/engine.
 */
import type { Color } from './chess';

/** A quiet position has at least this many moves roughly as good as the best. */
export const QUIET_MOVES = 3;
/** "Roughly as good": within this many centipawns of the best (0.3 pawns). */
export const EQUAL_MARGIN = 30;

export interface LineEval {
  /** Centipawns, White's point of view. */
  cp?: number;
  /** Mate in N (positive = White mates). */
  mate?: number;
}

/** Better for the side to move = higher; mates beyond any centipawn score. */
function scoreFor(e: LineEval, mover: Color): number {
  const white = e.mate !== undefined ? (e.mate > 0 ? 100000 - e.mate : -100000 - e.mate) : (e.cp ?? 0);
  return mover === 'white' ? white : -white;
}

/**
 * How many of the side to move's moves hold — rated within EQUAL_MARGIN of the best (a little more
 * when the position is already decided: +5 or +4.6 makes no difference). `lines` are the engine's best
 * lines (any order), `legal` how many legal moves there are. Undefined when the lines can't tell: they
 * all hold but there may be more moves that do (fewer lines than QUIET_MOVES).
 */
export function movesThatHold(lines: readonly { eval: LineEval }[], mover: Color, legal: number): number | undefined {
  if (!lines.length || legal <= 0) return undefined;
  const scores = lines.map((l) => scoreFor(l.eval, mover)).sort((a, b) => b - a);
  const best = scores[0];
  const decided = Math.abs(best) >= 300 && Math.abs(best) < 90000;
  const margin = decided ? Math.max(EQUAL_MARGIN, Math.abs(best) * 0.1) : EQUAL_MARGIN;
  const holding = scores.filter((s) => best - s <= margin).length;
  if (holding === scores.length && scores.length < Math.min(QUIET_MOVES, legal)) return undefined;
  return Math.min(holding, legal);
}

/** Sharp: fewer than QUIET_MOVES moves hold. Undefined when the lines can't tell. */
export function isSharp(lines: readonly { eval: LineEval }[], mover: Color, legal: number): boolean | undefined {
  const n = movesThatHold(lines, mover, legal);
  return n === undefined ? undefined : n < QUIET_MOVES;
}
