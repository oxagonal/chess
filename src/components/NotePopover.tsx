import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { MoveNote } from './MoveNote';

export interface NoteTarget {
  id: string;
  san: string;
  x: number;
  y: number;
}

/**
 * Right-click (or long-press, on touch screens) handlers that open the note popover for a move.
 * Spread onto the move's element.
 */
export function annotateProps(open: (x: number, y: number) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    onContextMenu: (e: ReactMouseEvent) => {
      e.preventDefault();
      open(e.clientX, e.clientY);
    },
    // iPhones have no right-click: holding a finger on the move does the same.
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const { clientX, clientY } = e;
      timer = setTimeout(() => open(clientX, clientY), 550);
    },
    onPointerUp: () => clearTimeout(timer),
    onPointerLeave: () => clearTimeout(timer),
    onPointerCancel: () => clearTimeout(timer),
  };
}

/** A small floating note editor next to the move you right-clicked. Saves as you leave it. */
export function NotePopover({ target, onClose }: { target: NoteTarget; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: target.x, top: target.y });
  // Keep it on screen.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(target.x + 6, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(target.y + 6, window.innerHeight - height - 8)),
    });
  }, [target.x, target.y]);
  useEffect(() => {
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // Wait a tick so the click that opened it doesn't close it.
    const t = setTimeout(() => window.addEventListener('pointerdown', away), 0);
    window.addEventListener('keydown', esc);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  return createPortal(
    <div className="note-popover" ref={box} style={pos} onContextMenu={(e) => e.preventDefault()}>
      <MoveNote key={target.id} id={target.id} san={target.san} compact autoFocus />
      <div className="row note-popover-foot">
        <span className="muted small">Saves when you click away · Esc to close</span>
        <span className="spacer" />
        <button className="small" onClick={onClose}>
          Done
        </button>
      </div>
    </div>,
    document.body,
  );
}
