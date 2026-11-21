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

/**
 * Bump when the analysis changes so stored results are recalculated. 2 = follows unsaved
 * transpositions. (Preparing deeper after marked moves needs no bump: without marks results are the
 * same, and marking a move makes its chapters' runs stale — see setDeeper.)
 */
export const COVERAGE_ALGO = 2;

/**
 * How much deeper a sharp line is prepared: after a move marked "prepare deeper" a position needs an
 * answer when it's reached DEEPER times less often than the goal (1 in 800 → 1 in 8,000) — for lines
 * where not knowing a rare move loses on the spot. A position's `boost` is this factor (1 elsewhere);
 * it only changes what needs an answer, never how often a position is said to come up.
 */
export const DEEPER = 10;

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
  /** Each position's boost (see DEEPER): how much deeper it's prepared. Missing = 1. */
  boost: Map<string, number>;
  /** The opponent's replies that need an answer (`${fromKey}|${san}`), saved or not. */
  required: Set<string>;
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
  // How much deeper each position is prepared: after a move marked "prepare deeper", DEEPER — through
  // every move order into it (the most from any).
  const boost = new Map<string, number>([[graph.root, 1]]);
  const raise = (key: string, b: number) => b > (boost.get(key) ?? 1) && boost.set(key, b);
  const required = new Set<string>();
  const pathSans = (key: string) => (graph.pathTo(key) ?? []).map((m) => m.san);
  const statsAt = new Map<string, PositionStats>();

  for (const key of order) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const p = prob.get(key) ?? 0;
    if (p <= 0) continue;
    const b = boost.get(key) ?? 1;
    const kids = kidsOf(key);

    if (graph.isMyTurn(key)) {
      if (!kids.length) {
        if (!isGameOver(key)) {
          const node: CoverageNode = { key, prob: p, path: pathSans(key), myTurn: true };
          if (p * b >= threshold) unfinished.push(p >= threshold ? node : { ...node, boost: 'deeper' });
          else keepMinor(minorUnfinished, node);
        }
        continue;
      }
      // Several prepared moves: assume you pick between them evenly (or, for an import, play each).
      for (const m of kids) {
        add(m.toKey, opts.pickAll ? p : p / kids.length);
        raise(m.toKey, m.deeper ? DEEPER : b);
      }
      continue;
    }

    if (p * b < cutoff) continue;
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
      const q = p * freq;
      // The position after the reply is prepared as deep as this one — or deeper, after a marked move.
      const bc = edge?.deeper ? DEEPER : b;
      const needed = q * bc >= threshold;
      if (needed) required.add(`${key}|${ms.san}`);
      const gap: CoverageGap = { fromKey: key, san: ms.san, uci: ms.uci, prob: q, freq, games, path: pathSans(key) };
      if (edge) {
        add(edge.toKey, q);
        raise(edge.toKey, bc);
      } else if (needed) gaps.push(q >= threshold ? gap : { ...gap, boost: 'deeper' });
      else keepMinor(minorGaps, gap);
    }
  }
  return { prob, gaps, unfinished, minorGaps, minorUnfinished, noData, queried, statsAt, kidsOf, order, boost, required };
}

export async function computeCoverage(graph: RepGraph, provider: StatsProvider, opts: CoverageOptions): Promise<CoverageResult> {
  const { threshold } = opts;
  // Stamp with the start time: an edit made while this runs must make the result look stale.
  const startedAt = Date.now();
  const { prob, gaps, unfinished, minorGaps, minorUnfinished, noData, queried, statsAt, kidsOf, order, boost, required } = await reachProbabilities(
    graph,
    provider,
    opts,
  );

  // Backward pass: coverage of each position = share of games reaching it that stay in book until
  // they get rarer than the threshold. Consistent with the forward pass: at the root it equals
  // 1 − (gap mass + unprepared mass). Alongside, the part of that covered share that are rare
  // sidelines (`rare`): the opponent leaves your lines with a move rarer than the threshold *before
  // they reach your target depth* — at a position where some reply is still common enough to need an
  // answer. Once every reply is rarer than that, the games have gone as deep as your target asks: the
  // rest of them is past your lines' end, not a sideline (and preparing further there changes nothing).
  const cover = new Map<string, number>();
  const rare = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const key = order[i];
    const p = prob.get(key) ?? 0;
    if (p * (boost.get(key) ?? 1) < threshold) {
      cover.set(key, 1); // too rare to require anything from here on
      continue;
    }
    const kids = kidsOf(key);
    const childCover = (k: string) => cover.get(k) ?? 1;
    const childRare = (k: string) => rare.get(k) ?? 0;
    const evenly = (f: (k: string) => number) => kids.reduce((a, m) => a + f(m.toKey), 0) / kids.length;
    if (graph.isMyTurn(key)) {
      if (!kids.length) cover.set(key, isGameOver(key) ? 1 : 0);
      else {
        cover.set(key, evenly(childCover));
        rare.set(key, evenly(childRare));
      }
      continue;
    }
    const stats = statsAt.get(key);
    if (!stats) {
      cover.set(key, kids.length ? evenly(childCover) : 1);
      if (kids.length) rare.set(key, evenly(childRare));
      continue;
    }
    // Games that end here or continue with moves too rare to be listed count as covered.
    const freqOf = (ms: (typeof stats.moves)[number]) => moveGames(ms) / stats.total;
    const needed = (ms: (typeof stats.moves)[number]) => required.has(`${key}|${ms.san}`);
    const atDepth = !stats.moves.some(needed);
    let c = 1;
    let r = 0;
    for (const ms of stats.moves) {
      const freq = freqOf(ms);
      if (!freq) continue;
      const edge = kids.find((m) => m.san === ms.san);
      if (edge) {
        c -= freq * (1 - childCover(edge.toKey));
        r += freq * childRare(edge.toKey);
      } else if (needed(ms)) c -= freq;
      else if (!atDepth) r += freq;
    }
    cover.set(key, Math.max(0, Math.min(1, c)));
    rare.set(key, Math.max(0, Math.min(1, r)));
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
    sidelines: Object.fromEntries([...rare].filter(([, v]) => v > 0)),
    boost: Object.fromEntries([...boost].filter(([k, v]) => v > 1 && prob.has(k))),
    algo: COVERAGE_ALGO,
  };
}

interface Edge {
  san: string;
  toKey: string;
  /** A move marked "prepare deeper" (see DEEPER). */
  deeper?: boolean;
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
