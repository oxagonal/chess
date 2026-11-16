/**
 * Lichess opening explorer client: IndexedDB cache + a single serial request queue that backs off
 * for a minute on HTTP 429, as Lichess's API guidelines ask.
 */
import { db } from '../db/db';
import { playUci, posFromFen } from '../lib/chess';
import type { MoveStat, PositionStats } from '../lib/types';

export interface ExplorerParams {
  db: 'lichess' | 'masters';
  speeds: string[];
  ratings: number[];
}

const MAX_AGE = 30 * 24 * 3600 * 1000;
const SPACING_MS = 150;

export function paramsLabel(p: ExplorerParams): string {
  if (p.db === 'masters') return 'Masters';
  return `Lichess ${p.ratings.join('/')} · ${p.speeds.join(', ')}`;
}

function cacheKey(p: ExplorerParams, key: string): string {
  if (p.db === 'masters') return `masters|${key}`;
  return `lichess|${[...p.speeds].sort().join(',')}|${[...p.ratings].sort((a, b) => a - b).join(',')}|${key}`;
}

type Listener = (s: { waitingUntil?: number; inFlight: number }) => void;
const listeners = new Set<Listener>();
let waitingUntil: number | undefined;
let inFlight = 0;
export function onExplorerStatus(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  for (const fn of listeners) fn({ waitingUntil, inFlight });
}

let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => sleep(SPACING_MS),
    () => sleep(SPACING_MS),
  );
  return run;
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

interface RawMove {
  uci: string;
  san: string;
  white: number;
  draws: number;
  black: number;
  averageRating?: number;
}
interface RawResponse {
  white: number;
  draws: number;
  black: number;
  moves: RawMove[];
  opening?: { eco: string; name: string } | null;
}

function normalize(key: string, raw: RawResponse): PositionStats {
  const pos = posFromFen(key);
  const moves: MoveStat[] = raw.moves.map((m) => {
    const played = pos ? playUci(pos, m.uci) : undefined;
    return {
      san: played?.san ?? m.san,
      uci: played?.uci ?? m.uci,
      white: m.white,
      draws: m.draws,
      black: m.black,
      averageRating: m.averageRating,
    };
  });
  return {
    total: raw.white + raw.draws + raw.black,
    white: raw.white,
    draws: raw.draws,
    black: raw.black,
    moves,
    opening: raw.opening ?? undefined,
  };
}

export async function getCachedExplorer(p: ExplorerParams, key: string): Promise<PositionStats | undefined> {
  const row = await db.explorerCache.get(cacheKey(p, key));
  return row && Date.now() - row.fetchedAt < MAX_AGE ? row.data : undefined;
}

export async function fetchExplorer(p: ExplorerParams, key: string, signal?: AbortSignal): Promise<PositionStats> {
  const cached = await getCachedExplorer(p, key);
  if (cached) return cached;
  return enqueue(async () => {
    // Another caller may have filled the cache while we waited in the queue.
    const again = await getCachedExplorer(p, key);
    if (again) return again;
    const fen = `${key} 0 1`;
    const url =
      p.db === 'masters'
        ? `https://explorer.lichess.ovh/masters?${new URLSearchParams({ fen, moves: '40', topGames: '0' })}`
        : `https://explorer.lichess.ovh/lichess?${new URLSearchParams({
            variant: 'standard',
            fen,
            speeds: p.speeds.join(','),
            ratings: p.ratings.join(','),
            moves: '40',
            topGames: '0',
            recentGames: '0',
          })}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      inFlight++;
      emit();
      let res: Response;
      try {
        res = await fetch(url, { signal });
      } finally {
        inFlight--;
        emit();
      }
      if (res.status === 429) {
        waitingUntil = Date.now() + 60_000;
        emit();
        await sleep(60_000, signal).finally(() => {
          waitingUntil = undefined;
          emit();
        });
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error('The Lichess opening explorer refused the request (it may now require you to be logged in to lichess.org in this browser).');
      }
      if (!res.ok) throw new Error(`Opening explorer returned HTTP ${res.status}`);
      const data = normalize(key, (await res.json()) as RawResponse);
      await db.explorerCache.put({ key: cacheKey(p, key), fetchedAt: Date.now(), data });
      return data;
    }
    throw new Error('Opening explorer is rate limiting us — try again in a few minutes.');
  });
}

export async function clearExplorerCache() {
  await db.explorerCache.clear();
}

export async function explorerCacheSize(): Promise<number> {
  return db.explorerCache.count();
}
