import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

/**
 * While the finger that opened the annotation menu is still down — and for a moment after it lifts —
 * taps inside the menu don't count: lifting (or the phone snapping a tap to the nearest button) would
 * otherwise set a symbol you never chose.
 */
let guardUntil = 0;
export const touchGuarded = () => Date.now() < guardUntil;
/** How long after the finger lifts a tap in the menu still doesn't count. */
const AFTER_RELEASE_MS = 400;

/**
 * After a long press opens the annotation menu: the finger lifting mustn't count as a tap on the move
 * underneath, or on the menu that opened under it. (It doesn't go into the comment box: the keyboard
 * would cover the menu — tap the box to write.)
 */
function swallowRelease() {
  guardUntil = Infinity;
  const done = () => {
    document.removeEventListener('touchend', release, true);
    document.removeEventListener('touchcancel', done, true);
    document.removeEventListener('pointerup', done, true);
    document.removeEventListener('pointercancel', done, true);
    clearTimeout(failsafe);
    guardUntil = Date.now() + AFTER_RELEASE_MS;
  };
  const release = (e: TouchEvent) => {
    done();
    if (document.querySelector('.anno-popover')) e.preventDefault();
  };
  document.addEventListener('touchend', release, { capture: true, passive: false });
  // A touch the browser took over (a scroll…) ends no other way: don't wait for the next one.
  document.addEventListener('touchcancel', done, true);
  document.addEventListener('pointerup', done, true);
  document.addEventListener('pointercancel', done, true);
  // Never stuck: if the end of the touch got lost, the menu works again after a few seconds.
  const failsafe = setTimeout(done, 4000);
}

/**
 * Right-click (or long-press, on touch screens) handlers that open a move's annotation menu.
 * Spread onto the move's element.
 */
export function annotateProps(open: (x: number, y: number) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** A finger is on the move (a touch's long press opens the menu once, guarded). */
  let touching = false;
  let opened = false;
  const openByTouch = (x: number, y: number) => {
    clearTimeout(timer);
    if (opened) return;
    opened = true;
    swallowRelease();
    open(x, y);
  };
  const end = () => {
    clearTimeout(timer);
    touching = false;
  };
  return {
    onContextMenu: (e: ReactMouseEvent) => {
      e.preventDefault();
      // An iPad can send its own long-press "right-click" while the finger is down: same as ours.
      if (touching) openByTouch(e.clientX, e.clientY);
      else open(e.clientX, e.clientY);
    },
    // iPhones have no right-click: holding a finger on the move does the same.
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const { clientX, clientY } = e;
      touching = true;
      opened = false;
      timer = setTimeout(() => openByTouch(clientX, clientY), 550);
    },
    onPointerUp: end,
    onPointerLeave: () => clearTimeout(timer),
    onPointerCancel: end,
  };
}
