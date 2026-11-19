import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { revealInBox } from './MoveList';

/** One tab under the board. */
export interface PhoneTab {
  id: string;
  label: string;
  /** A small mark beside the label (e.g. ✓ for a reviewed game). */
  mark?: ReactNode;
  content: ReactNode;
}

/**
 * The phone layout of the builder and the game review, like the analysis boards of the Lichess and
 * Chess.com apps: the board stays on screen, everything else lives in tabs under it — each scrolling
 * in its own box — and the move buttons sit at the bottom, under your thumb. The page itself never
 * scrolls, so nothing carries the board away.
 *
 * Every tab stays mounted while another is shown (an engine or a computer review keeps running);
 * the tab you were on is remembered per page on this device. The grip under the board makes it
 * smaller (more room for the tabs) — remembered too — and whenever there's room beside the board,
 * an evaluation bar sits on its left.
 */
const MIN_SCALE = 0.5;
export function PhoneStudio({
  page,
  head,
  top,
  board,
  bottom,
  tabs,
  controls,
  popup,
  evalBar,
  className = '',
}: {
  /** Which page (for remembering its tab). */
  page: string;
  /** A compact row above everything. */
  head?: ReactNode;
  /** Just above and below the board (e.g. the players and their clocks). */
  top?: ReactNode;
  board: ReactNode;
  bottom?: ReactNode;
  tabs: PhoneTab[];
  /** The bottom row: the move buttons. */
  controls: ReactNode;
  /** Something that matters at the move you're on: shown over the tabs (never the board). */
  popup?: ReactNode;
  /** An evaluation bar, shown on the board's left when there's room beside it. */
  evalBar?: ReactNode;
  className?: string;
}) {
  const storeKey = `chess-prep:phoneTab:${page}`;
  const [chosen, setChosen] = useState(() => {
    try {
      return localStorage.getItem(storeKey) ?? '';
    } catch {
      return '';
    }
  });
  const active = tabs.find((t) => t.id === chosen) ?? tabs[0];
  const pane = useRef<HTMLDivElement>(null);
  const choose = (id: string) => {
    setChosen(id);
    try {
      localStorage.setItem(storeKey, id);
    } catch {
      /* storage unavailable: just not remembered */
    }
  };
  // The board's size: a share of the largest that fits (1 = as big as possible).
  const scaleKey = `chess-prep:phoneBoard:${page}`;
  const [scale, setScale] = useState(() => {
    try {
      const v = Number(localStorage.getItem(scaleKey));
      return v >= MIN_SCALE && v <= 1 ? v : 1;
    } catch {
      return 1;
    }
  });
  const root = useRef<HTMLDivElement>(null);
  const boardBox = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  useEffect(() => {
    const measure = () => setRoom((root.current?.clientWidth ?? 0) - (boardBox.current?.getBoundingClientRect().width ?? 0));
    const ro = new ResizeObserver(measure);
    if (root.current) ro.observe(root.current);
    if (boardBox.current) ro.observe(boardBox.current);
    measure();
    return () => ro.disconnect();
  }, []);
  const saveScale = (v: number) => {
    try {
      localStorage.setItem(scaleKey, String(v));
    } catch {
      /* storage unavailable: just not remembered */
    }
  };
  // Drag the grip: up makes the board smaller, down bigger.
  const resize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = boardBox.current;
    if (!box) return;
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const w0 = box.getBoundingClientRect().width;
    const largest = w0 / scale;
    let next = scale;
    const move = (ev: PointerEvent) => {
      next = Math.min(1, Math.max(MIN_SCALE, (w0 + ev.clientY - startY) / largest));
      setScale(next);
    };
    const end = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      saveScale(next);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  };

  // A tab coming into view shows the move you're on (it couldn't scroll to it while hidden).
  useLayoutEffect(() => {
    const box = pane.current?.querySelector(`[data-tab="${active?.id}"]`);
    revealInBox(box?.querySelector('.ml-move.current, .iv-move.current, .mv.current'));
  }, [active?.id]);

  return (
    <div ref={root} className={`phone-studio ${tabs.length > 1 ? '' : 'one-tab'} ${className}`} style={{ '--ps-scale': scale } as CSSProperties}>
      {head && <div className="ps-head">{head}</div>}
      {top}
      <div className="ps-board-row">
        {evalBar && room >= 30 && <div className="ps-evalbar">{evalBar}</div>}
        <div className="ps-board" ref={boardBox}>
          {board}
        </div>
      </div>
      {bottom}
      <div
        className="ps-grip"
        onPointerDown={resize}
        onDoubleClick={() => {
          setScale(1);
          saveScale(1);
        }}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Board size"
        title="Drag to make the board smaller or bigger (double-tap: full size)"
      >
        <span />
      </div>
      {tabs.length > 1 && (
        <div className="ps-tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={t === active} className={t === active ? 'active' : ''} onClick={() => choose(t.id)}>
              {t.label}
              {t.mark}
            </button>
          ))}
        </div>
      )}
      <div className="ps-pane" ref={pane}>
        {tabs.map((t) => (
          <div key={t.id} data-tab={t.id} role="tabpanel" className="ps-tab" hidden={t !== active}>
            {t.content}
          </div>
        ))}
        {popup && (
          <div className="ps-popup" role="dialog">
            {popup}
          </div>
        )}
      </div>
      <div className="ps-controls">{controls}</div>
    </div>
  );
}
