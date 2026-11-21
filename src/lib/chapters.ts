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
import { playSan, START_KEY, startPos, turnOfKey, type Color } from './chess';
import { RepGraph } from './graph';
import type { RepMove } from './types';
import { nameParts, type OpeningIndex } from './openingNames';

/**
 * The moves that are trained: without the ones marked not to train, and without whatever can only be
 * reached through them (a blunder's refutation, say). Everything else is untouched.
 */
export function trainable<M extends RepMove>(color: Color, moves: readonly M[]): M[] {
  if (!moves.some((m) => m.noTrain)) return [...moves];
  const kept = moves.filter((m) => !m.noTrain);
  const reach = new RepGraph(color, kept).reachableKeys();
  return kept.filter((m) => reach.has(m.fromKey));
}

/** Alphabetical by name, for lists of chapters and repertoires to pick from ("#2" before "#10"). */
export const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

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
 * A chapter's own part of the tree: its opening's position (chapterPosition — 1.e4 c5 2.Nf3 d6 3.d4
 * cxd4 4.Nxd4 Nf6 5.Nc3 a6 for a Najdorf) and every position after it in the chapter, as opposed to
 * the moves it shares with other chapters on the way there. Undefined for a chapter whose opening is
 * the start position (it has no part of its own).
 */
export function chapterTerritory(graph: RepGraph, names: OpeningIndex | undefined, chapterName?: string): { key: string; moves: RepMove[]; keys: Set<string> } | undefined {
  const { key, moves } = chapterPosition(graph, names, chapterName);
  if (key === graph.root || !graph.has(key)) return undefined;
  const keys = new Set<string>([key]);
  const stack = [key];
  while (stack.length) {
    for (const m of graph.childrenOf(stack.pop()!)) {
      if (keys.has(m.toKey)) continue;
      keys.add(m.toKey);
      stack.push(m.toKey);
    }
  }
  return { key, moves, keys };
}

/**
 * Where saving a line (`path`, from the start) into a chapter would go into another chapter's own part
 * of the tree (see chapterTerritory): the first move the chapter doesn't have yet (`has`) that leads
 * from outside that part into it — a transposition, or a line carried on in the wrong chapter.
 */
export function entersOtherChapter<T extends { keys: ReadonlySet<string> }>(
  path: readonly { fromKey: string; key: string; san: string }[],
  has: (fromKey: string, san: string) => boolean,
  others: readonly T[],
): { index: number; other: T } | undefined {
  for (let i = 0; i < path.length; i++) {
    const m = path[i];
    if (has(m.fromKey, m.san)) continue;
    const other = others.find((o) => o.keys.has(m.key) && !o.keys.has(m.fromKey));
    if (other) return { index: i, other };
  }
  return undefined;
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

/**
 * Where a chapter branches: the moves from the start while there's only one way on (its trunk), and
 * the position at the end of them. A chapter that starts with several first moves branches at once.
 */
export function chapterTrunk(graph: RepGraph): { trunk: RepMove[]; key: string } {
  const trunk: RepMove[] = [];
  let key = graph.root;
  const seen = new Set([key]);
  for (let kids = graph.childrenOf(key); kids.length === 1 && !seen.has(kids[0].toKey); kids = graph.childrenOf(key)) {
    trunk.push(kids[0]);
    key = kids[0].toKey;
    seen.add(key);
  }
  return { trunk, key };
}

/**
 * Which existing chapter an incoming one (e.g. a study chapter) belongs in, by position: it does
 * when the incoming one passes through the chapter's branch position — and, for a chapter that
 * branches right at the start (a catch-all), when they also share real positions (a 1.c4 study
 * doesn't belong in a 1.e4 / 1.d4 catch-all). The chapter branching deepest (the most specific)
 * wins, then the one sharing the most positions. Undefined when none matches.
 */
export function matchChapter(incoming: RepGraph, candidates: readonly { id: string; graph: RepGraph }[]): { id: string; share: number } | undefined {
  const mine = incoming.reachableKeys();
  mine.delete(incoming.root);
  let best: { id: string; share: number; depth: number } | undefined;
  for (const c of candidates) {
    if (!c.graph.size) continue;
    const { trunk, key } = chapterTrunk(c.graph);
    if (!incoming.has(key)) continue;
    const theirs = c.graph.reachableKeys();
    let shared = 0;
    for (const k of mine) if (theirs.has(k)) shared++;
    if (!trunk.length && shared < 2) continue;
    const share = mine.size ? shared / mine.size : 0;
    if (!best || trunk.length > best.depth || (trunk.length === best.depth && share > best.share)) best = { id: c.id, share, depth: trunk.length };
  }
  return best && { id: best.id, share: best.share };
}

/**
 * The position that defines a chapter's opening — "1.e4 d6" for a Pirc chapter, "1.e4 c5 2.c3" for an
 * Alapin — even if the chapter only goes on one way for a while after it (a Black chapter's single
 * prepared reply isn't part of the opening's name). Along the chapter's trunk: the earliest position
 * with the same opening and variation as the deepest named one. Without names, the whole trunk.
 */
export function chapterPosition(graph: RepGraph, names: OpeningIndex | undefined, chapterName?: string): { moves: RepMove[]; key: string } {
  const { trunk, key } = chapterTrunk(graph);
  if (!names) return { moves: trunk, key };
  const group = (n: string) => {
    const p = nameParts(n);
    return p.variation ? `${p.family}: ${p.variation}` : p.family;
  };
  const named = [...graph.reachableKeys()].flatMap((k) => (names.has(k) ? [{ k, n: names.get(k)! }] : []));
  // The chapter's opening: its own name when that's an opening it has (chapters made by splitting
  // are named that way); else the variation most of its lines end up in, if most do; else the opening.
  let match: (n: string) => boolean = () => false;
  if (chapterName && named.some((x) => group(x.n) === chapterName)) match = (n) => group(n) === chapterName;
  else if (chapterName && named.some((x) => nameParts(x.n).family === chapterName)) match = (n) => nameParts(n).family === chapterName;
  else {
    const ends: string[] = [];
    for (const leaf of graph.leaves()) {
      const path = graph.pathTo(leaf) ?? [];
      for (let i = path.length - 1; i >= 0; i--) {
        const n = names.get(path[i].toKey);
        if (n) {
          ends.push(n);
          break;
        }
      }
    }
    if (!ends.length) return { moves: trunk, key };
    const top = (xs: string[]) => {
      const c = new Map<string, number>();
      for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
      let best = xs[0];
      for (const [x, v] of c) if (v > (c.get(best) ?? 0)) best = x;
      return { value: best, share: (c.get(best) ?? 0) / xs.length };
    };
    const variation = top(ends.map(group));
    if (variation.share >= 0.6) match = (n) => group(n) === variation.value;
    else {
      const family = top(ends.map((n) => nameParts(n).family)).value;
      match = (n) => nameParts(n).family === family;
    }
  }
  // …and the earliest position in the chapter with that name (a Dutch chapter that also plays
  // 1...e6 first is still 1.d4 f5; a King's Indian, Fianchetto is the fianchetto position).
  let best: RepMove[] | undefined;
  for (const { k, n } of named) {
    if (!match(n)) continue;
    const path = graph.pathTo(k);
    if (path && (!best || path.length < best.length)) best = path;
  }
  if (!best?.length) return { moves: trunk, key };
  return { moves: best, key: best[best.length - 1].toKey };
}

export type LineRoute = { kind: 'one'; id: string } | { kind: 'tie'; ids: string[] } | { kind: 'new'; name: string };

/**
 * Which chapter a line (SANs from the start) belongs in. A chapter claims a line that passes
 * through its own opening position (see chapterPosition) — so 1.Nf3 d5 2.b3 isn't the business of a
 * Semi-Slav chapter just because it reaches the Semi-Slav by 1.Nf3 d5 — and the most specific claim
 * (the deepest opening position) wins. Failing that, a chapter named for the line's own opening;
 * then a chapter that branches at the start (a catch-all); else a new chapter named after the
 * opening. Two chapters that fit equally well are a tie, for you to choose.
 */
export function routeLine(sans: readonly string[], chapters: readonly { id: string; name: string; graph: RepGraph }[], names: OpeningIndex | undefined): LineRoute {
  // The line's positions, and its own opening's name.
  const keys = new Set<string>([START_KEY]);
  let pos = startPos();
  let lineName: string | undefined;
  for (const san of sans) {
    const r = playSan(pos, san);
    if (!r) break;
    pos = r.pos;
    keys.add(r.key);
    const n = names?.get(r.key);
    if (n) lineName = n;
  }
  const group = (n: string) => {
    const p = nameParts(n);
    return p.variation ? `${p.family}: ${p.variation}` : p.family;
  };
  const claims: { id: string; depth: number }[] = [];
  for (const c of chapters) {
    if (!c.graph.size) continue;
    const def = chapterPosition(c.graph, names, c.name);
    if (keys.has(def.key)) claims.push({ id: c.id, depth: def.moves.length });
  }
  const pick = (list: { id: string }[]): LineRoute | undefined =>
    list.length === 1 ? { kind: 'one', id: list[0].id } : list.length > 1 ? { kind: 'tie', ids: list.map((x) => x.id) } : undefined;
  const specific = claims.filter((c) => c.depth > 0);
  if (specific.length) {
    const top = Math.max(...specific.map((c) => c.depth));
    return pick(specific.filter((c) => c.depth === top))!;
  }
  if (lineName) {
    const g = group(lineName);
    const family = nameParts(lineName).family;
    const byName = chapters.filter((c) => c.name === g);
    const byFamily = byName.length ? byName : chapters.filter((c) => c.name === family || nameParts(c.name).family === family);
    const r = pick(byFamily);
    if (r) return r;
  }
  const catchAll = pick(claims);
  if (catchAll) return catchAll;
  return { kind: 'new', name: lineName ? group(lineName) : '' };
}

/** Whether a line (SANs from the start) stays inside a graph's moves. */
export function lineInGraph(graph: RepGraph, sans: readonly string[]): boolean {
  let key = graph.root;
  for (const san of sans) {
    const m = graph.edge(key, san);
    if (!m) return false;
    key = m.toKey;
  }
  return true;
}

export interface ChapterGap {
  /** The line to the hole: an opponent reply you don't answer, or your move with nothing prepared. */
  sans: string[];
  /** How often it comes up, from the starting position. */
  prob: number;
  /** …and if the chapter's opening came up every game (among games reaching its position; undefined if unknown). */
  inChapter?: number;
  /** Rarer than the coverage target: you're prepared as deep as you asked to be. */
  beyondTarget: boolean;
}

/**
 * A chapter's biggest hole, from a coverage run of its color (all chapters together, so a reply
 * another chapter answers isn't a hole): the likeliest gap or unprepared position inside the chapter
 * — including ones rarer than the target, so you see the real figure (1 in 800) rather than nothing.
 */
export function chapterGap(
  graph: RepGraph,
  cov: {
    gaps: { path: string[]; san: string; prob: number }[];
    unfinished: { path: string[]; prob: number }[];
    minorGaps?: { path: string[]; san: string; prob: number }[];
    minorUnfinished?: { path: string[]; prob: number }[];
    probs: Record<string, number>;
    threshold?: number;
  },
  names?: OpeningIndex,
  chapterName?: string,
  /** The graph is all of a color's chapters (not one chapter): every hole in it counts. */
  whole = false,
): ChapterGap | undefined {
  const gaps = [...cov.gaps, ...(cov.minorGaps ?? [])];
  const unfinished = [...cov.unfinished, ...(cov.minorUnfinished ?? [])];
  // A hole belongs to the chapter when it's under the chapter's opening position — a hole right after
  // 1.e4 c5 is the business of the chapter whose opening that is, not of every Sicilian chapter.
  const key = whole ? graph.root : chapterPosition(graph, names, chapterName).key;
  const under = (sans: readonly string[]) => {
    if (key === graph.root) return lineInGraph(graph, sans);
    let k = graph.root;
    let through = false;
    for (const san of sans) {
      const m = graph.edge(k, san);
      if (!m) return false;
      k = m.toKey;
      if (k === key) through = true;
    }
    return through;
  };
  const holes = [
    ...gaps.filter((g) => under(g.path)).map((g) => ({ sans: [...g.path, g.san], prob: g.prob })),
    ...unfinished.filter((u) => under(u.path)).map((u) => ({ sans: u.path, prob: u.prob })),
  ];
  if (!holes.length) return undefined;
  const best = holes.reduce((a, b) => (b.prob > a.prob ? b : a));
  // "In this opening": as if the opening came up every game.
  const base = key === graph.root ? 1 : cov.probs[key];
  const inChapter = key !== graph.root && base && best.prob < base ? best.prob / base : undefined;
  return { ...best, inChapter, beyondTarget: cov.threshold !== undefined && best.prob < cov.threshold };
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
