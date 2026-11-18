import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

/**
 * After a long press opens the annotation menu: when the finger lifts, go to its comment box. Phones
 * only bring the keyboard up for a focus made during a touch, and the menu opened on a timer — so it
 * happens on the release (which then doesn't also count as a tap on the move).
 */
function typeOnRelease() {
  const done = () => {
    document.removeEventListener('touchend', release, true);
    document.removeEventListener('touchcancel', done, true);
  };
  const release = (e: TouchEvent) => {
    done();
    const box = document.querySelector<HTMLTextAreaElement>('.anno-popover .anno-comment');
    if (!box) return;
    e.preventDefault();
    box.blur(); // already focused without a keyboard: focus afresh, now during the touch
    box.focus({ preventScroll: true });
    box.setSelectionRange(box.value.length, box.value.length);
  };
  document.addEventListener('touchend', release, { capture: true, passive: false });
  // A touch the browser took over (a scroll…) ends no other way: don't wait for the next one.
  document.addEventListener('touchcancel', done, true);
}

/**
 * Right-click (or long-press, on touch screens) handlers that open a move's annotation menu.
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
      timer = setTimeout(() => {
        open(clientX, clientY);
        typeOnRelease();
      }, 550);
    },
    onPointerUp: () => clearTimeout(timer),
    onPointerLeave: () => clearTimeout(timer),
    onPointerCancel: () => clearTimeout(timer),
  };
}
