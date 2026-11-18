import { db, uid } from './db';
import { getSettings, type AppSettings } from './settings';
import { moveId, RepGraph } from '../lib/graph';
import { toRepMove, edgesForLine } from '../lib/lines';
import { graphToPgn, pgnToEdges, type ImportedEdge } from '../lib/pgn';
import { grade, gradeAhead, newCard, Rating } from '../lib/srs';
import { START_KEY, type Color } from '../lib/chess';
import type { Collection, Repertoire, RepMove, ReviewCard, ReviewSource } from '../lib/types';
import type { Grade } from 'ts-fsrs';
import { cardIdOf } from '../lib/chapters';
import { cleanAnnotation, type MoveAnnotation } from '../lib/annotations';

export async function createRepertoire(name: string, color: Color): Promise<Repertoire> {
  const now = Date.now();
  const rep: Repertoire = { id: uid(), name: name.trim() || `${color === 'white' ? 'White' : 'Black'} repertoire`, color, createdAt: now, updatedAt: now };
  await db.repertoires.add(rep);
  return rep;
}

/* Repertoires: named sets of chapters of one color (stored as `collections`). */

export async function createCollection(name: string, color: Color, chapterIds: string[]): Promise<Collection> {
  const now = Date.now();
  const set: Collection = { id: uid(), name: name.trim() || 'Repertoire', color, chapterIds, createdAt: now, updatedAt: now };
  await db.collections.add(set);
  return set;
}

export async function updateCollection(id: string, patch: Partial<Pick<Collection, 'name' | 'chapterIds'>>) {
  await db.collections.update(id, { ...patch, updatedAt: Date.now() });
}

export async function deleteCollection(id: string) {
  await db.transaction('rw', [db.collections, db.coverage], async () => {
    await db.collections.delete(id);
    await db.coverage.delete(`set:${id}`);
  });
}

/**
 * Split a chapter into new chapters, each given the ids of the chapter's moves it keeps (with their
 * notes). Your progress is untouched: cards belong to positions, not chapters. Unless `keepOriginal`,
 * the chapter is then deleted, and repertoires that had it get the new chapters instead.
 */
export async function splitChapter(chapterId: string, parts: { name: string; moveIds: string[] }[], opts: { keepOriginal?: boolean } = {}): Promise<string[]> {
  const ids: string[] = [];
  await db.transaction('rw', [db.repertoires, db.moves, db.cards, db.coverage, db.collections], async () => {
    const chapter = await db.repertoires.get(chapterId);
    if (!chapter) throw new Error('Chapter not found');
    const moves = new Map((await db.moves.where('repId').equals(chapterId).toArray()).map((m) => [m.id, m]));
    const now = Date.now();
    for (const [i, part] of parts.entries()) {
      const id = uid();
      ids.push(id);
      await db.repertoires.add({ id, name: part.name.trim() || `${chapter.name} ${i + 1}`, color: chapter.color, createdAt: now, updatedAt: now, ...(chapter.oneInN ? { oneInN: chapter.oneInN } : {}) });
      const copies = part.moveIds.map((mid) => moves.get(mid)).filter((m): m is RepMove => !!m);
      await db.moves.bulkAdd(copies.map(({ modifiedAt: _m, ...m }) => ({ ...m, id: moveId(id, m.fromKey, m.san), repId: id })));
    }
    if (opts.keepOriginal) return;
    await db.moves.where('repId').equals(chapterId).delete();
    await pruneCards([...moves.values()]);
    await db.coverage.delete(chapterId);
    await db.repertoires.delete(chapterId);
    await db.collections
      .filter((c) => c.chapterIds.includes(chapterId))
      .modify((c) => {
        c.chapterIds = c.chapterIds.flatMap((x) => (x === chapterId ? ids : [x]));
      });
  });
  return ids;
}

/**
 * Split a line off by hand: `startId` (a move) and everything after it go to another chapter (a new one named
 * `target.name`, or an existing one), with the moves leading to it copied so it starts from move 1.
 * The original chapter loses what only that move led to (positions it reaches another way stay);
 * with `keepCopy` it keeps everything. Progress is untouched. Returns the target chapter's id.
 */
export async function splitOff(chapterId: string, startId: string, target: { name: string } | { chapterId: string }, opts: { keepCopy?: boolean } = {}): Promise<string> {
  let targetId = '';
  await db.transaction('rw', [db.repertoires, db.moves, db.cards], async () => {
    const chapter = await db.repertoires.get(chapterId);
    if (!chapter) throw new Error('Chapter not found');
    const moves = await db.moves.where('repId').equals(chapterId).toArray();
    const graph = new RepGraph(chapter.color, moves);
    const start = graph.byId.get(startId);
    if (!start) throw new Error('Move not found');
    // The line: the moves to it, the move, and everything that follows.
    const take = new Map<string, RepMove>((graph.pathTo(start.fromKey) ?? []).map((m) => [m.id, m]));
    const stack = [start];
    while (stack.length) {
      const m = stack.pop()!;
      if (take.has(m.id)) continue;
      take.set(m.id, m);
      stack.push(...graph.childrenOf(m.toKey));
    }
    const now = Date.now();
    if ('chapterId' in target) {
      const t = await db.repertoires.get(target.chapterId);
      if (!t || t.color !== chapter.color) throw new Error('Pick a chapter of the same color');
      targetId = t.id;
    } else {
      targetId = uid();
      await db.repertoires.add({ id: targetId, name: target.name.trim() || `${chapter.name} — ${start.san}`, color: chapter.color, createdAt: now, updatedAt: now });
    }
    const copies = [...take.values()].map(({ modifiedAt: _m, ...m }) => ({ ...m, id: moveId(targetId, m.fromKey, m.san), repId: targetId }));
    const have = new Set((await db.moves.bulkGet(copies.map((c) => c.id))).filter((x): x is RepMove => !!x).map((x) => x.id));
    await db.moves.bulkAdd(copies.filter((c) => !have.has(c.id)));
    await db.repertoires.update(targetId, { updatedAt: now });
    if (opts.keepCopy) return;
    // From the original: the move and whatever only it led to.
    let rest = moves.filter((m) => m.id !== startId);
    const gone = [startId];
    for (;;) {
      const orphans = new RepGraph(chapter.color, rest).orphanMoves();
      if (!orphans.length) break;
      const ids = new Set(orphans.map((m) => m.id));
      gone.push(...ids);
      rest = rest.filter((m) => !ids.has(m.id));
    }
    await db.moves.bulkDelete(gone);
    await db.repertoires.update(chapterId, { updatedAt: now });
  });
  return targetId;
}

/**
 * Merge a chapter into another of the same color: its moves (with notes and symbols) join the
 * target, it's deleted, and repertoires that had it get the target instead. Progress is untouched.
 */
export async function mergeChapter(fromId: string, intoId: string) {
  if (fromId === intoId) return;
  await db.transaction('rw', [db.repertoires, db.moves, db.cards, db.coverage, db.collections], async () => {
    const [from, into] = await Promise.all([db.repertoires.get(fromId), db.repertoires.get(intoId)]);
    if (!from || !into) throw new Error('Chapter not found');
    if (from.color !== into.color) throw new Error("Chapters of different colors can't be merged");
    const moves = await db.moves.where('repId').equals(fromId).toArray();
    const copies = moves.map(({ modifiedAt: _m, ...m }) => ({ ...m, id: moveId(intoId, m.fromKey, m.san), repId: intoId }));
    const have = await db.moves.bulkGet(copies.map((c) => c.id));
    const add: RepMove[] = [];
    for (const [i, c] of copies.entries()) {
      const ex = have[i];
      if (!ex) add.push(c);
      else if ((c.comment && !ex.comment) || (c.glyphs?.length && !ex.glyphs?.length))
        await db.moves.update(ex.id, { comment: ex.comment || c.comment, glyphs: ex.glyphs?.length ? ex.glyphs : c.glyphs });
    }
    await db.moves.bulkAdd(add);
    await db.moves.where('repId').equals(fromId).delete();
    await db.coverage.delete(fromId);
    await db.repertoires.delete(fromId);
    await db.repertoires.update(intoId, { updatedAt: Date.now() });
    await db.collections
      .filter((c) => c.chapterIds.includes(fromId))
      .modify((c) => {
        c.chapterIds = [...new Set(c.chapterIds.map((x) => (x === fromId ? intoId : x)))];
      });
  });
}

export async function renameRepertoire(id: string, name: string) {
  await db.repertoires.update(id, { name, updatedAt: Date.now() });
}

/**
 * Sets the repertoire's coverage target (1 in N games). Leaves updatedAt alone: the moves haven't
 * changed, and a stored coverage result already goes stale when its threshold differs.
 */
export async function setRepertoireTarget(id: string, oneInN: number) {
  await db.repertoires.update(id, { oneInN });
}

/**
 * Delete a chapter. Cards (your progress) go only for moves no other chapter has; the review log
 * stays (it's history, and other chapters' cards share it).
 */
export async function deleteRepertoire(id: string) {
  await db.transaction('rw', [db.repertoires, db.moves, db.cards, db.coverage, db.collections], async () => {
    const moves = await db.moves.where('repId').equals(id).toArray();
    await db.moves.where('repId').equals(id).delete();
    await pruneCards(moves);
    await db.coverage.delete(id);
    await db.repertoires.delete(id);
    // Out of the repertoires that had it.
    await db.collections
      .filter((c) => c.chapterIds.includes(id))
      .modify((c) => {
        c.chapterIds = c.chapterIds.filter((x) => x !== id);
      });
  });
}

/** After moves were deleted: drop the cards of those moves that no chapter has any more. */
async function pruneCards(deleted: readonly RepMove[]) {
  const mine = deleted.filter((m) => m.mine);
  if (!mine.length) return;
  const still = await db.moves.where('fromKey').anyOf([...new Set(mine.map((m) => m.fromKey))]).toArray();
  const kept = new Set(still.filter((m) => m.mine).map(cardIdOf));
  await db.cards.bulkDelete([...new Set(mine.map(cardIdOf))].filter((id) => !kept.has(id)));
}

export async function loadGraph(repId: string): Promise<{ rep: Repertoire; graph: RepGraph } | undefined> {
  const rep = await db.repertoires.get(repId);
  if (!rep) return undefined;
  const moves = await db.moves.where('repId').equals(repId).toArray();
  return { rep, graph: new RepGraph(rep.color, moves) };
}

/**
 * Add edges to a chapter (existing ones are kept; empty notes and symbols get filled in). A new move
 * of yours gets a fresh spaced-repetition card — unless another chapter already has that move, in
 * which case it shares that card (and what you've learned of it).
 */
/**
 * `known`: you already know these moves (Play from memory) — your cards start as learned (graded
 * Easy now), so they skip Learn and go straight into normal reviews.
 */
export async function addEdges(repId: string, edges: ImportedEdge[], opts: { known?: boolean } = {}): Promise<{ added: number; mineAdded: number }> {
  const rep = await db.repertoires.get(repId);
  if (!rep) throw new Error('Repertoire not found');
  const now = Date.now();
  let added = 0;
  let mineAdded = 0;
  await db.transaction('rw', [db.moves, db.cards, db.repertoires], async () => {
    const candidates = edges.map((e, i) => toRepMove(repId, rep.color, e, now + i));
    const existing = await db.moves.bulkGet(candidates.map((m) => m.id));
    const mineIds = [...new Set(candidates.filter((m) => m.mine).map(cardIdOf))];
    const haveCard = new Set((await db.cards.bulkGet(mineIds)).filter((c): c is ReviewCard => !!c).map((c) => c.id));
    const toAdd: RepMove[] = [];
    const seen = new Set<string>();
    const cards: ReviewCard[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const m = candidates[i];
      const ex = existing[i];
      if (ex) {
        if ((m.comment && !ex.comment) || (m.glyphs?.length && !ex.glyphs?.length))
          await db.moves.update(ex.id, { comment: ex.comment || m.comment, glyphs: ex.glyphs?.length ? ex.glyphs : m.glyphs });
        continue;
      }
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      toAdd.push(m);
      if (m.mine && !haveCard.has(cardIdOf(m))) {
        haveCard.add(cardIdOf(m));
        const c = newCard({ id: cardIdOf(m), color: rep.color, fromKey: m.fromKey, san: m.san }, now);
        cards.push(opts.known ? grade(c, Rating.Easy, undefined, now) : c);
      }
    }
    await db.moves.bulkAdd(toAdd);
    await db.cards.bulkPut(cards);
    added = toAdd.length;
    mineAdded = cards.length;
    if (added) await db.repertoires.update(repId, { updatedAt: now });
  });
  return { added, mineAdded };
}

export async function addLine(repId: string, sans: string[], startKey: string = START_KEY) {
  const edges = edgesForLine(sans, startKey);
  if (!edges) throw new Error('Illegal move in line');
  return addEdges(repId, edges);
}

/** Delete a move and everything that is only reachable through it. Returns number of moves removed. */
export async function deleteMove(repId: string, id: string): Promise<number> {
  let removed = 0;
  await db.transaction('rw', [db.moves, db.cards, db.repertoires], async () => {
    const rep = await db.repertoires.get(repId);
    if (!rep) return;
    const all = await db.moves.where('repId').equals(repId).toArray();
    let moves = all.filter((m) => m.id !== id);
    const doomed = [id];
    // Repeatedly drop moves whose origin became unreachable.
    for (;;) {
      const orphans = new RepGraph(rep.color, moves).orphanMoves();
      if (!orphans.length) break;
      const ids = new Set(orphans.map((m) => m.id));
      doomed.push(...ids);
      moves = moves.filter((m) => !ids.has(m.id));
    }
    await db.moves.bulkDelete(doomed);
    const gone = new Set(doomed);
    await pruneCards(all.filter((m) => gone.has(m.id)));
    await db.repertoires.update(repId, { updatedAt: Date.now() });
    removed = doomed.length;
  });
  return removed;
}

export async function setMoveComment(id: string, comment: string) {
  await db.moves.update(id, { comment: comment.trim() || undefined });
}

/** Save a move's symbols and comment together (the right-click annotation menu). */
export async function setMoveAnnotation(id: string, a: MoveAnnotation | undefined) {
  const clean = cleanAnnotation(a);
  await db.moves.update(id, { comment: clean?.comment, glyphs: clean?.glyphs });
}

export async function importPgn(repId: string, pgn: string) {
  const loaded = await loadGraph(repId);
  if (!loaded) throw new Error('Repertoire not found');
  const result = pgnToEdges(pgn, loaded.graph.reachableKeys());
  const { added, mineAdded } = await addEdges(repId, result.edges);
  return { ...result, added, mineAdded };
}

export async function exportPgn(repId: string): Promise<string> {
  const loaded = await loadGraph(repId);
  if (!loaded) throw new Error('Repertoire not found');
  return graphToPgn(loaded.graph, {
    Event: loaded.rep.name,
    Orientation: loaded.rep.color,
  });
}

/** Whether the connected Lichess account lets us read its studies (private and unlisted ones too). */
export function canReadStudies(s: Pick<AppSettings, 'lichessToken' | 'lichessScopes'>): boolean {
  return !!s.lichessToken && s.lichessScopes.split(/\s+/).includes('study:read');
}

async function lichessHeaders(): Promise<HeadersInit> {
  const s = await getSettings();
  return s.lichessToken ? { Authorization: `Bearer ${s.lichessToken}` } : {};
}

/**
 * Fetch a Lichess study (all chapters) as PGN. Accepts a study or chapter URL or bare id. Sent with
 * your Lichess login, so your private and unlisted studies come through too.
 */
export async function fetchLichessStudy(urlOrId: string): Promise<string> {
  const m = urlOrId.match(/(?:study\/)?([A-Za-z0-9]{8})(?:\/([A-Za-z0-9]{8}))?/);
  if (!m) throw new Error('Could not find a study id in that URL');
  const [, studyId, chapterId] = m;
  const url = chapterId
    ? `https://lichess.org/api/study/${studyId}/${chapterId}.pgn?comments=true&variations=true&clocks=false`
    : `https://lichess.org/api/study/${studyId}.pgn?comments=true&variations=true&clocks=false`;
  const res = await fetch(url, { headers: await lichessHeaders() });
  if (res.ok) return res.text();
  if (res.status === 404 || res.status === 403 || res.status === 401) {
    const s = await getSettings();
    throw new Error(
      canReadStudies(s)
        ? 'Study not found — check the link, and that your connected Lichess account can see it.'
        : s.lichessToken
          ? 'Study not found or private — reconnect Lichess (allowing it to read your studies) to import private and unlisted ones.'
          : 'Study not found or private — connect Lichess to import your private and unlisted studies.',
    );
  }
  throw new Error(`Lichess returned HTTP ${res.status}`);
}

export interface LichessStudyInfo {
  id: string;
  name: string;
  updatedAt: number;
}

/** Your own Lichess studies (private and unlisted included), most recently changed first. */
export async function listMyStudies(): Promise<LichessStudyInfo[]> {
  const s = await getSettings();
  if (!s.lichessAccount) throw new Error('Connect Lichess first.');
  const res = await fetch(`https://lichess.org/api/study/by/${encodeURIComponent(s.lichessAccount)}`, { headers: await lichessHeaders() });
  if (!res.ok) throw new Error(res.status === 401 ? 'Your Lichess connection has expired — reconnect Lichess.' : `Lichess returned HTTP ${res.status}`);
  const out: LichessStudyInfo[] = [];
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as { id?: string; name?: string; updatedAt?: number; createdAt?: number };
      if (j.id) out.push({ id: j.id, name: j.name ?? j.id, updatedAt: j.updatedAt ?? j.createdAt ?? 0 });
    } catch {
      /* skip a malformed line */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Grade a card and append to the review log. */
/** `ahead`: a drill — a correct answer before the move is due restarts its interval rather than growing it (see gradeAhead). */
export async function gradeCard(
  cardId: string,
  rating: Grade,
  source: ReviewSource,
  gameId?: string,
  opts: { ahead?: boolean } = {},
): Promise<ReviewCard | undefined> {
  const settings = await getSettings();
  return db.transaction('rw', [db.cards, db.reviewLog], async () => {
    const card = await db.cards.get(cardId);
    if (!card) return undefined;
    const now = Date.now();
    const srs = { requestRetention: settings.requestRetention, maximumIntervalDays: settings.maxIntervalDays };
    const next = opts.ahead ? gradeAhead(card, rating, srs, now) : grade(card, rating, srs, now);
    await db.cards.put(next);
    await db.reviewLog.add({ cardId, color: card.color, rating, state: card.state, reviewedAt: now, source, gameId });
    return next;
  });
}

/** Make cards due right now (e.g. after forgetting them in a real game). */
export async function markForgotten(cardIds: string[], gameId?: string) {
  for (const id of cardIds) {
    const card = await db.cards.get(id);
    if (!card) continue;
    if (card.state === 0) continue; // never learned: nothing to forget, it's still in the learn queue
    await gradeCard(id, Rating.Again, 'game', gameId);
    // Relearning would normally wait a few minutes; a move forgotten over the board should be drilled now.
    await db.cards.update(id, { due: Date.now() });
  }
}

/** Forget what you've learned of a chapter's moves (shared cards too: they're the same moves). */
export async function resetCards(repId: string) {
  const moves = await db.moves.where('repId').equals(repId).toArray();
  const cards = (await db.cards.bulkGet([...new Set(moves.filter((m) => m.mine).map(cardIdOf))])).filter((c): c is ReviewCard => !!c);
  const now = Date.now();
  await db.cards.bulkPut(cards.map((c) => newCard({ id: c.id, color: c.color, fromKey: c.fromKey, san: c.san }, now)));
}
