import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/** The smallest board the grip allows: half the largest that fits. */
const MIN_SCALE = 0.5;

/**
 * A phone board's size, chosen with a grip under it like the builder's phone studio: drag up for a
 * smaller board (more room for what's under it), down for a bigger one, double-tap for full size.
 * Remembered per page on this device. `scale` is a share of the largest board that fits; set it as
 * --board-scale on the board's box (its CSS multiplies its width by it).
 */
export function useBoardScale(page: string) {
  const key = `chess-prep:phoneBoard:${page}`;
  const [scale, setScale] = useState(() => {
    try {
      const v = Number(localStorage.getItem(key));
      return v >= MIN_SCALE && v <= 1 ? v : 1;
    } catch {
      return 1;
    }
  });
  const boardRef = useRef<HTMLDivElement>(null);
  const save = (v: number) => {
    try {
      localStorage.setItem(key, String(v));
    } catch {
      /* storage unavailable: just not remembered */
    }
  };
  const resize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = boardRef.current;
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
      save(next);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  };
  const grip = (
    <div
      className="board-grip"
      onPointerDown={resize}
      onDoubleClick={() => {
        setScale(1);
        save(1);
      }}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Board size"
      title="Drag to make the board smaller or bigger (double-tap: full size)"
    >
      <span />
    </div>
  );
  return { scale, boardRef, grip };
}
