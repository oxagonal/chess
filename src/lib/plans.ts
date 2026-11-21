/**
 * Plans: what you're aiming for once the moves run out — written at the end of a line (or at a key
 * position earlier, where several lines share it). A plan is stored on the move that reaches the
 * position, and found by position, so transposed lines share it. Pure.
 */
import type { RepGraph } from './graph';
import type { RepMove } from './types';

/** A plan covers the line ends up to this many plies after it (5 moves each). */
export const PLAN_REACH = 10;

/** A plan, and the move whose position it's for. */
export interface PlanRef {
  text: string;
  move: RepMove;
}

/** Plans by position: the position after a move with a plan. */
export function plansByKey(moves: Iterable<RepMove>): Map<string, PlanRef> {
  const out = new Map<string, PlanRef>();
  for (const m of moves) {
    const text = m.plan?.trim();
    if (text && !out.has(m.toKey)) out.set(m.toKey, { text, move: m });
  }
  return out;
}

/**
 * own: the line ends on a plan · near: one is at most PLAN_REACH plies back · confirmed: one further
 * back, which you said still applies here · far: only one further back · none: no plan on the line.
 */
export type PlanStatus = 'own' | 'near' | 'confirmed' | 'far' | 'none';

export interface PlanCover {
  /** The nearest plan on the line, at or before its end, and how many plies back it is. */
  plan?: PlanRef;
  back?: number;
  status: PlanStatus;
}

/** The plan that covers the end of a line (`path`: from the start), and how well. */
export function planCover(path: readonly RepMove[], plans: ReadonlyMap<string, PlanRef>): PlanCover {
  const end = path[path.length - 1];
  for (let i = path.length - 1; i >= 0; i--) {
    const plan = plans.get(path[i].toKey);
    if (!plan) continue;
    const back = path.length - 1 - i;
    const status: PlanStatus = back === 0 ? 'own' : back <= PLAN_REACH ? 'near' : end?.planStill ? 'confirmed' : 'far';
    return { plan, back, status };
  }
  return { status: 'none' };
}

/** A line that wants a plan: nothing on it, or only a plan far back that you haven't confirmed. */
export const needsPlan = (c: PlanCover) => c.status === 'none' || c.status === 'far';

export interface LineEnd extends PlanCover {
  /** The line from the start; its last move is yours. */
  path: RepMove[];
}

/**
 * Your line ends: your moves with nothing after them (a line that ends on their move is a gap — for
 * coverage, not a plan), each with the plan that covers it.
 */
export function lineEnds(graph: RepGraph, plans: ReadonlyMap<string, PlanRef> = plansByKey(graph.byId.values())): LineEnd[] {
  const out: LineEnd[] = [];
  for (const key of graph.leaves()) {
    const path = graph.pathTo(key);
    if (!path?.length || !path[path.length - 1].mine) continue;
    out.push({ path, ...planCover(path, plans) });
  }
  return out;
}

/**
 * The plan for a line you're training, which may stop before its end (Learn stops after the last new
 * move): the nearest plan on it, or else the first one on the way on (your first move, their first
 * saved reply) — where the line is going.
 */
export function planAhead(graph: RepGraph, path: readonly RepMove[], plans: ReadonlyMap<string, PlanRef>): PlanRef | undefined {
  const here = planCover(path, plans);
  if (here.plan && here.status !== 'far') return here.plan;
  let key = path.length ? path[path.length - 1].toKey : graph.root;
  const seen = new Set([key]);
  for (let guard = 0; guard < 60; guard++) {
    const next = graph.childrenOf(key)[0];
    if (!next || seen.has(next.toKey)) break;
    const plan = plans.get(next.toKey);
    if (plan) return plan;
    key = next.toKey;
    seen.add(key);
  }
  return here.plan;
}
