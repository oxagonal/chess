/**
 * Thin helpers around chessops so the rest of the app deals in plain strings:
 *  - a "position key" is the first four FEN fields (board, turn, castling, legal ep square).
 *    It identifies a position independent of move order, so transpositions merge.
 *  - moves are identified by SAN within a position, and carried around with a standard UCI
 *    string (castling as e1g1, not chessops' internal king-takes-rook e1h1).
 */
import { Chess, castlingSide, normalizeMove } from 'chessops/chess';
import type { Position } from 'chessops/chess';
import { INITIAL_FEN, makeFen, parseFen } from 'chessops/fen';
import { makeSan, parseSan } from 'chessops/san';
import { kingCastlesTo, makeSquare, makeUci, parseUci } from 'chessops/util';
import { chessgroundDests } from 'chessops/compat';
import type { Move, NormalMove } from 'chessops/types';

export type Color = 'white' | 'black';

export function keyFromFen(fen: string): string {
  return fen.trim().split(/\s+/).slice(0, 4).join(' ');
}

export function keyOf(pos: Position): string {
  return keyFromFen(makeFen(pos.toSetup()));
}

export function fenOf(pos: Position): string {
  return makeFen(pos.toSetup());
}

/** Parse a FEN or a 4-field position key. Returns undefined on invalid input. */
export function posFromFen(fenOrKey: string): Chess | undefined {
  const parts = fenOrKey.trim().split(/\s+/);
  const fen = parts.length === 4 ? `${parts.join(' ')} 0 1` : fenOrKey.trim();
  const setup = parseFen(fen);
  if (setup.isErr) return undefined;
  const pos = Chess.fromSetup(setup.value);
  return pos.isOk ? pos.value : undefined;
}

export function startPos(): Chess {
  return Chess.default();
}

export const START_FEN = INITIAL_FEN;
export const START_KEY = keyFromFen(INITIAL_FEN);

export function turnOfKey(key: string): Color {
  return key.split(' ')[1] === 'b' ? 'black' : 'white';
}

/** Standard UCI (e1g1 for castling) for a legal move in `pos`. */
export function stdUci(pos: Position, move: Move): string {
  if (!('from' in move)) return makeUci(move);
  const side = castlingSide(pos, move);
  if (side) return makeSquare(move.from) + makeSquare(kingCastlesTo(pos.turn, side));
  return makeUci(move);
}

export interface PlayedMove {
  san: string;
  uci: string;
  pos: Chess;
  key: string;
}

function playMove(pos: Position, move: Move): PlayedMove {
  const san = makeSan(pos, move);
  const uci = stdUci(pos, move);
  const next = pos.clone() as Chess;
  next.play(move);
  return { san, uci, pos: next, key: keyOf(next) };
}

/** Play a SAN move (tolerant of missing/extra check markers and annotations). */
export function playSan(pos: Position, san: string): PlayedMove | undefined {
  const cleaned = san.replace(/[!?]+$/g, '').replace(/^\d+\.+/, '').trim();
  const move = parseSan(pos, cleaned);
  if (!move) return undefined;
  return playMove(pos, move);
}

/** Play a UCI move; accepts both e1g1 and e1h1 style castling. */
export function playUci(pos: Position, uci: string): PlayedMove | undefined {
  const raw = parseUci(uci);
  if (!raw) return undefined;
  const move = normalizeMove(pos, raw);
  if (!pos.isLegal(move)) return undefined;
  return playMove(pos, move);
}

/** Canonical SAN of a move given in SAN (normalises check markers etc). */
export function normalizeSan(pos: Position, san: string): string | undefined {
  return playSan(pos, san)?.san;
}

export function legalDests(pos: Position): Map<string, string[]> {
  return chessgroundDests(pos) as Map<string, string[]>;
}

/** True if moving from orig to dest in `pos` is a pawn reaching the last rank. */
export function isPromotion(pos: Position, orig: string, dest: string): boolean {
  const from = parseUci(orig + dest) as NormalMove | undefined;
  if (!from) return false;
  const piece = pos.board.get(from.from);
  if (!piece || piece.role !== 'pawn') return false;
  return dest[1] === '8' || dest[1] === '1';
}

export function sanToUciLine(sans: string[], start: Position = startPos()): string[] | undefined {
  let pos: Position = start;
  const out: string[] = [];
  for (const san of sans) {
    const r = playSan(pos, san);
    if (!r) return undefined;
    out.push(r.uci);
    pos = r.pos;
  }
  return out;
}

/** Ply index (0-based, from the standard start) → "1." / "1..." style prefix. */
export function moveNumberPrefix(ply: number, force = false): string {
  const n = Math.floor(ply / 2) + 1;
  if (ply % 2 === 0) return `${n}.`;
  return force ? `${n}...` : '';
}

/** "1. e4 c5 2. Nf3" style rendering of a SAN sequence. */
export function formatLine(sans: string[], startPly = 0): string {
  const parts: string[] = [];
  sans.forEach((san, i) => {
    const ply = startPly + i;
    const prefix = moveNumberPrefix(ply, i === 0);
    parts.push(prefix ? `${prefix} ${san}` : san);
  });
  return parts.join(' ');
}

/** "1.e4 c5 2.Nf3" — compact, like Lichess writes a line in running text. */
export function compactLine(sans: string[], startPly = 0): string {
  return sans
    .map((san, i) => {
      const prefix = moveNumberPrefix(startPly + i, i === 0);
      return prefix ? `${prefix}${san}` : san;
    })
    .join(' ');
}

/** Square names for chessground lastMove highlighting. */
export function uciSquares(uci: string): [string, string] | undefined {
  if (uci.length < 4) return undefined;
  return [uci.slice(0, 2), uci.slice(2, 4)];
}

export function opposite(color: Color): Color {
  return color === 'white' ? 'black' : 'white';
}

export function isCheck(pos: Position): boolean {
  return pos.isCheck();
}
