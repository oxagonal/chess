/**
 * A one-time fix: review lines used to have you play moves you'd never learned (your moves after the
 * due one, to the end of the branch) without counting them, so the same moves came up again and again
 * and stayed "new". This gives you credit for them once — they count as learned — and remembers that
 * it ran (synced, so each device runs it once at most). Review lines now count them as you go (Train).
 */
import { db } from '../db/db';
import { markKnown } from '../db/repertoire';
import { trainingGraph, COLORS, loadScope } from '../db/scopes';
import { practicedUnlearned } from '../lib/trainer';
import type { ReviewCard } from '../lib/types';

export const PRACTICE_CREDIT_KEY = 'fix:practice-credit';

export interface PracticeCredit {
  at: number;
  /** How many moves now count as learned. */
  count: number;
  /** You've seen the note about it. */
  seen?: boolean;
}

/** The moves to credit: every scope a review can run on (each color, each chapter). Card ids. */
export async function findPracticedUnlearned(): Promise<string[]> {
  const [chapters, moves, cards, logs] = await Promise.all([
    db.repertoires.toArray(),
    db.moves.toArray(),
    db.cards.toArray(),
    db.reviewLog.toArray(),
  ]);
  const byId = new Map<string, ReviewCard>(cards.map((c) => [c.id, c]));
  const last = new Map<string, number>();
  for (const l of logs) if (l.source === 'review' && l.reviewedAt > (last.get(l.cardId) ?? 0)) last.set(l.cardId, l.reviewedAt);
  const out = new Set<string>();
  for (const id of [...COLORS, ...chapters.map((c) => c.id)]) {
    const scope = await loadScope(id);
    if (!scope) continue;
    // Scope graphs' move ids are card ids.
    const graph = trainingGraph(scope, moves);
    for (const cardId of practicedUnlearned(graph, (m) => byId.get(m.id), (cid) => last.get(cid))) out.add(cardId);
  }
  return [...out];
}

/** Run the fix once (per synced set of devices). Returns what it did, or undefined if it ran before. */
export async function creditPracticedMoves(): Promise<PracticeCredit | undefined> {
  if (await db.kv.get(PRACTICE_CREDIT_KEY)) return undefined;
  const ids = await findPracticedUnlearned();
  const count = ids.length ? await markKnown(ids) : 0;
  const value: PracticeCredit = { at: Date.now(), count, seen: count === 0 };
  await db.kv.put({ key: PRACTICE_CREDIT_KEY, value });
  return value;
}
