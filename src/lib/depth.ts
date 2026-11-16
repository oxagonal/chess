/**
 * How deep does a repertoire have to go before positions get rarer than 1 in N games?
 *
 * We walk the opening tree from the start. On your turn we play the most popular move (a stand-in
 * for a typical repertoire); on the opponent's turn we follow every reply that keeps the position
 * at least 1-in-N likely. A line ends where every reply would drop below the threshold. The result
 * is the probability-weighted average line length and the number of lines such a repertoire needs.
 */
import { playUci, posFromFen, START_KEY, turnOfKey, type Color } from './chess';
import type { RepGraph } from './graph';
import { moveGames, type CoverageResult, type PositionStats } from './types';

export interface DepthProfile {
  color: Color;
  n: number;
  /** Probability-weighted average line length, in full moves. */
  avgMoves: number;
  /** Longest line, in full moves. */
  maxMoves: number;
  /** Number of lines (end positions). */
  lines: number;
  /** Your moves you'd have to memorise (positions where it's your turn). */
  myMoves: number;
  /** Share of games covered by those lines (the rest leave via individually rare moves). */
  mass: number;
  queried: number;
}

export async function estimateDepth(
  color: Color,
  provider: (key: string) => Promise<PositionStats | undefined>,
  n: number,
  opts: { signal?: AbortSignal; onProgress?: (queried: number) => void } = {},
): Promise<DepthProfile> {
  const threshold = 1 / n;
  let queried = 0;
  let lines = 0;
  let myMoves = 0;
  let mass = 0;
  let plySum = 0;
  let maxPly = 0;
  const seen = new Set<string>();

  const leaf = (p: number, ply: number) => {
    lines++;
    mass += p;
    plySum += p * ply;
    maxPly = Math.max(maxPly, ply);
  };

  const visit = async (key: string, p: number, ply: number): Promise<void> => {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (seen.has(key)) return; // transposition: already counted along another path
    seen.add(key);
    const stats = await provider(key);
    queried++;
    opts.onProgress?.(queried);
    const pos = posFromFen(key);
    if (!stats || stats.total <= 0 || !stats.moves.length || !pos) return leaf(p, ply);

    if (turnOfKey(key) === color) {
      myMoves++;
      const top = [...stats.moves].sort((a, b) => moveGames(b) - moveGames(a))[0];
      const next = playUci(pos, top.uci);
      if (!next) return leaf(p, ply);
      return visit(next.key, p, ply + 1);
    }

    const kids = stats.moves
      .map((m) => ({ m, q: (p * moveGames(m)) / stats.total }))
      .filter((x) => x.q >= threshold)
      .sort((a, b) => b.q - a.q);
    if (!kids.length) return leaf(p, ply);
    for (const { m, q } of kids) {
      const next = playUci(pos, m.uci);
      if (next) await visit(next.key, q, ply + 1);
    }
  };

  await visit(START_KEY, 1, 0);
  return {
    color,
    n,
    avgMoves: mass ? plySum / mass / 2 : 0,
    maxMoves: maxPly / 2,
    lines,
    myMoves,
    mass,
    queried,
  };
}

/**
 * The same measure for your actual repertoire, from a coverage run: your lines that end at a
 * position reached at least 1 in N games, weighted by how often they're reached.
 */
export function repertoireDepth(graph: RepGraph, result: CoverageResult): { avgMoves: number; maxMoves: number; lines: number } {
  const depths = graph.depths();
  let mass = 0;
  let sum = 0;
  let max = 0;
  let lines = 0;
  for (const k of graph.leaves()) {
    const p = result.probs[k] ?? 0;
    if (p < result.threshold) continue;
    const d = depths.get(k) ?? 0;
    lines++;
    mass += p;
    sum += p * d;
    max = Math.max(max, d);
  }
  return { avgMoves: mass ? sum / mass / 2 : 0, maxMoves: max / 2, lines };
}
