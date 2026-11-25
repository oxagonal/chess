/**
 * Lichess opening explorer client: IndexedDB cache + a single serial request queue that backs off
 * for a minute on HTTP 429, as Lichess's API guidelines ask.
 */
import { db } from '../db/db';
import { playUci, posFromFen } from '../lib/chess';
import type { MoveStat, PositionStats, TopGame } from '../lib/types';
import { getSettings } from '../db/settings';
import { LichessLoginRequired } from './lichessAuth';

export interface ExplorerParams {
  db: 'lichess' | 'masters';
  speeds: string[];
  ratings: number[];
}

const MAX_AGE = 30 * 24 * 3600 * 1000;
const SPACING_MS = 60;
/** A request that hasn't answered by then is dropped and retried — one stuck request would hold up the whole queue. */
const TIMEOUT_MS = 20_000;

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

/**
 * One request at a time. "high" (what's on screen right now) always goes before "low" (background
 * coverage runs and depth measurements), so the board never waits behind hundreds of lookups.
 */
export type Priority = 'high' | 'low';
const queues: Record<Priority, (() => Promise<void>)[]> = { high: [], low: [] };
let pumping = false;
function enqueue<T>(task: () => Promise<T>, priority: Priority): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queues[priority].push(() => task().then(resolve, reject));
    void pump();
  });
}
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const next = queues.high.shift() ?? queues.low.shift();
      if (!next) break;
      await next();
      await sleep(SPACING_MS);
    }
  } finally {
    pumping = false;
  }
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
  topGames?: { id: string; white: { name: string; rating?: number }; black: { name: string; rating?: number }; winner?: 'white' | 'black' | null; year?: number }[];
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
    ...(raw.topGames
      ? {
          topGames: raw.topGames.map((g) => ({
            id: g.id,
            white: { name: g.white.name, rating: g.white.rating },
            black: { name: g.black.name, rating: g.black.rating },
            winner: g.winner ?? undefined,
            year: g.year,
          })),
        }
      : {}),
  };
}

/**
 * What's been read from the cache this session: a coverage run asks about thousands of positions, and
 * reading each from IndexedDB one at a time is most of what a run takes once everything is cached.
 */
const memo = new Map<string, { fetchedAt: number; data: PositionStats }>();

export async function getCachedExplorer(p: ExplorerParams, key: string): Promise<PositionStats | undefined> {
  const k = cacheKey(p, key);
  let row = memo.get(k);
  if (!row) {
    const r = await db.explorerCache.get(k);
    if (r) memo.set(k, (row = { fetchedAt: r.fetchedAt, data: r.data }));
  }
  return row && Date.now() - row.fetchedAt < MAX_AGE ? row.data : undefined;
}

/** Read many positions from the cache at once (one IndexedDB request), ahead of a coverage run. */
export async function prefetchExplorer(p: ExplorerParams, keys: Iterable<string>): Promise<void> {
  const wanted = [...new Set([...keys].map((k) => cacheKey(p, k)))].filter((k) => !memo.has(k));
  if (!wanted.length) return;
  const rows = await db.explorerCache.bulkGet(wanted);
  for (const r of rows) if (r) memo.set(r.key, { fetchedAt: r.fetchedAt, data: r.data });
}

/**
 * `fresh`: skip the cache (e.g. a masters position cached before its top games were fetched with it).
 */
export async function fetchExplorer(p: ExplorerParams, key: string, signal?: AbortSignal, priority: Priority = 'high', fresh = false): Promise<PositionStats> {
  const cached = fresh ? undefined : await getCachedExplorer(p, key);
  if (cached) return cached;
  return enqueue(async () => {
    // Another caller may have filled the cache while we waited in the queue.
    const again = fresh ? undefined : await getCachedExplorer(p, key);
    if (again) return again;
    // Since 2026 the explorer refuses anonymous requests; any Lichess token (no scopes) works.
    const { lichessToken } = await getSettings();
    if (!lichessToken) throw new LichessLoginRequired();
    const headers = { Authorization: `Bearer ${lichessToken}` };
    const fen = `${key} 0 1`;
    const url =
      p.db === 'masters'
        ? `https://explorer.lichess.org/masters?${new URLSearchParams({ fen, moves: '40', topGames: '8' })}`
        : `https://explorer.lichess.org/lichess?${new URLSearchParams({
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
      // The caller's cancel, or our timeout — whichever comes first.
      const ctrl = new AbortController();
      const cancel = () => ctrl.abort();
      signal?.addEventListener('abort', cancel);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, TIMEOUT_MS);
      try {
        res = await fetch(url, { signal: ctrl.signal, headers });
      } catch (e) {
        if (timedOut && !signal?.aborted) continue; // try again
        throw e;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
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
      if (res.status === 401 || res.status === 403) throw new LichessLoginRequired(true);
      if (!res.ok) throw new Error(`Opening explorer returned HTTP ${res.status}`);
      const data = normalize(key, (await res.json()) as RawResponse);
      const row = { key: cacheKey(p, key), fetchedAt: Date.now(), data };
      await db.explorerCache.put(row);
      memo.set(row.key, row);
      return data;
    }
    throw new Error('The opening explorer is rate limiting us or not answering — try again in a few minutes.');
  }, priority);
}

export async function clearExplorerCache() {
  memo.clear();
  await db.explorerCache.clear();
}

export async function explorerCacheSize(): Promise<number> {
  return db.explorerCache.count();
}

/** The best-known master games through a position (for plans: how strong players went on from here). */
export async function masterGames(key: string, signal?: AbortSignal): Promise<TopGame[]> {
  const masters: ExplorerParams = { db: 'masters', speeds: [], ratings: [] };
  let data = await fetchExplorer(masters, key, signal);
  if (data.topGames === undefined) data = await fetchExplorer(masters, key, signal, 'high', true);
  return data.topGames ?? [];
}
