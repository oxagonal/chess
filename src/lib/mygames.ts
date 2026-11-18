import { playSan, posFromFen, START_KEY, startPos, type Color } from './chess';
import type { Position } from 'chessops/chess';
import { SquareSet } from 'chessops/squareSet';
import type { MoveStat, PositionStats, StoredGame } from './types';

/** How deep into each game the explorers built from games look. */
export const EXPLORER_PLIES = 40;

/**
 * The moves by which a game reaches position `key` — and, given `san`, goes on with that move there —
 * counted as the explorers count (a move must be played from the position, within the first
 * `maxPly` plies). Undefined if it never does. Lists "the games in this position" behind an explorer.
 */
export function pathToPosition(sans: readonly string[], key: string, san?: string, maxPly = EXPLORER_PLIES): string[] | undefined {
  return positionFinder(key, san, maxPly)(sans);
}

/**
 * pathToPosition for many games: set up once, then call with each game's moves. A game is dropped
 * as soon as it can no longer reach the position (see stillReaches), so most are read only a few
 * moves deep.
 */
export function positionFinder(key: string, san?: string, maxPly = EXPLORER_PLIES): (sans: readonly string[]) => string[] | undefined {
  const target = posFromFen(key);
  if (!target) return () => undefined;
  const reaches = stillReaches(target);
  return (sans) => {
    let pos: Position = startPos();
    let here = START_KEY;
    const path: string[] = [];
    for (let i = 0; i < Math.min(maxPly, sans.length); i++) {
      if (here !== key && !reaches(pos)) return undefined;
      const played = playSan(pos, sans[i]);
      if (!played) return undefined;
      if (here === key && (!san || played.san === san)) return path;
      path.push(played.san);
      pos = played.pos;
      here = played.key;
    }
    return undefined;
  };
}

/**
 * Whether a position can still turn into `target`, by what can't be undone: a pawn that has left its
 * first square never goes back, a captured piece never returns, and castling rights once lost stay
 * lost.
 */
function stillReaches(target: Position): (pos: Position) => boolean {
  const t = target.board;
  const whiteHome = t.pawn.intersect(t.white).intersect(SquareSet.fromRank(1));
  const blackHome = t.pawn.intersect(t.black).intersect(SquareSet.fromRank(6));
  const whites = t.white.size();
  const blacks = t.black.size();
  const rights = target.castles.castlingRights;
  return (pos) => {
    const b = pos.board;
    return (
      b.white.size() >= whites &&
      b.black.size() >= blacks &&
      whiteHome.diff(b.pawn.intersect(b.white)).isEmpty() &&
      blackHome.diff(b.pawn.intersect(b.black)).isEmpty() &&
      rights.diff(pos.castles.castlingRights).isEmpty()
    );
  };
}

/**
 * An opening explorer built from your own games: for every position, which moves were played
 * and how those games ended. Used both as an explorer tab and as a probability source for the
 * "1 in N" analysis (what *your* opponents actually play against you).
 */
export class GameStatsIndex {
  private readonly stats = new Map<string, { total: number; white: number; draws: number; black: number; last: number; moves: Map<string, MoveStat> }>();

  constructor(games: readonly StoredGame[], filter?: { color?: Color }, maxPly = EXPLORER_PLIES) {
    for (const g of games) {
      if (filter?.color && g.userColor !== filter.color) continue;
      const w = g.result === '1-0' ? 1 : 0;
      const b = g.result === '0-1' ? 1 : 0;
      const d = g.result === '1/2-1/2' ? 1 : 0;
      let pos: Position = startPos();
      let key = START_KEY;
      for (let i = 0; i < Math.min(maxPly, g.sans.length); i++) {
        const played = playSan(pos, g.sans[i]);
        if (!played) break;
        let s = this.stats.get(key);
        if (!s) {
          s = { total: 0, white: 0, draws: 0, black: 0, last: 0, moves: new Map() };
          this.stats.set(key, s);
        }
        s.total++;
        s.white += w;
        s.black += b;
        s.draws += d;
        s.last = Math.max(s.last, g.playedAt || 0);
        let ms = s.moves.get(played.san);
        if (!ms) {
          ms = { san: played.san, uci: played.uci, white: 0, draws: 0, black: 0 };
          s.moves.set(played.san, ms);
        }
        ms.white += w;
        ms.black += b;
        ms.draws += d;
        // (0 = undated, e.g. pasted PGN without a date)
        if (g.playedAt) ms.lastPlayed = Math.max(ms.lastPlayed ?? 0, g.playedAt);
        pos = played.pos;
        key = played.key;
      }
    }
  }

  get(key: string): PositionStats | undefined {
    const s = this.stats.get(key);
    if (!s) return undefined;
    const moves = [...s.moves.values()].sort((a, b) => b.white + b.draws + b.black - (a.white + a.draws + a.black));
    return { total: s.total, white: s.white, draws: s.draws, black: s.black, moves, ...(s.last ? { lastPlayed: s.last } : {}) };
  }

  get positions(): number {
    return this.stats.size;
  }
}
