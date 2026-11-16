import { db, uid } from './db';
import { getSettings } from './settings';
import { RepGraph } from '../lib/graph';
import { toRepMove, edgesForLine } from '../lib/lines';
import { graphToPgn, pgnToEdges, type ImportedEdge } from '../lib/pgn';
import { grade, newCard, Rating } from '../lib/srs';
import { START_KEY, type Color } from '../lib/chess';
import type { Repertoire, RepMove, ReviewCard, ReviewSource } from '../lib/types';
import type { Grade } from 'ts-fsrs';

export async function createRepertoire(name: string, color: Color): Promise<Repertoire> {
  const now = Date.now();
  const rep: Repertoire = { id: uid(), name: name.trim() || `${color === 'white' ? 'White' : 'Black'} repertoire`, color, createdAt: now, updatedAt: now };
  await db.repertoires.add(rep);
  return rep;
}

export async function renameRepertoire(id: string, name: string) {
  await db.repertoires.update(id, { name, updatedAt: Date.now() });
}

export async function deleteRepertoire(id: string) {
  await db.transaction('rw', [db.repertoires, db.moves, db.cards, db.coverage, db.reviewLog], async () => {
    await db.moves.where('repId').equals(id).delete();
    await db.cards.where('repId').equals(id).delete();
    await db.reviewLog.where('repId').equals(id).delete();
    await db.coverage.delete(id);
    await db.repertoires.delete(id);
  });
}

export async function loadGraph(repId: string): Promise<{ rep: Repertoire; graph: RepGraph } | undefined> {
  const rep = await db.repertoires.get(repId);
  if (!rep) return undefined;
  const moves = await db.moves.where('repId').equals(repId).toArray();
  return { rep, graph: new RepGraph(rep.color, moves) };
}

/**
 * Add edges to a repertoire (existing ones are kept; empty comments get filled in).
 * Every new move of yours gets a fresh spaced-repetition card.
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
    const toAdd: RepMove[] = [];
    const seen = new Set<string>();
    const cards: ReviewCard[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const m = candidates[i];
      const ex = existing[i];
      if (ex) {
        if (m.comment && !ex.comment) await db.moves.update(ex.id, { comment: m.comment });
        continue;
      }
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      toAdd.push(m);
      if (m.mine) {
        const c = newCard({ id: m.id, repId, fromKey: m.fromKey, san: m.san }, now);
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
    let moves = (await db.moves.where('repId').equals(repId).toArray()).filter((m) => m.id !== id);
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
    await db.cards.bulkDelete(doomed);
    await db.repertoires.update(repId, { updatedAt: Date.now() });
    removed = doomed.length;
  });
  return removed;
}

export async function setMoveComment(id: string, comment: string) {
  await db.moves.update(id, { comment: comment.trim() || undefined });
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
export async function gradeCard(cardId: string, rating: Grade, source: ReviewSource, gameId?: string): Promise<ReviewCard | undefined> {
  const settings = await getSettings();
  return db.transaction('rw', [db.cards, db.reviewLog], async () => {
    const card = await db.cards.get(cardId);
    if (!card) return undefined;
    const now = Date.now();
    const next = grade(card, rating, { requestRetention: settings.requestRetention, maximumIntervalDays: settings.maxIntervalDays }, now);
    await db.cards.put(next);
    await db.reviewLog.add({ cardId, repId: card.repId, rating, state: card.state, reviewedAt: now, source, gameId });
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

export async function resetCards(repId: string) {
  const cards = await db.cards.where('repId').equals(repId).toArray();
  const now = Date.now();
  await db.cards.bulkPut(cards.map((c) => newCard({ id: c.id, repId: c.repId, fromKey: c.fromKey, san: c.san }, now)));
}
