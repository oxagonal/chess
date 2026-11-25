import { db } from '../db/db';
import { sharpProvider } from './sharpness';
import { getSettings, repTarget, type AppSettings } from '../db/settings';
import { loadScope, loadScopeGraph } from '../db/scopes';
import { computeCoverage, COVERAGE_ALGO, likelyPositions } from '../lib/coverage';
import { GameStatsIndex } from '../lib/mygames';
import { bandsForRating, toLichessRating } from '../lib/ratings';
import { moveGames, type CoverageResult, type PositionStats, type Repertoire } from '../lib/types';
import { turnOfKey, type Color } from '../lib/chess';
import { estimateDepth, type DepthProfile } from '../lib/depth';
import { gamesInRange, rangeLabel } from '../lib/gameRange';
import { RepGraph } from '../lib/graph';
import { chapterPosition, trainable } from '../lib/chapters';
import { loadOpeningIndex } from '../lib/openingNames';
import { fetchExplorer, paramsLabel, prefetchExplorer, type ExplorerParams, type Priority } from './explorer';

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
      return `Your opponents (${rangeLabel(s.opponentRange).toLowerCase()})`;
  }
}

/** Coverage of a scope ('white', 'black', a chapter or `set:<id>`): its chapters' union graph. */
export async function runCoverage(
  scopeId: string,
  opts: { signal?: AbortSignal; onProgress?: (queried: number) => void; oneInN?: number; localEngine?: boolean } = {},
): Promise<CoverageResult> {
  const loaded = await loadScopeGraph(scopeId);
  if (!loaded) throw new Error('Not found');
  // A full run may ask Stockfish about positions Lichess's cloud doesn't know (to find sharp lines).
  return runCoverageForGraph(scopeId, loaded.graph, { oneInN: repTarget(loaded.scope, await getSettings()), localEngine: true, ...opts });
}

/** What a coverage run at 1 in `n` games would say about a scope (Map → Details → compare targets). */
export interface TargetRow {
  n: number;
  /** Share of games that leave your lines while still common (1 − coverage of the start). */
  notCovered: number;
  /** Rare sidelines: games leaving your lines by rarer moves before they reach the target depth. */
  sidelines: number;
  /** Gaps and unprepared positions to fill — each at least one more move. */
  open: number;
  /** Your-move positions reached at least 1 in n games (moves you have now). */
  moves: number;
}

/**
 * A scope's coverage at several targets, from one set of lookups, without storing anything: the
 * deepest target first — it looks up every position the others need (explorer answers are cached),
 * so the rest come quickly.
 */
export async function compareTargets(
  scopeId: string,
  targets: readonly number[],
  opts: { signal?: AbortSignal; onProgress?: (n: number, queried: number) => void; provider?: StatsProvider } = {},
): Promise<TargetRow[]> {
  const loaded = await loadScopeGraph(scopeId);
  if (!loaded) throw new Error('Not found');
  const { graph } = loaded;
  const s = await getSettings();
  const provider = opts.provider ?? (await statsProvider(s, graph.color, opts.signal, 'low'));
  const rows: TargetRow[] = [];
  for (const n of [...new Set(targets)].sort((a, b) => b - a)) {
    const r = await computeCoverage(graph, provider, {
      repId: scopeId,
      threshold: 1 / n,
      source: s.probabilitySource,
      paramsLabel: sourceLabel(s),
      signal: opts.signal,
      onProgress: (q) => opts.onProgress?.(n, q),
    });
    rows.push({
      n,
      notCovered: Math.min(1, Math.max(0, 1 - (r.coverage?.[graph.root] ?? 1))),
      sidelines: r.sidelines?.[graph.root] ?? 0,
      open: r.gaps.length + r.unfinished.length,
      moves: likelyPositions(graph, r).filter((p) => p.myTurn).length,
    });
  }
  return rows.sort((a, b) => a.n - b.n);
}

/**
 * The runs going on now, one per scope: asked again while one runs (the builder, the Map, the
 * background updater), you get the same run — unless it was cancelled. With how far each has got.
 */
const inFlight = new Map<string, { promise: Promise<CoverageResult>; signal?: AbortSignal; queried: number }>();
const runListeners = new Set<() => void>();
const notifyRuns = () => runListeners.forEach((f) => f());

export function subscribeCoverageRuns(f: () => void): () => void {
  runListeners.add(f);
  return () => void runListeners.delete(f);
}

/** Positions looked up so far by the run going on for a scope (undefined: none running). */
export function coverageRunProgress(scopeId: string): number | undefined {
  return inFlight.get(scopeId)?.queried;
}

/** Run the analysis on an in-memory graph (the builder uses this to keep scores live). */
export function runCoverageForGraph(
  repId: string,
  graph: RepGraph,
  opts: Parameters<typeof runCoverageNow>[2] = {},
): Promise<CoverageResult> {
  const running = inFlight.get(repId);
  if (running && !running.signal?.aborted) return running.promise;
  const entry: { promise: Promise<CoverageResult>; signal?: AbortSignal; queried: number } = { promise: Promise.resolve(undefined as never), signal: opts.signal, queried: 0 };
  entry.promise = runCoverageNow(repId, graph, {
    ...opts,
    onProgress: (q) => {
      entry.queried = q;
      notifyRuns();
      opts.onProgress?.(q);
    },
  }).finally(() => {
    if (inFlight.get(repId) === entry) inFlight.delete(repId);
    notifyRuns();
  });
  inFlight.set(repId, entry);
  notifyRuns();
  return entry.promise;
}

async function runCoverageNow(
  repId: string,
  graph: RepGraph,
  opts: {
    signal?: AbortSignal;
    onProgress?: (queried: number) => void;
    oneInN?: number;
    /** Ask Stockfish where Lichess's cloud analysis can't tell if a line is sharp (not while the Stockfish box is in use). */
    localEngine?: boolean;
  } = {},
): Promise<CoverageResult> {
  const s = await getSettings();
  const n = opts.oneInN ?? repTarget(await loadScope(repId), s);
  const provider = await statsProvider(s, graph.color, opts.signal, 'low');
  await prefetchFor(s, graph).catch(() => undefined);
  const result = await computeCoverage(graph, provider, {
    repId,
    threshold: 1 / n,
    source: s.probabilitySource,
    paramsLabel: sourceLabel(s),
    sharp: sharpProvider({ local: !!opts.localEngine, signal: opts.signal }),
    chapters: s.chapterOneInN > 0 ? { anchors: await chapterAnchors(repId, graph.color), threshold: 1 / s.chapterOneInN } : undefined,
    signal: opts.signal,
    onProgress: (q) => opts.onProgress?.(q),
  });
  if (!opts.signal?.aborted) await db.coverage.put(result);
  return result;
}

/** Where each chapter of a scope starts (its opening's position), for the chapters' own goal. */
async function chapterAnchors(scopeId: string, color: Color): Promise<string[]> {
  const scope = await loadScope(scopeId);
  const ids = scope?.chapterIds ?? [];
  if (!ids.length) return [];
  const [chapters, moves, names] = await Promise.all([db.repertoires.bulkGet(ids), db.moves.where('repId').anyOf(ids).toArray(), loadOpeningIndex().catch(() => undefined)]);
  const out: string[] = [];
  for (const c of chapters) {
    if (!c) continue;
    const g = new RepGraph(color, trainable(color, moves.filter((m) => m.repId === c.id)));
    if (!g.size) continue;
    const key = chapterPosition(g, names, c.name).key;
    if (key !== g.root) out.push(key);
  }
  return out;
}

export type StatsProvider = (key: string) => Promise<PositionStats | undefined>;

/** Opponent-move statistics from the source chosen in Settings. */
export async function statsProvider(s: AppSettings, color: Color, signal?: AbortSignal, priority: Priority = 'high'): Promise<StatsProvider> {
  if (s.probabilitySource === 'mygames') {
    const games = await db.games.where('userColor').equals(color).toArray();
    const idx = new GameStatsIndex(gamesInRange(games, s.opponentRange));
    return async (key) => idx.get(key);
  }
  const params = s.probabilitySource === 'masters' ? MASTERS : lichessParams(s);
  return (key) => fetchExplorer(params, key, signal, priority);
}

/** Load what's cached for a repertoire's positions in one go, before a run walks them one by one. */
async function prefetchFor(s: AppSettings, graph: RepGraph): Promise<void> {
  if (s.probabilitySource === 'mygames') return;
  const params = s.probabilitySource === 'masters' ? MASTERS : lichessParams(s);
  await prefetchExplorer(params, graph.reachableKeys());
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
  const provider = await statsProvider(s, color, opts.signal, 'low');
  const profile = await estimateDepth(color, provider, n, opts);
  await db.kv.put({ key: depthKey(s, color, n), value: profile });
  return profile;
}

/** Whether a stored result still matches the repertoire (its moves and coverage target) and the current settings. */
export function isCoverageFresh(result: CoverageResult | undefined, rep: Pick<Repertoire, 'updatedAt' | 'oneInN'>, s: AppSettings): boolean {
  return !!result && result.computedAt >= rep.updatedAt && coverageMatchesSettings(result, rep, s);
}

/** A result made with today's settings and target — though maybe before your latest edits. */
export function coverageMatchesSettings(result: CoverageResult | undefined, rep: Pick<Repertoire, 'oneInN'>, s: AppSettings): boolean {
  return (
    !!result &&
    !!result.coverage &&
    result.algo === COVERAGE_ALGO &&
    result.paramsLabel === sourceLabel(s) &&
    Math.abs(result.threshold - 1 / repTarget(rep, s)) < 1e-12 &&
    (result.chapterOneInN ?? 0) === (s.chapterOneInN || 0)
  );
}
