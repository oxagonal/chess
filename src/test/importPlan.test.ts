import { describe, expect, it } from 'vitest';
import { alternativesIn, importGraph, keptEdges, reachable, studyChapters, trimByReach } from '../lib/importPlan';
import { reachProbabilities } from '../lib/coverage';
import { playSan, START_KEY, startPos } from '../lib/chess';
import type { PositionStats } from '../lib/types';

const STUDY = `[Event "Caro-Kann: Exchange"]
[StudyName "Caro-Kann"]
[ChapterName "Exchange"]
[Orientation "white"]

1. e4 c6 2. d4 d5 3. exd5 (3. f3 dxe4 4. fxe4) cxd5 4. Bd3 Nc6 (4... Nf6 5. c3) 5. c3 *

[Event "Caro-Kann: Advance"]
[StudyName "Caro-Kann"]
[ChapterName "Advance"]
[Orientation "white"]

1. e4 c6 2. d4 d5 3. e5 Bf5 4. Nf3 { Short system } *
`;

const keyAfter = (sans: string[]) => sans.reduce((acc, s) => playSan(acc.pos, s)!, { pos: startPos(), key: START_KEY } as { pos: ReturnType<typeof startPos>; key: string }).key;

describe('importing a study', () => {
  it('reads each chapter with its name and board orientation', () => {
    const { study, chapters } = studyChapters(STUDY);
    expect(study).toBe('Caro-Kann');
    expect(chapters.map((c) => [c.name, c.orientation])).toEqual([
      ['Exchange', 'white'],
      ['Advance', 'white'],
    ]);
    expect(chapters[1].edges.find((e) => e.san === 'Nf3')!.comment).toBe('Short system');
  });

  it('finds where it gives you a choice, and drops what only a removed choice reached', () => {
    const [ex] = studyChapters(STUDY).chapters;
    const g = importGraph('white', ex.edges);
    const all = new Set(g.byId.keys());
    const [alt] = alternativesIn(g, all);
    expect(alt.path).toEqual(['e4', 'c6', 'd4', 'd5']);
    expect(alt.options.map((m) => m.san).sort()).toEqual(['exd5', 'f3']);
    // Keep only 3.exd5: the 3.f3 line goes with it.
    const f3 = alt.options.find((m) => m.san === 'f3')!;
    const kept = reachable(g, (m) => all.has(m.id) && m.id !== f3.id);
    expect(keptEdges(g, kept).map((e) => e.san)).not.toContain('fxe4');
    expect(alternativesIn(g, kept)).toEqual([]);
  });

  it('trims opponent replies rarer than the target, keeping lines the explorer knows nothing about', async () => {
    const [ex] = studyChapters(STUDY).chapters;
    const g = importGraph('white', ex.edges);
    // After 4.Bd3: Nc6 is common, Nf6 rare. Everything else: no data.
    const at = keyAfter(['e4', 'c6', 'd4', 'd5', 'exd5', 'cxd5', 'Bd3']);
    const stats = (moves: [string, number][]): PositionStats => ({ total: 1000, moves: moves.map(([san, n]) => ({ san, uci: '', white: n, draws: 0, black: 0 })) }) as unknown as PositionStats;
    const fwd = await reachProbabilities(g, async (k) => (k === at ? stats([['Nc6', 995], ['Nf6', 5]]) : k === START_KEY || g.isMyTurn(k) ? undefined : stats(g.childrenOf(k).map((m) => [m.san, 1000]))), {
      threshold: 1 / 100,
      pickAll: true,
    });
    const kept = trimByReach(g, fwd, 1 / 100);
    const sans = keptEdges(g, kept).map((e) => e.san);
    expect(sans).toContain('Nc6');
    expect(sans).not.toContain('Nf6');
    // The 5.c3 after 4...Nf6 goes with it; the one after 4...Nc6 stays.
    expect(sans.filter((s) => s === 'c3')).toHaveLength(1);
    // Both 3rd moves stay: your own alternatives are reviewed, not trimmed.
    expect(sans).toContain('f3');
  });
});

describe('clashes with your other chapters', () => {
  it('finds where an import gives you a different move than another chapter (Center Attack vs Pianissimo)', async () => {
    const { clashesIn, movesByPosition } = await import('../lib/importPlan');
    const { movesFromLines } = await import('../lib/lines');
    const { pgnToEdges } = await import('../lib/pgn');
    const pianissimo = movesFromLines('p', 'white', ['e4 e5 Nf3 Nc6 Bc4 Bc5 d3 Nf6 c3']);
    const others = movesByPosition(pianissimo, () => 'Giuoco Pianissimo');
    const { edges } = pgnToEdges('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d4 *');
    const graph = importGraph('white', edges);
    const all = new Set(graph.byId.keys());
    const reached = new Set([graph.root, ...[...graph.byId.values()].map((m) => m.toKey)]);
    const clashes = clashesIn(graph, all, reached, () => true, others);
    // Only after 3...Bc5: the study's 4.c3 against the chapter's 4.d3 (1.e4, 2.Nf3 and 3.Bc4 agree).
    // After 4.c3 Nf6 the study plays 5.d4; the Pianissimo reaches 4.d3 Nf6 5.c3 — a different position.
    expect(clashes.map((c) => c.path.join(' '))).toEqual(['e4 e5 Nf3 Nc6 Bc4 Bc5']);
    expect(clashes[0].options.map((m) => m.san)).toEqual(['c3']);
    expect(clashes[0].elsewhere).toEqual([{ san: 'd3', uci: 'd2d3', chapter: 'Giuoco Pianissimo' }]);
  });

  it('finds a clash reached by transposition, and none where the import adds nothing of yours', async () => {
    const { clashesIn, movesByPosition } = await import('../lib/importPlan');
    const { movesFromLines } = await import('../lib/lines');
    const { pgnToEdges } = await import('../lib/pgn');
    // Your chapter: 1.e4 e5 2.Bc4 Nf6 3.d3. The study gets to the same position as 1.e4 Nf6 2.Bc4 e5,
    // then plays 3.Nc3.
    const mine = movesFromLines('m', 'white', ['e4 e5 Bc4 Nf6 d3']);
    const others = movesByPosition(mine, () => 'Bishop’s Opening');
    const { edges } = pgnToEdges('1. e4 Nf6 2. Bc4 e5 3. Nc3 *');
    const graph = importGraph('white', edges);
    const all = new Set(graph.byId.keys());
    const reached = new Set([graph.root, ...[...graph.byId.values()].map((m) => m.toKey)]);
    const clashes = clashesIn(graph, all, reached, () => true, others);
    expect(clashes.map((c) => c.options.map((m) => m.san).join() + ' vs ' + c.elsewhere.map((e) => e.san).join())).toEqual(['Nc3 vs d3']);
    // If none of the moves there are the import's own (all already in the chapter), it isn't flagged.
    expect(clashesIn(graph, all, reached, () => false, others)).toEqual([]);
  });
});
