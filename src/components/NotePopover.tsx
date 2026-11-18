import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

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
      timer = setTimeout(() => open(clientX, clientY), 550);
    },
    onPointerUp: () => clearTimeout(timer),
    onPointerLeave: () => clearTimeout(timer),
    onPointerCancel: () => clearTimeout(timer),
  };
}
