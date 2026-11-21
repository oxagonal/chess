import { describe, expect, it } from 'vitest';
import { RepGraph } from '../lib/graph';
import { movesFromLines } from '../lib/lines';
import { cardIdOf } from '../lib/chapters';
import { chapterLines, strengthCounts, strengthHistory, strengthOf, chapterGames } from '../lib/map';
import { grade, newCard, Rating } from '../lib/srs';
import type { ReviewCard, ReviewLogEntry } from '../lib/types';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 18, 12);
const TODAY = Date.UTC(2026, 10, 18);

describe('repertoire map', () => {
  // Black: 2.Nf3 e6 3.d4 cxd4 and 2.d4 cxd4 3.Nf3 e6 reach the same position (a transposition).
  const moves = movesFromLines('r', 'black', ['e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nf6', 'e4 c5 d4 cxd4 Nf3 e6', 'e4 c5 c3 d5']);
  const graph = new RepGraph('black', moves);
  const cardsFor = (state: (san: string) => Partial<ReviewCard>) =>
    new Map(
      graph.myMoves().map((m) => {
        const c = { ...newCard({ id: cardIdOf(m), color: 'black', fromKey: m.fromKey, san: m.san }, NOW - 40 * DAY), ...state(m.san) };
        return [c.id, c];
      }),
    );

  it('splits a chapter into lines, a transposition ending a line of its own', () => {
    const lines = chapterLines(graph, cardsFor(() => ({})), NOW, TODAY);
    expect(lines.map((l) => l.path.map((m) => m.san).join(' '))).toEqual([
      'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nf6',
      'e4 c5 d4 cxd4 Nf3 e6',
      'e4 c5 c3 d5',
    ]);
    expect(lines.every((l) => l.strength === 'new')).toBe(true);
  });

  it('rates each line by its weakest move, and marks due lines', () => {
    const learned = { state: 2, scheduledDays: 45, due: NOW + 20 * DAY, lastReview: NOW - 25 * DAY };
    const cards = cardsFor((san) => (san === 'd5' ? { state: 3, due: NOW - 2 * DAY, lastReview: TODAY + 1000 } : san === 'Nf6' ? { ...learned, scheduledDays: 10 } : learned));
    const lines = chapterLines(graph, cards, NOW, TODAY);
    expect(lines.map((l) => l.strength)).toEqual(['growing', 'solid', 'lapsed']);
    expect(lines[2]).toMatchObject({ due: true, overdueDays: 2, today: true });
    expect(strengthCounts(lines)).toMatchObject({ solid: 1, growing: 1, lapsed: 1, new: 0 });
    expect(strengthOf({ state: 1, scheduledDays: 0 })).toBe('learning');
  });

  it('replays reviews to show how strong the lines were on past days', () => {
    const c5 = graph.myMoves().find((m) => m.san === 'c5')!;
    const id = cardIdOf(c5);
    let card = newCard({ id, color: 'black', fromKey: c5.fromKey, san: 'c5' }, NOW - 10 * DAY);
    const logs: ReviewLogEntry[] = [];
    for (const t of [NOW - 3 * DAY, NOW - 2 * DAY]) {
      logs.push({ cardId: id, color: 'black', rating: Rating.Good, state: card.state, reviewedAt: t, source: 'review' });
      card = grade(card, Rating.Good, undefined, t);
    }
    const only = new RepGraph('black', moves.filter((m) => m.san === 'e4' || m.san === 'c5'));
    const lines = chapterLines(only, new Map([[id, card]]), NOW, TODAY);
    const hist = strengthHistory(lines, logs, undefined, 5, NOW, TODAY);
    expect(hist).toHaveLength(5);
    expect(hist[0].counts.new).toBe(1); // four days ago: not learned yet
    expect(hist[2].counts.new).toBe(0); // learned three days ago
    expect(hist[4].day).toBe(TODAY);
  });
});

describe("a chapter's games", () => {
  it('come in at its opening when the move there is yours, however little of them you cover', () => {
    // 1.e4 b6: 1 game in 100; 10% stay in your lines (half of those by rare sidelines).
    const run = { probs: { A: 0.01 }, coverage: { A: 0.1 }, sidelines: { A: 0.05 } };
    const g = chapterGames(run, ['A'])!;
    expect(g.games).toBeCloseTo(0.01);
    expect(g.inLines).toBeCloseTo(0.0005);
    expect(g.rare).toBeCloseTo(0.0005);
    expect(g.uncovered).toBeCloseTo(0.009);
  });

  it("come in by the replies it answers — and, for the chapter starting there, the replies nobody answers", () => {
    const run = {
      probs: { A: 0.2, Bc5: 0.1, Nf6: 0.06, h6: 0.01 },
      coverage: { A: 0.6, Bc5: 0.8, Nf6: 0.7, h6: 0.5 },
      sidelines: { A: 0.1, Bc5: 0.1, Nf6: 0.05, h6: 0.1 },
    };
    // Another chapter's opening is here too: only its own reply counts.
    const own = chapterGames(run, ['h6'])!;
    expect(own.games).toBeCloseTo(0.01);
    expect(own.inLines).toBeCloseTo(0.004);
    // The catch-all starting here also takes what leaves your prep by unanswered replies.
    const catchAll = chapterGames(run, ['h6'], { anchor: 'A', answered: ['Bc5', 'Nf6', 'h6'] })!;
    expect(catchAll.uncovered).toBeCloseTo(0.005 + (0.08 - 0.043));
    expect(catchAll.rare).toBeCloseTo(0.001 + (0.02 - 0.014));
    expect(catchAll.games).toBeCloseTo(0.01 + 0.037 + 0.006);
    expect(chapterGames({ probs: { A: 0.1 } }, ['A'])).toBeUndefined();
  });
});
