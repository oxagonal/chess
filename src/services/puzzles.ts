/**
 * Lichess puzzles over the Lichess API (the Puzzles tab).
 *
 * Fetching never touches your Lichess account. Logged in with `puzzle:read`, Lichess picks puzzles
 * around your puzzle rating that you haven't played; without it (or not connected) it picks around
 * 1500. Results are sent back only with `puzzle:write` and when you choose to: `rated` ones change your
 * Lichess puzzle rating (the first time you play a puzzle), unrated ones just go into your history.
 * A token without a puzzle permission must not be sent at all — Lichess refuses it — so calls then go
 * out anonymously. Requests go one at a time; Lichess asks clients not to mass-download puzzles.
 */
import { getSettings, type AppSettings } from '../db/settings';
import type { LichessPuzzle, PuzzleDifficulty } from '../lib/puzzle';
import { LICHESS } from './lichessAuth';

export interface Glicko {
  rating: number;
  deviation: number;
  provisional?: boolean;
}

export const hasScope = (s: Pick<AppSettings, 'lichessToken' | 'lichessScopes'>, scope: string) =>
  !!s.lichessToken && (s.lichessScopes ?? '').split(/\s+/).includes(scope);

/** Why a puzzle request didn't work, in words. */
export class PuzzleError extends Error {}

let queue: Promise<unknown> = Promise.resolve();
/** One request at a time. */
function serial<T>(f: () => Promise<T>): Promise<T> {
  const next = queue.then(f, f);
  queue = next.catch(() => undefined);
  return next;
}

async function call<T>(path: string, init: RequestInit & { scope: string }): Promise<T> {
  const s = await getSettings();
  const headers: Record<string, string> = { Accept: 'application/json', ...((init.headers as Record<string, string>) ?? {}) };
  if (hasScope(s, init.scope)) headers.Authorization = `Bearer ${s.lichessToken}`;
  const res = await serial(() => fetch(`${LICHESS}${path}`, { ...init, headers }));
  if (res.status === 404) throw new PuzzleError('Lichess has no puzzles for that — pick another opening or theme.');
  if (res.status === 429) throw new PuzzleError('Lichess asks to slow down — try again in a minute.');
  if (res.status === 401 || res.status === 403) throw new PuzzleError('Lichess refused the request — reconnect Lichess (Settings → Connections).');
  if (!res.ok) throw new PuzzleError(`Lichess puzzles failed (HTTP ${res.status}).`);
  return (await res.json()) as T;
}

/** A batch of puzzles: 'mix', a theme, or an opening's key (see openingAngle). */
export async function fetchPuzzles(angle: string, opts: { nb?: number; difficulty?: PuzzleDifficulty } = {}): Promise<{ puzzles: LichessPuzzle[]; glicko?: Glicko }> {
  const q = new URLSearchParams({ nb: String(opts.nb ?? 10) });
  if (opts.difficulty && opts.difficulty !== 'normal') q.set('difficulty', opts.difficulty);
  return call(`/api/puzzle/batch/${encodeURIComponent(angle)}?${q}`, { method: 'GET', scope: 'puzzle:read' });
}

export interface PuzzleRound {
  id: string;
  win: boolean;
  ratingDiff?: number;
}

/**
 * Tell Lichess how you did (needs `puzzle:write`). Returns each puzzle's rating change, your rating
 * after, and — as Lichess sends them along — more puzzles picked for you.
 */
export async function reportPuzzles(
  angle: string,
  solutions: { id: string; win: boolean; rated: boolean }[],
  opts: { nb?: number; difficulty?: PuzzleDifficulty } = {},
): Promise<{ rounds: PuzzleRound[]; glicko?: Glicko; puzzles: LichessPuzzle[] }> {
  const q = new URLSearchParams({ nb: String(opts.nb ?? 0) });
  if (opts.difficulty && opts.difficulty !== 'normal') q.set('difficulty', opts.difficulty);
  const r = await call<{ rounds?: PuzzleRound[]; glicko?: Glicko; puzzles?: LichessPuzzle[] }>(`/api/puzzle/batch/${encodeURIComponent(angle)}?${q}`, {
    method: 'POST',
    scope: 'puzzle:write',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ solutions }),
  });
  return { rounds: r.rounds ?? [], glicko: r.glicko, puzzles: r.puzzles ?? [] };
}

/** Whether results can be sent to Lichess (connected with puzzle permissions). */
export async function canReport(): Promise<boolean> {
  return hasScope(await getSettings(), 'puzzle:write');
}
