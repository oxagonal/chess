import { playSan, posFromFen, START_KEY, turnOfKey, type Color } from './chess';
import type { Position } from 'chessops/chess';
import { moveId } from './graph';
import type { ImportedEdge } from './pgn';
import type { RepMove } from './types';

/** Edges for a SAN line starting at `startKey`. Returns undefined if any move is illegal. */
export function edgesForLine(sans: string[], startKey: string = START_KEY): ImportedEdge[] | undefined {
  let pos: Position | undefined = posFromFen(startKey);
  if (!pos) return undefined;
  let key = startKey;
  const out: ImportedEdge[] = [];
  for (const san of sans) {
    const r = playSan(pos, san);
    if (!r) return undefined;
    out.push({ fromKey: key, toKey: r.key, san: r.san, uci: r.uci });
    pos = r.pos;
    key = r.key;
  }
  return out;
}

export function toRepMove(repId: string, color: Color, e: ImportedEdge, now = Date.now()): RepMove {
  return {
    id: moveId(repId, e.fromKey, e.san),
    repId,
    fromKey: e.fromKey,
    toKey: e.toKey,
    san: e.san,
    uci: e.uci,
    mine: turnOfKey(e.fromKey) === color,
    comment: e.comment,
    createdAt: now,
  };
}

/** Convenience for tests and seeding: many SAN lines (strings like "e4 e5 Nf3") → unique moves. */
export function movesFromLines(repId: string, color: Color, lines: string[]): RepMove[] {
  const out = new Map<string, RepMove>();
  let t = 0;
  for (const line of lines) {
    const edges = edgesForLine(line.split(/\s+/).filter(Boolean));
    if (!edges) throw new Error(`Illegal line: ${line}`);
    for (const e of edges) {
      const m = toRepMove(repId, color, e, t++);
      if (!out.has(m.id)) out.set(m.id, m);
    }
  }
  return [...out.values()];
}
