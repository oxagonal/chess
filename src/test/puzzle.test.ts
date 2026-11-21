import 'fake-indexeddb/auto';
import { gradeWritten, MoveTree, unconsidered } from '../lib/moveTree';
import { describe, expect, it } from 'vitest';
import { judgeMove, openingAngle, puzzleStart, type LichessPuzzle } from '../lib/puzzle';
import { fenOf, playUci, posFromFen } from '../lib/chess';

// The daily puzzle of 2026-11-20, as /api/puzzle/daily sent it (its fen and lastMove are what the
// batch endpoint leaves out — the start must be worked out from the game's moves).
const DAILY = {"pgn": "e4 c5 Nf3 Nc6 c3 e6 d4 cxd4 cxd4 d5 e5 a6 a3 Bd7 Nc3 b5 Na2 Rc8 Bd2 Nge7 Bd3 Ng6 O-O Be7 Nb4 Qb6 Nxc6 Rxc6 b4 O-O Qe2 Rfc8 Rac1 Rxc1 Rxc1 Rxc1+ Bxc1 Nh4 Be3 Nxf3+ Qxf3 a5 Qh5 h6 Bxh6 Qxd4 Bxg7 Qh4 Qxh4 Bxh4 Bf6 Bxf6 exf6 axb4 axb4 Kf8 h4 Kg8 h5 e5 f3 d4 Kf2 Bc6 Kg3 Kh8 Kf2 Kg8 g4 Kf8 g5 Kg8 g6 fxg6 hxg6 Bd7 Kg3 Bc6 Kf2 Bd7 Be4 Be6 Kg3 Kf8 Kh4 Bc4 Kg5 d3 Bxd3 Bxd3 Kh6 e4", "initialPly": 91, "solution": ["g6g7", "f8f7", "h6h7", "f7f6", "g7g8q"], "fen": "5k2/8/5PPK/1p6/1P2p3/3b1P2/8/8 w - - 0 1", "lastMove": "e5e4", "id": "GjqO9", "rating": 1715, "themes": ["endgame", "advancedPawn", "crushing", "long", "promotion", "bishopEndgame"]};
const daily: LichessPuzzle = {
  game: { id: 'g', pgn: DAILY.pgn },
  puzzle: { id: DAILY.id, rating: DAILY.rating, solution: DAILY.solution, themes: DAILY.themes, initialPly: DAILY.initialPly },
};

describe('puzzles', () => {
  it('sets a puzzle up from its game: after the opponent’s move, your turn', () => {
    const s = puzzleStart(daily)!;
    expect(fenOf(s.pos).split(' ').slice(0, 4)).toEqual(DAILY.fen.split(' ').slice(0, 4));
    expect(s.lastMove).toBe(DAILY.lastMove);
    expect(s.color).toBe('white');
  });

  it('judges your moves against the solution, the last one solving it', () => {
    let pos = puzzleStart(daily)!.pos;
    const sol = daily.puzzle.solution;
    expect(judgeMove(pos, sol, 0, 'h6h7')).toBe('wrong');
    for (let i = 0; i < sol.length; i += 2) {
      expect(judgeMove(pos, sol, i, sol[i])).toBe(i + 1 >= sol.length ? 'solved' : 'right');
      pos = playUci(pos, sol[i])!.pos;
      if (sol[i + 1]) pos = playUci(pos, sol[i + 1])!.pos;
    }
  });

  it('accepts any mate, like Lichess', () => {
    // Scholar's mate: Qxf7 mates (the solution); Bxf7+ is only a check.
    const p: LichessPuzzle = {
      game: { id: 'g', pgn: 'e4 e5 Qh5 Nc6 Bc4 Nf6' },
      puzzle: { id: 'x', rating: 600, solution: ['h5f7'], themes: ['mateIn1'], initialPly: 5 },
    };
    const s = puzzleStart(p)!;
    expect(judgeMove(s.pos, p.puzzle.solution, 0, 'h5f7')).toBe('solved');
    expect(judgeMove(s.pos, p.puzzle.solution, 0, 'c4f7')).toBe('wrong'); // a check, not mate
  });

  it('turns opening names into Lichess puzzle keys', () => {
    expect(openingAngle('Sicilian Defense: Najdorf Variation')).toBe('Sicilian_Defense_Najdorf_Variation');
    expect(openingAngle("Queen's Gambit Accepted")).toBe('Queens_Gambit_Accepted');
    expect(openingAngle('Caro-Kann Defense: Advance Variation')).toBe('Caro-Kann_Defense_Advance_Variation');
  });
});

describe('the Lichess puzzle calls', () => {
  it('fetch anonymously without a puzzle permission, and report with the token and the right body', async () => {
    const { updateSettings } = await import('../db/settings');
    const { fetchPuzzles, reportPuzzles } = await import('../services/puzzles');
    const calls: { url: string; init: RequestInit }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ puzzles: [], rounds: [{ id: 'abc', win: true, ratingDiff: 7 }], glicko: { rating: 1712, deviation: 60 } }), { status: 200 });
    }) as typeof fetch;
    try {
      // Connected before puzzles: the token has study:read only — it mustn't go along (Lichess refuses it).
      await updateSettings({ lichessToken: 'tok', lichessScopes: 'study:read' });
      await fetchPuzzles('Sicilian_Defense', { nb: 5, difficulty: 'harder' });
      expect(calls[0].url).toBe('https://lichess.org/api/puzzle/batch/Sicilian_Defense?nb=5&difficulty=harder');
      expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();

      await updateSettings({ lichessScopes: 'study:read puzzle:read puzzle:write' });
      await fetchPuzzles('mix');
      expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
      const r = await reportPuzzles('mix', [{ id: 'abc', win: true, rated: true }]);
      expect(calls[2].init.method).toBe('POST');
      expect(calls[2].url).toBe('https://lichess.org/api/puzzle/batch/mix?nb=0');
      expect(JSON.parse(calls[2].init.body as string)).toEqual({ solutions: [{ id: 'abc', win: true, rated: true }] });
      expect(r.rounds[0].ratingDiff).toBe(7);
      expect(r.glicko?.rating).toBe(1712);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('writing a puzzle solution', () => {
  // A stand-in puzzle from the start: 1.e4 (yours) e5 (theirs) 2.Nf3 (yours).
  const solution = ['e2e4', 'e7e5', 'g1f3'];
  const write = (lines: string[][]) => {
    const tree = new MoveTree();
    for (const line of lines) {
      let id: string | undefined = tree.root;
      for (const uci of line) id = id && tree.add(id, uci, 'mine');
    }
    return tree;
  };
  it('asks for their other replies at each of their turns on your line', () => {
    const tree = write([['e2e4', 'e7e5', 'g1f3']]);
    const afterE4 = `${tree.root} e2e4`;
    expect(unconsidered(tree, tree.root, new Set())).toEqual([afterE4]);
    // A branch, or "only one sensible reply", settles it.
    expect(unconsidered(write([['e2e4', 'e7e5', 'g1f3'], ['e2e4', 'c7c5']]), tree.root, new Set())).toEqual([]);
    expect(unconsidered(tree, tree.root, new Set([afterE4]))).toEqual([]);
  });
  it("doesn't ask for other replies when theirs is the only legal move", () => {
    // Rh1+: the king on f6 covers g7, so Kg8 is Black's only move. After Rg1+ (pinning nothing), two.
    const tree = new MoveTree(posFromFen('7k/8/5K2/8/8/8/8/6R1 w - - 0 1')!);
    let id: string | undefined = tree.root;
    for (const uci of ['g1h1', 'h8g8', 'h1g1']) id = id && tree.add(id, uci, 'mine');
    expect(unconsidered(tree, tree.root, new Set())).toEqual([]);
    const two = new MoveTree(posFromFen('7k/8/8/8/8/8/8/K5R1 w - - 0 1')!);
    let j: string | undefined = two.root;
    for (const uci of ['g1h1', 'h8g8']) j = j && two.add(j, uci, 'mine');
    expect(unconsidered(two, two.root, new Set())).toEqual([`${two.root} g1h1`]);
  });
  it('is right when your lines contain the solution, their best defence included', () => {
    expect(gradeWritten(write([['e2e4', 'e7e5', 'g1f3'], ['e2e4', 'c7c5', 'g1f3']]), 'root', solution)).toEqual({ win: true });
    // Their move wasn't considered.
    expect(gradeWritten(write([['e2e4', 'c7c5', 'g1f3']]), 'root', solution)).toEqual({ win: false, wrongAt: { nodeId: 'root e2e4', expected: 'e7e5', yours: false } });
    // Your first move was wrong.
    expect(gradeWritten(write([['d2d4']]), 'root', solution).wrongAt).toEqual({ nodeId: 'root', expected: 'e2e4', yours: true });
  });
  it('takes any mate, as Lichess does', () => {
    const tree = new MoveTree();
    let id: string = tree.root;
    for (const san of ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6']) id = tree.addSan(id, san, 'game')!;
    tree.add(id, 'h5f7', 'mine');
    expect(gradeWritten(tree, id, ['h5f7'])).toEqual({ win: true });
    expect(tree.path(`${id} h5f7`).map((n) => n.san).join(' ')).toBe('e4 e5 Bc4 Nc6 Qh5 Nf6 Qxf7#');
    tree.remove(`${id} h5f7`);
    expect(tree.children(id)).toEqual([]);
  });
});
