import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { touchGuarded } from './NotePopover';
import { MOVE_GLYPHS, OBSERVATION_GLYPHS, POSITION_GLYPHS, glyphClass, toggleGlyph, type Glyph, type MoveAnnotation } from '../lib/annotations';

export interface AnnotationTarget {
  /** The move's ply from the start of the game (for its move number). */
  ply: number;
  san: string;
  x: number;
  y: number;
  /** A move of a side line (its id, and the move's index in it) rather than of the game itself. */
  lineId?: string;
  index?: number;
}

/**
 * Lichess-style annotation menu for a move, opened by right-click (or a long press on touch screens):
 * move symbols, position assessment, observations and a comment. Symbols save as you click them;
 * the comment saves when you leave the box or close the menu.
 */
export function AnnotationMenu({
  target,
  annotation,
  onChange,
  onClose,
  extra,
}: {
  target: AnnotationTarget;
  annotation: MoveAnnotation | undefined;
  onChange: (next: MoveAnnotation | undefined) => void;
  onClose: () => void;
  /** More actions under the comment (e.g. splitting the line off, in the builder). */
  extra?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: target.x, top: target.y });
  const [comment, setComment] = useState(annotation?.comment ?? '');
  // Symbols update here at once; saving to the game happens in the background.
  const [glyphs, setGlyphs] = useState<string[]>(annotation?.glyphs ?? []);
  const latest = useRef({ annotation, comment, onChange });
  latest.current = { annotation, comment, onChange };
  const commentBox = useRef<HTMLTextAreaElement>(null);
  // Opened by a finger still on the screen (a long press): beside it, not under it.
  const byTouch = useRef(touchGuarded()).current;

  // With a mouse, straight into the comment, the cursor after what's written. Not on a touch screen:
  // the keyboard would come up over the symbols — tap the box to write.
  useEffect(() => {
    const t = commentBox.current;
    if (!t || window.matchMedia?.('(pointer: coarse)').matches) return;
    t.focus({ preventScroll: true });
    t.setSelectionRange(t.value.length, t.value.length);
  }, []);

  // Keep it on screen — also when it grows (a form opening inside it) or the window changes size.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const place = () => {
      const { width, height } = el.getBoundingClientRect();
      const clampX = (x: number) => Math.max(8, Math.min(x, window.innerWidth - width - 8));
      const clampY = (y: number) => Math.max(8, Math.min(y, window.innerHeight - height - 8));
      if (!byTouch) return setPos({ left: clampX(target.x + 6), top: clampY(target.y + 6) });
      // Clear of the fingertip: below it if there's room, else above, else to the side.
      const FINGER = 40;
      const below = target.y + FINGER;
      const above = target.y - FINGER - height;
      if (below + height <= window.innerHeight - 8) return setPos({ left: clampX(target.x - width / 2), top: below });
      if (above >= 8) return setPos({ left: clampX(target.x - width / 2), top: above });
      const right = target.x + FINGER;
      const left = right + width <= window.innerWidth - 8 ? right : target.x - FINGER - width;
      setPos({ left: clampX(left), top: clampY(target.y - height / 2) });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [target.x, target.y, byTouch]);

  // Close on a tap outside or Escape (the comment is saved on the way out).
  useEffect(() => {
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const t = setTimeout(() => window.addEventListener('pointerdown', away), 0);
    window.addEventListener('keydown', esc);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  useEffect(
    () => () => {
      const { annotation: a, comment: c, onChange: save } = latest.current;
      if ((a?.comment ?? '') !== c) save({ ...a, comment: c });
    },
    [],
  );

  const toggle = (g: Glyph) => {
    const next = toggleGlyph(glyphs, g.symbol);
    setGlyphs(next);
    onChange({ ...annotation, comment, glyphs: next });
  };
  const section = (label: string, list: Glyph[]) => (
    <div className="anno-section">
      <div className="anno-label">{label}</div>
      <div className="anno-grid">
        {list.map((g) => (
          <button
            key={g.symbol}
            className={`anno-glyph ${glyphClass(g.symbol)} ${glyphs.includes(g.symbol) ? 'active' : ''}`}
            title={g.name}
            aria-label={g.name}
            aria-pressed={glyphs.includes(g.symbol)}
            onClick={() => toggle(g)}
          >
            {g.symbol}
          </button>
        ))}
      </div>
    </div>
  );
  const moveNo = `${Math.floor(target.ply / 2) + 1}${target.ply % 2 ? '…' : '.'}`;

  return createPortal(
    <div
      className="anno-popover"
      ref={box}
      style={pos}
      onContextMenu={(e) => e.preventDefault()}
      // The finger that opened it is still down (or just lifted): not a tap on a symbol.
      onClickCapture={(e) => {
        if (!touchGuarded()) return;
        e.preventDefault();
        e.stopPropagation();
      }} role="dialog" aria-label={`Annotate ${moveNo} ${target.san}`}>
      <div className="row anno-head">
        <b className="keep-case">
          {moveNo} {target.san}
        </b>
        <span className="spacer" />
        <button className="ghost small" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {section('Move', MOVE_GLYPHS)}
      {section('Position', POSITION_GLYPHS)}
      {section('Observation', OBSERVATION_GLYPHS)}
      <textarea
        ref={commentBox}
        className="anno-comment"
        rows={2}
        placeholder="Comment"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onBlur={() => (annotation?.comment ?? '') !== comment && onChange({ ...annotation, comment })}
      />
      {extra}
      <div className="row anno-foot">
        <button className="small ghost" disabled={!glyphs.length && !comment} onClick={() => (setComment(''), setGlyphs([]), onChange(undefined))}>
          Clear
        </button>
        <span className="spacer" />
        <button className="small primary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>,
    document.body,
  );
}
