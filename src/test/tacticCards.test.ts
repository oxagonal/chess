import { describe, expect, it } from 'vitest';
import { gameCards, isDueCard, missedCard, REVIEW_DAYS, reviewed, startOfDay } from '../lib/tacticCards';
import { puzzleStart } from '../lib/puzzle';
import type { StoredGame } from '../lib/types';
import type { LichessPuzzle } from '../lib/puzzle';

const puzzle = { game: { id: 'g', pgn: 'e4' }, puzzle: { id: 'abc', rating: 1800, plays: 1, solution: ['e2e4'], themes: [], initialPly: 0 } } as unknown as LichessPuzzle;
const DAY = 86_400_000;
const noon = new Date(2026, 10, 22, 12, 0).getTime();

describe('missed puzzles as spaced cards', () => {
  it('a miss comes back the next day, not in an hour', () => {
    const c = missedCard(puzzle, noon);
    expect(c.id).toBe('p:abc');
    expect(c.due).toBe(startOfDay(noon) + DAY);
    expect(isDueCard(c, noon + 3 * 3600_000)).toBe(false);
    expect(isDueCard(c, startOfDay(noon) + DAY + 1)).toBe(true);
  });
  it('solved in time: 3 days, then done after two in a row; missed again: back to a day', () => {
    const c = missedCard(puzzle, noon);
    const once = reviewed(c, true, noon + DAY);
    expect([once.streak, once.step, once.retired]).toEqual([1, 1, undefined]);
    expect(once.due).toBe(startOfDay(noon + DAY) + REVIEW_DAYS[1] * DAY);
    const twice = reviewed(once, true, noon + 4 * DAY);
    expect(twice.retired).toBe(true);
    const again = reviewed(once, false, noon + 4 * DAY);
    expect([again.streak, again.step, again.retired]).toEqual([0, 0, undefined]);
    expect(again.due).toBe(startOfDay(noon + 4 * DAY) + DAY);
    expect(isDueCard(twice, noon + 100 * DAY)).toBe(false);
  });
  it('missing a puzzle you already had keeps when it was first missed', () => {
    const first = missedCard(puzzle, noon);
    const later = missedCard(puzzle, noon + 10 * DAY, reviewed(first, true, noon + DAY));
    expect([later.createdAt, later.streak, later.step]).toEqual([noon, 0, 0]);
  });
});

describe('mistakes in your games as cards', () => {
  it('your crucial swings (not theirs) become positions to solve: the engine move as the answer', () => {
    // 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6?? 4.Qxf7#. You are Black: 3...Nf6 is your blunder; 2.Qh5 isn't yours.
    const sans = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#'];
    const cp = (v: number) => ({ cp: v });
    const game = {
      id: 'lichess:abc', white: 'Opp', black: 'Me', whiteElo: 2000, blackElo: 2100, userColor: 'black', timeClass: 'blitz', playedAt: 5, sans,
      review: { depth: 18, analyzedAt: 1, complete: true, evals: [cp(30), cp(30), cp(20), cp(-50), cp(0), cp(10), { mate: 1 }, { mate: 0 }], best: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'd2d3', 'g7g6', 'h5f7', null] },
    } as unknown as StoredGame;
    const cards = gameCards(game, noon);
    expect(cards.map((c) => c.id)).toEqual(['g:lichess:abc:5']);
    const [c] = cards;
    expect([c.game!.played, c.game!.opponent, c.puzzle.puzzle.solution]).toEqual(['Nf6', 'Opp', ['g7g6']]);
    // It starts after White's 3.Bc4, Black to move.
    const start = puzzleStart(c.puzzle)!;
    expect([start.color, start.lastMove]).toEqual(['black', 'f1c4']);
    expect(c.due).toBe(startOfDay(noon) + DAY);
  });
});
