import type { Api } from 'chessground/api';
import type { DrawShape } from 'chessground/draw';
import type { Key } from 'chessground/types';

/**
 * Arrows and circles on a touch screen, as in the Lichess app: keep one finger on the board and drag
 * another from a square to a square for an arrow, or lift it where it started for a circle. Keep the
 * first finger down to draw several. Drawing the same shape again removes it; a tap on an empty square
 * clears them all (chessground's own rule, as with right-click arrows on a computer).
 *
 * Listens on the board's host element in the capture phase, so while a two-finger gesture is on its
 * touches never reach chessground (no piece moves, no page scroll or zoom). Returns the unbind function.
 */
export function bindTwoFingerDrawing(host: HTMLElement, getApi: () => Api | null, enabled: () => boolean): () => void {
  /** Fingers that came down on the board and are still down. */
  const down = new Set<number>();
  /** The drawn shapes when the first finger came down (chessground clears them on a touch of an empty square). */
  let saved: DrawShape[] = [];
  /** A two-finger gesture is on: every touch on the board is ours until all fingers are up. */
  let gesture = false;
  let drawing: { id: number; orig: Key; dest?: Key } | null = null;

  const swallow = (e: TouchEvent) => {
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
  };
  const keyAt = (t: Touch) => getApi()?.getKeyAtDomPos([t.clientX, t.clientY]);
  const ofDrawing = (e: TouchEvent) => (drawing ? Array.from(e.changedTouches).find((t) => t.identifier === drawing!.id) : undefined);

  const preview = () => {
    const cg = getApi();
    if (!cg) return;
    cg.state.drawable.current = drawing
      ? { orig: drawing.orig, dest: drawing.dest, mouseSq: drawing.dest ?? drawing.orig, pos: [0, 0], brush: 'green', snapToValidMove: false }
      : undefined;
    cg.state.dom.redraw();
  };

  const commit = () => {
    const cg = getApi();
    const d = drawing;
    drawing = null;
    preview();
    if (!cg || !d) return;
    const shapes = cg.state.drawable.shapes;
    const same = (s: DrawShape) => s.orig === d.orig && s.dest === d.dest;
    cg.setShapes(shapes.some(same) ? shapes.filter((s) => !same(s)) : [...shapes, { orig: d.orig, dest: d.dest, brush: 'green' }]);
  };

  const onStart = (e: TouchEvent) => {
    const cg = getApi();
    if (!cg) return;
    const onScreen = new Set(Array.from(e.touches, (t) => t.identifier));
    for (const id of down) if (!onScreen.has(id)) down.delete(id);
    for (const t of Array.from(e.changedTouches)) down.add(t.identifier);
    if (!gesture && down.size === 1) {
      saved = cg.state.drawable.shapes.slice();
      return;
    }
    if (!gesture && (down.size !== 2 || !enabled())) return;
    swallow(e);
    if (drawing || down.size !== 2) return;
    const t = e.changedTouches[e.changedTouches.length - 1];
    const orig = keyAt(t);
    if (!orig) return;
    if (!gesture) {
      gesture = true;
      cg.cancelMove();
      cg.setShapes(saved);
    }
    drawing = { id: t.identifier, orig };
    preview();
  };

  const onMove = (e: TouchEvent) => {
    if (!gesture) return;
    swallow(e);
    const t = ofDrawing(e);
    if (!t || !drawing) return;
    const key = keyAt(t);
    if (!key) return; // off the board: keep the last square
    const dest = key === drawing.orig ? undefined : key;
    if (dest !== drawing.dest) {
      drawing.dest = dest;
      preview();
    }
  };

  const onEnd = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) down.delete(t.identifier);
    if (!gesture) return;
    swallow(e);
    if (ofDrawing(e)) {
      if (e.type === 'touchend') commit();
      else {
        drawing = null;
        preview();
      }
    }
    if (!down.size) gesture = false;
  };

  // Safari's pinch-zoom gesture, while drawing.
  const onGesture = (e: Event) => {
    if (gesture) e.preventDefault();
  };

  const active = { capture: true, passive: false } as const;
  host.addEventListener('touchstart', onStart, active);
  host.addEventListener('touchmove', onMove, active);
  host.addEventListener('touchend', onEnd, active);
  host.addEventListener('touchcancel', onEnd, active);
  host.addEventListener('gesturestart', onGesture, active);
  return () => {
    host.removeEventListener('touchstart', onStart, active);
    host.removeEventListener('touchmove', onMove, active);
    host.removeEventListener('touchend', onEnd, active);
    host.removeEventListener('touchcancel', onEnd, active);
    host.removeEventListener('gesturestart', onGesture, active);
  };
}
