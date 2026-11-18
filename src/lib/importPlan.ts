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

/** The kept moves as edges to save, with their notes and symbols. */
export function keptEdges(graph: RepGraph, kept: ReadonlySet<string>): ImportedEdge[] {
  return [...graph.byId.values()]
    .filter((m) => kept.has(m.id))
    .map((m) => ({ fromKey: m.fromKey, toKey: m.toKey, san: m.san, uci: m.uci, comment: m.comment, ...(m.glyphs?.length ? { glyphs: m.glyphs } : {}) }));
}
