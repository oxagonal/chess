import { moveNumberPrefix } from '../lib/chess';
import type { RepGraph } from '../lib/graph';
import type { RepMove } from '../lib/types';

/** How a continuation looks from here: the moves until the next choice, and what comes after them. */
export interface Continuation {
  /** The moves played with no choice along the way (the first is the move that starts it). */
  run: RepMove[];
  /** The choices at the end of the run (empty = the line ends there). */
  next: RepMove[];
  /** Distinct line endings reachable this way. */
  lines: number;
}

const MAX_RUN = 40;

/**
 * Every repertoire move from `key`, each followed through the stretch where there's only one move
 * per turn, up to the next real choice. Opponent replies are ordered most common first when reach
 * probabilities are known.
 */
export function continuations(graph: RepGraph, key: string, probs?: Record<string, number>): Continuation[] {
  const order = (kids: RepMove[]) => (probs ? [...kids].sort((a, b) => (probs[b.toKey] ?? 0) - (probs[a.toKey] ?? 0)) : kids);
  const leafMemo = new Map<string, Set<string>>();
  const leaves = (k: string, guard: Set<string>): Set<string> => {
    const hit = leafMemo.get(k);
    if (hit) return hit;
    if (guard.has(k)) return new Set();
    guard.add(k);
    const kids = graph.childrenOf(k);
    const out = new Set<string>();
    if (!kids.length) out.add(k);
    for (const m of kids) for (const l of leaves(m.toKey, guard)) out.add(l);
    guard.delete(k);
    leafMemo.set(k, out);
    return out;
  };
  return order(graph.childrenOf(key)).map((first) => {
    const run = [first];
    const seen = new Set([key, first.toKey]);
    let at = first.toKey;
    for (let kids = graph.childrenOf(at); kids.length === 1 && run.length < MAX_RUN && !seen.has(kids[0].toKey); kids = graph.childrenOf(at)) {
      run.push(kids[0]);
      at = kids[0].toKey;
      seen.add(at);
    }
    return { run, next: order(graph.childrenOf(at)), lines: leaves(first.toKey, new Set()).size };
  });
}

/**
 * The navigator under the current line: one row per move from here. A row runs ahead to the next
 * choice ("1…Nf6 2.c4 → e6 · g6"); click or tap anywhere on it to jump there. (To stop partway, step
 * back with ◀ or click the move in the line above.)
 */
export function NextMoves({
  graph,
  fenKey,
  ply,
  probs,
  onGo,
}: {
  graph: RepGraph;
  fenKey: string;
  /** Plies played to reach `fenKey` (for move numbers). */
  ply: number;
  probs?: Record<string, number>;
  /** Play these repertoire moves from the current position. */
  onGo: (moves: RepMove[]) => void;
}) {
  const rows = continuations(graph, fenKey, probs);
  if (!rows.length) return null;
  const here = probs?.[fenKey];
  return (
    <div className="next-moves">
      {rows.map(({ run, next, lines }) => {
        const first = run[0];
        // Share of games from here that go this way (the opponent's choice), when coverage knows.
        const share = !first.mine && here && probs?.[first.toKey] !== undefined ? Math.min(1, probs[first.toKey] / here) : undefined;
        return (
          <div key={first.id} className="next-row" role="button" tabIndex={0} onClick={() => onGo(run)} onKeyDown={(e) => e.key === 'Enter' && onGo(run)} title="Go to the next choice in this line">
            <span className="next-share">{share !== undefined ? `${Math.round(share * 100)}%` : ''}</span>
            <span className="next-run">
              {run.map((m, i) => {
                const prefix = moveNumberPrefix(ply + i, i === 0);
                return (
                  <span key={m.id} style={{ display: 'contents' }}>
                    {prefix && <span className="num">{prefix}</span>}
                    <span className={`mv ${m.comment ? 'has-note' : ''}`} title={m.comment || undefined}>
                      {m.san}
                    </span>
                  </span>
                );
              })}
              {next.length > 0 ? (
                <span className="next-choices" title="The choices waiting at the end of this stretch">
                  → {next.map((m) => m.san).join(' · ')}
                </span>
              ) : (
                <span className="next-choices">· end</span>
              )}
            </span>
            {lines > 1 && <span className="next-count">{lines} lines</span>}
          </div>
        );
      })}
    </div>
  );
}
