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
