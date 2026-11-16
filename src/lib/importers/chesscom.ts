import { parsePgn, parseComment } from 'chessops/pgn';
import type { StoredGame } from '../types';
import { START_FEN } from '../chess';
import { HttpError, normalizeTimeClass, scoreFor, type ImportOptions } from './common';

interface ChessComPlayer {
  username: string;
  rating?: number;
  result: string;
}

export interface ChessComGameJson {
  url: string;
  pgn?: string;
  time_control?: string;
  end_time: number; // seconds
  rated?: boolean;
  uuid?: string;
  initial_setup?: string;
  time_class: string;
  rules: string;
  eco?: string; // URL
  white: ChessComPlayer;
  black: ChessComPlayer;
}

const DRAW_RESULTS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);

function openingFromEcoUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const slug = url.split('/openings/')[1];
  if (!slug) return undefined;
  return decodeURIComponent(slug)
    .replace(/-\d+\..*$/, '') // strip trailing move text like "-3.Nc3"
    .replace(/-/g, ' ')
    .trim();
}

export function parseChessComGame(g: ChessComGameJson, account: string): StoredGame | undefined {
  if (g.rules !== 'chess' || !g.pgn) return undefined;
  if (g.initial_setup && g.initial_setup.split(' ')[0] !== START_FEN.split(' ')[0]) return undefined;
  const acc = account.toLowerCase();
  const userColor =
    g.white.username.toLowerCase() === acc ? 'white' : g.black.username.toLowerCase() === acc ? 'black' : undefined;
  if (!userColor) return undefined;

  const [game] = parsePgn(g.pgn);
  if (!game) return undefined;
  const sans: string[] = [];
  const clocks: number[] = [];
  for (const node of game.moves.mainline()) {
    sans.push(node.san);
    const clk = node.comments?.map((c) => parseComment(c).clock).find((c) => c !== undefined);
    if (clk !== undefined) clocks.push(clk);
  }
  if (!sans.length) return undefined;

  const result: StoredGame['result'] =
    g.white.result === 'win' ? '1-0' : g.black.result === 'win' ? '0-1' : DRAW_RESULTS.has(g.white.result) ? '1/2-1/2' : '*';
  const loser = g.white.result === 'win' ? g.black.result : g.white.result;
  const id = g.uuid || g.url.split('/').pop() || g.url;
  return {
    id: `chesscom:${id}`,
    source: 'chesscom',
    account: acc,
    url: g.url,
    white: g.white.username,
    black: g.black.username,
    whiteElo: g.white.rating,
    blackElo: g.black.rating,
    userColor,
    result,
    userScore: scoreFor(result, userColor),
    timeClass: normalizeTimeClass(g.time_class),
    rated: g.rated ?? true,
    playedAt: g.end_time * 1000,
    eco: game.headers.get('ECO'),
    opening: openingFromEcoUrl(g.eco ?? game.headers.get('ECOUrl')),
    sans,
    clocks: clocks.length === sans.length ? clocks : undefined,
    termination: loser,
  };
}

/** "https://api.chess.com/pub/player/x/games/2024/03" → 2024*12 + 2 */
export function archiveMonthIndex(url: string): number {
  const m = url.match(/(\d{4})\/(\d{2})\/?$/);
  return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : 0;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (res.status === 404) throw new HttpError(404, 'Chess.com user not found');
  if (res.status === 429) throw new HttpError(429, 'Chess.com rate limit hit — wait a minute and try again');
  if (!res.ok) throw new HttpError(res.status, `Chess.com returned HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function importChessCom(opts: ImportOptions): Promise<number> {
  const user = encodeURIComponent(opts.username.toLowerCase());
  opts.onProgress?.({ phase: 'Listing Chess.com archives…', games: 0 });
  const { archives } = await getJson<{ archives: string[] }>(
    `https://api.chess.com/pub/player/${user}/games/archives`,
    opts.signal,
  );
  const sinceDate = new Date(opts.since);
  const sinceIdx = sinceDate.getUTCFullYear() * 12 + sinceDate.getUTCMonth();
  const months = archives.filter((u) => archiveMonthIndex(u) >= sinceIdx);
  const wanted = new Set(opts.timeClasses);

  let count = 0;
  for (let i = 0; i < months.length; i++) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const label = months[i].match(/(\d{4}\/\d{2})\/?$/)?.[1] ?? months[i];
    opts.onProgress?.({ phase: 'Downloading Chess.com games', games: count, detail: `month ${i + 1}/${months.length} (${label})` });
    const { games } = await getJson<{ games: ChessComGameJson[] }>(months[i], opts.signal);
    const parsed = games
      .map((g) => parseChessComGame(g, opts.username))
      .filter((g): g is StoredGame => !!g && g.playedAt >= opts.since && wanted.has(g.timeClass as never));
    if (parsed.length) await opts.onGames?.(parsed);
    count += parsed.length;
  }
  opts.onProgress?.({ phase: 'Chess.com done', games: count });
  return count;
}

export async function fetchChessComRatings(username: string): Promise<Record<string, number>> {
  const data = await getJson<Record<string, { last?: { rating: number } }>>(
    `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/stats`,
  );
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith('chess_') && v?.last?.rating) out[k.replace('chess_', '')] = v.last.rating;
  }
  return out;
}
