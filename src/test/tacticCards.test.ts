import { describe, expect, it } from 'vitest';
import { isDueCard, missedCard, REVIEW_DAYS, reviewed, startOfDay } from '../lib/tacticCards';
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
