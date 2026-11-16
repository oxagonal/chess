import { describe, expect, it } from 'vitest';
import { RepGraph } from '../lib/graph';
import { movesFromLines } from '../lib/lines';
import { computeCoverage, oneIn, likelyPositions } from '../lib/coverage';
import { analyzeGame, summarize } from '../lib/prep';
import { parseLichessGame } from '../lib/importers/lichess';
import { parseChessComGame, archiveMonthIndex } from '../lib/importers/chesscom';
import { GameStatsIndex } from '../lib/mygames';
import { bandsForRating, toLichessRating } from '../lib/ratings';
import { keysAlong } from '../lib/pgn';
import { START_KEY } from '../lib/chess';
import type { PositionStats, Repertoire, StoredGame } from '../lib/types';

const stat = (moves: [string, string, number][]): PositionStats => {
  const ms = moves.map(([san, uci, n]) => ({ san, uci, white: n, draws: 0, black: 0 }));
  const total = ms.reduce((a, m) => a + m.white, 0);
  return { total, white: total, draws: 0, black: 0, moves: ms };
};

describe('coverage (1 in N)', () => {
  // Black repertoire vs 1.e4 / 1.d4
  const moves = movesFromLines('b', 'black', ['e4 c5 Nf3 d6', 'e4 c5 Nc3 Nc6', 'd4 Nf6']);
  const g = new RepGraph('black', moves);
  const keyAfter = (line: string) => keysAlong(line.split(' ')).keys.at(-1)!;

  const db: Record<string, PositionStats> = {
    [START_KEY]: stat([['e4', 'e2e4', 50], ['d4', 'd2d4', 30], ['c4', 'c2c4', 10], ['Nf3', 'g1f3', 10]]),
    [keyAfter('e4 c5')]: stat([['Nf3', 'g1f3', 60], ['Nc3', 'b1c3', 20], ['c3', 'c2c3', 20]]),
    [keyAfter('d4 Nf6')]: stat([['c4', 'c2c4', 100]]),
  };

  it('computes reach probabilities and finds gaps above the threshold', async () => {
    const res = await computeCoverage(g, async (k) => db[k], { repId: 'b', threshold: 1 / 20, source: 'lichess', paramsLabel: 't' });
    expect(res.probs[keyAfter('e4')]).toBeCloseTo(0.5);
    expect(res.probs[keyAfter('e4 c5 Nf3')]).toBeCloseTo(0.3);
    expect(res.probs[keyAfter('e4 c5 Nc3')]).toBeCloseTo(0.1);
    const gaps = res.gaps.map((x) => `${x.path.join(' ')} ${x.san} ${x.prob.toFixed(2)}`);
    // c4 and Nf3 on move 1 (10% each), 2.c3 (10%), and 3.c4 after 1.d4 Nf6 (30%)
    expect(gaps).toEqual(['d4 Nf6 c4 0.30', ' c4 0.10', ' Nf3 0.10', 'e4 c5 c3 0.10']);
    expect(res.unfinished).toEqual([]);
  });

  it('flags your-move positions with no prepared answer', async () => {
    const g2 = new RepGraph('black', movesFromLines('b', 'black', ['e4 c5 Nf3']));
    const res = await computeCoverage(g2, async (k) => db[k], { repId: 'b', threshold: 1 / 20, source: 'lichess', paramsLabel: 't' });
    expect(res.unfinished.map((u) => u.path.join(' '))).toEqual(['e4 c5 Nf3']);
  });

  it('does not look up positions below the cutoff', async () => {
    const asked: string[] = [];
    await computeCoverage(g, async (k) => (asked.push(k), db[k]), { repId: 'b', threshold: 0.35, source: 'lichess', paramsLabel: 't' });
    expect(asked).toEqual([START_KEY, keyAfter('e4 c5')]); // d4 line is 30% < 35%
  });

  it('lists likely positions and formats odds', async () => {
    const res = await computeCoverage(g, async (k) => db[k], { repId: 'b', threshold: 1 / 20, source: 'lichess', paramsLabel: 't' });
    expect(likelyPositions(g, res)[0].key).toBe(START_KEY);
    expect(oneIn(0.1)).toBe('1 in 10');
    expect(oneIn(1 / 37.2)).toBe('1 in 37');
    expect(oneIn(1)).toBe('every game');
  });
});

const game = (sans: string, color: 'white' | 'black', extra: Partial<StoredGame> = {}): StoredGame => ({
  id: Math.random().toString(36),
  source: 'lichess',
  account: 'me',
  url: '',
  white: 'a',
  black: 'b',
  userColor: color,
  result: '1-0',
  userScore: color === 'white' ? 1 : 0,
  timeClass: 'blitz',
  rated: true,
  playedAt: 1,
  sans: sans.split(' '),
  ...extra,
});

describe('prep analysis', () => {
  const rep: Repertoire = { id: 'w', name: 'White', color: 'white', createdAt: 0, updatedAt: 0 };
  const g = new RepGraph('white', movesFromLines('w', 'white', ['e4 c5 Nf3 d6 d4', 'e4 e5 Nf3 Nc6 Bb5']));
  const reps = [{ rep, graph: g }];

  it('detects forgotten prep', () => {
    const r = analyzeGame(game('e4 c5 Nf3 d6 c3 Nf6', 'white'), reps);
    expect(r.kind).toBe('you-deviated');
    expect(r.ply).toBe(4);
    expect(r.played).toBe('c3');
    expect(r.expected).toEqual(['d4']);
  });

  it('detects opponent deviations', () => {
    const r = analyzeGame(game('e4 c6 d4 d5', 'white'), reps);
    expect(r.kind).toBe('opponent-deviated');
    expect(r.played).toBe('c6');
  });

  it('detects end of prep and other openings', () => {
    expect(analyzeGame(game('e4 c5 Nf3 d6 d4 cxd4 Nxd4', 'white'), reps).kind).toBe('end-of-prep');
    expect(analyzeGame(game('d4 d5', 'white'), reps).kind).toBe('other-opening');
    expect(analyzeGame(game('e4 e5', 'black'), reps).kind).toBe('no-repertoire');
  });

  it('accepts transpositions back into the repertoire', () => {
    // 1.Nf3 is not prepared, but the rep (as white) has e4 e5 Nf3 Nc6 — test a black-side transposition instead
    const blackRep: Repertoire = { id: 'b', name: 'B', color: 'black', createdAt: 0, updatedAt: 0 };
    const gb = new RepGraph('black', movesFromLines('b', 'black', ['d4 Nf6 c4 e6 Nc3 Bb4', 'c4 e6 d4 Nf6 Nc3 Bb4']));
    const r = analyzeGame(game('d4 Nf6 c4 e6 Nc3 Bb4 Qc2', 'black'), [{ rep: blackRep, graph: gb }]);
    expect(r.kind).toBe('end-of-prep');
    expect(r.bookPlies).toBe(6);
  });

  it('summarizes forgotten moves and surprises', () => {
    const games = [game('e4 c5 Nf3 d6 c3', 'white'), game('e4 c5 Nf3 d6 Bc4', 'white'), game('e4 c6', 'white', { userScore: 0 })];
    const results = new Map(games.map((x) => [x.id, analyzeGame(x, reps)]));
    const s = summarize(games, results);
    expect(s.forgotten).toHaveLength(1);
    expect(s.forgotten[0].count).toBe(2);
    expect(s.forgotten[0].played).toEqual({ c3: 1, Bc4: 1 });
    expect(s.surprises[0].san).toBe('c6');
    expect(s.surprises[0].score).toBe(0);
  });
});

describe('importers', () => {
  it('parses a Lichess NDJSON game', () => {
    const g = parseLichessGame(
      {
        id: 'abcd1234',
        rated: true,
        variant: 'standard',
        speed: 'blitz',
        createdAt: 1700000000000,
        status: 'resign',
        players: { white: { user: { name: 'Opp', id: 'opp' }, rating: 1500 }, black: { user: { name: 'Me', id: 'me' }, rating: 1550 } },
        winner: 'black',
        opening: { eco: 'B20', name: 'Sicilian Defense', ply: 2 },
        moves: 'e4 c5 Nf3',
        clocks: [18000, 18000, 17900],
      },
      'Me',
    )!;
    expect(g.userColor).toBe('black');
    expect(g.result).toBe('0-1');
    expect(g.userScore).toBe(1);
    expect(g.sans).toEqual(['e4', 'c5', 'Nf3']);
    expect(g.clocks).toEqual([180, 180, 179]);
    expect(g.url).toBe('https://lichess.org/abcd1234/black');
  });

  it('skips variants and from-position games', () => {
    const base = { id: 'x', rated: true, speed: 'blitz', createdAt: 1, status: 'mate', players: { white: { user: { name: 'me', id: 'me' } }, black: {} }, moves: 'e4' };
    expect(parseLichessGame({ ...base, variant: 'chess960' }, 'me')).toBeUndefined();
    expect(parseLichessGame({ ...base, variant: 'standard', initialFen: '8/8/8/8/8/8/8/K6k w - - 0 1' }, 'me')).toBeUndefined();
  });

  it('parses a Chess.com archive game', () => {
    const pgn = `[Event "Live Chess"]
[Site "Chess.com"]
[White "Me"]
[Black "Opp"]
[Result "1/2-1/2"]
[ECO "C50"]
[ECOUrl "https://www.chess.com/openings/Italian-Game-3...Bc5"]

1. e4 {[%clk 0:04:59.9]} 1... e5 {[%clk 0:04:58.1]} 2. Nf3 {[%clk 0:04:57]} 2... Nc6 {[%clk 0:04:55]} 3. Bc4 {[%clk 0:04:50]} 3... Bc5 {[%clk 0:04:40]} 1/2-1/2`;
    const g = parseChessComGame(
      {
        url: 'https://www.chess.com/game/live/123',
        pgn,
        end_time: 1700000000,
        rated: true,
        uuid: 'uuid-1',
        time_class: 'blitz',
        rules: 'chess',
        eco: 'https://www.chess.com/openings/Italian-Game-3...Bc5',
        white: { username: 'Me', rating: 1200, result: 'agreed' },
        black: { username: 'Opp', rating: 1210, result: 'agreed' },
      },
      'me',
    )!;
    expect(g.id).toBe('chesscom:uuid-1');
    expect(g.userColor).toBe('white');
    expect(g.result).toBe('1/2-1/2');
    expect(g.sans).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']);
    expect(g.clocks?.[0]).toBeCloseTo(299.9);
    expect(g.opening).toBe('Italian Game');
    expect(g.eco).toBe('C50');
  });

  it('indexes archive months', () => {
    expect(archiveMonthIndex('https://api.chess.com/pub/player/x/games/2024/03')).toBe(2024 * 12 + 2);
  });
});

describe('my-games explorer + ratings', () => {
  it('counts moves per position', () => {
    const idx = new GameStatsIndex([game('e4 c5 Nf3', 'white'), game('e4 e5 Nf3', 'white'), game('d4 d5', 'black')], { color: 'white' });
    const s = idx.get(START_KEY)!;
    expect(s.total).toBe(2);
    expect(s.moves.map((m) => [m.san, m.white])).toEqual([['e4', 2]]);
  });

  it('picks explorer rating bands', () => {
    expect(bandsForRating(1650)).toEqual([1400, 1600]);
    expect(bandsForRating(1750)).toEqual([1600, 1800]);
    expect(bandsForRating(800)).toEqual([0, 1000]);
    expect(bandsForRating(2700)).toEqual([2200, 2500]);
    expect(toLichessRating(1500, 'chesscom-blitz')).toBe(1775);
  });
});

describe('per-position coverage score', () => {
  const moves = movesFromLines('b', 'black', ['e4 c5 Nf3 d6', 'e4 c5 Nc3 Nc6', 'd4 Nf6']);
  const g = new RepGraph('black', moves);
  const keyAfter = (line: string) => keysAlong(line.split(' ')).keys.at(-1)!;
  const db: Record<string, PositionStats> = {
    [START_KEY]: stat([['e4', 'e2e4', 50], ['d4', 'd2d4', 30], ['c4', 'c2c4', 10], ['Nf3', 'g1f3', 10]]),
    [keyAfter('e4 c5')]: stat([['Nf3', 'g1f3', 60], ['Nc3', 'b1c3', 20], ['c3', 'c2c3', 20]]),
    [keyAfter('d4 Nf6')]: stat([['c4', 'c2c4', 100]]),
  };

  it('scores each position and agrees with the gap total at the root', async () => {
    const res = await computeCoverage(g, async (k) => db[k], { repId: 'b', threshold: 1 / 20, source: 'lichess', paramsLabel: 't' });
    const leak = res.gaps.reduce((a, x) => a + x.prob, 0) + res.unfinished.reduce((a, x) => a + x.prob, 0);
    expect(res.coverage![START_KEY]).toBeCloseTo(1 - leak);
    // After 1.e4 c5 white plays Nf3 (60%, covered), Nc3 (20%, covered) or c3 (20%, gap)
    expect(res.coverage![keyAfter('e4 c5')]).toBeCloseTo(0.8);
    expect(res.coverage![keyAfter('e4')]).toBeCloseTo(0.8); // our only move c5
    // After 1.d4 Nf6 everyone plays 2.c4, which we don't answer
    expect(res.coverage![keyAfter('d4 Nf6')]).toBeCloseTo(0);
    // Positions below the threshold require nothing
    expect(res.coverage![keyAfter('e4 c5 Nc3 Nc6')]).toBe(1);
  });
});
