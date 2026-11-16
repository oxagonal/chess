import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb, type ChessDB } from '../db/db';
import { addLine, createRepertoire, deleteMove, deleteRepertoire, gradeCard, setMoveComment } from '../db/repertoire';
import { updateSettings } from '../db/settings';
import { Rating } from '../lib/srs';
import { mergeSync, emptySnapshot, rowKey, SYNC_TABLES, type Row, type SyncDoc, type SyncTable } from '../lib/syncMerge';
import { syncOnce } from '../services/cloudSync';
import { GistTransport, RemoteChangedError, decode, docGroups, encode, MANIFEST, type Transport } from '../services/gist';
import { exportBackup, importBackup } from '../services/backup';
import { markQuiet } from '../db/changes';

/** The synced copy, kept in memory (stands in for the gist). */
class MemoryRemote implements Transport {
  json: string | null = null;
  version = 0;
  writes = 0;
  async read() {
    return { version: this.json ? String(this.version) : null, doc: this.json ? (JSON.parse(this.json) as SyncDoc) : null };
  }
  async latestVersion() {
    return this.json ? String(this.version) : null;
  }
  async write(doc: SyncDoc, expected: string | null) {
    if ((await this.latestVersion()) !== expected) throw new RemoteChangedError();
    this.json = JSON.stringify(doc);
    this.version++;
    this.writes++;
    return String(this.version);
  }
  get doc(): SyncDoc {
    return JSON.parse(this.json!);
  }
}

let clock = 1_700_000_000_000;
const tick = (ms = 1000) => (clock += ms);

let phone: ChessDB;
let remote: MemoryRemote;

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  await Promise.all(db.tables.map((t) => t.clear()));
  phone = openDb(`phone-${Math.random()}`);
  remote = new MemoryRemote();
});

afterEach(async () => {
  vi.restoreAllMocks();
  phone.close();
  await phone.delete();
});

/** A device's data, comparable across devices (review-log ids are per device). */
async function contents(d: ChessDB) {
  const out: Record<string, Row[]> = {};
  for (const t of SYNC_TABLES) {
    const rows = ((await d.table(t).toArray()) as Row[]).map((r) => {
      const { id, ...rest } = r;
      return t === 'reviewLog' ? rest : { id, ...rest };
    });
    out[t] = rows.sort((a, b) => (rowKey(t, a) < rowKey(t, b) ? -1 : 1));
  }
  return out;
}

const sync = async (d: ChessDB) => {
  tick();
  return syncOnce(d, remote);
};

describe('change tracking', () => {
  it('stamps every write with modifiedAt, except writes applying synced data', async () => {
    const rep = await createRepertoire('W', 'white');
    expect((await db.repertoires.get(rep.id))!.modifiedAt).toBe(clock);
    await addLine(rep.id, ['e4']);
    const [move] = await db.moves.toArray();
    tick();
    await setMoveComment(move.id, 'King pawn');
    expect((await db.moves.get(move.id))!.modifiedAt).toBe(clock);
    const [card] = await db.cards.toArray();
    tick();
    await gradeCard(card.id, Rating.Good, 'learn');
    expect((await db.cards.get(card.id))!.modifiedAt).toBe(clock);

    await db.transaction('rw', db.moves, async (tx) => {
      markQuiet(tx);
      await db.moves.put({ ...move, comment: 'from the phone', modifiedAt: 5 });
    });
    expect((await db.moves.get(move.id))!.modifiedAt).toBe(5);
  });
});

describe('merge', () => {
  const move = (id: string, extra: Row = {}) => ({ id, repId: 'r', fromKey: 'x', toKey: 'y', san: id, uci: '', mine: true, createdAt: 1, ...extra });

  it('keeps the newer copy of a row changed on both sides', () => {
    const rep = { id: 'r', name: 'R', color: 'white', createdAt: 1, updatedAt: 1 };
    const local = emptySnapshot();
    local.repertoires.set('r', rep);
    local.moves.set('a', move('a', { comment: 'mine', modifiedAt: 20 }));
    local.moves.set('b', move('b', { comment: 'old', modifiedAt: 10 }));
    const remoteDoc = mergeSync({ local: emptySnapshot(), remote: null, base: null, now: 0 }).doc;
    remoteDoc.tables.repertoires.rows = [rep];
    remoteDoc.tables.moves.rows = [move('a', { comment: 'theirs', modifiedAt: 10 }), move('b', { comment: 'new', modifiedAt: 30 }), move('c')];
    const r = mergeSync({ local, remote: remoteDoc, base: null, now: 100 });
    const byId = Object.fromEntries(r.doc.tables.moves.rows.map((m) => [m.id, m.comment]));
    expect(byId).toEqual({ a: 'mine', b: 'new', c: undefined });
    expect(r.puts.moves.map((m) => m.id).sort()).toEqual(['b', 'c']);
    expect(r.remoteChanged).toContain('moves');
  });

  it('merges a computer review from one device with "prep applied" from another', () => {
    const game = { id: 'g', playedAt: 1, sans: ['e4'] };
    const local = emptySnapshot();
    local.games.set('g', { ...game, review: { depth: 18, analyzedAt: 5, evals: [], best: [] }, modifiedAt: 5 });
    const doc = mergeSync({ local: emptySnapshot(), remote: null, base: null, now: 0 }).doc;
    doc.tables.games.rows = [{ ...game, prepApplied: true, modifiedAt: 9 }];
    const [merged] = mergeSync({ local, remote: doc, base: null, now: 10 }).doc.tables.games.rows;
    expect(merged.prepApplied).toBe(true);
    expect(merged.review.depth).toBe(18);
  });
});

describe('sync between two devices', () => {
  it('copies a repertoire to a new device and keeps both in step', async () => {
    const rep = await createRepertoire('Sicilian', 'black');
    await addLine(rep.id, ['e4', 'c5', 'Nf3', 'd6']);
    await sync(db);
    const first = await sync(phone);
    expect(first.received).toBeGreaterThan(0);
    expect(await contents(phone)).toEqual(await contents(db));

    // Train on the phone while adding a line on the computer.
    tick();
    const c5 = (await phone.cards.toArray()).find((c) => c.san === 'c5')!;
    await phone.cards.update(c5.id, { reps: 1, state: 2, lastReview: clock });
    await phone.reviewLog.add({ cardId: c5.id, repId: rep.id, rating: 3, state: 0, reviewedAt: clock, source: 'review' });
    tick();
    await addLine(rep.id, ['e4', 'c5', 'Nc3', 'Nc6']);

    await sync(phone);
    await sync(db);
    await sync(phone);
    expect(await contents(phone)).toEqual(await contents(db));
    expect((await db.cards.get(c5.id))!.reps).toBe(1);
    expect(await db.reviewLog.count()).toBe(1);
    expect(await phone.moves.count()).toBe(6);
  });

  it('deletes on every device, and a note edited elsewhere doesn’t bring a deleted move back', async () => {
    const rep = await createRepertoire('Sicilian', 'black');
    await addLine(rep.id, ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4']);
    await sync(db);
    await sync(phone);

    const nf3 = (await db.moves.toArray()).find((m) => m.san === 'Nf3')!;
    tick();
    await deleteMove(rep.id, nf3.id);
    // Meanwhile the phone edits a note on d6 (inside the deleted line) and adds a reply under it.
    tick();
    const d6 = (await phone.moves.toArray()).find((m) => m.san === 'd6')!;
    await phone.moves.update(d6.id, { comment: 'Najdorf next' });
    const d4 = (await phone.moves.toArray()).find((m) => m.san === 'd4')!;
    await phone.moves.add({ ...d4, id: `${rep.id}|${d4.fromKey}|c4`, san: 'c4', uci: 'c2c4', toKey: 'elsewhere', createdAt: clock });

    await sync(db);
    await sync(phone);
    await sync(db);
    const sans = (await phone.moves.toArray()).map((m) => m.san).sort();
    expect(sans).toEqual(['c5', 'e4']);
    expect((await phone.cards.toArray()).map((c) => c.san)).toEqual(['c5']);
    expect(await contents(phone)).toEqual(await contents(db));

    // Adding a deleted move again brings it back everywhere.
    tick();
    await addLine(rep.id, ['e4', 'c5', 'Nf3']);
    await sync(db);
    await sync(phone);
    expect((await phone.moves.toArray()).map((m) => m.san).sort()).toEqual(['Nf3', 'c5', 'e4']);
  });

  it('deleting a repertoire removes its moves, cards and history on the other device', async () => {
    const rep = await createRepertoire('W', 'white');
    await addLine(rep.id, ['e4', 'e5', 'Nf3']);
    const [card] = await db.cards.toArray();
    await gradeCard(card.id, Rating.Good, 'learn');
    await sync(db);
    await sync(phone);
    expect(await phone.reviewLog.count()).toBe(1);

    tick();
    await deleteRepertoire(rep.id);
    // The phone trains the card before it hears about the deletion.
    tick();
    await phone.cards.update(card.id, { reps: 5 });
    await sync(db);
    await sync(phone);
    for (const t of ['repertoires', 'moves', 'cards', 'reviewLog'] as SyncTable[]) expect(await phone.table(t).count()).toBe(0);
  });

  it('keeps this device’s Lichess token out of the synced copy', async () => {
    await updateSettings({ lichessToken: 'lip_secret', newPerDay: 7 });
    await phone.kv.put({ key: 'settings', value: { lichessToken: 'lip_phone' } });
    tick();
    await sync(db);
    expect(remote.json).not.toContain('lip_secret');
    await sync(phone);
    const s = (await phone.kv.get('settings'))!.value as Record<string, unknown>;
    expect(s.newPerDay).toBe(7);
    expect(s.lichessToken).toBe('lip_phone');
  });

  it('a restored backup replaces the data on every device', async () => {
    const rep = await createRepertoire('W', 'white');
    await addLine(rep.id, ['e4', 'e5']);
    await sync(db);
    const backup = await exportBackup();
    tick();
    await addLine(rep.id, ['d4', 'd5']);
    await sync(db);
    await sync(phone);
    expect(await phone.moves.count()).toBe(4);
    // The phone adds a repertoire of its own, synced before the restore.
    const other = { id: 'other', name: 'Other', color: 'black' as const, createdAt: clock, updatedAt: clock };
    await phone.repertoires.add(other);
    await sync(phone);

    tick();
    await importBackup(backup);
    await sync(db);
    await sync(phone);
    expect(await phone.moves.count()).toBe(2);
    expect(await phone.repertoires.count()).toBe(1);
    expect(await contents(phone)).toEqual(await contents(db));
  });

  it('can replace a device’s own data with the synced copy when connecting', async () => {
    const rep = await createRepertoire('W', 'white');
    await addLine(rep.id, ['e4']);
    await sync(db);
    await phone.repertoires.add({ id: 'mine', name: 'Phone only', color: 'black', createdAt: 1, updatedAt: 1 });
    tick();
    await syncOnce(phone, remote, { replaceLocal: true });
    expect(await contents(phone)).toEqual(await contents(db));
  });

  it('merges again when another device synced in between', async () => {
    const rep = await createRepertoire('W', 'white');
    await addLine(rep.id, ['e4']);
    await sync(db);
    await sync(phone);
    tick();
    await addLine(rep.id, ['d4']);
    await phone.repertoires.update(rep.id, { name: 'Renamed on phone' });
    // The phone's upload sneaks in between the computer's read and write.
    const realWrite = remote.write.bind(remote);
    let raced = false;
    remote.write = async (doc, expected) => {
      if (!raced) {
        raced = true;
        await syncOnce(phone, { read: () => remote.read(), latestVersion: () => remote.latestVersion(), write: realWrite });
      }
      return realWrite(doc, expected);
    };
    await sync(db);
    remote.write = realWrite;
    await sync(phone);
    expect((await db.repertoires.get(rep.id))!.name).toBe('Renamed on phone');
    expect(await phone.moves.count()).toBe(2);
    expect(await contents(phone)).toEqual(await contents(db));
  });

  it('doesn’t upload when nothing changed', async () => {
    const rep = await createRepertoire('W', 'white');
    await addLine(rep.id, ['e4']);
    await sync(db);
    await sync(phone);
    const writes = remote.writes;
    await sync(db);
    await sync(phone);
    expect(remote.writes).toBe(writes);
  });
});

describe('gist storage', () => {
  /** Just enough of the GitHub gist API. */
  function fakeGitHub() {
    const files: Record<string, string> = {};
    let version = 0;
    const uploads: string[][] = [];
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname;
      const gist = () => ({
        id: 'g1',
        files: Object.fromEntries(Object.entries(files).map(([n, content]) => [n, { content, truncated: false }])),
        history: [{ version: `v${version}` }],
      });
      if (path === '/gists/g1/commits') return json([{ version: `v${version}` }]);
      if (path === '/gists/g1' && (init.method ?? 'GET') === 'GET') return json(gist());
      if (path === '/gists/g1' && init.method === 'PATCH') {
        const body = JSON.parse(init.body as string) as { files: Record<string, { content: string } | null> };
        for (const [name, f] of Object.entries(body.files)) {
          if (f === null) delete files[name];
          else files[name] = f.content;
        }
        version++;
        uploads.push(Object.keys(body.files).sort());
        return json(gist());
      }
      return new Response('{}', { status: 404 });
    });
    files[MANIFEST] = JSON.stringify({ app: 'chess-prep', format: 1, groups: {} });
    return { files, uploads };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('compresses, splits into files, and re-uploads only what changed', async () => {
    const gh = fakeGitHub();
    const t = new GistTransport('token', 'g1', 200);
    expect((await t.read()).doc).toBeNull();

    const rep = await createRepertoire('W', 'white');
    await addLine(rep.id, ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7']);
    await db.games.add({ id: 'lichess:1', source: 'lichess', account: 'me', url: '', white: 'me', black: 'you', userColor: 'white', result: '1-0', timeClass: 'blitz', rated: true, playedAt: Date.UTC(2025, 3, 1), sans: ['e4', 'e5'] });
    await syncOnce(db, t);
    expect(gh.files['moves.0.txt']).toBeDefined();
    expect(gh.files['moves.1.txt']).toBeDefined(); // split at 200 characters
    expect(gh.files['games.2025.0.txt']).toBeDefined();

    // Another device reads it back.
    await syncOnce(phone, new GistTransport('token', 'g1', 200));
    expect(await contents(phone)).toEqual(await contents(db));

    // Grading a card uploads cards + review log + manifest, not moves or games.
    tick();
    const [card] = await db.cards.toArray();
    await gradeCard(card.id, Rating.Good, 'learn');
    tick();
    await syncOnce(db, t);
    const last = gh.uploads.at(-1)!;
    expect(last).toContain(MANIFEST);
    expect(last.some((n) => n.startsWith('cards.'))).toBe(true);
    expect(last.some((n) => n.startsWith('reviewLog.'))).toBe(true);
    expect(last.some((n) => n.startsWith('moves.') || n.startsWith('games.'))).toBe(false);
  });

  it('round-trips the encoding and groups the review log by month', async () => {
    const text = JSON.stringify({ hello: 'wörld', n: [1, 2, 3] });
    const { enc, data } = await encode(text);
    expect(enc).toBe('gzip-base64');
    expect(await decode(data, enc)).toBe(text);
    const doc = mergeSync({ local: emptySnapshot(), remote: null, base: null, now: 0 }).doc;
    doc.tables.reviewLog.rows = [
      { cardId: 'a', reviewedAt: Date.UTC(2026, 0, 5) },
      { cardId: 'a', reviewedAt: Date.UTC(2026, 1, 5) },
    ];
    expect([...docGroups(doc).keys()]).toEqual(['reviewLog.2026-01', 'reviewLog.2026-02']);
  });
});
