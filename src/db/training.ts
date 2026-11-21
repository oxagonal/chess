import { db } from './db';
import { getSettings, type AppSettings } from './settings';
import { COLORS, scopeIdsFor, scopeOf, trainingGraph, type Scope } from './scopes';
import { cardsOf } from '../lib/chapters';
import { filterByProbability } from '../lib/trainer';
import { isDue, isNew } from '../lib/srs';
import type { Color } from '../lib/chess';
import type { RepGraph } from '../lib/graph';
import type { Chapter, Collection, CoverageResult, RepMove, ReviewCard } from '../lib/types';

/**
 * The coverage run that decides which positions are likely enough to train (Settings → only likely
 * positions): the scope's own, else its color's — a chapter rarely has a run of its own, and how
 * often a position comes up doesn't depend on which chapter it's in.
 */
export function coverageFor(scope: Pick<Scope, 'id' | 'color'>, runs: readonly CoverageResult[] | undefined): CoverageResult | undefined {
  return runs?.find((r) => r.repId === scope.id) ?? runs?.find((r) => r.repId === scope.color);
}

/**
 * The cards Learn and Review take in a scope: your moves in its training graph — so not a move left
 * out with "Don't train this move" (its card, your progress, is kept) or one only reached through
 * such a move — and, with "only train likely positions" on and a coverage run, the common enough
 * ones. Every count of what's due or new comes from here as well, so none of them promises a review
 * that the session then doesn't have.
 */
export function trainedCards(
  scope: Pick<Scope, 'id' | 'color'>,
  graph: RepGraph,
  cards: readonly ReviewCard[],
  settings: Pick<AppSettings, 'trainOnlyLikely'>,
  runs: readonly CoverageResult[] | undefined,
): ReviewCard[] {
  const mine = cardsOf(graph, cards).filter((c) => c.color === scope.color);
  const cov = settings.trainOnlyLikely ? coverageFor(scope, runs) : undefined;
  return cov ? filterByProbability(mine, cov.probs, cov.threshold, cov.boost) : mine;
}

export interface TrainCounts {
  due: number;
  fresh: number;
}

export interface TrainingData {
  chapters: readonly Chapter[];
  collections: readonly Collection[];
  moves: readonly RepMove[];
  cards: readonly ReviewCard[];
  settings: Pick<AppSettings, 'trainOnlyLikely' | 'scopeTargets'>;
  runs: readonly CoverageResult[] | undefined;
}

/** Due and new moves of a Train link's scope ('all' is both colors; `chapterIds` narrows it). */
export function trainCounts(param: string, data: TrainingData, now = Date.now(), chapterIds?: readonly string[]): TrainCounts {
  const counts = { due: 0, fresh: 0 };
  for (const id of scopeIdsFor(param)) {
    let scope = scopeOf(id, data.chapters, data.collections, data.settings);
    if (!scope) continue;
    if (chapterIds) scope = { ...scope, chapterIds: scope.chapterIds.filter((c) => chapterIds.includes(c)) };
    for (const c of trainedCards(scope, trainingGraph(scope, data.moves), data.cards, data.settings, data.runs)) {
      if (isDue(c, now)) counts.due++;
      else if (isNew(c)) counts.fresh++;
    }
  }
  return counts;
}

/** Everything the counts are worked out from (for live queries: they follow every change). */
export async function loadTrainingData(): Promise<TrainingData> {
  const [settings, chapters, collections, moves, cards, runs] = await Promise.all([
    getSettings(),
    db.repertoires.toArray(),
    db.collections.toArray(),
    db.moves.toArray(),
    db.cards.toArray(),
    db.coverage.toArray(),
  ]);
  return { settings, chapters, collections, moves, cards, runs };
}

/** Moves learned today (first answered today): what the daily new-move limit counts. */
export async function learnedTodayCount(): Promise<number> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const logs = await db.reviewLog.where('reviewedAt').aboveOrEqual(start.getTime()).toArray();
  return new Set(logs.filter((l) => l.state === 0).map((l) => l.cardId)).size;
}

/** What there is to train, everything and per color (for live queries: Home). */
export async function loadTrainCounts(now = Date.now()): Promise<Record<'all' | Color, TrainCounts>> {
  const data = await loadTrainingData();
  const [white, black] = COLORS.map((c) => trainCounts(c, data, now));
  return { all: { due: white.due + black.due, fresh: white.fresh + black.fresh }, white, black };
}

/** What there is to train in one scope (a Train link's: 'all', a color, `set:<id>` or a chapter). */
export async function loadScopeCounts(scopeId: string, now = Date.now()): Promise<TrainCounts> {
  return trainCounts(scopeId, await loadTrainingData(), now);
}

/** Moves due for review across everything (the Train tab's badge) — cheap while nothing is due at all. */
export async function loadDueCount(now = Date.now()): Promise<number> {
  const any = await db.cards.where('due').belowOrEqual(now).filter((c) => c.state !== 0).count();
  return any ? trainCounts('all', await loadTrainingData(), now).due : 0;
}
