/**
 * Spaced repetition built on FSRS (ts-fsrs). Each of *your* repertoire moves is a card.
 * Grades are derived automatically from how you answered (gradeForAnswer):
 *   correct first try → Good — or, with the answer timer, Hard when slow, and Easy when quick on a
 *   move already in regular reviews that you didn't miss last time (easyAllowed);
 *   correct after a wrong attempt / hint → Again.
 */
import { createEmptyCard, fsrs, Rating, State, type Card, type Grade } from 'ts-fsrs';
import type { ReviewCard } from './types';
import type { Color } from './chess';

export { Rating, State };
export type { Grade };

export interface SrsSettings {
  requestRetention: number; // 0.7 .. 0.97
  maximumIntervalDays: number;
}

export const DEFAULT_SRS: SrsSettings = { requestRetention: 0.9, maximumIntervalDays: 365 };

function scheduler(s: SrsSettings) {
  return fsrs({
    request_retention: s.requestRetention,
    maximum_interval: s.maximumIntervalDays,
    enable_fuzz: true,
    enable_short_term: true,
  });
}

export function newCard(base: { id: string; color: Color; fromKey: string; san: string }, now = Date.now()): ReviewCard {
  const c = createEmptyCard(new Date(now));
  return { ...base, ...fromFsrs(c), createdAt: now };
}

function toFsrs(card: ReviewCard): Card {
  return {
    due: new Date(card.due),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsedDays,
    scheduled_days: card.scheduledDays,
    learning_steps: card.learningSteps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state as State,
    last_review: card.lastReview ? new Date(card.lastReview) : undefined,
  };
}

function fromFsrs(c: Card) {
  return {
    due: c.due.getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsedDays: c.elapsed_days,
    scheduledDays: c.scheduled_days,
    learningSteps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state as number,
    lastReview: c.last_review ? c.last_review.getTime() : undefined,
  };
}

export function grade(card: ReviewCard, rating: Grade, settings: SrsSettings = DEFAULT_SRS, now = Date.now()): ReviewCard {
  const { card: next } = scheduler(settings).next(toFsrs(card), new Date(now), rating);
  return { ...card, ...fromFsrs(next) };
}

/** The longest a quick answer can take and still be Easy, whatever the timer: Easy means you knew it at once. */
export const EASY_MAX_MS = 2000;

/** How quick an answer must be to count as Easy: the first quarter of the timer, at most EASY_MAX_MS. */
export const easyWithin = (limitMs: number) => Math.min(limitMs / 4, EASY_MAX_MS);

/**
 * The grade for an answer. `ms`: how long it took, `limitMs`: the answer timer (0 or no `ms`: untimed).
 * Correct within the time is Good, slower Hard; a miss is Again. Easy is kept for answers that are
 * quick (easyWithin) on a move where it's allowed (`easyOk`, see easyAllowed) — FSRS gives Easy a big
 * bonus, so it must mean "knew it at once", not "played it fast": otherwise a quick answer is Good.
 */
export function gradeForAnswer(missed: boolean, ms?: number, limitMs = 0, easyOk = true): Grade {
  if (missed) return Rating.Again;
  if (!limitMs || ms === undefined) return Rating.Good;
  if (ms > limitMs) return Rating.Hard;
  return easyOk && ms <= easyWithin(limitMs) ? Rating.Easy : Rating.Good;
}

/**
 * Whether a quick answer on this move may count as Easy: it's in regular reviews (not new, still in its
 * learning steps, or relearning after a miss — Easy would skip those steps) and your last answer on it
 * (`lastRating`, training or a game) wasn't a miss.
 */
export function easyAllowed(card: Pick<ReviewCard, 'state'>, lastRating?: number): boolean {
  return card.state === State.Review && lastRating !== Rating.Again;
}

/**
 * A drill: you practice a move whether or not it's due. A correct answer on a move that isn't due
 * yet restarts its current interval from today — as if its last review had been today — instead of
 * growing it: an early review proves little, and drilling a move again and again (even on different
 * days) must not push it months away. Only real reviews, when it's due, lengthen the interval.
 * Misses, moves that are due anyway, and moves still in their (re)learning steps are graded as usual.
 */
export function gradeAhead(card: ReviewCard, rating: Grade, settings: SrsSettings = DEFAULT_SRS, now = Date.now()): ReviewCard {
  // (A quick answer, Easy, is still only an early review: it restarts the interval like Good.)
  if ((rating !== Rating.Good && rating !== Rating.Easy) || card.state !== State.Review || card.due <= now || card.lastReview === undefined) {
    return grade(card, rating, settings, now);
  }
  const interval = card.due - card.lastReview;
  return { ...card, due: now + interval, lastReview: now, elapsedDays: 0, reps: card.reps + 1 };
}

/** Predicted next interval (ms) for each grade — used for "next review in …" hints. */
export function previewIntervals(card: ReviewCard, settings: SrsSettings = DEFAULT_SRS, now = Date.now()) {
  const preview = scheduler(settings).repeat(toFsrs(card), new Date(now));
  return {
    again: preview[Rating.Again].card.due.getTime() - now,
    good: preview[Rating.Good].card.due.getTime() - now,
  };
}

export function isNew(card: ReviewCard): boolean {
  return card.state === State.New;
}

export function isDue(card: ReviewCard, now = Date.now()): boolean {
  return card.state !== State.New && card.due <= now;
}

/** A card is "mature" once its scheduled interval reaches three weeks. */
export function isMature(card: ReviewCard): boolean {
  return card.state === State.Review && card.scheduledDays >= 21;
}

export function formatInterval(ms: number): string {
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (ms < hour) return `${Math.max(1, Math.round(ms / min))}m`;
  if (ms < day) return `${Math.round(ms / hour)}h`;
  if (ms < 30 * day) return `${Math.round(ms / day)}d`;
  if (ms < 365 * day) return `${Math.round(ms / (30 * day))}mo`;
  return `${(ms / (365 * day)).toFixed(1)}y`;
}

/** Probability (0..1) that you still remember the move right now; undefined for unlearned cards. */
export function retrievability(card: ReviewCard, now = Date.now(), settings: SrsSettings = DEFAULT_SRS): number | undefined {
  if (card.state === State.New) return undefined;
  return scheduler(settings).get_retrievability(toFsrs(card), new Date(now), false);
}

/** FSRS difficulty (1–10) bucketed for display. */
export function difficultyLabel(card: ReviewCard): 'new' | 'easy' | 'medium' | 'hard' {
  if (card.state === State.New) return 'new';
  if (card.difficulty < 4.5) return 'easy';
  if (card.difficulty < 7) return 'medium';
  return 'hard';
}
