import { useEffect, useRef, type ReactNode } from 'react';
import { moveNumberPrefix } from '../lib/chess';

/** One move in the list. */
export interface ListMove {
  san: string;
  /** Extra classes, e.g. "out" for a move that isn't saved. */
  className?: string;
  title?: string;
  /** Has a note (shown as a dot). */
  note?: boolean;
  /** The note's text, shown under the move's row (the line you're on shows its notes). */
  comment?: string;
  /** Right-click / long-press handlers (e.g. to annotate it). */
  menu?: Record<string, unknown>;
  /** Small text at the end of the move's cell (e.g. the eval in a game review). */
  extra?: ReactNode;
  /**
   * Shown in a column at the right end of the move's row, White's above Black's, like Chess.com's
   * move times. When any move has one, every row gets the column.
   */
  aside?: ReactNode;
}

/** A side line: a one-line alternative to the move at its ply, shown under the row where it branches. */
export interface SideLine {
  key: string;
  /** Its moves, the first being the alternative itself. */
  moves: ListMove[];
  /** Go to the j-th move of the side line (0-based). */
  onSelect: (j: number) => void;
  /** Shown after the moves, e.g. how many more choices follow. */
  tail?: ReactNode;
}

/**
 * A scoresheet like a Lichess study or ChessBase: the line you're on, two moves per row; where the
 * line has alternatives, they appear as short one-line side lines tucked under that row. Click a move
 * to go there. Generic — the builder and game review both use it.
 */
export function MoveList({
  moves,
  current,
  onSelect,
  sideLines,
  startPly = 0,
  empty = 'Starting position',
}: {
  /** The line, from `startPly`. */
  moves: ListMove[];
  /** Number of moves played (0 = before the first). */
  current: number;
  onSelect: (plies: number) => void;
  /** Side lines branching at move i (alternatives to moves[i]). */
  sideLines?: (i: number) => SideLine[];
  startPly?: number;
  empty?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector('.ml-move.current')?.scrollIntoView({ block: 'nearest' });
  }, [current, moves.length]);

  if (!moves.length) return <div className="movelist2 empty muted">{empty}</div>;

  const cells: ReactNode[] = [];
  let restart = true; // a black move needs its own row start (first move, or after side lines)
  const withAside = moves.some((m) => m.aside !== undefined);
  let rowAsides: ReactNode[] = [];
  let rowOpen = false;
  const endRow = (i: number) => {
    if (withAside) cells.push(<div key={`a${i}`} className="ml-aside">{rowAsides}</div>);
    rowAsides = [];
    rowOpen = false;
  };
  moves.forEach((m, i) => {
    const ply = startPly + i;
    const white = ply % 2 === 0;
    if (white) {
      cells.push(<span key={`n${i}`} className="ml-num">{Math.floor(ply / 2) + 1}</span>);
    } else if (restart) {
      cells.push(<span key={`n${i}`} className="ml-num">{Math.floor(ply / 2) + 1}</span>);
      cells.push(<span key={`e${i}`} className="ml-move ml-empty">…</span>);
    }
    restart = false;
    cells.push(
      <span
        key={`m${i}`}
        className={`ml-move ${current === i + 1 ? 'current' : ''} ${m.note && !m.comment ? 'has-note' : ''} ${m.className ?? ''}`}
        title={m.title}
        onClick={() => onSelect(i + 1)}
        {...m.menu}
      >
        {m.san}
        {m.extra !== undefined && <span className="ml-extra">{m.extra}</span>}
      </span>,
    );
    rowOpen = true;
    if (withAside) rowAsides.push(<div key={i} className="ml-aside-item">{m.aside}</div>);
    const sides = sideLines?.(i) ?? [];
    const breaks = !!m.comment || sides.length > 0;
    if (breaks && white) cells.push(<span key={`g${i}`} className="ml-move ml-empty">…</span>);
    if (breaks || !white) endRow(i);
    // A note on the line you're on reads under the move, like a comment in a Lichess study.
    if (m.comment) {
      cells.push(
        <div key={`c${i}`} className="ml-comment" {...m.menu}>
          {m.comment}
        </div>,
      );
      restart = true;
    }
    if (sides.length) {
      cells.push(
        <div key={`s${i}`} className="ml-sides">
          {sides.map((s) => (
            <div key={s.key} className="ml-side">
              {s.moves.map((sm, j) => {
                const prefix = moveNumberPrefix(ply + j, j === 0);
                return (
                  <span key={j} style={{ display: 'contents' }}>
                    {prefix && <span className="num">{prefix}</span>}
                    <span className={`mv ${sm.note ? 'has-note' : ''} ${sm.className ?? ''}`} title={sm.title} onClick={() => s.onSelect(j)} {...sm.menu}>
                      {sm.san}
                    </span>
                    {sm.comment && (
                      <span className="ml-side-comment" {...sm.menu}>
                        {sm.comment}
                      </span>
                    )}
                  </span>
                );
              })}
              {s.tail}
            </div>
          ))}
        </div>,
      );
      restart = true;
    }
  });
  // The game ended on a White move: fill Black's cell so the aside column lines up.
  if (rowOpen && withAside) {
    cells.push(<span key="end" className="ml-move ml-empty" />);
    endRow(moves.length);
  }
  return (
    <div className={`movelist2 ${withAside ? 'with-aside' : ''}`} ref={box}>
      {cells}
    </div>
  );
}
