/**
 * Lichess puzzles (the Puzzles tab): setting one up on a board and judging the moves you play.
 * A puzzle comes with the game it's from, up to and including the opponent's move that sets it up,
 * and its solution in UCI — your moves and the opponent's replies, alternating, yours first.
 * Pure: no DOM, no database (the Lichess calls are services/puzzles).
 */
import type { Chess } from 'chessops/chess';
import { playSan, playUci, startPos, type Color } from './chess';
import { tokenizeMoveText } from './pgn';

/** A puzzle as the Lichess API sends it (/api/puzzle/batch/{angle}, /api/puzzle/daily). */
export interface LichessPuzzle {
  game: { id: string; pgn: string; players?: { name?: string; color: Color; rating?: number }[] };
  puzzle: { id: string; rating: number; plays?: number; solution: string[]; themes: string[]; initialPly: number };
}

export interface PuzzleStart {
  /** The position you solve from (after the opponent's move). */
  pos: Chess;
  /** The side you play. */
  color: Color;
  /** The opponent's move that set the puzzle up (UCI), to show as the last move. */
  lastMove?: string;
  /** The position before it, to show that move being played. */
  before: Chess;
}

/** The puzzle's start: its game replayed up to the opponent's last move. Undefined if the moves don't play. */
export function puzzleStart(p: LichessPuzzle): PuzzleStart | undefined {
  const sans = tokenizeMoveText(p.game.pgn).slice(0, p.puzzle.initialPly + 1);
  let pos = startPos();
  let before = pos;
  let lastMove: string | undefined;
  for (const san of sans) {
    const r = playSan(pos, san);
    if (!r) return undefined;
    before = pos;
    pos = r.pos;
    lastMove = r.uci;
  }
  return { pos, color: pos.turn, lastMove, before };
}

export type Verdict = 'right' | 'wrong' | 'solved';

/**
 * Your move at `step` of the solution (an even index: yours): right, solved (the last one), or wrong.
 * As on Lichess, any move that mates is right too, even if the solution has another.
 */
export function judgeMove(pos: Chess, solution: readonly string[], step: number, uci: string): Verdict {
  const played = playUci(pos, uci);
  if (!played) return 'wrong';
  const expected = solution[step] ? playUci(pos, solution[step]) : undefined;
  const mates = played.pos.isCheckmate();
  if ((expected && played.uci === expected.uci) || mates) return mates || step + 1 >= solution.length ? 'solved' : 'right';
  return 'wrong';
}

/**
 * Lichess's key for puzzles from an opening, from its name: "Sicilian Defense: Najdorf Variation" →
 * Sicilian_Defense_Najdorf_Variation, "Queen's Gambit Accepted" → Queens_Gambit_Accepted.
 */
export function openingAngle(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/'/g, '')
    .replace(/[^A-Za-z0-9-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** The puzzle themes offered to pick from (Lichess's keys), with names. */
export const PUZZLE_THEMES: [string, string][] = [
  ['mix', 'Healthy mix'],
  ['opening', 'Opening'],
  ['middlegame', 'Middlegame'],
  ['endgame', 'Endgame'],
  ['short', 'Short (2 moves)'],
  ['long', 'Long (3+ moves)'],
  ['mateIn1', 'Mate in 1'],
  ['mateIn2', 'Mate in 2'],
  ['mateIn3', 'Mate in 3'],
  ['fork', 'Fork'],
  ['pin', 'Pin'],
  ['skewer', 'Skewer'],
  ['discoveredAttack', 'Discovered attack'],
  ['doubleCheck', 'Double check'],
  ['sacrifice', 'Sacrifice'],
  ['deflection', 'Deflection'],
  ['attraction', 'Attraction'],
  ['hangingPiece', 'Hanging piece'],
  ['trappedPiece', 'Trapped piece'],
  ['kingsideAttack', 'Kingside attack'],
  ['defensiveMove', 'Defensive move'],
  ['quietMove', 'Quiet move'],
  ['zugzwang', 'Zugzwang'],
  ['rookEndgame', 'Rook endgame'],
  ['pawnEndgame', 'Pawn endgame'],
];

export const PUZZLE_DIFFICULTIES = ['easiest', 'easier', 'normal', 'harder', 'hardest'] as const;
export type PuzzleDifficulty = (typeof PUZZLE_DIFFICULTIES)[number];
