import { db, uid } from './db';
import { getSettings } from './settings';
import { RepGraph } from '../lib/graph';
import { toRepMove, edgesForLine } from '../lib/lines';
import { graphToPgn, pgnToEdges, type ImportedEdge } from '../lib/pgn';
import { grade, gradeAhead, newCard, Rating } from '../lib/srs';
import { START_KEY, type Color } from '../lib/chess';
import type { Repertoire, RepMove, ReviewCard, ReviewSource } from '../lib/types';
import type { Grade } from 'ts-fsrs';
import { cardIdOf } from '../lib/chapters';
import { cleanAnnotation, type MoveAnnotation } from '../lib/annotations';

export async function createRepertoire(name: string, color: Color): Promise<Repertoire> {
  const now = Date.now();
  const rep: Repertoire = { id: uid(), name: name.trim() || `${color === 'white' ? 'White' : 'Black'} repertoire`, color, createdAt: now, updatedAt: now };
  await db.repertoires.add(rep);
  return rep;
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

/** Fetch a Lichess study (all chapters) as PGN. Accepts a study or chapter URL or bare id. */
export async function fetchLichessStudy(urlOrId: string): Promise<string> {
  const m = urlOrId.match(/(?:study\/)?([A-Za-z0-9]{8})(?:\/([A-Za-z0-9]{8}))?/);
  if (!m) throw new Error('Could not find a study id in that URL');
  const [, studyId, chapterId] = m;
  const url = chapterId
    ? `https://lichess.org/api/study/${studyId}/${chapterId}.pgn?comments=true&variations=true&clocks=false`
    : `https://lichess.org/api/study/${studyId}.pgn?comments=true&variations=true&clocks=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status === 404 ? 'Study not found (is it public?)' : `Lichess returned HTTP ${res.status}`);
  return res.text();
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
