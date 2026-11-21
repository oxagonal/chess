import { useEffect, useRef, type ReactNode } from 'react';
import { moveNumberPrefix } from '../lib/chess';
import type { MoveTree, TreeNode } from '../lib/moveTree';
import { revealInBox } from './MoveList';

/**
 * A move tree as running notation, like a Lichess study: the first choice straight through, every
 * other move in ( … ) where it branches off. Moves are coloured by where they came from — the game
 * before the puzzle (dim), the solution (green), yours, or explored afterwards (italic). Click one to
 * go there.
 */
export function MoveTreeView({
  tree,
  cursor,
  onSelect,
  wrong,
}: {
  tree: MoveTree;
  cursor: string;
  onSelect: (id: string) => void;
  /** A move of yours that went wrong (shown in red). */
  wrong?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => revealInBox(box.current?.querySelector('.mt-move.current')), [cursor]);

  const cls = (n: TreeNode) =>
    n.tags.includes('game') ? 'mt-game' : n.id === wrong ? 'mt-wrong' : n.tags.includes('solution') ? 'mt-solution' : n.tags.includes('mine') ? 'mt-mine' : 'mt-explore';
  const move = (n: TreeNode, numbered: boolean) => (
    <span key={n.id} className="mt-step">
      {(numbered || n.ply % 2 === 1) && <span className="mt-num">{moveNumberPrefix(n.ply - 1, numbered)}</span>}
      <button className={`mt-move ${cls(n)} ${n.id === cursor ? 'current' : ''}`} onClick={() => onSelect(n.id)}>
        {n.san}
      </button>
    </span>
  );
  const line = (fromId: string, numbered: boolean): ReactNode[] => {
    const out: ReactNode[] = [];
    let id = fromId;
    let num = numbered;
    for (;;) {
      const kids = tree.children(id);
      if (!kids.length) break;
      const [main, ...alts] = kids;
      out.push(move(main, num));
      num = false;
      for (const a of alts) {
        out.push(
          <span key={`v${a.id}`} className="mt-var">
            ({move(a, true)}
            {line(a.id, false)})
          </span>,
        );
        num = true;
      }
      id = main.id;
    }
    return out;
  };
  return (
    <div className="move-tree" ref={box}>
      {line(tree.root, true)}
    </div>
  );
}
