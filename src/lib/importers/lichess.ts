import type { StoredGame } from '../types';
import { HttpError, normalizeTimeClass, scoreFor, type ImportOptions } from './common';

interface LichessPlayer {
  user?: { name: string; id: string };
  rating?: number;
  aiLevel?: number;
}

export interface LichessGameJson {
  id: string;
  rated: boolean;
  variant: string;
  speed: string;
  perf?: string;
  createdAt: number;
  lastMoveAt?: number;
  status: string;
  players: { white: LichessPlayer; black: LichessPlayer };
  winner?: 'white' | 'black';
  opening?: { eco: string; name: string; ply: number };
  moves?: string;
  clocks?: number[];
  initialFen?: string;
}

function playerName(p: LichessPlayer): string {
  if (p.user) return p.user.name;
  if (p.aiLevel) return `Stockfish level ${p.aiLevel}`;
  return 'Anonymous';
}

export function parseLichessGame(g: LichessGameJson, account: string): StoredGame | undefined {
  if (g.variant !== 'standard' || g.initialFen) return undefined;
  const acc = account.toLowerCase();
  const userColor = g.players.white.user?.id === acc ? 'white' : g.players.black.user?.id === acc ? 'black' : undefined;
  if (!userColor) return undefined;
  const sans = (g.moves ?? '').split(' ').filter(Boolean);
  if (!sans.length) return undefined;
  const result: StoredGame['result'] =
    g.winner === 'white' ? '1-0' : g.winner === 'black' ? '0-1' : ['draw', 'stalemate'].includes(g.status) ? '1/2-1/2' : '*';
  return {
    id: `lichess:${g.id}`,
    source: 'lichess',
    account: acc,
    url: `https://lichess.org/${g.id}${userColor === 'black' ? '/black' : ''}`,
    white: playerName(g.players.white),
    black: playerName(g.players.black),
    whiteElo: g.players.white.rating,
    blackElo: g.players.black.rating,
    userColor,
    result,
    userScore: scoreFor(result, userColor),
    timeClass: normalizeTimeClass(g.speed),
    rated: g.rated,
    playedAt: g.createdAt,
    eco: g.opening?.eco,
    opening: g.opening?.name,
    sans,
    clocks: g.clocks?.map((c) => c / 100),
    termination: g.status,
  };
}

/** Parse an NDJSON chunk stream into objects. */
export async function* ndjson<T>(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield JSON.parse(line) as T;
      }
    }
    const rest = buf.trim();
    if (rest) yield JSON.parse(rest) as T;
  } finally {
    reader.releaseLock();
  }
}

const PERF_TYPES: Record<string, string[]> = {
  bullet: ['ultraBullet', 'bullet'],
  blitz: ['blitz'],
  rapid: ['rapid'],
  classical: ['classical'],
  correspondence: ['correspondence'],
};

export async function importLichess(opts: ImportOptions): Promise<number> {
  const perf = opts.timeClasses.flatMap((t) => PERF_TYPES[t] ?? []);
  const params = new URLSearchParams({
    since: String(opts.since),
    moves: 'true',
    clocks: 'true',
    opening: 'true',
    perfType: perf.join(','),
    // Oldest first, so an interrupted download resumes where it stopped.
    sort: 'dateAsc',
  });
  const headers: Record<string, string> = { Accept: 'application/x-ndjson' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  opts.onProgress?.({ phase: 'Contacting Lichess…', games: 0 });
  const res = await fetch(`https://lichess.org/api/games/user/${encodeURIComponent(opts.username)}?${params}`, {
    headers,
    signal: opts.signal,
  });
  if (res.status === 404) throw new HttpError(404, `Lichess user "${opts.username}" not found`);
  if (res.status === 429) throw new HttpError(429, 'Lichess rate limit hit — wait a minute and try again');
  if (!res.ok || !res.body) throw new HttpError(res.status, `Lichess returned HTTP ${res.status}`);

  let count = 0;
  let batch: StoredGame[] = [];
  for await (const raw of ndjson<LichessGameJson>(res.body, opts.signal)) {
    const g = parseLichessGame(raw, opts.username);
    if (g) batch.push(g);
    if (batch.length >= 50) {
      await opts.onGames?.(batch);
      count += batch.length;
      batch = [];
      opts.onProgress?.({ phase: 'Downloading Lichess games', games: count });
    }
  }
  if (batch.length) {
    await opts.onGames?.(batch);
    count += batch.length;
  }
  opts.onProgress?.({ phase: 'Lichess done', games: count });
  return count;
}

export async function fetchLichessRatings(username: string): Promise<Record<string, number>> {
  const res = await fetch(`https://lichess.org/api/user/${encodeURIComponent(username)}`);
  if (!res.ok) throw new HttpError(res.status, `Lichess user "${username}" not found`);
  const data = (await res.json()) as { perfs?: Record<string, { rating: number; games: number }> };
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(data.perfs ?? {})) if (v.games > 0) out[k] = v.rating;
  return out;
}
