import { useEffect, useRef, useState, type ReactNode } from 'react';
import { moveNumberPrefix } from '../lib/chess';
import type { RepGraph } from '../lib/graph';
import type { RepMove } from '../lib/types';

/**
 * The whole repertoire as notation, to jump straight to any position. The main line reads straight
 * through; at each branch the other moves fold away behind a "▸ 2 more" toggle (open = indented
 * sub-lines, which fold the same way). Opponent replies are ordered most common first when coverage
 * probabilities are known. Branches on the current line open by themselves.
 *
 * Transpositions: a position reached by several move orders is written out once, under its shortest
 * move order; the other move orders end with ⤳ (clicking still takes you there).
 */
export function RepTree({
  graph,
  path,
  probs,
  onSelect,
}: {
  graph: RepGraph;
  /** The repertoire moves leading to the board's position (current move last). */
  path: RepMove[];
  probs?: Record<string, number>;
  onSelect: (sans: string[]) => void;
}) {
  // Branches you opened or closed yourself; the rest follow the current line.
  const [overrides, setOverrides] = useState(new Map<string, boolean>());
  const currentId = path.at(-1)?.id;
  // Moving onto a line hands its branches back to "open if the current line runs through them".
  useEffect(() => {
    setOverrides((prev) => {
      if (!path.some((m) => prev.has(m.fromKey))) return prev;
      const next = new Map(prev);
      for (const m of path) next.delete(m.fromKey);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector('.mv.current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [currentId]);

  const onPath = new Set(path.map((m) => m.id));
  const tree = graph.tree();
  const shortest = (m: RepMove) => tree.get(m.toKey)?.id === m.id;
  const order = (kids: RepMove[]) => (probs ? [...kids].sort((a, b) => (probs[b.toKey] ?? 0) - (probs[a.toKey] ?? 0)) : kids);
  const branchKeys: string[] = [];

  const move = (m: RepMove, before: RepMove[], numbered: boolean) => {
    const ply = before.length;
    const prefix = moveNumberPrefix(ply, numbered);
    return (
      <span key={m.id} style={{ display: 'contents' }}>
        {prefix && <span className="num">{prefix}</span>}
        <span
          className={`mv ${m.mine ? 'book' : ''} ${m.id === currentId ? 'current' : onPath.has(m.id) ? 'onpath' : ''} ${m.comment ? 'has-note' : ''}`}
          title={m.comment || undefined}
          onClick={() => onSelect([...before, m].map((x) => x.san))}
        >
          {m.san}
        </span>
      </span>
    );
  };

  // A line of play from the position after `before`, starting with `kids[0]` (alternatives fold away).
  const line = (before: RepMove[], kids: RepMove[]): ReactNode[] => {
    const out: ReactNode[] = [];
    let numbered = true;
    let p = before;
    for (let guard = 0; guard < 600; guard++) {
      const [main, ...alts] = kids;
      out.push(move(main, p, numbered));
      numbered = false;
      if (alts.length) {
        const k = main.fromKey;
        branchKeys.push(k);
        const open = overrides.get(k) ?? alts.some((a) => onPath.has(a.id));
        out.push(
          <button
            key={`t${k}`}
            className="tree-toggle"
            onClick={() => setOverrides((prev) => new Map(prev).set(k, !open))}
            title={open ? 'Fold these moves away' : alts.map((a) => a.san).join(', ')}
          >
            <span>
              {open ? '▾' : '▸'} {alts.length} more
              {!open && <span className="muted">{`: ${alts.slice(0, 3).map((a) => a.san).join(', ')}${alts.length > 3 ? '…' : ''}`}</span>}
            </span>
          </button>,
        );
        if (open)
          out.push(
            <div key={`v${k}`} className="tree-vars">
              {alts.map((a) => (
                <div key={a.id} className="tree-var">
                  {line(p, [a])}
                </div>
              ))}
            </div>,
          );
        numbered = true; // after a fold, the main line's next move gets its number again
      }
      if (!shortest(main)) {
        out.push(
          <span key={`x${main.id}`} className="tree-transpose" title="Transposes into a position written out elsewhere in the tree">
            ⤳
          </span>,
        );
        break;
      }
      p = [...p, main];
      const next = order(graph.childrenOf(main.toKey));
      if (!next.length) break;
      kids = next;
    }
    return out;
  };

  const roots = order(graph.childrenOf(graph.root));
  const body = roots.length ? line([], roots) : [<span key="none" className="muted">No moves yet.</span>];
  const anyOpen = branchKeys.some((k) => overrides.get(k) !== false);

  return (
    <div className="panel tree-panel">
      <div className="row" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>Repertoire</h3>
        <span className="muted small">click a move to go there</span>
        <span className="spacer" />
        {branchKeys.length > 0 && (
          <button
            className="small ghost"
            disabled={!anyOpen}
            onClick={() => setOverrides(new Map(branchKeys.map((k) => [k, false])))}
            title="Fold every branch away"
          >
            Collapse all
          </button>
        )}
      </div>
      <div className="tree line" ref={box}>
        {body}
      </div>
    </div>
  );
}
