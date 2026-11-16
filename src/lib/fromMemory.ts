/**
 * "Play from memory": walk the opening tree the way your games would go — your saved moves on your
 * turn, opponent replies in order of popularity — and find the first position (depth-first, most
 * common line first) where it's your move and nothing is saved yet. That's where you get asked next.
 */
import { playUci, posFromFen, turnOfKey, type Color } from './chess';
import type { RepGraph } from './graph';
import { moveGames, type PositionStats } from './types';

export interface MemoryStep {
  san: string;
  uci: string;
  fromKey: string;
  key: string;
}

export interface MemoryTarget {
  /** Moves from the start of the search to the position that needs your move. */
  path: MemoryStep[];
  /** How often this position comes up (1 = every game). */
  prob: number;
}

export async function nextMemoryTarget(opts: {
  graph: RepGraph;
  color: Color;
  /** Where the search starts and how often that position is reached. */
  startKey: string;
  startPath: MemoryStep[];
  startProb: number;
  threshold: number;
  provider: (key: string) => Promise<PositionStats | undefined>;
  /** Positions you said you don't know (skipped for this session). */
  skip: Set<string>;
  signal?: AbortSignal;
}): Promise<MemoryTarget | undefined> {
  const { graph, color, threshold, provider, skip, signal } = opts;
  const visited = new Set<string>();

  const explore = async (key: string, path: MemoryStep[], p: number): Promise<MemoryTarget | undefined> => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (p < threshold || visited.has(key) || skip.has(key)) return undefined;
    visited.add(key);
    const pos = posFromFen(key);
    if (!pos || pos.isEnd()) return undefined;

    if (turnOfKey(key) === color) {
      const mine = graph.childrenOf(key).filter((m) => m.mine);
      if (!mine.length) return { path, prob: p };
      for (const m of mine) {
        const r = await explore(m.toKey, [...path, { san: m.san, uci: m.uci, fromKey: key, key: m.toKey }], p / mine.length);
        if (r) return r;
      }
      return undefined;
    }

    const stats = await provider(key);
    if (!stats || stats.total <= 0) return undefined;
    const replies = [...stats.moves].sort((a, b) => moveGames(b) - moveGames(a));
    for (const ms of replies) {
      const q = (p * moveGames(ms)) / stats.total;
      if (q < threshold) break;
      const next = playUci(pos, ms.uci);
      if (!next) continue;
      const r = await explore(next.key, [...path, { san: next.san, uci: next.uci, fromKey: key, key: next.key }], q);
      if (r) return r;
    }
    return undefined;
  };

  return explore(opts.startKey, opts.startPath, opts.startProb);
}
