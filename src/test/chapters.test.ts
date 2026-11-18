import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../db/db';
import { addLine, createRepertoire, deleteMove, deleteRepertoire, loadGraph } from '../db/repertoire';
import { loadScopeGraph, repertoireScopeId } from '../db/scopes';
import { cardIdOf, cardsOf, chapterForLine, migrateCardRows, unionGraph } from '../lib/chapters';
import { playSan, START_KEY, startPos } from '../lib/chess';
import { emptyDoc, upgradeSyncDoc } from '../lib/syncMerge';
import { exportBackup, importBackup } from '../services/backup';
import type { RepMove } from '../lib/types';

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

const keyAfter = (sans: string[]) => {
  let pos = startPos();
  let key = START_KEY;
  for (const s of sans) {
    const r = playSan(pos, s)!;
    pos = r.pos;
    key = r.key;
  }
  return key;
};

describe('cards shared by chapters', () => {
  it('gives the same move in two chapters one card, and keeps it until no chapter has the move', async () => {
    const italian = await createRepertoire('Italian', 'white');
    const ck = await createRepertoire('Caro-Kann Exchange', 'white');
    await addLine(italian.id, ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
    await addLine(ck.id, ['e4', 'c6', 'd4', 'd5', 'exd5']);
    const cards = await db.cards.toArray();
    // e4 once, Nf3, Bc4, d4, exd5.
    expect(cards.map((c) => c.san).sort()).toEqual(['Bc4', 'Nf3', 'd4', 'e4', 'exd5']);
    expect(cards.every((c) => c.color === 'white')).toBe(true);

    // Training e4 in one chapter is training it in both.
    const e4 = cardIdOf({ fromKey: START_KEY, san: 'e4' });
    await db.cards.update(e4, { reps: 3 });
    const { graph: ckGraph } = (await loadGraph(ck.id))!;
    expect(cardsOf(ckGraph, await db.cards.toArray()).find((c) => c.san === 'e4')!.reps).toBe(3);

    // Deleting e4 from the Italian keeps the card (the Caro-Kann has it); the Italian's own moves go.
    const { graph: itGraph } = (await loadGraph(italian.id))!;
    await deleteMove(italian.id, itGraph.edge(START_KEY, 'e4')!.id);
    expect((await db.cards.toArray()).map((c) => c.san).sort()).toEqual(['d4', 'e4', 'exd5']);
    await deleteRepertoire(ck.id);
    expect(await db.cards.count()).toBe(0);
  });

  it('a repertoire trains the union of its chapters, and loses a deleted chapter', async () => {
    const a = await createRepertoire('Italian', 'white');
    const b = await createRepertoire('Fantasy', 'white');
    await addLine(a.id, ['e4', 'e5', 'Nf3']);
    await addLine(b.id, ['e4', 'c6', 'd4', 'd5', 'f3']);
    await db.collections.add({ id: 'set1', name: 'Tournament', color: 'white', chapterIds: [a.id, b.id], createdAt: 1, updatedAt: 1 });
    const loaded = (await loadScopeGraph(repertoireScopeId('set1')))!;
    expect(loaded.scope.kind).toBe('repertoire');
    // e4 is in both chapters but once in the union; its id is its card's.
    expect(loaded.graph.childrenOf(START_KEY).map((m) => m.id)).toEqual([cardIdOf({ fromKey: START_KEY, san: 'e4' })]);
    expect(cardsOf(loaded.graph, await db.cards.toArray()).map((c) => c.san).sort()).toEqual(['Nf3', 'd4', 'e4', 'f3']);
    await deleteRepertoire(b.id);
    expect((await db.collections.get('set1'))!.chapterIds).toEqual([a.id]);
  });
});

describe('union graphs', () => {
  const mv = (repId: string, sans: string[], comment?: string): RepMove => {
    const before = sans.slice(0, -1);
    const san = sans[sans.length - 1];
    const fromKey = keyAfter(before);
    return { id: `${repId}|${fromKey}|${san}`, repId, fromKey, toKey: keyAfter(sans), san, uci: '', mine: before.length % 2 === 0, comment, createdAt: 1 };
  };

  it('merges chapters by position, keeping each note once, and finds the chapter a line belongs to', () => {
    const moves = [mv('it', ['e4'], 'Best by test'), mv('it', ['e4', 'e5']), mv('ck', ['e4'], 'Best by test'), mv('ck', ['e4', 'c6']), mv('ck', ['e4', 'c6', 'd4'], 'Main')];
    const g = unionGraph('white', moves);
    const e4 = g.edge(START_KEY, 'e4')!;
    expect(e4.comment).toBe('Best by test');
    expect(g.childrenOf(e4.toKey).map((m) => m.san).sort()).toEqual(['c6', 'e5']);
    expect(chapterForLine(g, ['e4', 'c6', 'd4', 'd5'])).toBe('ck');
    expect(chapterForLine(g, ['e4', 'e5', 'Nf3'])).toBe('it');
  });
});

describe('moving to chapters', () => {
  const k1 = keyAfter(['e4', 'c5']);
  const oldRows = () => ({
    cards: [
      // The same move in two old repertoires: the learned, more recently reviewed one wins.
      { id: `r1|${k1}|Nf3`, repId: 'r1', fromKey: k1, san: 'Nf3', state: 2, reps: 4, lastReview: 50, createdAt: 1 },
      { id: `r2|${k1}|Nf3`, repId: 'r2', fromKey: k1, san: 'Nf3', state: 0, reps: 0, createdAt: 2 },
    ],
    logs: [{ cardId: `r1|${k1}|Nf3`, repId: 'r1', rating: 3, state: 0, reviewedAt: 50, source: 'review' }],
  });

  it('turns per-repertoire cards into per-position cards', () => {
    const { cards, logs } = oldRows();
    const next = migrateCardRows(cards, logs);
    expect(next.cards).toHaveLength(1);
    expect(next.cards[0]).toMatchObject({ id: `${k1}|Nf3`, color: 'white', reps: 4 });
    expect(next.cards[0]).not.toHaveProperty('repId');
    expect(next.logs[0]).toMatchObject({ cardId: `${k1}|Nf3`, color: 'white' });
    // Already moved: unchanged.
    expect(migrateCardRows(next.cards, next.logs)).toEqual(next);
  });

  it('upgrades a database from before chapters', async () => {
    const name = `old-${Math.random()}`;
    const old = new Dexie(name);
    old.version(3).stores({
      repertoires: 'id, color',
      moves: 'id, repId, [repId+fromKey], [repId+toKey]',
      cards: 'id, repId, due, state, [repId+state]',
      reviewLog: '++id, cardId, repId, reviewedAt',
      games: 'id, playedAt, source, account, userColor',
      explorerCache: 'key, fetchedAt',
      coverage: 'repId',
      kv: 'key',
      syncState: 'key',
      players: 'id, name',
      playerGames: 'id, playerId, [playerId+source]',
    });
    const { cards, logs } = oldRows();
    await old.table('repertoires').bulkAdd([
      { id: 'r1', name: 'A', color: 'white', createdAt: 1, updatedAt: 1, oneInN: 50 },
      { id: 'r2', name: 'B', color: 'white', createdAt: 1, updatedAt: 1, oneInN: 100 },
    ]);
    await old.table('cards').bulkAdd(cards);
    await old.table('reviewLog').bulkAdd(logs);
    await old.table('coverage').add({ repId: 'r1', computedAt: 1 });
    old.close();

    const fresh = openDb(name);
    const upgraded = await fresh.cards.toArray();
    expect(upgraded.map((c) => c.id)).toEqual([`${k1}|Nf3`]);
    expect((await fresh.reviewLog.toArray())[0].cardId).toBe(`${k1}|Nf3`);
    expect(await fresh.coverage.count()).toBe(0);
    expect(((await fresh.kv.get('settings'))!.value as { scopeTargets: Record<string, number> }).scopeTargets).toEqual({ white: 100 });
    fresh.close();
    await fresh.delete();
  });

  it('upgrades a synced copy and a backup saved before chapters', async () => {
    const { cards, logs } = oldRows();
    const doc = emptyDoc(1);
    doc.format = 1;
    doc.tables.cards.rows = cards;
    doc.tables.reviewLog.rows = logs;
    doc.tables.cards.tombs = { [`r1|${k1}|e4`]: 5 };
    const up = upgradeSyncDoc(doc);
    expect(up.format).toBe(2);
    expect(up.tables.cards.rows.map((c) => c.id)).toEqual([`${k1}|Nf3`]);
    expect(up.tables.cards.tombs).toEqual({});

    await importBackup(JSON.stringify({ app: 'chess-prep', version: 1, repertoires: [], moves: [], cards, reviewLog: logs, coverage: [{ repId: 'r1' }] }));
    expect((await db.cards.toArray()).map((c) => c.id)).toEqual([`${k1}|Nf3`]);
    expect(await db.coverage.count()).toBe(0);
    expect(JSON.parse(await exportBackup()).version).toBe(2);
  });
});
