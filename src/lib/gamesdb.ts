/**
 * The over-the-board games database (Lumbra's Gigabase, exported by gamesdb/SPEC.md) as static files:
 *
 *   manifest.json        what's in it (release, counts, number of buckets)
 *   names/<xx>.bin       gzip JSON: every player name with a word starting with "xx"
 *   games/<n>.bin        gzip JSON: the games of the players whose id % buckets == n
 *
 * Pure: no DOM, no network. See services/gamesdb.ts for fetching.
 */
import { nameWords, normalizeName } from './otb';
import { playUci, startPos, stdUci } from './chess';
import { parseSan } from 'chessops/san';
import type { StoredGame } from './types';

export const GAMESDB_FORMAT = 1;
/** Moves kept per game: the first 30 moves. */
export const MAX_PLIES = 60;

export interface GamesDbManifest {
  format: number;
  source: string;
  sourceUrl?: string;
  license: string;
  /** e.g. "2026-11" — also busts caches when a new release is deployed. */
  release: string;
  games: number;
  players: number;
  buckets: number;
  maxPlies: number;
  builtAt?: string;
}

/** [name, id, games, firstYear, lastYear, fideId] — years and FIDE id 0 when unknown. */
export type NameEntry = [name: string, id: number, games: number, firstYear: number, lastYear: number, fideId: number];

/**
 * One game seen from a player's side:
 * [color (0 White, 1 Black), opponent, opponentElo, playerElo, date YYYYMMDD (0 = unknown parts),
 *  result (0 *, 1 1-0, 2 0-1, 3 ½-½), event index, time-control index (-1 none), moves]
 */
export type GameEntry = [c: 0 | 1, opp: string, oppElo: number, myElo: number, date: number, r: 0 | 1 | 2 | 3, ev: number, tc: number, mv: string];

export interface GameBucket {
  events: string[];
  tcs: string[];
  players: Record<string, GameEntry[]>;
}

/** Words of a name that are indexed (2+ letters; initials aren't). */
export function nameTokens(name: string): string[] {
  return normalizeName(name)
    .split(' ')
    .filter((w) => w.length >= 2);
}

/** Which names/ file holds a word: its first two characters, anything outside a–z0–9 as "_". */
export function shardKey(token: string): string {
  return (token + '__')
    .slice(0, 2)
    .replace(/[^a-z0-9]/g, '_');
}

/** Names matching what's typed: every word must appear; the last one may be just the start of a word. */
export function matchNames(entries: readonly NameEntry[], query: string): NameEntry[] {
  // Every typed word counts here, initials too ("iinuma p" while typing, "paul y iinuma").
  const q = nameWords(query);
  if (!nameTokens(query).length) return [];
  const last = q[q.length - 1];
  const rest = q.slice(0, -1);
  return entries
    .filter(([name]) => {
      const words = normalizeName(name).split(' ');
      return rest.every((w) => words.includes(w)) && words.some((w) => w.startsWith(last));
    })
    .sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0]));
}

const PROMOS = ['q', 'n', 'b', 'r'];

function toBase64Url(bytes: number[]): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64: string): Uint8Array {
  const std = b64.replace(/-/g, '+').replace(/_/g, '/');
  const s = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const sq = (name: string) => name.charCodeAt(0) - 97 + (Number(name[1]) - 1) * 8;
const sqName = (n: number) => String.fromCharCode(97 + (n % 8)) + String(Math.floor(n / 8) + 1);

/**
 * Moves as 2 bytes each: from square, then to square | promotion << 6 (a1 = 0 … h8 = 63; castling as the
 * king's two-square move; promotion 0 queen, 1 knight, 2 bishop, 3 rook). Base64url, no padding.
 */
export function encodeMoves(sans: readonly string[], max = MAX_PLIES): string {
  const bytes: number[] = [];
  let pos = startPos();
  for (const san of sans.slice(0, max)) {
    const move = parseSan(pos, san);
    if (!move || !('from' in move)) break;
    const uci = stdUci(pos, move);
    const promo = uci.length > 4 ? PROMOS.indexOf(uci[4]) : 0;
    bytes.push(sq(uci.slice(0, 2)), sq(uci.slice(2, 4)) | (promo << 6));
    pos = playUci(pos, uci)!.pos;
  }
  return toBase64Url(bytes);
}

/** The SAN moves back; stops at the first move that isn't legal. */
export function decodeMoves(b64: string): string[] {
  const bytes = fromBase64Url(b64);
  const sans: string[] = [];
  let pos = startPos();
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const from = bytes[i] & 63;
    const to = bytes[i + 1] & 63;
    const promo = bytes[i + 1] >> 6;
    const piece = pos.board.get(from);
    const promoting = piece?.role === 'pawn' && (to >= 56 || to < 8);
    const played = playUci(pos, sqName(from) + sqName(to) + (promoting ? PROMOS[promo] : ''));
    if (!played) break;
    sans.push(played.san);
    pos = played.pos;
  }
  return sans;
}

const RESULTS: StoredGame['result'][] = ['*', '1-0', '0-1', '1/2-1/2'];

/** YYYYMMDD with unknown parts as 00 → local noon; unknown year → 0. */
export function dateOf(ymd: number): number {
  const y = Math.floor(ymd / 10000);
  if (!y) return 0;
  const m = Math.floor(ymd / 100) % 100 || 1;
  const d = ymd % 100 || 1;
  return new Date(y, m - 1, d, 12).getTime();
}

/** A database player's games as stored games, seen from their side (`userColor` = their color). */
export function bucketGames(bucket: GameBucket, entry: readonly [name: string, id: number, ...rest: unknown[]], release: string): StoredGame[] {
  const [name, id] = entry;
  return (bucket.players[String(id)] ?? []).map((g, i) => {
    const [c, opp, oppElo, myElo, date, r, ev, tc, mv] = g;
    const color = c === 0 ? 'white' : 'black';
    const result = RESULTS[r] ?? '*';
    const tcName = tc >= 0 ? bucket.tcs[tc] : undefined;
    return {
      id: `lgb:${id}:${i}`,
      source: 'otb',
      account: `lgb:${release}`,
      url: '',
      white: color === 'white' ? name : opp,
      black: color === 'white' ? opp : name,
      whiteElo: (color === 'white' ? myElo : oppElo) || undefined,
      blackElo: (color === 'white' ? oppElo : myElo) || undefined,
      userColor: color,
      result,
      userScore: result === '1/2-1/2' ? 0.5 : result === '*' ? undefined : (result === '1-0') === (color === 'white') ? 1 : 0,
      timeClass: timeClassOf(tcName),
      rated: true,
      playedAt: dateOf(date),
      sans: decodeMoves(mv),
      event: ev >= 0 ? bucket.events[ev] : undefined,
    } satisfies StoredGame;
  });
}

/** Rough time class from a PGN TimeControl / Mode tag (classical when unknown — it's an OTB database). */
export function timeClassOf(tc: string | undefined): string {
  if (!tc) return 'classical';
  const t = tc.toLowerCase();
  if (/blitz/.test(t)) return 'blitz';
  if (/rapid/.test(t)) return 'rapid';
  const base = Number(t.match(/^(?:\d+\/)?(\d+)/)?.[1]);
  if (!base) return 'classical';
  if (base < 600) return base < 180 ? 'bullet' : 'blitz';
  return base < 3600 ? 'rapid' : 'classical';
}
