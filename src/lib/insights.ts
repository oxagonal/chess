/**
 * Insights: how well you know each move and each line of a repertoire.
 *
 * Signals per move (= review card):
 *  - training accuracy: share of training attempts answered right first time
 *  - recall: FSRS retrievability, the probability you'd remember it right now
 *  - difficulty: FSRS difficulty (1–10), which rises every time you miss the move
 *  - game slips: how often you left your prep at this move in real games
 * They are blended into a 0–100 "mastery" score; lines aggregate the moves below them.
 */
import type { RepGraph } from './graph';
import type { RepMove, ReviewCard, ReviewLogEntry } from './types';
import { retrievability } from './srs';

export interface Tally {
  /** Your moves in scope. */
  moves: number;
  learned: number;
  attempts: number;
  misses: number;
  gameSlips: number;
  /** Opponent moves outside your repertoire seen in games, at positions in scope. */
  surprises: number;
  recallSum: number;
  difficultySum: number;
}

export interface MoveInsight extends Tally {
  move: RepMove;
  card: ReviewCard;
  path: string[];
  accuracy?: number;
  recall?: number;
  mastery?: number;
}

export interface LineInsight extends Tally {
  id: string; // id of the first move of the segment
  /** Moves shown on this row: a run of moves without branching. */
  segment: RepMove[];
  /** SAN path from the start up to (excluding) the segment. */
  prefix: string[];
  transposes: boolean;
  accuracy?: number;
  recall?: number;
  mastery?: number;
  children: LineInsight[];
}

export interface InsightInput {
  graph: RepGraph;
  cards: ReviewCard[];
  logs: ReviewLogEntry[];
  /** cardId → times forgotten in real games */
  gameSlips?: Map<string, number>;
  /** position key → opponent deviations seen there */
  surprises?: Map<string, number>;
  now?: number;
}

const empty = (): Tally => ({ moves: 0, learned: 0, attempts: 0, misses: 0, gameSlips: 0, surprises: 0, recallSum: 0, difficultySum: 0 });

function addInto(a: Tally, b: Tally) {
  a.moves += b.moves;
  a.learned += b.learned;
  a.attempts += b.attempts;
  a.misses += b.misses;
  a.gameSlips += b.gameSlips;
  a.surprises += b.surprises;
  a.recallSum += b.recallSum;
  a.difficultySum += b.difficultySum;
}

/**
 * Mastery 0–100. Misses are smoothed toward a 25% prior so a single unlucky attempt doesn't dominate;
 * a slip in a real game weighs double. Undefined until something has been learned.
 */
export function mastery(t: Tally): number | undefined {
  if (!t.learned) return undefined;
  const missRate = (t.misses + 2 * t.gameSlips + 0.5) / (t.attempts + 2 * t.gameSlips + 2);
  const recall = t.recallSum / t.learned;
  const difficulty = (t.difficultySum / t.learned - 1) / 9;
  const weakness = 0.5 * missRate + 0.3 * (1 - recall) + 0.2 * Math.max(0, Math.min(1, difficulty));
  return Math.round(100 * (1 - Math.max(0, Math.min(1, weakness))));
}

function finish<T extends Tally>(t: T): T & { accuracy?: number; recall?: number; mastery?: number } {
  return {
    ...t,
    accuracy: t.attempts ? (t.attempts - t.misses) / t.attempts : undefined,
    recall: t.learned ? t.recallSum / t.learned : undefined,
    mastery: mastery(t),
  };
}

export interface Insights {
  total: ReturnType<typeof finish<Tally>>;
  moves: MoveInsight[];
  lines: LineInsight[];
  /** Training accuracy over the last 30 days. */
  recentAccuracy?: number;
  recentAttempts: number;
}

export function computeInsights({ graph, cards, logs, gameSlips, surprises, now = Date.now() }: InsightInput): Insights {
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const attempts = new Map<string, { n: number; miss: number }>();
  let recentN = 0;
  let recentMiss = 0;
  for (const l of logs) {
    if (l.source === 'game') continue;
    const a = attempts.get(l.cardId) ?? { n: 0, miss: 0 };
    a.n++;
    if (l.rating === 1) a.miss++;
    attempts.set(l.cardId, a);
    if (now - l.reviewedAt < 30 * 86_400_000) {
      recentN++;
      if (l.rating === 1) recentMiss++;
    }
  }

  const tallyMove = (m: RepMove): Tally => {
    const t = empty();
    const card = cardById.get(m.id);
    if (!m.mine || !card) return t;
    t.moves = 1;
    const a = attempts.get(m.id);
    t.attempts = a?.n ?? 0;
    t.misses = a?.miss ?? 0;
    t.gameSlips = gameSlips?.get(m.id) ?? 0;
    const r = retrievability(card, now);
    if (r !== undefined) {
      t.learned = 1;
      t.recallSum = r;
      t.difficultySum = card.difficulty;
    }
    return t;
  };

  // Per-move insights
  const moves: MoveInsight[] = [];
  for (const m of graph.byId.values()) {
    const card = cardById.get(m.id);
    if (!m.mine || !card || !graph.has(m.fromKey)) continue;
    moves.push({ ...finish(tallyMove(m)), move: m, card, path: (graph.pathTo(m.fromKey) ?? []).map((x) => x.san) });
  }
  moves.sort((a, b) => (a.mastery ?? 101) - (b.mastery ?? 101) || b.misses + b.gameSlips - (a.misses + a.gameSlips));

  // Line tree over the BFS spanning tree; transposing moves become leaves.
  const tree = graph.tree();
  const isTreeEdge = (m: RepMove) => tree.get(m.toKey) === m;
  const memo = new Map<string, Tally>();
  const below = (key: string): Tally => {
    const hit = memo.get(key);
    if (hit) return hit;
    const t = empty();
    t.surprises = surprises?.get(key) ?? 0;
    for (const m of graph.childrenOf(key)) {
      addInto(t, tallyMove(m));
      if (isTreeEdge(m)) addInto(t, below(m.toKey));
    }
    memo.set(key, t);
    return t;
  };

  const row = (first: RepMove, prefix: string[]): LineInsight => {
    const segment = [first];
    const tally = tallyMove(first);
    if (!isTreeEdge(first)) {
      return { ...finish(tally), id: first.id, segment, prefix, transposes: true, children: [] };
    }
    addInto(tally, below(first.toKey));
    let end = first.toKey;
    for (;;) {
      const kids = graph.childrenOf(end);
      if (kids.length !== 1 || !isTreeEdge(kids[0])) break;
      segment.push(kids[0]);
      end = kids[0].toKey;
    }
    const childPrefix = [...prefix, ...segment.map((m) => m.san)];
    const children = graph
      .childrenOf(end)
      .map((m) => row(m, childPrefix))
      .sort(byWeakness);
    return { ...finish(tally), id: first.id, segment, prefix, transposes: false, children };
  };

  const lines = graph.childrenOf(graph.root).map((m) => row(m, [])).sort(byWeakness);
  return {
    total: finish(below(graph.root)),
    moves,
    lines,
    recentAccuracy: recentN ? (recentN - recentMiss) / recentN : undefined,
    recentAttempts: recentN,
  };
}

/** Weakest first; rows with nothing learned yet go last. */
function byWeakness(a: LineInsight, b: LineInsight): number {
  const ma = a.mastery ?? 1000;
  const mb = b.mastery ?? 1000;
  return ma - mb || b.moves - a.moves;
}

/**
 * "Train this line": the moves on the way to `key` plus every move reachable from it.
 * At the starting position that's the whole repertoire.
 */
export function movesForLine(graph: RepGraph, key: string): Set<string> {
  const out = new Set<string>();
  for (const m of graph.pathTo(key) ?? []) out.add(m.id);
  const seen = new Set<string>();
  const stack = [key];
  while (stack.length) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    for (const m of graph.childrenOf(k)) {
      out.add(m.id);
      stack.push(m.toKey);
    }
  }
  return out;
}

/** Ids of every move reachable below (and including) `moveId` — for "drill this line". */
export function movesUnder(graph: RepGraph, moveId: string): Set<string> {
  const start = graph.byId.get(moveId);
  const out = new Set<string>();
  if (!start) return out;
  out.add(start.id);
  const seen = new Set<string>();
  const stack = [start.toKey];
  while (stack.length) {
    const key = stack.pop()!;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const m of graph.childrenOf(key)) {
      out.add(m.id);
      stack.push(m.toKey);
    }
  }
  return out;
}
