import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
 * the tab you were on is remembered per page on this device.
 */
export function PhoneStudio({
  page,
  head,
  top,
  board,
  bottom,
  tabs,
  controls,
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
  // A tab coming into view shows the move you're on (it couldn't scroll to it while hidden).
  useLayoutEffect(() => {
    const box = pane.current?.querySelector(`[data-tab="${active?.id}"]`);
    revealInBox(box?.querySelector('.ml-move.current, .iv-move.current, .mv.current'));
  }, [active?.id]);

  return (
    <div className={`phone-studio ${tabs.length > 1 ? '' : 'one-tab'} ${className}`}>
      {head && <div className="ps-head">{head}</div>}
      {top}
      <div className="ps-board">{board}</div>
      {bottom}
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
      </div>
      <div className="ps-controls">{controls}</div>
    </div>
  );
}
