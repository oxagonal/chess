/**
 * Planning an import (a Lichess study or PGN): its chapters, trimming opponent replies too rare to
 * prepare, and the positions where it gives you more than one move to choose from.
 * Pure: no DOM, no database.
 */
import { parsePgn, makePgn } from 'chessops/pgn';
import type { Color } from './chess';
import { RepGraph } from './graph';
import { toRepMove } from './lines';
import { pgnToEdges, type ImportedEdge } from './pgn';
import type { RepMove } from './types';
import type { ForwardResult } from './coverage';

export interface StudyChapter {
  name: string;
  /** From the chapter's Orientation tag (Lichess studies set it), if any. */
  orientation?: Color;
  edges: ImportedEdge[];
  errors: string[];
}

/** Each game of the PGN (each chapter of a Lichess study) on its own, named and with its board orientation. */
export function studyChapters(pgn: string): { study?: string; chapters: StudyChapter[] } {
  const games = parsePgn(pgn);
  let study: string | undefined;
  const chapters = games.map((game, i) => {
    const h = game.headers;
    study ??= h.get('StudyName') ?? undefined;
    const event = h.get('Event');
    const name = h.get('ChapterName') ?? (event && event !== '?' ? event.replace(/^.*?:\s*/, '') : undefined) ?? `Chapter ${i + 1}`;
    const o = h.get('Orientation')?.toLowerCase();
    const r = pgnToEdges(makePgn(game));
    return { name, orientation: o === 'white' || o === 'black' ? o : undefined, edges: r.edges, errors: r.errors } satisfies StudyChapter;
  });
  if (!study) {
    const e = games[0]?.headers.get('Event');
    if (e && e.includes(':')) study = e.split(':')[0].trim();
  }
  return { study, chapters: chapters.filter((c) => c.edges.length > 0) };
}

/** The edges as a graph (ids `import|fromKey|san`), for analysis before anything is saved. */
export function importGraph(color: Color, edges: readonly ImportedEdge[], existing: readonly RepMove[] = []): RepGraph {
  const seen = new Set<string>();
  const moves: RepMove[] = [];
  for (const m of existing) {
    const id = `import|${m.fromKey}|${m.san}`;
    if (!seen.has(id)) moves.push({ ...m, id, repId: 'import' }), seen.add(id);
  }
  edges.forEach((e, i) => {
    const m = toRepMove('import', color, e, i);
    if (!seen.has(m.id)) moves.push(m), seen.add(m.id);
  });
  return new RepGraph(color, moves);
}

/**
 * Which moves survive trimming to `threshold` (1/N): at opponent positions with explorer data, replies
 * that come up less often than the threshold go, with everything after them. Where the explorer has
 * no data the line is kept — too little is known to drop it. Your own moves all stay (you choose
 * between alternatives next). Returns kept move ids.
 */
export function trimByReach(graph: RepGraph, fwd: Pick<ForwardResult, 'prob' | 'statsAt'>, threshold: number): Set<string> {
  const kept = new Set<string>();
  const seen = new Set<string>([graph.root]);
  const stack = [graph.root];
  while (stack.length) {
    const key = stack.pop()!;
    const known = graph.isMyTurn(key) || fwd.statsAt.has(key);
    for (const m of graph.childrenOf(key)) {
      if (!graph.isMyTurn(key) && known && (fwd.prob.get(m.toKey) ?? 0) < threshold) continue;
      kept.add(m.id);
      if (!seen.has(m.toKey)) {
        seen.add(m.toKey);
        stack.push(m.toKey);
      }
    }
  }
  return kept;
}

/** Moves still reachable from the start using only `allowed` ones. */
export function reachable(graph: RepGraph, allowed: (m: RepMove) => boolean): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>([graph.root]);
  const stack = [graph.root];
  while (stack.length) {
    const key = stack.pop()!;
    for (const m of graph.childrenOf(key)) {
      if (!allowed(m)) continue;
      out.add(m.id);
      if (!seen.has(m.toKey)) {
        seen.add(m.toKey);
        stack.push(m.toKey);
      }
    }
  }
  return out;
}

export interface Alternative {
  key: string;
  path: string[];
  options: RepMove[];
}

/** Positions (your turn) where the kept moves give you more than one move, shallowest first. */
export function alternativesIn(graph: RepGraph, kept: ReadonlySet<string>): Alternative[] {
  const out: Alternative[] = [];
  for (const [key, kids] of graph.children) {
    if (!graph.isMyTurn(key)) continue;
    const options = kids.filter((m) => kept.has(m.id));
    if (options.length < 2) continue;
    const path = graph.pathTo(key);
    if (!path || !path.every((m) => kept.has(m.id))) continue;
    out.push({ key, path: path.map((m) => m.san), options });
  }
  return out.sort((a, b) => a.path.length - b.path.length || (a.path.join(' ') < b.path.join(' ') ? -1 : 1));
}

/** A move of yours another chapter already has, at a position an import reaches. */
export interface Elsewhere {
  san: string;
  uci: string;
  /** The chapter(s) that have it, by name. */
  chapter: string;
}

/** Your moves in some chapters, by the position they're played from (mine only; one entry per move). */
export function movesByPosition(moves: readonly RepMove[], chapterName: (repId: string) => string): Map<string, Elsewhere[]> {
  const out = new Map<string, Elsewhere[]>();
  for (const m of moves) {
    if (!m.mine) continue;
    const list = out.get(m.fromKey) ?? [];
    const had = list.find((e) => e.san === m.san);
    const name = chapterName(m.repId);
    if (had) {
      if (!had.chapter.split(', ').includes(name)) had.chapter += `, ${name}`;
    } else list.push({ san: m.san, uci: m.uci, chapter: name });
    out.set(m.fromKey, list);
  }
  return out;
}

/**
 * Where an import would clash with your other chapters: positions it reaches (`reached`), your turn,
 * where it adds a move of yours (`incoming`) but another chapter already plays something else there —
 * so you'd end up with two moves to know. With the import's options there (`options`, from `base`) and
 * the other chapters' moves it doesn't have (`elsewhere`). Positions match by position, so a
 * transposition into your other prep counts too.
 */
export function clashesIn(
  graph: RepGraph,
  base: ReadonlySet<string>,
  reached: ReadonlySet<string>,
  incoming: (m: RepMove) => boolean,
  others: ReadonlyMap<string, readonly Elsewhere[]>,
): (Alternative & { elsewhere: Elsewhere[] })[] {
  const out: (Alternative & { elsewhere: Elsewhere[] })[] = [];
  for (const key of reached) {
    if (!graph.isMyTurn(key)) continue;
    const there = others.get(key);
    if (!there?.length) continue;
    const options = graph.childrenOf(key).filter((m) => base.has(m.id));
    if (!options.some(incoming)) continue;
    const elsewhere = there.filter((e) => !options.some((m) => m.san === e.san));
    if (!elsewhere.length) continue;
    const path = graph.pathTo(key);
    if (!path) continue;
    out.push({ key, path: path.map((m) => m.san), options, elsewhere });
  }
  return out;
}

/** The kept moves as edges to save, with their notes and symbols. */
export function keptEdges(graph: RepGraph, kept: ReadonlySet<string>): ImportedEdge[] {
  return [...graph.byId.values()]
    .filter((m) => kept.has(m.id))
    .map((m) => ({ fromKey: m.fromKey, toKey: m.toKey, san: m.san, uci: m.uci, comment: m.comment, ...(m.glyphs?.length ? { glyphs: m.glyphs } : {}) }));
}
