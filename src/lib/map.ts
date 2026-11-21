/**
 * The repertoire map: each chapter as its lines, each line as strong as its weakest move.
 * A line is a path from the start to the end of a branch; a move into a position already reached
 * another way (a transposition) ends a line of its own, so every move you must know is on a line.
 * Pure: no DOM, no database.
 */
import type { RepGraph } from './graph';
import type { RepMove, ReviewCard, ReviewLogEntry } from './types';
import { cardIdOf } from './chapters';
import { grade, isDue, newCard, type SrsSettings } from './srs';
import type { Grade } from 'ts-fsrs';

/** How well you know a line, weakest first. */
export type Strength = 'new' | 'lapsed' | 'learning' | 'growing' | 'solid';
export const STRENGTHS: Strength[] = ['new', 'lapsed', 'learning', 'growing', 'solid'];
export const STRENGTH_LABEL: Record<Strength, string> = {
  new: 'Not learned',
  lapsed: 'Missed',
  learning: 'Learning',
  growing: 'Growing',
  solid: 'Solid',
};
export const STRENGTH_HINT: Record<Strength, string> = {
  new: 'not learned yet',
  lapsed: 'a move on it was wrong the last time it came up in training',
  learning: 'next review in under a week',
  growing: 'next review in 1–4 weeks',
  solid: 'next review a month or more away',
};

const DAY = 86_400_000;

/** A card's strength: by its state, then how far off its next review is. */
export function strengthOf(card: Pick<ReviewCard, 'state' | 'scheduledDays'>): Strength {
  if (card.state === 0) return 'new';
  if (card.state === 3) return 'lapsed';
  if (card.state === 1 || card.scheduledDays < 7) return 'learning';
  return card.scheduledDays < 30 ? 'growing' : 'solid';
}

const rank = (s: Strength) => STRENGTHS.indexOf(s);
export const weakest = (list: Strength[]): Strength => list.reduce((a, b) => (rank(b) < rank(a) ? b : a), 'solid' as Strength);

export interface MapLine {
  /** The last move's id (unique per line). */
  id: string;
  path: RepMove[];
  /** Your cards on it, in order. */
  cards: ReviewCard[];
  strength: Strength;
  /** Some move on it is due for review. */
  due: boolean;
  /** Days the most overdue move has waited (0 = due today). */
  overdueDays: number;
  /** A move on it was reviewed today. */
  today: boolean;
  /** The shortest interval among its learned moves (ms), if any is learned. */
  interval?: number;
  reviews: number;
  /** When it came to exist (its newest move). */
  createdAt: number;
}

/**
 * A graph's lines as move paths, depth-first in the order the moves were added: each path runs from
 * the start to the end of a branch, or to a move into a position the tree reaches another way.
 */
export function linePaths(graph: RepGraph): RepMove[][] {
  const tree = graph.tree();
  const out: RepMove[][] = [];
  const walk = (key: string, path: RepMove[], seen: Set<string>) => {
    const kids = graph.childrenOf(key);
    if (!kids.length && path.length) out.push(path);
    for (const m of kids) {
      const next = [...path, m];
      // A move the tree reaches another way (or a loop) ends a line here; the position's own
      // continuation is written out where the tree reaches it.
      if (tree.get(m.toKey) !== m || seen.has(m.toKey)) {
        out.push(next);
        continue;
      }
      walk(m.toKey, next, new Set(seen).add(m.toKey));
    }
  };
  walk(graph.root, [], new Set([graph.root]));
  return out;
}

/** One line (a path of moves from the start) with where its cards stand. */
export function mapLine(path: RepMove[], cardById: ReadonlyMap<string, ReviewCard>, now = Date.now(), startOfToday = now - (now % DAY)): MapLine {
  const cards = path.filter((m) => m.mine).map((m) => cardById.get(cardIdOf(m))).filter((c): c is ReviewCard => !!c);
  const learned = cards.filter((c) => c.state !== 0);
  const due = cards.filter((c) => isDue(c, now));
  return {
    id: path[path.length - 1].id,
    path,
    cards,
    strength: cards.length ? weakest(cards.map(strengthOf)) : 'solid',
    due: due.length > 0,
    overdueDays: due.length ? Math.max(...due.map((c) => Math.floor((now - c.due) / DAY))) : 0,
    today: cards.some((c) => (c.lastReview ?? 0) >= startOfToday),
    interval: learned.length ? Math.min(...learned.map((c) => c.due - (c.lastReview ?? c.due))) : undefined,
    reviews: cards.reduce((n, c) => n + c.reps, 0),
    createdAt: Math.max(...path.map((m) => m.createdAt)),
  };
}

/** A chapter's lines, in the order they appear (depth-first, main moves first). */
export function chapterLines(graph: RepGraph, cardById: ReadonlyMap<string, ReviewCard>, now = Date.now(), startOfToday = now - (now % DAY)): MapLine[] {
  // Lines with none of your moves on them (an opponent move ending a branch) don't need knowing.
  return linePaths(graph)
    .map((p) => mapLine(p, cardById, now, startOfToday))
    .filter((l) => l.cards.length > 0);
}

/** Share of lines at each strength. */
export function strengthCounts(lines: readonly Pick<MapLine, 'strength'>[]): Record<Strength, number> {
  const c = Object.fromEntries(STRENGTHS.map((s) => [s, 0])) as Record<Strength, number>;
  for (const l of lines) c[l.strength]++;
  return c;
}

/**
 * How many lines stood at each strength at the end of each of the last `days` days, by replaying
 * each card's review log through the scheduler (drills count like reviews, so it's close rather
 * than exact). Lines count from the day their newest move was added. The last day uses the cards
 * as they are now.
 */
export function strengthHistory(
  lines: readonly MapLine[],
  logs: readonly ReviewLogEntry[],
  srs: SrsSettings | undefined,
  days: number,
  now = Date.now(),
  startOfToday = now - (now % DAY),
): { day: number; counts: Record<Strength, number> }[] {
  const byCard = new Map<string, ReviewLogEntry[]>();
  for (const l of logs) {
    const arr = byCard.get(l.cardId);
    if (arr) arr.push(l);
    else byCard.set(l.cardId, [l]);
  }
  const endOfToday = startOfToday + DAY - 1;
  const ends = Array.from({ length: days }, (_, i) => endOfToday - (days - 1 - i) * DAY);
  // Each card's strength at the end of each day.
  const timeline = new Map<string, Strength[]>();
  for (const line of lines)
    for (const card of line.cards) {
      if (timeline.has(card.id)) continue;
      const entries = (byCard.get(card.id) ?? []).slice().sort((a, b) => a.reviewedAt - b.reviewedAt);
      let c = newCard({ id: card.id, color: card.color, fromKey: card.fromKey, san: card.san }, card.createdAt);
      let i = 0;
      timeline.set(
        card.id,
        ends.map((end, d) => {
          if (d === ends.length - 1) return strengthOf(card);
          while (i < entries.length && entries[i].reviewedAt <= end) {
            c = grade(c, entries[i].rating as Grade, srs, entries[i].reviewedAt);
            i++;
          }
          return strengthOf(c);
        }),
      );
    }
  return ends.map((end, d) => {
    const counts = Object.fromEntries(STRENGTHS.map((s) => [s, 0])) as Record<Strength, number>;
    for (const line of lines) {
      if (line.createdAt > end) continue;
      counts[weakest(line.cards.map((c) => timeline.get(c.id)![d]))]++;
    }
    return { day: end + 1 - DAY, counts };
  });
}

/** A chapter's games, as probabilities (shares of all your games with its color). */
export interface ChapterGames {
  /** How often games come into the chapter. */
  games: number;
  /** …and stay in its lines until positions get rarer than the target. */
  inLines: number;
  /** …leave them while still more common than the target. */
  uncovered: number;
  /** …leave by an opponent move rarer than the target (rare sidelines). */
  rare: number;
}

const unit = (x: number) => Math.min(1, Math.max(0, x));

/**
 * How a coverage run shares out a chapter's games. They come in at `entries`: its opening's position
 * when the move there is yours, else the opponent's replies there that the chapter answers. With
 * `unanswered`, the chapter also takes the replies at its opening's position that no chapter answers
 * (`answered`: where every chapter's replies there lead) — the chapter, or catch-all, that starts there.
 * Coverage counts rare sidelines as covered, so in its lines = covered − rare. Undefined when the run
 * hasn't priced these positions.
 */
export function chapterGames(
  run: { probs: Record<string, number>; coverage?: Record<string, number>; sidelines?: Record<string, number> },
  entries: readonly string[],
  unanswered?: { anchor: string; answered: readonly string[] },
): ChapterGames | undefined {
  const coverage = run.coverage;
  if (!coverage) return undefined;
  const split = (k: string) => {
    const p = run.probs[k] ?? 0;
    const c = unit(coverage[k] ?? 0);
    const r = Math.min(c, unit(run.sidelines?.[k] ?? 0));
    return { p, inLines: p * (c - r), rare: p * r, uncovered: p * (1 - c) };
  };
  const out: ChapterGames = { games: 0, inLines: 0, uncovered: 0, rare: 0 };
  for (const e of entries) {
    const s = split(e);
    out.games += s.p;
    out.inLines += s.inLines;
    out.rare += s.rare;
    out.uncovered += s.uncovered;
  }
  if (unanswered) {
    // What leaves your prep at the opening's position, less what leaves it after the answered replies.
    const at = split(unanswered.anchor);
    let uncovered = at.uncovered;
    let rare = at.rare;
    for (const k of new Set(unanswered.answered)) {
      const s = split(k);
      uncovered -= s.uncovered;
      rare -= s.rare;
    }
    out.uncovered += Math.max(0, uncovered);
    out.rare += Math.max(0, rare);
    out.games += Math.max(0, uncovered) + Math.max(0, rare);
  }
  return out.games > 0 ? out : undefined;
}
