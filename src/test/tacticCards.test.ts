import { describe, expect, it } from 'vitest';
import { cardPly, gameCards, gameMistakes, isDueCard, missedCard, mistakeAt, needsUpgrade, REVIEW_DAYS, reviewed, startOfDay } from '../lib/tacticCards';
import { puzzleStart } from '../lib/puzzle';
import { missedTactics } from '../lib/review';
import { playSan, startPos } from '../lib/chess';
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
  it('a blunder where many moves held becomes their punishment to find (your crucial swings, not theirs)', () => {
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
    // About equal before 3...Nf6?? (many moves held): find White's punishment, 4.Qxf7#; then a better move than Nf6 (g6).
    expect([c.game!.kind, c.game!.played, c.game!.opponent, c.puzzle.puzzle.solution, c.game!.betterMove]).toEqual(['punish', 'Nf6', 'Opp', ['h5f7'], 'g7g6']);
    // It starts after your 3...Nf6, White to move (the board turned your way by the solver).
    const start = puzzleStart(c.puzzle)!;
    expect([start.color, start.lastMove]).toEqual(['white', 'g8f6']);
    expect(c.due).toBe(startOfDay(noon) + DAY);
  });
});

describe('a blunder when you were already losing', () => {
  it('many moves kept it at about −4, yours lost more: their punishment to find; old cards are sorted again', () => {
    const sans = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#'];
    const cp = (v: number) => ({ cp: v });
    // You are Black; before 3...Nf6 White is +3.95, the second-best move +4.47 (barely worse).
    const evals = [cp(30), cp(30), cp(20), cp(300), cp(380), cp(395), { mate: 1 }, { mate: 0 }];
    const game = {
      id: 'lichess:x:y', white: 'Opp', black: 'Me', userColor: 'black', timeClass: 'blitz', playedAt: 5, sans,
      review: { depth: 18, analyzedAt: 1, complete: true, evals, second: evals.map((_, i) => (i === 5 ? cp(447) : null)), best: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'd2d3', 'g7g6', 'h5f7', null] },
    } as unknown as StoredGame;
    const m = mistakeAt(game, 5);
    expect([m.kind, m.reply]).toEqual(['punish', 'h5f7']);
    const [c] = gameCards(game, noon).filter((x) => x.id.endsWith(':5'));
    // The game's id has colons; the move's index is the last part.
    expect([cardPly(c), c.game!.best, c.game!.after]).toEqual([5, cp(395), { mate: 1 }]);
    expect(needsUpgrade(c)).toBe(false);
    expect(needsUpgrade({ ...c, game: { ...c.game!, kind: undefined } })).toBe(true);
  });
});

describe('mistakes you marked yourself', () => {
  it('your ? and ?? moves count (not theirs), with the Stockfish box’s best move where it looked — no computer review needed', () => {
    const game = {
      id: 'g2', white: 'Me', black: 'Opp', userColor: 'white', timeClass: 'rapid', playedAt: 1,
      sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nd4'],
      annotations: { 2: { glyphs: ['?'] }, 3: { glyphs: ['??'] }, 4: { glyphs: ['!'] } },
      liveEvals: { 2: { cp: 40, depth: 20, best: 'd2d4' } },
    } as unknown as StoredGame;
    // Ply 2 (2.Nf3?) is yours and marked; ply 3 is theirs; ply 4 is marked "!".
    // About equal before it: a blunder — its card is their reply, which the engine hasn't seen yet.
    expect(gameMistakes(game)).toEqual([{ ply: 2, kind: 'punish', best: 'd2d4', before: { cp: 40, mate: undefined }, reply: undefined, after: undefined }]);
    expect(gameCards(game, noon)).toEqual([]);
    // With their reply known (the Stockfish box looked there too), it's a card.
    const seen = { ...game, liveEvals: { ...game.liveEvals, 3: { cp: 250, depth: 20, best: 'f8c5' } } } as unknown as StoredGame;
    expect(gameCards(seen, noon).map((c) => [c.id, c.game!.kind, c.puzzle.puzzle.solution[0], c.game!.played])).toEqual([['g:g2:2', 'punish', 'f8c5', 'Nf3']]);
    // Marked where Stockfish hasn't looked: found, but without the engine's move yet (added when it's made a card).
    const unseen = { ...game, liveEvals: undefined } as StoredGame;
    expect(gameMistakes(unseen)).toEqual([{ ply: 2, kind: 'punish', best: undefined, before: undefined, reply: undefined, after: undefined }]);
    expect(gameCards(unseen, noon)).toEqual([]);
  });
});

describe('missed tactics', () => {
  it('a strong move that stood out, not played — not when the second-best was about as good', () => {
    const sans = ['e4', 'e5', 'Nf3', 'd6', 'Bc4', 'Bg4', 'Nc3', 'g6', 'Nxe5', 'Bxd1', 'Bxf7+'];
    const ucis: string[] = [];
    let pos = startPos();
    for (const san of sans) {
      const r = playSan(pos, san)!;
      ucis.push(r.uci);
      pos = r.pos;
    }
    const ev = (cp: number) => ({ cp });
    // Before White's 5th move best play is +4 (ply 8); the move played leaves +0.2.
    const review = {
      depth: 18, analyzedAt: 1, complete: true,
      evals: [30, 30, 30, 40, 40, 40, 40, 40, 400, 20, 30, 30].map(ev),
      best: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'b1c3', 'g8f6', 'h2h3', 'f8g7', 'c3d5', 'g4d1', null, null],
    };
    expect(missedTactics(review, ucis).map((t) => [t.ply, t.mover])).toEqual([[8, 'white']]);
    // The second-best move nearly as good: no single move to find.
    const near = { ...review, second: review.evals.map((_, i) => (i === 8 ? ev(380) : null)) };
    expect(missedTactics(near, ucis)).toEqual([]);
    // Far below: still a missed tactic, with how far it stood out.
    const far = { ...review, second: review.evals.map((_, i) => (i === 8 ? ev(30) : null)) };
    expect(missedTactics(far, ucis)[0].gap).toBeGreaterThan(20);
    // Played as Black, it's their missed tactic: your 4...g6 was a blunder they let you off — its card is
    // the punishment they missed (5.Nd5), from your side of the board.
    const game = {
      id: 'g3', white: 'Opp', black: 'Me', userColor: 'black', timeClass: 'blitz', playedAt: 1, sans, review: far,
    } as unknown as StoredGame;
    const cards = gameCards(game, noon);
    expect(cards.map((c) => [c.id, c.game!.kind, c.game!.played, c.puzzle.puzzle.solution[0], c.game!.theyPlayed])).toContainEqual(['g:g3:7', 'punish', 'g6', 'c3d5', 'Nxe5']);
    expect(cards.every((c) => Number(c.id.split(':').pop()) % 2 === 1)).toBe(true);
  });
});
