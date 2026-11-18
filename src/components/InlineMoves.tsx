import { isValidElement, useEffect, useRef, type ReactNode } from 'react';
import { moveNumberPrefix } from '../lib/chess';
import type { RepGraph } from '../lib/graph';
import { revealInBox } from './MoveList';
import type { RepMove } from '../lib/types';
import { glyphClass, glyphName, moveGlyph, sanWithGlyphs } from '../lib/annotations';

/** A move of the line you're on (it may not be saved in the repertoire yet). */
export interface LineStep {
  san: string;
  uci: string;
  fromKey: string;
  key: string;
}

/**
 * The repertoire as one block of text, like Lichess's inline notation: the line you're on reads
 * straight through; every other move branches off in ( … ) right where it could have been played,
 * nested as deep as the repertoire goes; notes are plain text after their move. A variation that
 * transposes into a position written out elsewhere ends with ⤳. Click a move to go there.
 */
export function InlineMoves({
  graph,
  line,
  current,
  order,
  onSelect,
  menuFor,
}: {
  graph: RepGraph;
  /** The line you're on, from the starting position. */
  line: LineStep[];
  /** Moves played (the current move is line[current - 1]). */
  current: number;
  /** Order of the alternatives at a position (most common first). */
  order: (kids: RepMove[]) => RepMove[];
  /** Go to the end of this sequence of moves from the starting position. */
  onSelect: (path: LineStep[]) => void;
  /** Right-click / long-press handlers for a saved move (to annotate it); `ply` = its place from the start. */
  menuFor: (m: RepMove, ply: number) => Record<string, unknown>;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    revealInBox(box.current?.querySelector('.iv-move.current'));
  }, [current, line.length]);

  if (!line.length && !graph.childrenOf(graph.root).length) return <div className="inline-moves muted">Starting position</div>;

  const step = (m: RepMove): LineStep => ({ san: m.san, uci: m.uci, fromKey: m.fromKey, key: m.toKey });
  // Positions already written out: the line you're on first, so side lines that reach it say ⤳.
  const written = new Set<string>([graph.root, ...line.map((m) => m.key)]);
  let n = 0;
  const key = () => `t${n++}`;

  const moveEl = (san: string, ply: number, numbered: boolean, onClick: () => void, cls: string, edge?: RepMove) => {
    const prefix = moveNumberPrefix(ply, numbered);
    return (
      <span key={key()} className="iv-tok">
        {prefix && <span className="num">{prefix}</span>}
        <span
          className={`iv-move ${cls} ${glyphClass(moveGlyph(edge))}`}
          title={edge?.glyphs?.map(glyphName).join(' · ') || undefined}
          onClick={onClick}
          {...(edge ? menuFor(edge, ply) : {})}
        >
          {edge ? sanWithGlyphs(san, edge.glyphs) : san}
        </span>
      </span>
    );
  };
  const note = (text: string, edge: RepMove, ply: number) => (
    <span key={key()} className="iv-comment" {...menuFor(edge, ply)}>
      {text}
    </span>
  );

  // A variation: `first`, then its own main continuation, with alternatives nested in ( … ).
  const variation = (before: LineStep[], first: RepMove): ReactNode[] => {
    const out: ReactNode[] = [];
    let path = before;
    let kids: RepMove[] = [first];
    let numbered = true;
    for (let guard = 0; guard < 400 && kids.length; guard++) {
      const [main, ...alts] = kids;
      const here = path;
      out.push(moveEl(main.san, here.length, numbered, () => onSelect([...here, step(main)]), main.mine ? 'mine' : '', main));
      numbered = false;
      if (main.comment) {
        out.push(note(main.comment, main, here.length));
        numbered = true;
      }
      for (const a of alts) {
        out.push(
          <span key={key()} className="iv-var">
            ({spaced(variation(here, a))})
          </span>,
        );
        numbered = true;
      }
      if (written.has(main.toKey)) {
        out.push(
          <span key={key()} className="iv-transpose" title="Transposes into a position written out elsewhere">
            ⤳
          </span>,
        );
        break;
      }
      written.add(main.toKey);
      path = [...path, step(main)];
      kids = order(graph.childrenOf(main.toKey));
    }
    return out;
  };

  // The line you're on, with every other repertoire move branching off where it could be played.
  const out: ReactNode[] = [];
  let numbered = true;
  line.forEach((m, i) => {
    const edge = graph.edge(m.fromKey, m.san);
    out.push(
      moveEl(m.san, i, numbered, () => onSelect(line.slice(0, i + 1)), `main ${current === i + 1 ? 'current' : ''} ${edge ? '' : 'out'}`, edge),
    );
    numbered = false;
    if (edge?.comment) {
      out.push(note(edge.comment, edge, i));
      numbered = true;
    }
    const alts = order(graph.childrenOf(m.fromKey)).filter((c) => c.san !== m.san);
    for (const a of alts) {
      out.push(
        <span key={key()} className="iv-var">
          ({spaced(variation(line.slice(0, i), a))})
        </span>,
      );
      numbered = true;
    }
  });
  // Past the end of the line: whatever the repertoire has next (the builder usually passes the line
  // carried on to its end, so this is mostly the starting position of an empty line).
  const endKids = order(graph.childrenOf(line.length ? line[line.length - 1].key : graph.root));
  endKids.forEach((a, j) => {
    if (!line.length && j === 0) out.push(...variation([], a));
    else
      out.push(
        <span key={key()} className="iv-var">
          ({spaced(variation(line, a))})
        </span>,
      );
  });

  return (
    <div className="inline-moves" ref={box}>
      {spaced(out)}
    </div>
  );
}

/**
 * Spaces between the tokens: each move keeps its number on its line (white-space: nowrap), and the
 * text can only wrap where there's a space — without them the whole repertoire is one long line.
 * A transposition mark stays with its move.
 */
function spaced(nodes: ReactNode[]): ReactNode[] {
  return nodes.flatMap((n, i) => (i === 0 || (isValidElement<{ className?: string }>(n) && n.props.className === 'iv-transpose') ? [n] : [' ', n]));
}
