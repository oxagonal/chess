/**
 * Chapters and the knowledge they share. A chapter is one color's move tree from the starting
 * position ("Italian", "Caro-Kann, Exchange"); a repertoire is a named set of chapters of one color.
 * Training state lives on cards, one per position and move of yours (`cardIdOf`), so the same move in
 * two chapters is one card, and progress carries across chapters and repertoires.
 *
 * Anything that trains or measures (the trainer, insights, coverage, game prep) works on a union graph
 * of the chapters in play: the same positions and moves, deduplicated, each move's id being its card id.
 * The builder edits one chapter's own graph. Pure: no DOM, no database.
 */
import { turnOfKey, type Color } from './chess';
import { RepGraph } from './graph';
import type { RepMove } from './types';

/** A move's card: `${fromKey}|${san}` (your color is the side to move in fromKey). */
export function cardIdOf(m: { fromKey: string; san: string }): string {
  return `${m.fromKey}|${m.san}`;
}

/** A move of a union graph: `id` is its card id; `sources` are the chapter moves it stands for. */
export interface UnionMove extends RepMove {
  sources: string[];
}

/**
 * The chapters' moves as one graph (all of one color). Positions and moves are merged; a move's note
 * is its chapters' notes (each once), its symbols the first chapter's that has any.
 */
export function unionGraph(color: Color, moves: readonly RepMove[], scopeId: string = color): RepGraph {
  const by = new Map<string, UnionMove>();
  for (const m of moves) {
    const id = cardIdOf(m);
    const u = by.get(id);
    if (!u) {
      by.set(id, { ...m, id, repId: scopeId, sources: [m.id] });
      continue;
    }
    u.sources.push(m.id);
    if (m.comment && !u.comment?.split('\n').includes(m.comment)) u.comment = u.comment ? `${u.comment}\n${m.comment}` : m.comment;
    if (!u.glyphs?.length && m.glyphs?.length) u.glyphs = m.glyphs;
    u.createdAt = Math.min(u.createdAt, m.createdAt);
  }
  return new RepGraph(color, [...by.values()]);
}

/** The cards of a graph's moves (your moves in it) — for a chapter's graph or a union graph. */
export function cardsOf<C extends { id: string }>(graph: RepGraph, cards: readonly C[]): C[] {
  const ids = new Set<string>();
  for (const m of graph.byId.values()) if (m.mine) ids.add(cardIdOf(m));
  return cards.filter((c) => ids.has(c.id));
}

/** The chapter a chapter move belongs to (move ids are `${chapterId}|${fromKey}|${san}`). */
export function chapterOfMoveId(moveId: string): string {
  return moveId.slice(0, moveId.indexOf('|'));
}

/**
 * Which chapter a line belongs in: the chapter of the deepest move of `sans` that a union graph has
 * (e.g. where a coverage gap or a game's deviation should be answered). Undefined if none.
 */
export function chapterForLine(graph: RepGraph, sans: readonly string[]): string | undefined {
  let key = graph.root;
  let last: RepMove | undefined;
  for (const san of sans) {
    const m = graph.edge(key, san);
    if (!m) break;
    last = m;
    key = m.toKey;
  }
  if (!last) last = graph.childrenOf(graph.root)[0];
  return last ? chapterOfMoveId(sourcesOf(last)[0]) : undefined;
}

/** The chapter moves behind a move of a union graph (or the move itself, for a chapter's own graph). */
export function sourcesOf(m: RepMove): string[] {
  return (m as Partial<UnionMove>).sources ?? [m.id];
}

/** A position where chapters played together give you different moves. */
export interface ChapterConflict {
  key: string;
  /** Moves to the position (one move order). */
  path: string[];
  /** Each of your moves there, and the chapters that play it. */
  options: { san: string; chapters: string[] }[];
}

/**
 * Where the chapters disagree: positions (your turn) where one chapter plays a move another chapter
 * that reaches the position doesn't — e.g. 3.exd5 in an Exchange Caro-Kann chapter and 3.f3 in a
 * Fantasy one. Alternatives within one chapter are your own choice and don't count.
 */
export function chapterConflicts(color: Color, moves: readonly RepMove[]): ChapterConflict[] {
  const graph = unionGraph(color, moves);
  const out: ChapterConflict[] = [];
  for (const [key, kids] of graph.children) {
    const mine = kids.filter((m) => m.mine);
    if (mine.length < 2) continue;
    const options = mine.map((m) => ({ san: m.san, chapters: [...new Set(sourcesOf(m).map(chapterOfMoveId))] }));
    const all = new Set(options.flatMap((o) => o.chapters));
    // A conflict: some chapter here lacks one of the moves another chapter plays.
    if (![...all].some((c) => options.some((o) => !o.chapters.includes(c)))) continue;
    const path = graph.pathTo(key);
    if (!path) continue;
    out.push({ key, path: path.map((m) => m.san), options });
  }
  return out.sort((a, b) => a.path.length - b.path.length);
}

/* ------------------------------------------------ migration from per-repertoire cards */

type Row = Record<string, any>;

/** Old card / move ids were `${repId}|${fromKey}|${san}`; position keys never contain '|'. */
function splitOldId(id: string): { repId: string; fromKey: string; san: string } | undefined {
  const parts = id.split('|');
  return parts.length === 3 ? { repId: parts[0], fromKey: parts[1], san: parts[2] } : undefined;
}

/** True for a card row from before chapters (it belongs to a repertoire). */
export function isOldCard(c: Row): boolean {
  return 'repId' in c || !!splitOldId(String(c.id));
}

/** Which of two cards for the same move keeps its progress: learned beats new, then the latest review, then more reviews. */
function better(a: Row, b: Row): Row {
  const learned = (c: Row) => (c.state ?? 0) !== 0;
  if (learned(a) !== learned(b)) return learned(a) ? a : b;
  if ((a.lastReview ?? 0) !== (b.lastReview ?? 0)) return (a.lastReview ?? 0) > (b.lastReview ?? 0) ? a : b;
  return (a.reps ?? 0) >= (b.reps ?? 0) ? a : b;
}

/**
 * Cards and review log from per-repertoire ids to per-position ids. Where two repertoires had the
 * same move, the card with the most progress is kept. Rows already in the new form pass through.
 */
export function migrateCardRows(cards: Row[], logs: Row[]): { cards: Row[]; logs: Row[] } {
  const out = new Map<string, Row>();
  for (const c of cards) {
    const { repId: _r, ...rest } = c;
    const fromKey = String(c.fromKey ?? splitOldId(String(c.id))?.fromKey);
    const san = String(c.san ?? splitOldId(String(c.id))?.san);
    const id = cardIdOf({ fromKey, san });
    const next = { ...rest, id, fromKey, san, color: c.color ?? turnOfKey(fromKey) };
    const had = out.get(id);
    out.set(id, had ? better(had, next) : next);
  }
  const newLogs = logs.map((l) => {
    const old = splitOldId(String(l.cardId));
    const { repId: _r, ...rest } = l;
    if (!old) return { ...rest, color: l.color ?? turnOfKey(String(l.cardId).split('|')[0]) };
    return { ...rest, cardId: cardIdOf(old), color: turnOfKey(old.fromKey) };
  });
  return { cards: [...out.values()], logs: newLogs };
}
