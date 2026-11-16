import { db } from '../db/db';
import { getSettings, type AppSettings } from '../db/settings';
import { loadGraph } from '../db/repertoire';
import { computeCoverage } from '../lib/coverage';
import { GameStatsIndex } from '../lib/mygames';
import { bandsForRating, toLichessRating } from '../lib/ratings';
import type { CoverageResult } from '../lib/types';
import { fetchExplorer, paramsLabel, type ExplorerParams } from './explorer';

export function effectiveBands(s: AppSettings): number[] {
  if (s.bandsMode === 'manual' && s.manualBands.length) return [...s.manualBands].sort((a, b) => a - b);
  return bandsForRating(toLichessRating(s.rating, s.ratingPool));
}

export function lichessParams(s: AppSettings): ExplorerParams {
  return { db: 'lichess', speeds: s.speeds.length ? s.speeds : ['blitz', 'rapid', 'classical'], ratings: effectiveBands(s) };
}

export const MASTERS: ExplorerParams = { db: 'masters', speeds: [], ratings: [] };

export function sourceLabel(s: AppSettings): string {
  switch (s.probabilitySource) {
    case 'lichess':
      return paramsLabel(lichessParams(s));
    case 'masters':
      return 'Masters database';
    case 'mygames':
      return 'Your opponents (imported games)';
  }
}

export async function runCoverage(
  repId: string,
  opts: { signal?: AbortSignal; onProgress?: (queried: number) => void; oneInN?: number } = {},
): Promise<CoverageResult> {
  const s = await getSettings();
  const loaded = await loadGraph(repId);
  if (!loaded) throw new Error('Repertoire not found');
  const n = opts.oneInN ?? s.oneInN;
  let provider: (key: string) => Promise<import('../lib/types').PositionStats | undefined>;
  if (s.probabilitySource === 'mygames') {
    const games = await db.games.where('userColor').equals(loaded.rep.color).toArray();
    const idx = new GameStatsIndex(games);
    provider = async (key) => idx.get(key);
  } else {
    const params = s.probabilitySource === 'masters' ? MASTERS : lichessParams(s);
    provider = (key) => fetchExplorer(params, key, opts.signal);
  }
  const result = await computeCoverage(loaded.graph, provider, {
    repId,
    threshold: 1 / n,
    source: s.probabilitySource,
    paramsLabel: sourceLabel(s),
    signal: opts.signal,
    onProgress: (q) => opts.onProgress?.(q),
  });
  await db.coverage.put(result);
  return result;
}
