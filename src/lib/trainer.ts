import type { RepGraph } from './graph';
import type { RepMove, ReviewCard } from './types';
import { State } from './srs';

/**
 * quiz: graded (review) · show: shown then quizzed (learn; in a review, a move you never learned) ·
 * auto: played for you · practice: you play it, but it isn't graded (your known moves in a review
 * line; Learn never asks them).
 */
export type StepKind = 'quiz' | 'show' | 'auto' | 'practice';

export interface PlannedStep {
  move: RepMove;
  kind: StepKind;
  /** A practice move leading up to the trained one (review lines, played from move 1). */
  leadIn?: boolean;
}

export type TrainMode = 'review' | 'learn';

/**
 * Every distinct move order (path from the starting position) that reaches `key` through the
 * repertoire — a transposed position has several. Ordered most common first when reach
 * probabilities are known (estimated per path from the coverage run), else shortest first.
 */
export function moveOrders(graph: RepGraph, key: string, probs?: Record<string, number>, max = 8): RepMove[][] {
  const found: RepMove[][] = [];
  const onPath = new Set<string>([key]);
  const rev: RepMove[] = [];
  let budget = 20_000; // transposition-heavy repertoires: stop exploring rather than hang
  const walk = (k: string) => {
    if (found.length >= max * 4 || budget-- <= 0) return;
    if (k === graph.root) {
      found.push([...rev].reverse());
      return;
    }
    for (const m of graph.parentsOf(k)) {
      if (onPath.has(m.fromKey)) continue;
      onPath.add(m.fromKey);
      rev.push(m);
      walk(m.fromKey);
      rev.pop();
      onPath.delete(m.fromKey);
    }
  };
  walk(key);
  // A path's share ≈ product over the opponent's moves of how often that reply is chosen, read off
  // the coverage probabilities (exact unless the reply itself lands on a transposition).
  const weight = (path: RepMove[]) =>
    probs
      ? path.reduce((w, m) => (m.mine ? w : w * Math.min(1, (probs[m.toKey] ?? 0) / Math.max(probs[m.fromKey] ?? 0, 1e-12))), 1)
      : 0;
  const keyed = found.map((path) => ({ path, w: weight(path) }));
  keyed.sort((a, b) => b.w - a.w || a.path.length - b.path.length || a.path.map((m) => m.san).join().localeCompare(b.path.map((m) => m.san).join()));
  return keyed.slice(0, max).map((x) => x.path);
}

/**
 * Plan the next line to play through in a training session.
 *
 * Starting from the root, walk the path to the target card's position (`via`: one particular move
 * order, else the shortest), play the target move,
 * then keep extending the line through opponent replies whose continuation still contains pending
 * cards. Your moves along the way are quizzed (review) / shown (learn) if pending.
 * This mirrors how a real game unfolds: you always see the position arise from the starting position.
 *
 * Review (and drills) then carry on to the end of the branch and, with `leadIn`, have you play your
 * known moves from move 1 as ungraded practice. Learn only asks for the new moves: everything you
 * already know is played for you, and the line stops after the last new move.
 */
export interface PlanOptions {
  /** Also have you play your moves before the trained one, from move 1 (review only). */
  leadIn?: boolean;
  /** Which move order to reach the target by (see moveOrders); defaults to the shortest. */
  via?: RepMove[];
  /**
   * "Skip repeats": your moves already played this session. They're played for you instead of
   * asked (unless due), and the rest of the branch heads for moves you haven't played yet.
   */
  seen?: ReadonlySet<string>;
  /**
   * Review: your moves you never learned (move ids). Met in the line, they're taught right there —
   * shown, then replayed from memory at the line's end, like Learn — instead of asked cold.
   */
  teach?: ReadonlySet<string>;
}

export function planLine(graph: RepGraph, target: RepMove, pending: ReadonlySet<string>, mode: TrainMode, opts: PlanOptions = {}): PlannedStep[] {
  const { leadIn = false, via, seen, teach } = opts;
  const prefix = via ?? graph.pathTo(target.fromKey);
  if (!prefix) return [];
  const line: RepMove[] = [...prefix, target];
  const onLine = new Set(line.map((m) => m.fromKey));
  onLine.add(target.toKey);

  const memo = new Map<string, boolean>();
  const pendingBelow = (key: string, guard: Set<string>): boolean => {
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    if (guard.has(key)) return false;
    guard.add(key);
    let found = false;
    for (const m of graph.childrenOf(key)) {
      if ((m.mine && pending.has(m.id)) || pendingBelow(m.toKey, guard)) {
        found = true;
        break;
      }
    }
    guard.delete(key);
    memo.set(key, found);
    return found;
  };

  const taken = new Set(line.filter((m) => m.mine && pending.has(m.id)).map((m) => m.id));
  let key = target.toKey;
  for (let guard = 0; guard < 400; guard++) {
    const kids = graph.childrenOf(key).filter((m) => !onLine.has(m.toKey));
    let next: RepMove | undefined;
    if (graph.isMyTurn(key)) {
      next =
        kids.find((m) => pending.has(m.id) && !taken.has(m.id)) ??
        kids.find((m) => pendingBelow(m.toKey, new Set(onLine)));
    } else {
      next = kids.find((m) => pendingBelow(m.toKey, new Set(onLine)));
    }
    if (!next) break;
    line.push(next);
    if (next.mine && pending.has(next.id)) taken.add(next.id);
    onLine.add(next.toKey);
    key = next.toKey;
  }

  // With Skip repeats: does the branch below `key` still hold one of your moves not played this session?
  const freshMemo = new Map<string, boolean>();
  const freshBelow = (k: string, guard: Set<string>): boolean => {
    if (!seen) return false;
    const hit = freshMemo.get(k);
    if (hit !== undefined) return hit;
    if (guard.has(k)) return false;
    guard.add(k);
    const found = graph.childrenOf(k).some((m) => (m.mine && !seen.has(m.id)) || freshBelow(m.toKey, guard));
    guard.delete(k);
    freshMemo.set(k, found);
    return found;
  };

  // Review: then carry on down the branch to its end, like a game would — your (first) move on your
  // turn, the first saved reply on theirs; with Skip repeats, the way into moves you haven't played
  // yet this session. Learn stops here: the rest is moves you already know.
  for (let guard = 0; guard < 400 && mode === 'review'; guard++) {
    const kids = graph.childrenOf(key).filter((m) => !onLine.has(m.toKey));
    const fresh = (m: RepMove) => (m.mine && !seen?.has(m.id)) || freshBelow(m.toKey, new Set(onLine));
    const next = graph.isMyTurn(key)
      ? (seen && kids.find((m) => m.mine && fresh(m))) || kids.find((m) => m.mine)
      : (seen && kids.find(fresh)) || kids[0];
    if (!next) break;
    line.push(next);
    onLine.add(next.toKey);
    key = next.toKey;
  }

  const targetIndex = prefix.length;
  const asked = new Set<string>();
  return line.map((move, i) => {
    // Review: a move you never learned is taught where you meet it (even one being drilled).
    if (mode === 'review' && move.mine && teach?.has(move.id) && !asked.has(move.id)) {
      asked.add(move.id);
      return { move, kind: 'show' };
    }
    if (move.mine && pending.has(move.id) && !asked.has(move.id)) {
      asked.add(move.id);
      return { move, kind: mode === 'learn' ? 'show' : 'quiz' };
    }
    // Learn: moves you already know are played for you, never asked.
    if (mode === 'learn') return { move, kind: 'auto' };
    // Skip repeats: a known move you've already played this session is played for you.
    if (move.mine && seen?.has(move.id)) return { move, kind: 'auto' };
    // Your moves after the one being trained: you play them, ungraded.
    if (move.mine && i > targetIndex) return { move, kind: 'practice' };
    // Lead-in: you also play your moves from the starting position.
    if (move.mine && leadIn && i < targetIndex) return { move, kind: 'practice', leadIn: true };
    return { move, kind: 'auto' };
  });
}

/** Turn a learned line into the immediate test of the same line. */
export function asQuiz(steps: PlannedStep[]): PlannedStep[] {
  return steps.map((s) => (s.kind === 'show' ? { ...s, kind: 'quiz' } : s));
}

/**
 * After a review line that taught you new moves: the same line from move 1, quizzing just those
 * (from memory, like Learn's replay) — everything else is played for you.
 */
export function newMovesQuiz(steps: PlannedStep[]): PlannedStep[] {
  return steps.map((s) => ({ move: s.move, kind: s.kind === 'show' ? 'quiz' : 'auto' }));
}

/**
 * Order cards for a session: likeliest positions first (if reach probabilities are known),
 * then shallowest, then most overdue.
 */
export function orderCards(cards: ReviewCard[], graph: RepGraph, probs?: Record<string, number>): ReviewCard[] {
  const depths = graph.depths();
  return [...cards].sort((a, b) => {
    if (probs) {
      const pa = probs[a.fromKey] ?? 0;
      const pb = probs[b.fromKey] ?? 0;
      if (Math.abs(pa - pb) > 1e-12) return pb - pa;
    }
    const da = depths.get(a.fromKey) ?? 999;
    const db = depths.get(b.fromKey) ?? 999;
    if (da !== db) return da - db;
    return a.due - b.due;
  });
}

/** Keep only cards whose position is reached at least `threshold` of the time. */
export function filterByProbability(cards: ReviewCard[], probs: Record<string, number> | undefined, threshold: number): ReviewCard[] {
  if (!probs || threshold <= 0) return cards;
  return cards.filter((c) => (probs[c.fromKey] ?? 0) >= threshold);
}

/**
 * Your moves you never learned that review lines have had you play anyway: a review carries on past
 * the due move to the end of its branch, with your later moves as ungraded practice — new ones too.
 * Rebuilt from the graph (those answers weren't saved): each move reviewed (`lastReviewed`, when you
 * last reviewed it) planned as a review line would be, and the new moves among its practice ones
 * that already existed then. Card ids (via `cardIdOf`).
 */
export function practicedUnlearned(
  graph: RepGraph,
  cardOf: (move: RepMove) => ReviewCard | undefined,
  lastReviewed: (cardId: string) => number | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const move of graph.byId.values()) {
    if (!move.mine) continue;
    const card = cardOf(move);
    const at = card && lastReviewed(card.id);
    if (!card || !at) continue;
    for (const step of planLine(graph, move, new Set([move.id]), 'review', { leadIn: true })) {
      if (step.kind !== 'practice') continue;
      const c = cardOf(step.move);
      if (c && c.state === State.New && c.createdAt < at) out.add(c.id);
    }
  }
  return out;
}
