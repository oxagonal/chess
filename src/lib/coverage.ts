/**
 * "1 in N games" analysis (the Chessbook idea).
 *
 * Assume you always play your repertoire moves and your opponents choose moves with the frequencies
 * seen in a reference database (Lichess games at your rating, masters, or your own past opponents).
 * Then every repertoire position has a probability of appearing on the board in one of your games.
 * Positions reached in at least 1 of N games are the ones worth knowing cold; opponent moves that
 * show up that often but are missing from the repertoire are gaps.
 */
import { isPromotion, legalDests, playUci, posFromFen } from './chess';
import type { RepGraph } from './graph';
import { moveGames, type CoverageGap, type CoverageNode, type CoverageResult, type PositionStats, type ProbabilitySource } from './types';

/** Bump when the analysis changes so stored results are recalculated. 2 = follows unsaved transpositions. */
export const COVERAGE_ALGO = 2;

export type StatsProvider =(key: string) => Promise<PositionStats | undefined>;

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

export interface ForwardOptions {
  threshold: number;
  /** Opponent positions less likely than this are not looked up (defaults to threshold). */
  queryCutoff?: number;
  /**
   * Every move of yours counts as played (each gets the whole probability) instead of your choices
   * splitting it evenly — for an import, before you've picked between its alternatives.
   */
  pickAll?: boolean;
  onProgress?: (queried: number, current: string) => void;
  signal?: AbortSignal;
}

export interface ForwardResult {
  /** How often each position comes up, summed over every move order that reaches it. */
  prob: Map<string, number>;
  gaps: CoverageGap[];
  unfinished: CoverageNode[];
  /** The likeliest holes rarer than the threshold (capped), see CoverageResult.minorGaps. */
  minorGaps: CoverageGap[];
  minorUnfinished: CoverageNode[];
  noData: string[];
  queried: number;
  statsAt: Map<string, PositionStats>;
  kidsOf: (key: string) => Edge[];
  order: string[];
}

/**
 * Forward pass: walks the repertoire in topological order so each position's probability is the sum
 * over all the ways it can arise (transpositions included) before it's used. Shared by the coverage
 * analysis and Play from memory, so both agree on how often a position comes up.
 */
export async function reachProbabilities(graph: RepGraph, provider: StatsProvider, opts: ForwardOptions): Promise<ForwardResult> {
  const { threshold } = opts;
  const cutoff = opts.queryCutoff ?? threshold;
  const { kidsOf, order } = withTranspositions(graph);
  const prob = new Map<string, number>([[graph.root, 1]]);
  const gaps: CoverageGap[] = [];
  const unfinished: CoverageNode[] = [];
  const minorGaps: CoverageGap[] = [];
  const minorUnfinished: CoverageNode[] = [];
  const noData: string[] = [];
  let queried = 0;

  const add = (key: string, p: number) => prob.set(key, (prob.get(key) ?? 0) + p);
  const pathSans = (key: string) => (graph.pathTo(key) ?? []).map((m) => m.san);
  const statsAt = new Map<string, PositionStats>();

  for (const key of order) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const p = prob.get(key) ?? 0;
    if (p <= 0) continue;
    const kids = kidsOf(key);

    if (graph.isMyTurn(key)) {
      if (!kids.length) {
        if (!isGameOver(key)) {
          if (p >= threshold) unfinished.push({ key, prob: p, path: pathSans(key), myTurn: true });
          else keepMinor(minorUnfinished, { key, prob: p, path: pathSans(key), myTurn: true });
        }
        continue;
      }
      // Several prepared moves: assume you pick between them evenly (or, for an import, play each).
      for (const m of kids) add(m.toKey, opts.pickAll ? p : p / kids.length);
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
    statsAt.set(key, stats);
    for (const ms of stats.moves) {
      const games = moveGames(ms);
      if (!games) continue;
      const freq = games / stats.total;
      const edge = kids.find((m) => m.san === ms.san);
      if (edge) add(edge.toKey, p * freq);
      else if (p * freq >= threshold) {
        gaps.push({ fromKey: key, san: ms.san, uci: ms.uci, prob: p * freq, freq, games, path: pathSans(key) });
      } else keepMinor(minorGaps, { fromKey: key, san: ms.san, uci: ms.uci, prob: p * freq, freq, games, path: pathSans(key) });
    }
  }
  return { prob, gaps, unfinished, minorGaps, minorUnfinished, noData, queried, statsAt, kidsOf, order };
}

export async function computeCoverage(graph: RepGraph, provider: StatsProvider, opts: CoverageOptions): Promise<CoverageResult> {
  const { threshold } = opts;
  // Stamp with the start time: an edit made while this runs must make the result look stale.
  const startedAt = Date.now();
  const { prob, gaps, unfinished, minorGaps, minorUnfinished, noData, queried, statsAt, kidsOf, order } = await reachProbabilities(graph, provider, opts);

  // Backward pass: coverage of each position = share of games reaching it that stay in book until
  // they get rarer than the threshold. Consistent with the forward pass: at the root it equals
  // 1 − (gap mass + unprepared mass).
  const cover = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const key = order[i];
    const p = prob.get(key) ?? 0;
    if (p < threshold) {
      cover.set(key, 1); // too rare to require anything from here on
      continue;
    }
    const kids = kidsOf(key);
    const childCover = (k: string) => cover.get(k) ?? 1;
    if (graph.isMyTurn(key)) {
      if (!kids.length) cover.set(key, isGameOver(key) ? 1 : 0);
      else cover.set(key, kids.reduce((a, m) => a + childCover(m.toKey), 0) / kids.length);
      continue;
    }
    const stats = statsAt.get(key);
    if (!stats) {
      cover.set(key, kids.length ? kids.reduce((a, m) => a + childCover(m.toKey), 0) / kids.length : 1);
      continue;
    }
    // Games that end here or continue with moves too rare to be listed count as covered.
    let c = 1;
    for (const ms of stats.moves) {
      const freq = moveGames(ms) / stats.total;
      if (!freq) continue;
      const edge = kids.find((m) => m.san === ms.san);
      if (edge) c -= freq * (1 - childCover(edge.toKey));
      else if (p * freq >= threshold) c -= freq;
    }
    cover.set(key, Math.max(0, Math.min(1, c)));
  }

  gaps.sort((a, b) => b.prob - a.prob);
  unfinished.sort((a, b) => b.prob - a.prob);
  const probs: Record<string, number> = {};
  for (const [k, v] of prob) if (v > 0) probs[k] = v;

  return {
    repId: opts.repId,
    computedAt: startedAt,
    threshold,
    source: opts.source,
    paramsLabel: opts.paramsLabel,
    probs,
    gaps,
    unfinished,
    minorGaps: minorGaps.sort((a, b) => b.prob - a.prob).slice(0, MINOR_KEEP),
    minorUnfinished: minorUnfinished.sort((a, b) => b.prob - a.prob).slice(0, MINOR_KEEP),
    noData,
    queried,
    coverage: Object.fromEntries(cover),
    algo: COVERAGE_ALGO,
  };
}

interface Edge {
  san: string;
  toKey: string;
}

/** How many sub-threshold holes a run keeps (the likeliest). */
const MINOR_KEEP = 300;
/** Keep the MINOR_KEEP likeliest; trimmed in batches so it stays cheap. */
function keepMinor<T extends { prob: number }>(list: T[], item: T) {
  if (item.prob <= 0) return;
  list.push(item);
  if (list.length > MINOR_KEEP * 2) {
    list.sort((a, b) => b.prob - a.prob);
    list.length = MINOR_KEEP;
  }
}

/**
 * The repertoire's moves plus "transposition edges": an opponent move you haven't saved that lands on
 * a position you have. Coverage follows those too, so a position counts every way it can arise in your
 * games and such moves aren't reported as gaps. (Your own unsaved moves aren't added — the app can't
 * assume what you'd play outside your prep.) Returns each position's outgoing edges, minus any that
 * would close a cycle, and a topological order to process positions in.
 */
export function withTranspositions(graph: RepGraph): { kidsOf: (key: string) => Edge[]; order: string[] } {
  const reachable = graph.reachableKeys();
  const extra = new Map<string, Edge[]>();
  for (const key of reachable) {
    if (graph.isMyTurn(key)) continue;
    const pos = posFromFen(key);
    if (!pos) continue;
    const saved = new Set(graph.childrenOf(key).map((m) => m.san));
    const seen = new Set<string>();
    for (const [orig, dests] of legalDests(pos)) {
      for (const dest of dests) {
        const r = playUci(pos, orig + dest + (isPromotion(pos, orig, dest) ? 'q' : ''));
        if (!r || saved.has(r.san) || seen.has(r.san) || !reachable.has(r.key)) continue;
        seen.add(r.san);
        const list = extra.get(key) ?? [];
        list.push({ san: r.san, toKey: r.key });
        extra.set(key, list);
      }
    }
  }
  const all = (key: string): Edge[] => [...graph.childrenOf(key), ...(extra.get(key) ?? [])];

  // Iterative DFS: drop edges that point back onto the current path (cycles), record post-order.
  const back = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const post: string[] = [];
  const stack: { key: string; kids: Edge[]; i: number }[] = [{ key: graph.root, kids: all(graph.root), i: 0 }];
  state.set(graph.root, 1);
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top.i < top.kids.length) {
      const e = top.kids[top.i++];
      const s = state.get(e.toKey);
      if (s === 1) back.add(`${top.key}|${e.san}`);
      else if (!s) {
        state.set(e.toKey, 1);
        stack.push({ key: e.toKey, kids: all(e.toKey), i: 0 });
      }
    } else {
      state.set(top.key, 2);
      post.push(top.key);
      stack.pop();
    }
  }
  return { kidsOf: (key) => all(key).filter((e) => !back.has(`${key}|${e.san}`)), order: post.reverse() };
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

/** Just N from "1 in N" (e.g. "142", "2.5"); "1" for every game. */
export function oneInNumber(prob: number): string {
  if (prob <= 0) return '—';
  const n = 1 / prob;
  if (n < 1.05) return '1';
  if (n < 10) return n.toFixed(1).replace(/\.0$/, '');
  return Math.round(n).toLocaleString();
}

const compactN = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** oneInNumber kept short like a count of games: "2.5", "142", "1.2K", "14.8K", "1.4M". */
export function oneInShort(prob: number): string {
  if (prob <= 0) return '—';
  const n = 1 / prob;
  if (n < 1.05) return '1';
  if (n < 10) return n.toFixed(1).replace(/\.0$/, '');
  return compactN.format(Math.round(n));
}

export function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}
