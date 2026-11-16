import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/db';
import { addLine, createRepertoire, deleteMove, exportPgn, gradeCard, importPgn, loadGraph, markForgotten } from '../db/repertoire';
import { Rating } from '../lib/srs';
import { importBackup, exportBackup } from '../services/backup';

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('repertoire persistence', () => {
  it('adds lines, creates cards only for your moves, and prunes on delete', async () => {
    const rep = await createRepertoire('Sicilian', 'black');
    await addLine(rep.id, ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4']);
    await addLine(rep.id, ['e4', 'c5', 'Nc3', 'Nc6']);
    expect(await db.moves.count()).toBe(8);
    const cards = await db.cards.toArray();
    expect(cards.map((c) => c.san).sort()).toEqual(['Nc6', 'c5', 'cxd4', 'd6']);

    const { graph } = (await loadGraph(rep.id))!;
    const nf3 = [...graph.byId.values()].find((m) => m.san === 'Nf3')!;
    const removed = await deleteMove(rep.id, nf3.id);
    expect(removed).toBe(4); // Nf3 d6 d4 cxd4
    expect((await db.cards.toArray()).map((c) => c.san).sort()).toEqual(['Nc6', 'c5']);
  });

  it('keeps transposed positions alive when one path is deleted', async () => {
    const rep = await createRepertoire('QGD', 'black');
    await addLine(rep.id, ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6']);
    await addLine(rep.id, ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'd5', 'Bg5', 'Be7']);
    const { graph } = (await loadGraph(rep.id))!;
    const firstNf6 = [...graph.byId.values()].find((m) => m.san === 'Nf6' && m.fromKey.startsWith('rnbqkbnr/ppp2ppp'))!;
    await deleteMove(rep.id, firstNf6.id);
    const after = (await loadGraph(rep.id))!.graph;
    expect([...after.byId.values()].some((m) => m.san === 'Be7')).toBe(true);
  });

  it('imports and exports PGN', async () => {
    const rep = await createRepertoire('W', 'white');
    const r = await importPgn(rep.id, '1. e4 e5 (1... c5 2. c3 {Alapin}) 2. Nf3 *');
    expect(r.added).toBe(5);
    expect(r.mineAdded).toBe(3);
    const pgn = await exportPgn(rep.id);
    expect(pgn).toContain('Alapin');
    expect(pgn).toMatch(/1\. e4 e5 \( 1\.\.\. c5 2\. c3 \{ Alapin \} \) 2\. Nf3/);
  });

  it('grades cards and marks forgotten prep', async () => {
    const rep = await createRepertoire('W', 'white');
    await addLine(rep.id, ['e4']);
    const [card] = await db.cards.toArray();
    await markForgotten([card.id]); // still new → ignored
    expect((await db.cards.get(card.id))!.lapses).toBe(0);
    await gradeCard(card.id, Rating.Good, 'learn');
    for (let i = 0; i < 3; i++) await gradeCard(card.id, Rating.Good, 'review');
    await markForgotten([card.id], 'g1');
    const after = (await db.cards.get(card.id))!;
    expect(after.lapses).toBe(1);
    expect((await db.reviewLog.toArray()).filter((l) => l.source === 'game')).toHaveLength(1);
  });

  it('round-trips a backup', async () => {
    const rep = await createRepertoire('W', 'white');
    await addLine(rep.id, ['e4', 'e5', 'Nf3']);
    const json = await exportBackup();
    await Promise.all(db.tables.map((t) => t.clear()));
    await importBackup(json);
    expect(await db.moves.count()).toBe(3);
    expect(await db.cards.count()).toBe(2);
  });
});

describe('reach along a line', () => {
  it('multiplies opponent move frequencies and ignores your own moves', async () => {
    const { reachAlongLine } = await import('../services/coverage');
    const { edgesForLine } = await import('../lib/lines');
    const line = edgesForLine(['e4', 'c5', 'Nf3', 'd6'])!;
    const stats = (moves: [string, number][]) => ({
      total: moves.reduce((a, [, n]) => a + n, 0), white: 0, draws: 0, black: 0,
      moves: moves.map(([san, n]) => ({ san, uci: '', white: n, draws: 0, black: 0 })),
    });
    const db: Record<string, ReturnType<typeof stats>> = {
      [line[0].toKey]: stats([['c5', 40], ['e5', 60]]),
      [line[2].toKey]: stats([['d6', 50], ['Nc6', 50]]),
    };
    const p = await reachAlongLine(line, 'white', async (k) => db[k]);
    expect(p).toBeCloseTo(0.4 * 0.5);
    // two prepared moves on move 1 → split evenly
    expect(await reachAlongLine(line, 'white', async (k) => db[k], (k) => (k === line[0].fromKey ? 2 : 1))).toBeCloseTo(0.1);
    // as Black, White's 1.e4 has no data here → 0
    expect(await reachAlongLine(line, 'black', async (k) => db[k])).toBe(0);
  });
});

describe('depth estimate', () => {
  it('follows replies until they get rarer than 1 in N and averages line length', async () => {
    const { estimateDepth } = await import('../lib/depth');
    const { edgesForLine } = await import('../lib/lines');
    const { START_KEY } = await import('../lib/chess');
    const st = (moves: [string, string, number][]) => ({
      total: moves.reduce((a, [, , n]) => a + n, 0), white: 0, draws: 0, black: 0,
      moves: moves.map(([san, uci, n]) => ({ san, uci, white: n, draws: 0, black: 0 })),
    });
    const k = (l: string) => edgesForLine(l.split(' '))!.at(-1)!.toKey;
    const data: Record<string, ReturnType<typeof st>> = {
      [START_KEY]: st([['e4', 'e2e4', 70], ['d4', 'd2d4', 30]]),
      [k('e4')]: st([['c5', 'c7c5', 50], ['e5', 'e7e5', 50]]),
      [k('e4 c5')]: st([['Nf3', 'g1f3', 100]]),
      [k('e4 e5')]: st([['Nf3', 'g1f3', 100]]),
      [k('e4 c5 Nf3')]: st([['d6', 'd7d6', 90], ['a6', 'a7a6', 10]]),
      [k('e4 e5 Nf3')]: st([['Nc6', 'b8c6', 100]]),
    };
    const r = await estimateDepth('white', async (key) => data[key], 4);
    // As White we always play 1.e4 (top move). Lines: c5 Nf3 d6 (p .45), e5 Nf3 Nc6 (.5); a6 (.05) is below 1/4.
    expect(r.lines).toBe(2);
    expect(r.mass).toBeCloseTo(0.95);
    expect(r.maxMoves).toBe(2); // 1.e4 c5 2.Nf3 d6 / 1.e4 e5 2.Nf3 Nc6
    expect(r.avgMoves).toBeCloseTo(2);
  });
});
