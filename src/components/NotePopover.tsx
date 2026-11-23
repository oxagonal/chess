import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

/**
 * After a long press opens the annotation menu: the finger lifting mustn't count as a tap on the move
 * underneath. (It doesn't go into the comment box: the keyboard would cover the menu — tap the box to
 * write.)
 */
function swallowRelease() {
  const done = () => {
    document.removeEventListener('touchend', release, true);
    document.removeEventListener('touchcancel', done, true);
  };
  const release = (e: TouchEvent) => {
    done();
    if (document.querySelector('.anno-popover')) e.preventDefault();
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
        swallowRelease();
      }, 550);
    },
    onPointerUp: () => clearTimeout(timer),
    onPointerLeave: () => clearTimeout(timer),
    onPointerCancel: () => clearTimeout(timer),
  };
}
