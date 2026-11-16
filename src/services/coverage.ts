import { db } from '../db/db';
import { getSettings, type AppSettings } from '../db/settings';
import { loadGraph } from '../db/repertoire';
import { computeCoverage } from '../lib/coverage';
import { GameStatsIndex } from '../lib/mygames';
import { bandsForRating, toLichessRating } from '../lib/ratings';
import { moveGames, type CoverageResult, type PositionStats } from '../lib/types';
import { turnOfKey, type Color } from '../lib/chess';
import { estimateDepth, type DepthProfile } from '../lib/depth';
import type { RepGraph } from '../lib/graph';
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
  const loaded = await loadGraph(repId);
  if (!loaded) throw new Error('Repertoire not found');
  return runCoverageForGraph(repId, loaded.graph, opts);
}

/** Run the analysis on an in-memory graph (the builder uses this to keep scores live). */
export async function runCoverageForGraph(
  repId: string,
  graph: RepGraph,
  opts: { signal?: AbortSignal; onProgress?: (queried: number) => void; oneInN?: number } = {},
): Promise<CoverageResult> {
  const s = await getSettings();
  const n = opts.oneInN ?? s.oneInN;
  const provider = await statsProvider(s, graph.color, opts.signal);
  const result = await computeCoverage(graph, provider, {
    repId,
    threshold: 1 / n,
    source: s.probabilitySource,
    paramsLabel: sourceLabel(s),
    signal: opts.signal,
    onProgress: (q) => opts.onProgress?.(q),
  });
  if (!opts.signal?.aborted) await db.coverage.put(result);
  return result;
}

export type StatsProvider = (key: string) => Promise<PositionStats | undefined>;

/** Opponent-move statistics from the source chosen in Settings. */
export async function statsProvider(s: AppSettings, color: Color, signal?: AbortSignal): Promise<StatsProvider> {
  if (s.probabilitySource === 'mygames') {
    const games = await db.games.where('userColor').equals(color).toArray();
    const idx = new GameStatsIndex(games);
    return async (key) => idx.get(key);
  }
  const params = s.probabilitySource === 'masters' ? MASTERS : lichessParams(s);
  return (key) => fetchExplorer(params, key, signal);
}

/**
 * Chance that a game reaches the end of `line`, if you always play your moves and opponents
 * choose with database frequencies. Your own moves count as certain unless the repertoire offers
 * several at that position (then they are split evenly, matching the coverage analysis).
 */
export async function reachAlongLine(
  line: { fromKey: string; san: string }[],
  color: Color,
  provider: StatsProvider,
  myOptions: (fromKey: string, san: string) => number = () => 1,
): Promise<number> {
  let p = 1;
  for (const m of line) {
    if (turnOfKey(m.fromKey) === color) {
      p /= Math.max(1, myOptions(m.fromKey, m.san));
      continue;
    }
    const stats = await provider(m.fromKey);
    if (!stats || stats.total <= 0) return 0;
    const ms = stats.moves.find((x) => x.san === m.san);
    p *= ms ? moveGames(ms) / stats.total : 0;
    if (p === 0) return 0;
  }
  return p;
}

const depthKey = (s: AppSettings, color: Color, n: number) => `depth|${sourceLabel(s)}|${color}|${n}`;

export async function getDepthProfile(s: AppSettings, color: Color, n: number): Promise<DepthProfile | undefined> {
  return (await db.kv.get(depthKey(s, color, n)))?.value as DepthProfile | undefined;
}

/** Measure (and remember) how deep lines go at 1 in N games for the current probability source. */
export async function measureDepth(
  color: Color,
  n: number,
  opts: { signal?: AbortSignal; onProgress?: (queried: number) => void } = {},
): Promise<DepthProfile> {
  const s = await getSettings();
  const provider = await statsProvider(s, color, opts.signal);
  const profile = await estimateDepth(color, provider, n, opts);
  await db.kv.put({ key: depthKey(s, color, n), value: profile });
  return profile;
}

/** Whether a stored result still matches the repertoire and the current settings. */
export function isCoverageFresh(result: CoverageResult | undefined, repUpdatedAt: number, s: AppSettings): boolean {
  return (
    !!result &&
    !!result.coverage &&
    result.computedAt >= repUpdatedAt &&
    result.paramsLabel === sourceLabel(s) &&
    Math.abs(result.threshold - 1 / s.oneInN) < 1e-12
  );
}
