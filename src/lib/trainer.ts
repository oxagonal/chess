import type { RepGraph } from './graph';
import type { RepMove, ReviewCard } from './types';

/**
 * quiz: graded (review) · show: shown then quizzed (learn) · auto: played for you ·
 * practice: you play it, but it isn't graded (your known moves further down the branch).
 */
export type StepKind = 'quiz' | 'show' | 'auto' | 'practice';

export interface PlannedStep {
  move: RepMove;
  kind: StepKind;
}

export type TrainMode = 'review' | 'learn';

/**
 * Plan the next line to play through in a training session.
 *
 * Starting from the root, walk the shortest path to the target card's position, play the target move,
 * then keep extending the line through opponent replies whose continuation still contains pending
 * cards. Your moves along the way are quizzed (review) / shown (learn) if pending, else auto-played.
 * This mirrors how a real game unfolds: you always see the position arise from the starting position.
 */
export function planLine(graph: RepGraph, target: RepMove, pending: ReadonlySet<string>, mode: TrainMode): PlannedStep[] {
  const prefix = graph.pathTo(target.fromKey);
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

  // Then carry on down the branch to its end, like a game would: your (first) move on your turn,
  // the first saved reply on theirs.
  for (let guard = 0; guard < 400; guard++) {
    const kids = graph.childrenOf(key).filter((m) => !onLine.has(m.toKey));
    const next = graph.isMyTurn(key) ? kids.find((m) => m.mine) : kids[0];
    if (!next) break;
    line.push(next);
    onLine.add(next.toKey);
    key = next.toKey;
  }

  const targetIndex = prefix.length;
  const asked = new Set<string>();
  return line.map((move, i) => {
    if (move.mine && pending.has(move.id) && !asked.has(move.id)) {
      asked.add(move.id);
      return { move, kind: mode === 'learn' ? 'show' : 'quiz' };
    }
    // Your moves after the one being trained: you play them, ungraded.
    if (move.mine && i > targetIndex) return { move, kind: 'practice' };
    return { move, kind: 'auto' };
  });
}

/** Turn a learned line into the immediate test of the same line. */
export function asQuiz(steps: PlannedStep[]): PlannedStep[] {
  return steps.map((s) => (s.kind === 'show' ? { ...s, kind: 'quiz' } : s));
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
