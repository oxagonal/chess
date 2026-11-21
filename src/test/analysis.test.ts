import { describe, expect, it } from 'vitest';
import { RepGraph } from '../lib/graph';
import { movesFromLines } from '../lib/lines';
import { computeCoverage, oneIn, oneInShort, likelyPositions, DEEPER } from '../lib/coverage';
import { analyzeGame, summarize } from '../lib/prep';
import { parseLichessGame } from '../lib/importers/lichess';
import { parseChessComGame, archiveMonthIndex } from '../lib/importers/chesscom';
import { GameStatsIndex, pathToPosition, positionFinder } from '../lib/mygames';
import { bandsForRating, toLichessRating } from '../lib/ratings';
import { keysAlong } from '../lib/pgn';
import { START_KEY, playSan, playUci, startPos } from '../lib/chess';
import type { PositionStats, Repertoire, StoredGame } from '../lib/types';

const stat = (moves: [string, string, number][]): PositionStats => {
  const ms = moves.map(([san, uci, n]) => ({ san, uci, white: n, draws: 0, black: 0 }));
  const total = ms.reduce((a, m) => a + m.white, 0);
  return { total, white: total, draws: 0, black: 0, moves: ms };
};

describe('coverage (1 in N)', () => {
  it('keeps 1 in N short like a count of games', () => {
    expect([1, 0.4, 1 / 142, 1 / 1234, 1 / 14800, 1 / 1_400_000].map(oneInShort)).toEqual(['1', '2.5', '142', '1.2K', '14.8K', '1.4M']);
  });
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

  it('prepares deeper after a move marked so: replies 10× rarer than the goal need an answer there', async () => {
    const lines = movesFromLines('b', 'black', ['e4 c5 Nf3 d6']);
    const stats: Record<string, PositionStats> = {
      [START_KEY]: stat([['e4', 'e2e4', 90], ['g3', 'g2g3', 6], ['b3', 'b2b3', 4]]),
      [keyAfter('e4 c5')]: stat([['Nf3', 'g1f3', 97], ['a3', 'a2a3', 3]]),
    };
    const run = (ms: typeof lines) => computeCoverage(new RepGraph('black', ms), async (k) => stats[k], { repId: 'b', threshold: 1 / 20, source: 'lichess', paramsLabel: 't' });
    const plain = await run(lines);
    expect(plain.gaps.map((x) => x.san)).toEqual(['g3']);
    // 1...c5 starts a sharp line: 2.a3 (2.7% of games, rarer than 1 in 20) now needs an answer.
    const sharp = await run(lines.map((m) => (m.san === 'c5' ? { ...m, deeper: true } : m)));
    expect(sharp.gaps.map((x) => [x.san, x.boost])).toEqual([['g3', undefined], ['a3', 'deeper']]);
    expect(sharp.probs[keyAfter('e4 c5')]).toBeCloseTo(plain.probs[keyAfter('e4 c5')]); // how often: unchanged
    expect(1 - sharp.coverage![START_KEY]).toBeCloseTo(0.06 + 0.9 * 0.03);
    expect(sharp.boost![keyAfter('e4 c5')]).toBe(DEEPER);
    expect(sharp.boost![START_KEY]).toBeUndefined();
  });

  it('finds sharp lines with the engine: rarer than the goal, but only one or two of your moves hold', async () => {
    // After 1.e4 c5: 2.a3 is rare (2.7% < 1 in 20). Where 2.a3 is sharp for Black, it needs an answer;
    // then the line goes on at the deeper goal while it stays sharp, and stops where it's quiet.
    const lines = movesFromLines('b', 'black', ['e4 c5 Nf3 d6', 'e4 c5 a3 Nc6']);
    const stats: Record<string, PositionStats> = {
      [START_KEY]: stat([['e4', 'e2e4', 90], ['g3', 'g2g3', 6], ['b3', 'b2b3', 4]]),
      [keyAfter('e4 c5')]: stat([['Nf3', 'g1f3', 97], ['a3', 'a2a3', 3]]),
      [keyAfter('e4 c5 a3 Nc6')]: stat([['b4', 'b2b4', 60], ['Nf3', 'g1f3', 40]]),
    };
    const sharpAfter = new Set([keyAfter('e4 c5 a3'), keyAfter('e4 c5 a3 Nc6 b4')]);
    const asked: string[] = [];
    const sharp = async (_from: string, _uci: string, to: string) => (asked.push(to), sharpAfter.has(to));
    const res = await computeCoverage(new RepGraph('black', lines), async (k) => stats[k], {
      repId: 'b',
      threshold: 1 / 20,
      source: 'lichess',
      paramsLabel: 't',
      sharp,
    });
    // 2.a3 is answered (1...Nc6), so no gap there; 3.b4 is sharp and unanswered: a gap; 3.Nf3 is quiet.
    expect(res.gaps.map((x) => [x.path.concat(x.san).join(' '), x.boost])).toEqual([
      ['g3', undefined],
      ['e4 c5 a3 Nc6 b4', 'sharp'],
    ]);
    expect(res.boost![keyAfter('e4 c5 a3')]).toBe(DEEPER);
    expect(res.boost![keyAfter('e4 c5')]).toBeUndefined();
    // Only the rare replies that could matter were asked about — not 1.b3 (its position needs no answer) or 2.Nf3.
    expect(asked).not.toContain(keyAfter('e4 c5 Nf3'));
    expect(asked).toContain(keyAfter('e4 c5 a3 Nc6 Nf3'));
    // Without the engine: as before.
    const plain = await computeCoverage(new RepGraph('black', lines), async (k) => stats[k], { repId: 'b', threshold: 1 / 20, source: 'lichess', paramsLabel: 't' });
    expect(plain.gaps.map((x) => x.san)).toEqual(['g3']);
  });

  it('splits the covered games into your lines and rare sidelines', async () => {
    // 1.b3 (4%) is rarer than 1 in 20, 1.g3 (6%) is a gap; after 1.e4 c5, 2.a3 (3% of those games) is rare.
    const g3 = new RepGraph('black', movesFromLines('b', 'black', ['e4 c5 Nf3 d6']));
    const stats: Record<string, PositionStats> = {
      [START_KEY]: stat([['e4', 'e2e4', 90], ['g3', 'g2g3', 6], ['b3', 'b2b3', 4]]),
      [keyAfter('e4 c5')]: stat([['Nf3', 'g1f3', 97], ['a3', 'a2a3', 3]]),
    };
    const res = await computeCoverage(g3, async (k) => stats[k], { repId: 'b', threshold: 1 / 20, source: 'lichess', paramsLabel: 't' });
    const covered = res.coverage![START_KEY];
    const rare = res.sidelines![START_KEY];
    expect(1 - covered).toBeCloseTo(0.06); // not covered: 1.g3
    expect(rare).toBeCloseTo(0.04 + 0.9 * 0.03); // rare sidelines: 1.b3, and 2.a3
    // What's left is the games that stay on your line to its end.
    expect(covered - rare).toBeCloseTo(res.probs[keyAfter('e4 c5 Nf3 d6')]);
    expect(res.sidelines![keyAfter('e4 c5')]).toBeCloseTo(0.03);
  });

  it('counts the games past the end of a line that reached your target depth as your lines, not sidelines', async () => {
    // After 1.e4 c5 2.Nf3 d6 (90% · 97% ≈ 87% of games, opponent to move) every reply is rarer than the
    // 1 in 2 target: the line has gone as deep as the target asks, so its end is no sideline.
    const g = new RepGraph('black', movesFromLines('b', 'black', ['e4 c5 Nf3 d6']));
    const stats: Record<string, PositionStats> = {
      [START_KEY]: stat([['e4', 'e2e4', 90], ['b3', 'b2b3', 10]]),
      [keyAfter('e4 c5')]: stat([['Nf3', 'g1f3', 97], ['a3', 'a2a3', 3]]),
      [keyAfter('e4 c5 Nf3 d6')]: stat([['d4', 'd2d4', 40], ['c3', 'c2c3', 35], ['Bb5+', 'f1b5', 25]]),
    };
    const res = await computeCoverage(g, async (k) => stats[k], { repId: 'b', threshold: 0.5, source: 'lichess', paramsLabel: 't' });
    expect(res.coverage![START_KEY]).toBeCloseTo(1);
    expect(res.sidelines?.[keyAfter('e4 c5 Nf3 d6')] ?? 0).toBe(0);
    // 1.b3 (10%) and 2.a3 do leave before the target depth: the main moves there are common.
    expect(res.sidelines![START_KEY]).toBeCloseTo(0.1 + 0.9 * 0.03);
    // Preparing a reply past the target changes nothing.
    const deeper = new RepGraph('black', movesFromLines('b', 'black', ['e4 c5 Nf3 d6 d4 cxd4']));
    const res2 = await computeCoverage(deeper, async (k) => stats[k], { repId: 'b', threshold: 0.5, source: 'lichess', paramsLabel: 't' });
    expect(res2.sidelines![START_KEY]).toBeCloseTo(res.sidelines![START_KEY]);
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

  it('knows when each move was last played, and finds the games in a position', () => {
    const games = [
      game('e4 c5 Nf3 d6', 'white', { playedAt: 100 }),
      game('Nf3 c5 e4 d6', 'white', { playedAt: 300 }), // same position by another move order
      game('e4 c5 Nf3 Nc6', 'white', { playedAt: 200 }),
      game('e4 e5', 'white', { playedAt: 0 }), // undated
    ];
    const idx = new GameStatsIndex(games);
    expect(idx.get(START_KEY)!.lastPlayed).toBe(300);
    const start = idx.get(START_KEY)!;
    expect(start.moves.find((m) => m.san === 'e4')!.lastPlayed).toBe(200);
    expect(start.moves.find((m) => m.san === 'Nf3')!.lastPlayed).toBe(300);
    // After 1. e4 c5 2. Nf3 (Black to move): three games, two of them went on d6.
    const key = keysAlong(['e4', 'c5', 'Nf3']).keys[3];
    const at = idx.get(key)!;
    expect(at.total).toBe(3);
    expect(at.moves.find((m) => m.san === 'd6')!.lastPlayed).toBe(300);
    expect(games.map((g) => pathToPosition(g.sans, key)?.join(' '))).toEqual(['e4 c5 Nf3', 'Nf3 c5 e4', 'e4 c5 Nf3', undefined]);
    expect(games.map((g) => !!pathToPosition(g.sans, key, 'd6'))).toEqual([true, true, false, false]);
    // A position counts only when a move is played from it, as in the explorer.
    expect(pathToPosition(['e4', 'c5', 'Nf3'], key)).toBeUndefined();
  });

  it('finds exactly the games in a position, even skipping games that can no longer get there', () => {
    // Random games (with a few common openings so positions repeat and transpose); every target
    // position comes from one of them. The fast finder must agree with replaying every game in full.
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const openings = ['e4 c5 Nf3 d6', 'Nf3 c5 e4 d6', 'e4 e5 Nf3 Nc6', 'd4 d5 c4 e6', 'c4 e6 d4 d5', 'e4 c5'];
    const games: string[][] = [];
    for (let i = 0; i < 300; i++) {
      let pos = startPos();
      const sans: string[] = [];
      for (const s of openings[i % openings.length].split(' ')) {
        const r = playSan(pos, s)!;
        sans.push(r.san);
        pos = r.pos;
      }
      for (let k = 0; k < 50 && !pos.isEnd(); k++) {
        const moves: string[] = [];
        for (const [from, ds] of pos.allDests()) for (const to of ds) moves.push(`${'abcdefgh'[from % 8]}${(from >> 3) + 1}${'abcdefgh'[to % 8]}${(to >> 3) + 1}`);
        const uci = moves[Math.floor(rnd() * moves.length)];
        const r = playUci(pos, uci) ?? playUci(pos, `${uci}q`);
        if (!r) break;
        sans.push(r.san);
        pos = r.pos;
      }
      games.push(sans);
    }
    const naive = (sans: string[], key: string, san?: string) => {
      let pos = startPos();
      let here = START_KEY;
      const path: string[] = [];
      for (let i = 0; i < Math.min(40, sans.length); i++) {
        const r = playSan(pos, sans[i])!;
        if (here === key && (!san || r.san === san)) return path;
        path.push(r.san);
        pos = r.pos;
        here = r.key;
      }
      return undefined;
    };
    let found = 0;
    for (let t = 0; t < 40; t++) {
      const g = games[Math.floor(rnd() * games.length)];
      const ply = Math.floor(rnd() * Math.min(20, g.length - 1));
      const key = keysAlong(g.slice(0, ply)).keys[ply];
      const san = t % 2 ? g[ply] : undefined;
      const find = positionFinder(key, san);
      for (const sans of games) {
        const want = naive(sans, key, san);
        expect(find(sans)).toEqual(want);
        if (want) found++;
      }
    }
    expect(found).toBeGreaterThan(300); // the targets really are shared between games
  }, 30_000); // a big randomized check: slow machines need more than the default 5s

  it('picks explorer rating bands', () => {
    expect(bandsForRating(1650)).toEqual([1400, 1600, 1800]);
    expect(bandsForRating(1750)).toEqual([1400, 1600, 1800]);
    expect(bandsForRating(800)).toEqual([0, 1000, 1200]);
    expect(bandsForRating(2700)).toEqual([2000, 2200, 2500]);
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

describe('coverage follows unsaved opponent transpositions', () => {
  it('counts an unsaved opponent move that lands in the repertoire, and not as a gap', async () => {
    const { computeCoverage } = await import('../lib/coverage');
    const { movesFromLines } = await import('../lib/lines');
    const { RepGraph } = await import('../lib/graph');
    const { edgesForLine } = await import('../lib/lines');
    // White: 1.e4 e5 2.Nf3 Nc6 3.Bc4, and 1.e4 Nc6 2.Nf3 — where 2...e5 (not saved) transposes.
    const g = new RepGraph('white', movesFromLines('w', 'white', ['e4 e5 Nf3 Nc6 Bc4', 'e4 Nc6 Nf3']));
    const k = (l: string) => edgesForLine(l.split(' '))!.at(-1)!.toKey;
    const st = (moves: [string, number][]) => ({
      total: moves.reduce((a, [, n]) => a + n, 0), white: 0, draws: 0, black: 0,
      moves: moves.map(([san, n]) => ({ san, uci: '', white: n, draws: 0, black: 0 })),
    });
    const db: Record<string, ReturnType<typeof st>> = {
      [k('e4')]: st([['e5', 60], ['Nc6', 40]]),
      [k('e4 e5 Nf3')]: st([['Nc6', 100]]),
      [k('e4 Nc6 Nf3')]: st([['e5', 100]]),
    };
    const res = await computeCoverage(g, async (key) => db[key], { repId: 'w', threshold: 1 / 20, source: 'lichess', paramsLabel: 't' });
    expect(res.probs[k('e4 e5 Nf3 Nc6')]).toBeCloseTo(1); // 0.6 directly + 0.4 via 1...Nc6 2.Nf3 e5
    expect(res.gaps).toHaveLength(0);
  });
});
describe('play from memory', () => {
  it('asks for your move at the most popular unanswered position first, depth-first', async () => {
    const { nextMemoryTarget } = await import('../lib/fromMemory');
    const { movesFromLines, edgesForLine } = await import('../lib/lines');
    const { RepGraph } = await import('../lib/graph');
    const { START_KEY } = await import('../lib/chess');
    const k = (l: string) => edgesForLine(l.split(' '))!.at(-1)!.toKey;
    const st = (moves: [string, string, number][]) => ({
      total: moves.reduce((a, [, , n]) => a + n, 0), white: 0, draws: 0, black: 0,
      moves: moves.map(([san, uci, n]) => ({ san, uci, white: n, draws: 0, black: 0 })),
    });
    const db: Record<string, ReturnType<typeof st>> = {
      [k('e4')]: st([['c5', 'c7c5', 40], ['e5', 'e7e5', 50], ['a6', 'a7a6', 10]]),
      [k('e4 e5 Nf3')]: st([['Nc6', 'b8c6', 100]]),
    };
    const provider = async (key: string) => db[key];
    const base = { color: 'white' as const, startKey: START_KEY, startPath: [], startProb: 1, threshold: 1 / 5, provider, skip: new Set<string>() };

    // Empty repertoire: you're asked for your first move.
    let t = await nextMemoryTarget({ ...base, graph: new RepGraph('white', []) });
    expect(t?.path).toEqual([]);

    // 1.e4 saved: the most popular reply (1...e5) comes first.
    let g = new RepGraph('white', movesFromLines('r', 'white', ['e4']));
    t = await nextMemoryTarget({ ...base, graph: g });
    expect(t?.path.map((m) => m.san)).toEqual(['e4', 'e5']);
    expect(t?.prob).toBeCloseTo(0.5);

    // After 1...e5 2.Nf3, it continues down that line (2...Nc6) before switching to 1...c5.
    g = new RepGraph('white', movesFromLines('r', 'white', ['e4 e5 Nf3']));
    t = await nextMemoryTarget({ ...base, graph: g });
    expect(t?.path.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);

    // Skipping that position moves on to 1...c5; 1...a6 is rarer than 1 in 5 so it's never asked.
    t = await nextMemoryTarget({ ...base, graph: g, skip: new Set([k('e4 e5 Nf3 Nc6')]) });
    expect(t?.path.map((m) => m.san)).toEqual(['e4', 'c5']);
  });

  it('counts every move order into a position, like coverage does', async () => {
    const { nextMemoryTarget } = await import('../lib/fromMemory');
    const { edgesForLine } = await import('../lib/lines');
    const { START_KEY } = await import('../lib/chess');
    const k = (l: string) => edgesForLine(l.split(' '))!.at(-1)!.toKey;
    // 1.d4 Nf6 2.c4 e6 and 1.d4 e6 2.c4 Nf6 reach the same position, each half the time, so it comes
    // up in every game. After 3.Nc3, 3...Bb4 (30%) is a gap at 1 in 4 — but only 15% along either line.
    const db: Record<string, PositionStats> = {
      [k('d4')]: stat([['Nf6', 'g8f6', 50], ['e6', 'e7e6', 50]]),
      [k('d4 Nf6 c4')]: stat([['e6', 'e7e6', 100]]),
      [k('d4 e6 c4')]: stat([['Nf6', 'g8f6', 100]]),
      [k('d4 Nf6 c4 e6 Nc3')]: stat([['d5', 'd7d5', 70], ['Bb4', 'f8b4', 30]]),
    };
    const provider = async (key: string) => db[key];
    const g = new RepGraph('white', movesFromLines('r', 'white', ['d4 Nf6 c4 e6 Nc3 d5 cxd5', 'd4 e6 c4 Nf6']));
    const threshold = 1 / 4;

    const coverage = await computeCoverage(g, provider, { repId: 'r', threshold, source: 'lichess', paramsLabel: '' });
    expect(coverage.gaps.map((x) => [x.san, x.prob])).toEqual([['Bb4', expect.closeTo(0.3)]]);

    const t = await nextMemoryTarget({ graph: g, color: 'white', startKey: START_KEY, startPath: [], startProb: 1, threshold, provider, skip: new Set() });
    expect(t?.path.map((m) => m.san)).toEqual(['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4']);
    expect(t?.prob).toBeCloseTo(0.3);
  });
});
describe('game review swings', () => {
  it('finds the moves that lost the most winning chances, from the mover\'s side', async () => {
    const { biggestSwings, judge, winChanceOf } = await import('../lib/review');
    // evals before each move (White POV): even, White blunders (+0.2 → −3), Black slips back (−3 → −1), mate for Black.
    const review = {
      depth: 12, analyzedAt: 0, best: ['e2e4', 'e7e5', 'g1f3', 'b8c6', null],
      evals: [{ cp: 20 }, { cp: -300 }, { cp: -100 }, { cp: -120 }, { mate: -2 }],
    };
    const top = biggestSwings(review, 3);
    expect(top.map((s) => s.ply)).not.toContain(3); // Black finding mate is a gain, not a swing against Black
    expect(top.map((s) => s.ply)).toContain(0);
    const white = top.find((s) => s.ply === 0)!;
    expect(white.mover).toBe('white');
    expect(white.judgement).toBe('blunder');
    const black = top.find((s) => s.ply === 1)!; // −3 → −1 is a loss for Black
    expect(black.mover).toBe('black');
    expect(black.loss).toBeGreaterThan(5);
    expect(judge(3)).toBeUndefined();
    expect(winChanceOf({ mate: 3 })).toBe(100);
  });
});