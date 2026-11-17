/**
 * Over-the-board games: entered by hand (moves on a board, or pasted PGN) and stored like downloaded
 * games, so they count in prep analysis, Insights and the Players tab. Pure: no DOM, no database.
 */
import { parsePgn, startingPosition } from 'chessops/pgn';
import { playSan, startPos, type Color } from './chess';
import { scoreFor, type TimeClass } from './importers/common';
import type { StoredGame } from './types';

/**
 * Names compared loosely: case, accents, punctuation and word order don't matter, so
 * "Carlsen, Magnus", "magnus carlsen" and "Carlsen Magnus" are the same person.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.,;:'"()_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

export function sameName(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const na = normalizeName(a);
  return na !== '' && na === normalizeName(b);
}

/** "2026.11.15" (PGN) or "2026-11-15" → local noon that day; unknown parts ("????.??.??") → undefined. */
export function parsePgnDate(raw: string | undefined): number | undefined {
  const m = raw?.match(/^(\d{4})[.-](\d{2})[.-](\d{2})$/);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return Number.isNaN(d.getTime()) ? undefined : d.getTime();
}

/** epoch ms → "2026-11-15" (for date inputs) */
export function isoDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Everything needed to save an over-the-board game. */
export interface OtbDraft {
  /** Set when editing an existing game. */
  id?: string;
  sans: string[];
  userColor: Color;
  opponent: string;
  opponentElo?: number;
  myName?: string;
  myElo?: number;
  result: StoredGame['result'];
  playedAt: number;
  event?: string;
  timeClass: TimeClass;
}

export function makeOtbGame(d: OtbDraft, newId: () => string): StoredGame {
  const me = d.myName?.trim() || 'Me';
  const opp = d.opponent.trim() || 'Opponent';
  return {
    id: d.id ?? `otb:${newId()}`,
    source: 'otb',
    account: 'otb',
    url: '',
    white: d.userColor === 'white' ? me : opp,
    black: d.userColor === 'white' ? opp : me,
    whiteElo: d.userColor === 'white' ? d.myElo : d.opponentElo,
    blackElo: d.userColor === 'white' ? d.opponentElo : d.myElo,
    userColor: d.userColor,
    result: d.result,
    userScore: scoreFor(d.result, d.userColor),
    timeClass: d.timeClass,
    rated: true,
    playedAt: d.playedAt,
    sans: d.sans,
    event: d.event?.trim() || undefined,
  };
}

/** A stored over-the-board game back into an editable draft. */
export function draftOf(g: StoredGame): OtbDraft {
  const mine = g.userColor === 'white';
  return {
    id: g.id,
    sans: g.sans,
    userColor: g.userColor,
    opponent: mine ? g.black : g.white,
    opponentElo: mine ? g.blackElo : g.whiteElo,
    myName: mine ? g.white : g.black,
    myElo: mine ? g.whiteElo : g.blackElo,
    result: g.result,
    playedAt: g.playedAt,
    event: g.event,
    timeClass: g.timeClass as TimeClass,
  };
}

/** One game read from PGN text. */
export interface PgnGame {
  white: string;
  black: string;
  whiteElo?: number;
  blackElo?: number;
  result: StoredGame['result'];
  playedAt?: number;
  event?: string;
  sans: string[];
}

const RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '*']);

/** Every standard-start game in the PGN, main line only. Games from a set-up position are skipped. */
export function readPgnGames(pgn: string): { games: PgnGame[]; errors: string[] } {
  const games: PgnGame[] = [];
  const errors: string[] = [];
  parsePgn(pgn).forEach((g, i) => {
    const label = `Game ${i + 1}`;
    const start = startingPosition(g.headers);
    if (start.isErr) return void errors.push(`${label}: unreadable starting position`);
    const fen = g.headers.get('FEN');
    if (fen && fen.split(' ')[0] !== 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR') return void errors.push(`${label}: starts from a set-up position`);
    const sans: string[] = [];
    let pos = startPos();
    for (const node of g.moves.mainline()) {
      const played = playSan(pos, node.san);
      if (!played) {
        errors.push(`${label}: illegal move "${node.san}" after ${sans.length} plies — kept the moves before it`);
        break;
      }
      sans.push(played.san);
      pos = played.pos;
    }
    if (!sans.length) return void errors.push(`${label}: no moves`);
    const elo = (k: string) => {
      const n = Number(g.headers.get(k));
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    const result = g.headers.get('Result') ?? '*';
    const event = g.headers.get('Event');
    games.push({
      white: g.headers.get('White') ?? '?',
      black: g.headers.get('Black') ?? '?',
      whiteElo: elo('WhiteElo'),
      blackElo: elo('BlackElo'),
      result: (RESULTS.has(result) ? result : '*') as StoredGame['result'],
      playedAt: parsePgnDate(g.headers.get('Date') ?? g.headers.get('UTCDate')),
      event: event && event !== '?' ? event : undefined,
      sans,
    });
  });
  return { games, errors };
}

/** Which side you played in a PGN game: by your name, else undefined. */
export function sideOf(g: PgnGame, myName: string | undefined): Color | undefined {
  if (sameName(g.white, myName)) return 'white';
  if (sameName(g.black, myName)) return 'black';
  return undefined;
}

/** A PGN game you played as `color`, as a draft. */
export function draftFromPgn(g: PgnGame, color: Color, timeClass: TimeClass = 'classical'): OtbDraft {
  const mine = color === 'white';
  return {
    sans: g.sans,
    userColor: color,
    opponent: mine ? g.black : g.white,
    opponentElo: mine ? g.blackElo : g.whiteElo,
    myName: mine ? g.white : g.black,
    myElo: mine ? g.whiteElo : g.blackElo,
    result: g.result,
    playedAt: g.playedAt ?? Date.now(),
    event: g.event,
    timeClass,
  };
}

/** Small stable hash, to give PGN games an id that doesn't change between reads. */
export function hashString(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
