import { parsePgn, startingPosition, makePgn, parseComment, ChildNode, defaultGame } from 'chessops/pgn';
import type { Node, PgnNodeData } from 'chessops/pgn';
import type { Position } from 'chessops/chess';
import { keyOf, playSan, START_KEY, startPos } from './chess';
import type { RepGraph } from './graph';

export interface ImportedEdge {
  fromKey: string;
  toKey: string;
  san: string;
  uci: string;
  comment?: string;
}

export interface PgnImportResult {
  edges: ImportedEdge[];
  games: number;
  errors: string[];
}

function cleanComment(raw: string[] | undefined): string | undefined {
  if (!raw?.length) return undefined;
  const text = raw
    .map((c) => parseComment(c).text.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  return text || undefined;
}

/**
 * Convert PGN text (one or many games, with variations) into repertoire edges.
 * Games that start from a custom FEN are only accepted when that position is in `knownKeys`
 * (i.e. already reachable in the repertoire); otherwise the lines could not be reached in training.
 */
export function pgnToEdges(pgn: string, knownKeys: Set<string> = new Set([START_KEY])): PgnImportResult {
  const games = parsePgn(pgn);
  const edges = new Map<string, ImportedEdge>();
  const errors: string[] = [];
  let count = 0;

  games.forEach((game, gi) => {
    const label = game.headers.get('Event') || game.headers.get('ChapterName') || `Game ${gi + 1}`;
    const start = startingPosition(game.headers);
    if (start.isErr) {
      errors.push(`${label}: invalid starting position`);
      return;
    }
    const rootPos = start.value;
    const rootKey = keyOf(rootPos);
    if (!knownKeys.has(rootKey) && rootKey !== START_KEY) {
      errors.push(`${label}: starts from a custom position that is not in the repertoire yet — skipped`);
      return;
    }
    if (!game.moves.children.length) return;
    count++;

    const walk = (node: Node<PgnNodeData>, pos: Position, key: string, depth: number) => {
      for (const child of node.children) {
        const played = playSan(pos, child.data.san);
        if (!played) {
          errors.push(`${label}: illegal move "${child.data.san}" (ply ${depth + 1}) — rest of that line skipped`);
          continue;
        }
        const id = `${key}|${played.san}`;
        const comment = cleanComment(child.data.comments);
        const existing = edges.get(id);
        if (existing) {
          if (comment && !existing.comment?.includes(comment)) {
            existing.comment = existing.comment ? `${existing.comment} ${comment}` : comment;
          }
        } else {
          edges.set(id, { fromKey: key, toKey: played.key, san: played.san, uci: played.uci, comment });
        }
        walk(child, played.pos, played.key, depth + 1);
      }
    };
    walk(game.moves, rootPos, rootKey, 0);
  });

  return { edges: [...edges.values()], games: count, errors };
}

/** Split a SAN line typed by a user ("1. e4 c5 2.Nf3 d6") into moves. */
export function tokenizeMoveText(text: string): string[] {
  return text
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\$\d+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^\d+\.(\.\.)?/, '').trim())
    .filter((t) => t && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t));
}

/** Export a repertoire as a single PGN game with variations. Transpositions are not re-expanded. */
export function graphToPgn(graph: RepGraph, headers: Record<string, string> = {}): string {
  const game = defaultGame<PgnNodeData>();
  game.headers = new Map(Object.entries({ Event: 'Repertoire', Site: '?', Result: '*', ...headers }));
  const expanded = new Set<string>();

  const build = (parent: Node<PgnNodeData>, key: string) => {
    if (expanded.has(key)) return;
    expanded.add(key);
    const kids = [...graph.childrenOf(key)].sort((a, b) => a.createdAt - b.createdAt);
    for (const m of kids) {
      const comments: string[] = [];
      if (m.comment) comments.push(m.comment);
      if (expanded.has(m.toKey) && graph.childrenOf(m.toKey).length) comments.push('Transposes to a line given elsewhere.');
      const node = new ChildNode<PgnNodeData>({ san: m.san, comments: comments.length ? comments : undefined });
      parent.children.push(node);
      build(node, m.toKey);
    }
  };
  build(game.moves, graph.root);
  return makePgn(game);
}

/** Replay a SAN list, returning keys before each ply (index i = position before ply i) plus the final key. */
export function keysAlong(sans: string[], start: Position = startPos()): { keys: string[]; ucis: string[]; sans: string[] } {
  let pos: Position = start;
  const keys = [keyOf(pos)];
  const ucis: string[] = [];
  const out: string[] = [];
  for (const s of sans) {
    const r = playSan(pos, s);
    if (!r) break;
    ucis.push(r.uci);
    out.push(r.san);
    keys.push(r.key);
    pos = r.pos;
  }
  return { keys, ucis, sans: out };
}

