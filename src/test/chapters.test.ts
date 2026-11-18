import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../db/db';
import { addLine, chapterForNewLine, createRepertoire, deleteMove, deleteRepertoire, deleteUnionMove, loadGraph, mergeChapter, setMoveComment, splitChapter, splitOff } from '../db/repertoire';
import { loadScopeGraph, repertoireScopeId } from '../db/scopes';
import { cardIdOf, cardsOf, chapterConflicts, chapterForLine, chapterGap, chapterPosition, chapterTrunk, matchChapter, migrateCardRows, unionGraph } from '../lib/chapters';
import openings from '../data/openings.json';
import { buildOpeningIndex } from '../lib/openingNames';
import { RepGraph } from '../lib/graph';
import { movesFromLines } from '../lib/lines';
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

describe('splitting a chapter', () => {
  it('moves lines into new chapters with their notes, keeps progress, and updates repertoires', async () => {
    const big = await createRepertoire('Black', 'black');
    await addLine(big.id, ['e4', 'c5', 'Nf3', 'e6']);
    await addLine(big.id, ['d4', 'Nf6', 'c4', 'e6']);
    await db.collections.add({ id: 's', name: 'Open', color: 'black', chapterIds: [big.id], createdAt: 1, updatedAt: 1 });
    const { graph } = (await loadGraph(big.id))!;
    const e4 = graph.edge(START_KEY, 'e4')!;
    await setMoveComment(graph.edge(e4.toKey, 'c5')!.id, 'Sicilian!');
    const c5card = cardIdOf(graph.edge(e4.toKey, 'c5')!);
    await db.cards.update(c5card, { reps: 7 });
    const ofLine = (first: string) => {
      const ids: string[] = [];
      let key = START_KEY;
      let m = graph.edge(key, first);
      while (m) {
        ids.push(m.id);
        key = m.toKey;
        m = graph.childrenOf(key)[0];
      }
      return ids;
    };
    const [sic, qp] = await splitChapter(big.id, [
      { name: 'Sicilian', moveIds: ofLine('e4') },
      { name: 'Queen pawn', moveIds: ofLine('d4') },
    ]);
    expect(await db.repertoires.get(big.id)).toBeUndefined();
    const sicGraph = (await loadGraph(sic))!.graph;
    expect(sicGraph.size).toBe(4);
    expect(sicGraph.edge(sicGraph.edge(START_KEY, 'e4')!.toKey, 'c5')!.comment).toBe('Sicilian!');
    expect((await loadGraph(qp))!.graph.size).toBe(4);
    expect((await db.cards.get(c5card))!.reps).toBe(7);
    expect(await db.cards.count()).toBe(4);
    expect((await db.collections.get('s'))!.chapterIds).toEqual([sic, qp]);
  });
});

describe('splitting a line off by hand', () => {
  it('moves the line from a move on (with the moves to it) and keeps what else reaches it', async () => {
    const ch = await createRepertoire('Sicilian', 'black');
    await addLine(ch.id, ['e4', 'c5', 'Nf3', 'e6', 'd4', 'cxd4', 'Nxd4', 'Nc6']);
    await addLine(ch.id, ['e4', 'c5', 'c3', 'd5']);
    await db.cards.update(cardIdOf({ fromKey: keyAfter(['e4', 'c5', 'c3']), san: 'd5' }), { reps: 4 });
    const { graph } = (await loadGraph(ch.id))!;
    const c3 = graph.edge(keyAfter(['e4', 'c5']), 'c3')!;
    const alapin = await splitOff(ch.id, c3.id, { name: 'Alapin' });
    const a = (await loadGraph(alapin))!;
    expect(a.rep.name).toBe('Alapin');
    expect([...a.graph.byId.values()].map((m) => m.san).sort()).toEqual(['c3', 'c5', 'd5', 'e4']);
    const left = (await loadGraph(ch.id))!.graph;
    expect(left.edge(keyAfter(['e4', 'c5']), 'c3')).toBeUndefined();
    expect(left.size).toBe(8);
    expect((await db.cards.get(cardIdOf({ fromKey: keyAfter(['e4', 'c5', 'c3']), san: 'd5' })))!.reps).toBe(4);
    // Into an existing chapter, keeping a copy.
    const other = await createRepertoire('Open', 'black');
    const nf3 = left.edge(keyAfter(['e4', 'c5']), 'Nf3')!;
    expect(await splitOff(ch.id, nf3.id, { chapterId: other.id }, { keepCopy: true })).toBe(other.id);
    expect((await loadGraph(other.id))!.graph.size).toBe(8);
    expect((await loadGraph(ch.id))!.graph.size).toBe(8);
  });
});

describe('a chapter at a glance', () => {
  const g = new RepGraph('black', movesFromLines('c', 'black', ['e4 c5 c3 d5 exd5 Qxd5', 'e4 c5 c3 Nf6 e5 Nd5']));
  it('finds where it branches', () => {
    const { trunk, key } = chapterTrunk(g);
    expect(trunk.map((m) => m.san)).toEqual(['e4', 'c5', 'c3']);
    expect(key).toBe(keyAfter(['e4', 'c5', 'c3']));
    expect(chapterTrunk(new RepGraph('black', movesFromLines('c', 'black', ['e4 c5', 'd4 Nf6']))).trunk).toEqual([]);
  });
  it("finds the position that defines its opening, not the chapter's single replies after it", () => {
    const names = buildOpeningIndex(openings as [string, string, string][]);
    // A Pirc chapter that only prepares 2.d4, then plays 2...Nf6: the Pirc is 1.e4 d6.
    const pirc = new RepGraph('black', movesFromLines('p', 'black', ['e4 d6 d4 Nf6 Nc3 g6', 'e4 d6 d4 Nf6 f3 e5']));
    const pos = chapterPosition(pirc, names);
    expect(pos.moves.map((m) => m.san)).toEqual(['e4', 'd6']);
    // Without names: everything up to where it branches.
    expect(chapterPosition(pirc, undefined).moves.map((m) => m.san)).toEqual(['e4', 'd6', 'd4', 'Nf6']);
    // A Dutch chapter that also gets there by 1...e6: the Dutch is 1.d4 f5, not the shared 1.d4.
    const dutch = new RepGraph('black', movesFromLines('d', 'black', ['d4 f5 c4 Nf6 g3 e6', 'd4 e6 c4 f5 g3 Nf6', 'd4 f5 Nf3 Nf6 g3 g6']));
    expect(chapterPosition(dutch, names).moves.map((m) => m.san)).toEqual(['d4', 'f5']);
  });

  it('gives its biggest gap from the start and among games reaching it', () => {
    const cov = {
      gaps: [
        { path: ['e4', 'c5', 'c3', 'd5'], san: 'e5', prob: 0.004 },
        { path: ['e4', 'c5', 'Nf3'], san: 'x', prob: 0.2 }, // not in this chapter
      ],
      unfinished: [{ path: ['e4', 'c5', 'c3', 'Nf6', 'e5', 'Nd5'], prob: 0.002 }],
      probs: { [keyAfter(['e4', 'c5', 'c3'])]: 0.04 },
    };
    expect(chapterGap(g, cov)).toEqual({ sans: ['e4', 'c5', 'c3', 'd5', 'e5'], prob: 0.004, inChapter: 0.1, beyondTarget: false });
    // Rarer than the target, it still shows — from the run's sub-threshold holes.
    expect(chapterGap(g, { gaps: [], unfinished: [], minorGaps: [{ path: ['e4', 'c5', 'c3', 'd5'], san: 'Nf3', prob: 0.00125 }], probs: {}, threshold: 0.005 })).toMatchObject({ prob: 0.00125, beyondTarget: true });
    expect(chapterGap(g, { gaps: [], unfinished: [], probs: {} })).toBeUndefined();
    // A hole right after 1.e4 c5 is the business of the chapter whose opening that is, not the Alapin's.
    const early = { gaps: [{ path: ['e4', 'c5'], san: 'b3', prob: 0.01 }], unfinished: [], probs: {} };
    const open = new RepGraph('black', movesFromLines('o', 'black', ['e4 c5 Nf3 e6', 'e4 c5 d4 cxd4']));
    expect(chapterGap(g, early)).toBeUndefined();
    expect(chapterGap(open, early)?.sans).toEqual(['e4', 'c5', 'b3']);
  });
});

describe('browsing all of a color', () => {
  it('files a new line in the chapter it continues, or a new chapter named after its opening', async () => {
    const alapin = await createRepertoire('Alapin', 'black');
    await addLine(alapin.id, ['e4', 'c5', 'c3', 'd5']);
    const union = (await loadScopeGraph('black'))!.graph;
    expect(await chapterForNewLine('black', ['e4', 'c5', 'c3', 'Nf6'], union)).toBe(alapin.id);
    const fresh = await chapterForNewLine('black', ['d4', 'd5', 'c4', 'c6'], union);
    expect(fresh).not.toBe(alapin.id);
    expect((await db.repertoires.get(fresh))!.name).toBe('Slav Defense');
  });

  it('deletes a move from every chapter that has it', async () => {
    const a = await createRepertoire('A', 'white');
    const b = await createRepertoire('B', 'white');
    await addLine(a.id, ['e4', 'e5', 'Nf3']);
    await addLine(b.id, ['e4', 'c6', 'd4']);
    const union = (await loadScopeGraph('white'))!.graph;
    await deleteUnionMove(union.edge(START_KEY, 'e4')!);
    expect(await db.moves.count()).toBe(0);
  });
});

describe('merging chapters', () => {
  it('matches an incoming chapter to the existing one covering the same part of the tree', () => {
    const g = (lines: string[]) => new RepGraph('black', movesFromLines('x', 'black', lines));
    const existing = [
      { id: 'all', graph: g(['e4 c5 Nf3 e6', 'd4 Nf6 c4 e6']) }, // a catch-all, branching at the start
      { id: 'alapin', graph: g(['e4 c5 c3 d5 exd5 Qxd5', 'e4 c5 c3 Nf6 e5 Nd5']) },
      { id: 'nimzo', graph: g(['d4 Nf6 c4 e6 Nc3 Bb4']) },
    ];
    // A study chapter on the Alapin with a new sideline: the Alapin chapter, not the catch-all.
    expect(matchChapter(g(['e4 c5 c3 d5 exd5 Qxd5 d4 Nf6', 'e4 c5 c3 e6']), existing)?.id).toBe('alapin');
    expect(matchChapter(g(['d4 Nf6 c4 e6 Nc3 Bb4 Qc2 O-O']), existing)?.id).toBe('nimzo');
    // Nothing on 1.c4 yet.
    expect(matchChapter(g(['c4 e5 Nc3 Nf6']), existing)).toBeUndefined();
  });

  it('merges one chapter into another, keeping notes and fixing repertoires', async () => {
    const a = await createRepertoire('Alapin 1', 'black');
    const b = await createRepertoire('Alapin 2', 'black');
    await addLine(a.id, ['e4', 'c5', 'c3', 'd5']);
    await addLine(b.id, ['e4', 'c5', 'c3', 'Nf6']);
    const { graph } = (await loadGraph(b.id))!;
    await setMoveComment(graph.edge(keyAfter(['e4', 'c5']), 'c3')!.id, 'Alapin');
    await db.collections.add({ id: 's', name: 'S', color: 'black', chapterIds: [a.id, b.id], createdAt: 1, updatedAt: 1 });
    const before = await db.cards.count();
    await mergeChapter(b.id, a.id);
    const merged = (await loadGraph(a.id))!.graph;
    expect([...merged.byId.values()].map((m) => m.san).sort()).toEqual(['Nf6', 'c3', 'c5', 'd5', 'e4']);
    expect(merged.edge(keyAfter(['e4', 'c5']), 'c3')!.comment).toBe('Alapin');
    expect(await db.repertoires.get(b.id)).toBeUndefined();
    expect((await db.collections.get('s'))!.chapterIds).toEqual([a.id]);
    expect(await db.cards.count()).toBe(before);
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

  it('finds where chapters played together give you different moves', () => {
    const exchange = [mv('ex', ['e4']), mv('ex', ['e4', 'c6']), mv('ex', ['e4', 'c6', 'd4']), mv('ex', ['e4', 'c6', 'd4', 'd5']), mv('ex', ['e4', 'c6', 'd4', 'd5', 'exd5'])];
    const fantasy = [mv('fa', ['e4']), mv('fa', ['e4', 'c6']), mv('fa', ['e4', 'c6', 'd4']), mv('fa', ['e4', 'c6', 'd4', 'd5']), mv('fa', ['e4', 'c6', 'd4', 'd5', 'f3'])];
    const [c] = chapterConflicts('white', [...exchange, ...fantasy]);
    expect(c.path).toEqual(['e4', 'c6', 'd4', 'd5']);
    expect(c.options.map((o) => `${o.san}:${o.chapters.join()}`).sort()).toEqual(['exd5:ex', 'f3:fa']);
    // Two moves in one chapter is a choice you made, not a conflict.
    const both = [...exchange, mv('ex', ['e4', 'c6', 'd4', 'd5', 'f3'])];
    expect(chapterConflicts('white', both)).toEqual([]);
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
