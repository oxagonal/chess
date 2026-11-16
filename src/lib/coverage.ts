/**
 * "1 in N games" analysis (the Chessbook idea).
 *
 * Assume you always play your repertoire moves and your opponents choose moves with the frequencies
 * seen in a reference database (Lichess games at your rating, masters, or your own past opponents).
 * Then every repertoire position has a probability of appearing on the board in one of your games.
 * Positions reached in at least 1 of N games are the ones worth knowing cold; opponent moves that
 * show up that often but are missing from the repertoire are gaps.
 */
import { posFromFen } from './chess';
import type { RepGraph } from './graph';
import { moveGames, type CoverageGap, type CoverageNode, type CoverageResult, type PositionStats, type ProbabilitySource } from './types';

export type StatsProvider = (key: string) => Promise<PositionStats | undefined>;

export interface CoverageOptions {
  repId: string;
  threshold: number;
  /** Opponent positions less likely than this are not looked up (defaults to threshold). */
  queryCutoff?: number;
  source: ProbabilitySource;
  paramsLabel: string;
  onProgress?: (queried: number, current: string) => void;
  signal?: AbortSignal;
}

export async function computeCoverage(graph: RepGraph, provider: StatsProvider, opts: CoverageOptions): Promise<CoverageResult> {
  const { threshold } = opts;
  const cutoff = opts.queryCutoff ?? threshold;
  const back = graph.backEdges();
  const prob = new Map<string, number>([[graph.root, 1]]);
  const gaps: CoverageGap[] = [];
  const unfinished: CoverageNode[] = [];
  const noData: string[] = [];
  let queried = 0;

  const add = (key: string, p: number) => prob.set(key, (prob.get(key) ?? 0) + p);
  const pathSans = (key: string) => (graph.pathTo(key) ?? []).map((m) => m.san);

  for (const key of graph.topoOrder()) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const p = prob.get(key) ?? 0;
    if (p <= 0) continue;
    const kids = graph.childrenOf(key).filter((m) => !back.has(m.id));

    if (graph.isMyTurn(key)) {
      if (!kids.length) {
        if (p >= threshold && !isGameOver(key)) unfinished.push({ key, prob: p, path: pathSans(key), myTurn: true });
        continue;
      }
      // Several prepared moves: assume you pick between them evenly.
      for (const m of kids) add(m.toKey, p / kids.length);
      continue;
    }

    if (p < cutoff) continue;
    opts.onProgress?.(queried, key);
    const stats = await provider(key);
    queried++;
    if (!stats || stats.total <= 0) {
      noData.push(key);
      continue;
    }
    for (const ms of stats.moves) {
      const games = moveGames(ms);
      if (!games) continue;
      const freq = games / stats.total;
      const edge = kids.find((m) => m.san === ms.san);
      if (edge) add(edge.toKey, p * freq);
      else if (p * freq >= threshold) {
        gaps.push({ fromKey: key, san: ms.san, uci: ms.uci, prob: p * freq, freq, games, path: pathSans(key) });
      }
    }
  }

  gaps.sort((a, b) => b.prob - a.prob);
  unfinished.sort((a, b) => b.prob - a.prob);
  const probs: Record<string, number> = {};
  for (const [k, v] of prob) if (v > 0) probs[k] = v;

  return {
    repId: opts.repId,
    computedAt: Date.now(),
    threshold,
    source: opts.source,
    paramsLabel: opts.paramsLabel,
    probs,
    gaps,
    unfinished,
    noData,
    queried,
  };
}

function isGameOver(key: string): boolean {
  const pos = posFromFen(key);
  return !pos || pos.isEnd();
}

/** Repertoire positions sorted by how often they occur (only those ≥ threshold). */
export function likelyPositions(graph: RepGraph, result: CoverageResult, threshold = result.threshold): CoverageNode[] {
  return Object.entries(result.probs)
    .filter(([, p]) => p >= threshold)
    .map(([key, p]) => ({ key, prob: p, path: (graph.pathTo(key) ?? []).map((m) => m.san), myTurn: graph.isMyTurn(key) }))
    .sort((a, b) => b.prob - a.prob);
}

/** "1 in 37" style label. */
export function oneIn(prob: number): string {
  if (prob <= 0) return '—';
  const n = 1 / prob;
  if (n < 1.05) return 'every game';
  if (n < 10) return `1 in ${n.toFixed(1).replace(/\.0$/, '')}`;
  return `1 in ${Math.round(n).toLocaleString()}`;
}

export function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}
