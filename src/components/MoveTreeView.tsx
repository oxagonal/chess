import { useEffect, useRef, useState, type ReactNode } from 'react';
import { moveNumberPrefix } from '../lib/chess';
import type { MoveTree, TreeNode } from '../lib/moveTree';

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
  from,
}: {
  tree: MoveTree;
  cursor: string;
  onSelect: (id: string) => void;
  /** A move of yours that went wrong (shown in red). */
  wrong?: string;
  /** Start from here (e.g. just before the puzzle), with "…" to show the moves before. */
  from?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  // Long groups of replies with the same answer show their first few until opened.
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  // Keep the current move in view — inside this box only (scrolling the panel around it would push
  // what's above it, like the verdict, out of sight).
  useEffect(() => {
    const b = box.current;
    const el = b?.querySelector('.mt-move.current');
    if (!b || !el || b.scrollHeight <= b.clientHeight) return;
    const r = el.getBoundingClientRect();
    const top = b.getBoundingClientRect().top + b.clientTop;
    if (r.top < top) b.scrollTop -= top - r.top;
    else if (r.bottom > top + b.clientHeight) b.scrollTop += r.bottom - top - b.clientHeight;
  }, [cursor]);

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
      // Replies answered the same way, with nothing after (e.g. any king move, then Qxa8), share one
      // variation: (48.Kh2 · Kf2 · Kg1 Qxa8).
      const order: TreeNode[][] = [];
      const byAnswer = new Map<string, TreeNode[]>();
      for (const a of alts) {
        const next = tree.children(a.id);
        const key = next.length === 1 && !next[0].children.length ? next[0].san : undefined;
        const group = key ? byAnswer.get(key) : undefined;
        if (group) group.push(a);
        else {
          const g = [a];
          if (key) byAnswer.set(key, g);
          order.push(g);
        }
      }
      for (const g of order) {
        if (g.length === 1) {
          const [a] = g;
          out.push(
            <span key={`v${a.id}`} className="mt-var">
              ({move(a, true)}
              {line(a.id, false)})
            </span>,
          );
        } else {
          const answers = g.map((a) => tree.children(a.id)[0]);
          // The answer shown is the one after the reply you're on (or the first).
          const at = answers.find((x) => x.id === cursor) ?? answers[g.findIndex((a) => a.id === cursor)] ?? answers[0];
          const inside = g.some((a) => a.id === cursor) || answers.some((x) => x.id === cursor);
          const short = g.length > GROUP_SHOWN + 2 && !opened.has(g[0].id) && !inside;
          const shown = short ? g.slice(0, GROUP_SHOWN) : g;
          out.push(
            <span key={`v${g[0].id}`} className="mt-var">
              (
              {shown.map((a, i) => (
                <span key={a.id} className="mt-step">
                  {i === 0 ? <span className="mt-num">{moveNumberPrefix(a.ply - 1, true)}</span> : <span className="mt-sep">·</span>}
                  <button className={`mt-move ${cls(a)} ${a.id === cursor ? 'current' : ''}`} onClick={() => onSelect(a.id)}>
                    {a.san}
                  </button>
                </span>
              ))}
              {short && (
                <button className="mt-more" onClick={() => setOpened(new Set(opened).add(g[0].id))} title="Show them all">
                  +{g.length - GROUP_SHOWN} more
                </button>
              )}
              {move(at, false)})
            </span>,
          );
        }
        num = true;
      }
      id = main.id;
    }
    return out;
  };
  const [all, setAll] = useState(false);
  // From just before the puzzle — unless you asked for all of it, or you've gone back into the game.
  const start = from && !all && tree.has(from) && tree.isUnder(cursor, from) ? from : tree.root;
  return (
    <div className="move-tree" ref={box}>
      {start !== tree.root && (
        <button className="mt-more" onClick={() => setAll(true)} title="Show the game's moves before the puzzle">
          … earlier moves
        </button>
      )}
      {line(start, true)}
    </div>
  );
}

/** Replies shown in a long same-answer group before "+N more". */
const GROUP_SHOWN = 6;
