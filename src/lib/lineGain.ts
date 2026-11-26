/**
 * Does an engine line win something — a mate, or material it keeps — and how far must it go to show
 * it? A tactic's line does (33.Rxg7+ Kxg7 34.Bc3+ Kg6 35.Bxb2); a strong positional move's (10.h4,
 * wrecking the pawns) doesn't, however big the evaluation. Pure.
 */
import type { Position } from 'chessops/chess';
import { playUci, type Color } from './chess';
import { materialBalance } from './material';

/** Points `side` is ahead (behind: negative). */
function pointsFor(pos: Position, side: Color): number {
  const m = materialBalance(pos);
  return side === 'white' ? m.white.plus - m.black.plus : m.black.plus - m.white.plus;
}

/** What a card's line must win (points), and keep after the reply, before it ends. */
export const LINE_GAIN = 2;
/** The longest line a card asks for (plies: 6 of your moves). */
export const LINE_MAX_PLIES = 11;

/**
 * The moves a card asks for, from the engine's line `pv` (standard UCI, starting with the solver's
 * move): through the solver's move that mates, or after which they're LINE_GAIN points up on the start
 * and still are after the reply. A sacrifice's whole point — 33.Rxg7+ Kxg7 34.Bc3+ Kg6 35.Bxb2 — not
 * just its first move. A line that wins nothing that soon (a quiet best move): only its first move.
 */
export function solutionLine(start: Position, pv: readonly string[]): string[] {
  const side = start.turn;
  const base = pointsFor(start, side);
  let pos = start;
  const out: string[] = [];
  for (let i = 0; i < pv.length && i < LINE_MAX_PLIES; i++) {
    const r = playUci(pos, pv[i]);
    if (!r) break;
    out.push(r.uci);
    pos = r.pos;
    if (i % 2) continue;
    if (pos.isCheckmate()) return out;
    const reply = pv[i + 1] ? playUci(pos, pv[i + 1]) : undefined;
    if (pointsFor(reply?.pos ?? pos, side) - base >= LINE_GAIN) return out;
  }
  return out.slice(0, 1);
}


/** The line mates, or wins LINE_GAIN points and keeps them, within LINE_MAX_PLIES: a tactic. */
export function lineWins(start: Position, pv: readonly string[]): boolean {
  let pos = start;
  const side = start.turn;
  for (let i = 0; i < pv.length && i < LINE_MAX_PLIES; i++) {
    const r = playUci(pos, pv[i]);
    if (!r) return false;
    pos = r.pos;
    if (i % 2) continue;
    if (pos.isCheckmate()) return true;
    const reply = pv[i + 1] ? playUci(pos, pv[i + 1]) : undefined;
    if (pointsFor(reply?.pos ?? pos, side) - pointsFor(start, side) >= LINE_GAIN) return true;
  }
  return false;
}
