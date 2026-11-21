/**
 * The 1/3 rule (Noël Studer): training time split evenly between tactics, your games (playing and
 * reviewing them) and study — one study topic at a time, openings at most a third. Totals for a period
 * from what the app recorded (services/activity), what you logged and the games you played. Pure.
 */
import type { Activity, StoredGame, StudyTopic, Third } from './types';

export const THIRDS: Third[] = ['tactics', 'games', 'study'];
export const THIRD_LABEL: Record<Third, string> = { tactics: 'Tactics', games: 'Your games', study: 'Study' };
export const TOPIC_LABEL: Record<StudyTopic, string> = { openings: 'Openings', endgames: 'Endgames', positional: 'Positional play', other: 'Other' };
/** Speeds a played game can be (StoredGame.timeClass). */
export const SPEEDS = ['bullet', 'blitz', 'rapid', 'classical'] as const;

const MIN = 60_000;
const DAY = 86_400_000;

/** Monday 00:00 (local time) of the week `t` is in. */
export function weekStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** Typical length of a game when its clocks weren't recorded. */
const TYPICAL_MIN: Record<string, number> = { bullet: 2, blitz: 7, rapid: 20, classical: 60 };

/**
 * How long a game took, from the clocks after each move (seconds left): the time each side used,
 * added up (increments make it a little short), plus a second a move. Without clocks, a typical length.
 */
export function gameDurationMs(g: Pick<StoredGame, 'clocks' | 'sans' | 'timeClass'>): number {
  const c = g.clocks;
  if (c && c.length >= 4) {
    let used = 0;
    for (let i = 2; i < c.length; i++) used += Math.max(0, c[i - 2] - c[i]);
    return (used + c.length) * 1000;
  }
  return (TYPICAL_MIN[g.timeClass] ?? 0) * MIN;
}

export interface PlanTotals {
  /** By third (ms). */
  by: Record<Third, number>;
  total: number;
  /** Your games: playing them, and reviewing them. */
  playing: number;
  reviewing: number;
  /** Study, by topic. */
  topics: Record<StudyTopic, number>;
  /** How many games were played (of the counted speeds). */
  gamesPlayed: number;
  /** How many of those you've reviewed ("Done reviewing" in the game review). */
  gamesReviewed: number;
  /** The ones still to review, newest first. */
  toReview: string[];
}

/** Totals for activities and games between `from` and `to` (games of the given speeds count as play). */
export function planTotals(activities: readonly Activity[], games: readonly StoredGame[], from: number, to: number, speeds: readonly string[]): PlanTotals {
  const by: Record<Third, number> = { tactics: 0, games: 0, study: 0 };
  const topics: Record<StudyTopic, number> = { openings: 0, endgames: 0, positional: 0, other: 0 };
  let playing = 0;
  let reviewing = 0;
  for (const a of activities) {
    if (a.start < from || a.start >= to) continue;
    by[a.third] += a.ms;
    if (a.third === 'study') topics[a.topic ?? 'other'] += a.ms;
    if (a.third === 'games') {
      if (a.what === 'review') reviewing += a.ms;
      else playing += a.ms;
    }
  }
  let gamesPlayed = 0;
  let gamesReviewed = 0;
  const toReview: { id: string; at: number }[] = [];
  for (const g of games) {
    if (g.source === 'otb' || g.playedAt < from || g.playedAt >= to || !speeds.includes(g.timeClass)) continue;
    const ms = gameDurationMs(g);
    by.games += ms;
    playing += ms;
    gamesPlayed++;
    if (g.reviewedAt) gamesReviewed++;
    else toReview.push({ id: g.id, at: g.playedAt });
  }
  toReview.sort((a, b) => b.at - a.at);
  return { by, total: by.tactics + by.games + by.study, playing, reviewing, topics, gamesPlayed, gamesReviewed, toReview: toReview.map((x) => x.id) };
}

/** The third furthest behind its share of the target (or of what's been done, with no target). */
export function behind(t: PlanTotals, targetMs: number): Third {
  const goal = Math.max(targetMs, t.total) / 3;
  return THIRDS.reduce((a, b) => (goal - t.by[b] > goal - t.by[a] ? b : a));
}

/** Openings took more than a third of the training (with enough of it to say): Studer's cap. */
export function tooMuchOpenings(t: PlanTotals): boolean {
  return t.total >= 60 * MIN && t.topics.openings > t.total / 3;
}

/** A period's bounds: this week, last week, or the last 30 days. */
export function periodBounds(period: 'week' | 'last' | '30d', now = Date.now()): { from: number; to: number; days: number } {
  const w = weekStart(now);
  if (period === 'week') return { from: w, to: w + 7 * DAY, days: 7 };
  if (period === 'last') return { from: w - 7 * DAY, to: w, days: 7 };
  return { from: now - 30 * DAY, to: now + 1, days: 30 };
}

export const minutes = (ms: number) => Math.round(ms / MIN);

/** "1 h 25 min", "40 min". */
export function fmtDuration(ms: number): string {
  const m = minutes(ms);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}
