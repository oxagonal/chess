import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { DrawShape } from 'chessground/draw';
import type { Key } from 'chessground/types';
import type { Position } from 'chessops/chess';
import { liveQuery } from 'dexie';
import { fenOf, isPromotion, legalDests, uciSquares, type Color } from '../lib/chess';
import { DEFAULT_SETTINGS, getSettings } from '../db/settings';
import { bindTwoFingerDrawing } from './twoFingerDraw';

/** The two-finger drawing setting, watched once for every board. */
let twoFingerDraw = DEFAULT_SETTINGS.twoFingerDraw;
let watchingSettings = false;
function watchTwoFingerDraw() {
  if (watchingSettings) return;
  watchingSettings = true;
  liveQuery(getSettings).subscribe({ next: (s) => (twoFingerDraw = s.twoFingerDraw), error: () => {} });
}

export interface Arrow {
  uci: string;
  brush?: 'green' | 'red' | 'blue' | 'yellow' | 'paleBlue' | 'paleGreen' | 'paleGrey';
}

/** A small tag in the corner of a square (e.g. the number of the move that lands there). */
export interface SquareLabel {
  square: string;
  text: string;
  /** Its background (a CSS colour). */
  color?: string;
}

interface BoardProps {
  pos: Position;
  orientation: Color;
  /** Allow the side to move to play (dests computed from `pos`). */
  interactive?: boolean;
  lastMove?: string;
  arrows?: Arrow[];
  /** Called with a UCI string (promotion suffix included). */
  onMove?: (uci: string) => void;
  /** Colored flash around the board for training feedback. */
  flash?: 'good' | 'bad' | 'hint' | null;
  /** Square to mark (e.g. where you deviated). */
  markSquare?: string;
  /** Rank and file letters along the edges (off for a small preview). */
  coordinates?: boolean;
  /** Circles on squares (e.g. the square you picked). */
  circles?: { square: string; brush?: Arrow['brush'] }[];
  squareLabels?: SquareLabel[];
  /**
   * Enter moves by tapping squares instead of moving pieces: every tap on the board is passed on
   * (writing a puzzle's solution while the board stays still). The board itself takes no moves then.
   */
  onSquareClick?: (square: string) => void;
}

/**
 * Chessground board driven entirely by a chessops Position.
 * After every user move we re-apply the props, so a move the parent rejects snaps back.
 */
export function Board({ pos, orientation, interactive = false, lastMove, arrows, onMove, flash, markSquare, coordinates = true, circles, squareLabels, onSquareClick }: BoardProps) {
  const el = useRef<HTMLDivElement>(null);
  const pendingShapes = useRef<DrawShape[] | null>(null);
  const api = useRef<Api | null>(null);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const posRef = useRef(pos);
  posRef.current = pos;
  const [tick, setTick] = useState(0);
  const [promo, setPromo] = useState<{ orig: string; dest: string } | null>(null);

  const fen = useMemo(() => fenOf(pos), [pos]);
  const turn = pos.turn;
  const dests = useMemo(() => (interactive ? legalDests(pos) : new Map<string, string[]>()), [pos, interactive]);

  useEffect(() => {
    const node = el.current!;
    api.current = Chessground(node, {
      fen,
      orientation,
      coordinates,
      animation: { enabled: true, duration: 180 },
      highlight: { lastMove: true, check: true },
      movable: {
        free: false,
        showDests: true,
        events: {
          after: (orig, dest) => {
            if (isPromotion(posRef.current, orig, dest)) {
              setPromo({ orig, dest });
            } else {
              onMoveRef.current?.(orig + dest);
            }
            setTick((t) => t + 1);
          },
        },
      },
      draggable: { showGhost: true },
      drawable: { enabled: true, visible: true },
    });
    // Skip redraws while the board has no size (e.g. a studio pane being moved): chessground would
    // draw arrows at NaN coordinates. Arrows set meanwhile are applied once it's visible again.
    const ro = new ResizeObserver(() => {
      if (!node.clientWidth) return;
      if (pendingShapes.current) {
        api.current?.setAutoShapes(pendingShapes.current);
        pendingShapes.current = null;
      }
      api.current?.redrawAll();
    });
    ro.observe(node);
    watchTwoFingerDraw();
    const unbindDrawing = bindTwoFingerDrawing(node, () => api.current, () => twoFingerDraw);
    return () => {
      unbindDrawing();
      ro.disconnect();
      api.current?.destroy();
      api.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const cg = api.current;
    if (!cg) return;
    const lm = lastMove ? (uciSquares(lastMove) as [Key, Key] | undefined) : undefined;
    cg.set({
      fen,
      orientation,
      turnColor: turn,
      check: pos.isCheck() ? turn : false,
      lastMove: lm,
      movable: {
        color: interactive ? turn : undefined,
        dests: dests as Map<Key, Key[]>,
      },
    });
  }, [fen, orientation, turn, interactive, dests, lastMove, tick, pos]);

  // Arrows are compared by content so re-renders with a fresh array don't touch the board.
  const shapesKey = JSON.stringify([arrows ?? [], markSquare ?? null, circles ?? []]);
  useEffect(() => {
    const cg = api.current;
    if (!cg) return;
    const shapes: DrawShape[] = (arrows ?? []).flatMap((a) => {
      const sq = uciSquares(a.uci);
      return sq ? [{ orig: sq[0] as Key, dest: sq[1] as Key, brush: a.brush ?? 'green' }] : [];
    });
    if (markSquare) shapes.push({ orig: markSquare as Key, brush: 'red' });
    for (const c of circles ?? []) shapes.push({ orig: c.square as Key, brush: c.brush ?? 'green' });
    if (!el.current?.clientWidth) {
      pendingShapes.current = shapes;
      return;
    }
    cg.setAutoShapes(shapes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapesKey, tick]);

  const choose = (role: 'q' | 'r' | 'b' | 'n') => {
    if (promo) onMoveRef.current?.(promo.orig + promo.dest + role);
    setPromo(null);
    setTick((t) => t + 1);
  };

  const cancelPromo = () => {
    setPromo(null);
    setTick((t) => t + 1);
  };
  const pieceColor = turn;
  // The choice of piece on the promotion square itself, as on Lichess and Chess.com: a column from
  // that square toward the middle of the board — queen, knight, rook, bishop. A click elsewhere cancels.
  const promoColumn = promo && (() => {
    const file = 'abcdefgh'.indexOf(promo.dest[0]);
    const col = orientation === 'white' ? file : 7 - file;
    const atTop = (promo.dest[1] === '8') === (orientation === 'white');
    return (
      <div className="promo-overlay" onClick={cancelPromo}>
        <div className={`promo-column cg-wrap ${atTop ? 'top' : 'bottom'}`} style={{ left: `${col * 12.5}%` }} onClick={(e) => e.stopPropagation()}>
          {(['q', 'n', 'r', 'b'] as const).map((r) => (
            <button key={r} className="promo-btn" onClick={() => choose(r)} title={`Promote to ${roleName(r)}`} aria-label={`Promote to ${roleName(r)}`}>
              {createElement('piece', { className: `${roleName(r)} ${pieceColor}` })}
            </button>
          ))}
        </div>
      </div>
    );
  })();
  // Tapping squares: which square, from where the tap landed on the board.
  const squareInput = onSquareClick && (
    <div
      className="square-input"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const fx = Math.floor(((e.clientX - r.left) / r.width) * 8);
        const fy = Math.floor(((e.clientY - r.top) / r.height) * 8);
        if (fx < 0 || fx > 7 || fy < 0 || fy > 7) return;
        const file = orientation === 'white' ? fx : 7 - fx;
        const rank = orientation === 'white' ? 8 - fy : fy + 1;
        onSquareClick(`${'abcdefgh'[file]}${rank}`);
      }}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
  const labels = squareLabels?.length ? (
    <div className="square-labels" aria-hidden>
      {squareLabels.map((l, i) => {
        const file = 'abcdefgh'.indexOf(l.square[0]);
        const rank = Number(l.square[1]);
        const col = orientation === 'white' ? file : 7 - file;
        const row = orientation === 'white' ? 8 - rank : rank - 1;
        return (
          <span key={`${l.square}${i}`} className="sq-label" style={{ left: `${col * 12.5}%`, top: `${row * 12.5}%` }}>
            <span style={l.color ? { background: l.color } : undefined}>{l.text}</span>
          </span>
        );
      })}
    </div>
  ) : null;
  return (
    <div className={`board-wrap ${flash ? `flash-${flash}` : ''}`}>
      <div ref={el} className="cg-wrap-host" />
      {labels}
      {squareInput}
      {promoColumn}
    </div>
  );
}

function roleName(r: 'q' | 'r' | 'b' | 'n') {
  return { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }[r];
}
