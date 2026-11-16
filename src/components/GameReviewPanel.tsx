import { useEffect, useRef, useState } from 'react';
import type { Chess } from 'chessops/chess';
import { db } from '../db/db';
import { fenOf, playUci, type Color } from '../lib/chess';
import { biggestSwings, JUDGEMENT_GLYPH, swings, winChanceOf, type GameReview, type Score, type Swing } from '../lib/review';
import type { StoredGame } from '../lib/types';
import { evaluatePosition } from '../services/engine';

const DEPTHS = [10, 12, 14, 16];

/** Engine score of a finished position (no legal moves): mate or draw. */
function terminalScore(pos: Chess): Score {
  // The side to move has been mated: a win for the other side.
  if (pos.isCheckmate()) return { mate: pos.turn === 'white' ? -1 : 1 };
  return { cp: 0 }; // stalemate / insufficient material
}

/**
 * Runs Stockfish over every position of a game, saves the result on the game, and shows an eval graph
 * plus the three biggest swings (like a Lichess study chapter with computer analysis).
 */
export function GameReviewPanel({
  game,
  positions,
  sans,
  cursor,
  onJump,
  userColor,
  prepPly,
}: {
  game: StoredGame;
  positions: Chess[];
  sans: string[];
  cursor: number;
  onJump: (ply: number) => void;
  userColor: Color;
  prepPly?: number;
}) {
  const review = game.review;
  const [depth, setDepth] = useState(12);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const cancel = useRef(false);
  useEffect(() => () => void (cancel.current = true), []);

  const analyze = async () => {
    cancel.current = false;
    const total = positions.length;
    const evals: (Score | null)[] = [];
    const best: (string | null)[] = [];
    setProgress({ done: 0, total });
    for (let i = 0; i < total; i++) {
      if (cancel.current) break;
      const pos = positions[i];
      if (pos.isEnd()) {
        evals.push(terminalScore(pos));
        best.push(null);
      } else {
        const r = await evaluatePosition(fenOf(pos), depth);
        evals.push(r ? { cp: r.eval.cp, mate: r.eval.mate } : null);
        best.push(r?.best ?? null);
      }
      setProgress({ done: i + 1, total });
    }
    if (!cancel.current) {
      const result: GameReview = { depth, analyzedAt: Date.now(), evals, best };
      await db.games.update(game.id, { review: result });
    }
    setProgress(null);
  };

  if (!review) {
    return (
      <div className="panel">
        <div className="row">
          <h3 style={{ margin: 0 }}>Computer review</h3>
          <span className="spacer" />
          {!progress && (
            <>
              <select value={depth} onChange={(e) => setDepth(Number(e.target.value))} title="Search depth per position">
                {DEPTHS.map((d) => (
                  <option key={d} value={d}>
                    depth {d}
                  </option>
                ))}
              </select>
              <button className="primary small" onClick={analyze}>
                Analyze game
              </button>
            </>
          )}
          {progress && (
            <button className="small" onClick={() => (cancel.current = true)}>
              Stop
            </button>
          )}
        </div>
        {progress ? (
          <div style={{ marginTop: 10 }}>
            <div className="progress">
              <div style={{ width: `${(progress.done / progress.total) * 100}%` }} />
            </div>
            <div className="muted small" style={{ marginTop: 4 }}>
              Stockfish is going through the game… {progress.done}/{progress.total} positions
            </div>
          </div>
        ) : (
          <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
            Runs Stockfish on every position (in your browser) and finds the three biggest swings. Saved with the game.
          </p>
        )}
      </div>
    );
  }

  const top = biggestSwings(review, 3);
  return (
    <div className="panel">
      <div className="row">
        <h3 style={{ margin: 0 }}>Computer review</h3>
        <span className="spacer" />
        <span className="muted small">Stockfish depth {review.depth}</span>
        <button className="small ghost" onClick={() => db.games.update(game.id, { review: undefined })} title="Discard and analyze again">
          Re-analyze
        </button>
      </div>
      <EvalGraph review={review} cursor={cursor} onJump={onJump} prepPly={prepPly} />
      <h3 style={{ marginTop: 12 }}>Biggest swings</h3>
      {top.length === 0 ? (
        <div className="muted">No real swings — a clean game.</div>
      ) : (
        <div className="col" style={{ gap: 6 }}>
          {top.map((s) => (
            <SwingRow key={s.ply} s={s} san={sans[s.ply]} you={s.mover === userColor} pos={positions[s.ply]} active={cursor === s.ply} onJump={onJump} />
          ))}
        </div>
      )}
    </div>
  );
}

function SwingRow({ s, san, you, pos, active, onJump }: { s: Swing; san: string; you: boolean; pos: Chess; active: boolean; onJump: (ply: number) => void }) {
  const bestSan = s.best ? playUci(pos, s.best)?.san : undefined;
  const moveNo = `${Math.floor(s.ply / 2) + 1}${s.mover === 'white' ? '.' : '…'}`;
  const pct = (x: number) => `${Math.round(x)}%`;
  const fromView = (wc: number) => (s.mover === 'white' ? wc : 100 - wc);
  return (
    <button className={`swing ${s.judgement ?? ''} ${active ? 'active' : ''}`} onClick={() => onJump(s.ply)} title="Show the position before this move">
      <span className={`swing-glyph ${s.judgement ?? ''}`}>{s.judgement ? JUDGEMENT_GLYPH[s.judgement] : '·'}</span>
      <span>
        <b>
          {moveNo} <span className="keep-case">{san}</span>
        </b>{' '}
        <span className="muted">{you ? 'you' : 'opponent'}</span>
        <br />
        <span className="small muted">
          win chance {pct(fromView(s.before))} → {pct(fromView(s.after))}
          {bestSan && bestSan !== san ? (
            <>
              {' '}
              · best was <b className="keep-case">{bestSan}</b>
            </>
          ) : null}
        </span>
      </span>
    </button>
  );
}

/** White's win chance across the game; click to jump. Marks the swings and where you left prep. */
function EvalGraph({ review, cursor, onJump, prepPly }: { review: GameReview; cursor: number; onJump: (ply: number) => void; prepPly?: number }) {
  const W = 600;
  const H = 90;
  const n = review.evals.length;
  if (n < 2) return null;
  const x = (i: number) => (i / (n - 1)) * W;
  let last = 50;
  const wc = review.evals.map((e) => (e ? (last = winChanceOf(e)) : last));
  const y = (v: number) => H - (v / 100) * H;
  const path = `M0,${H} ` + wc.map((v, i) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ') + ` L${W},${H} Z`;
  const marks = swings(review).filter((s) => s.judgement === 'blunder' || s.judgement === 'mistake');
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="evalgraph"
      onClick={(e) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        onJump(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
      }}
    >
      <rect width={W} height={H} fill="#262421" />
      <path d={path} fill="#e8e6e3" />
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="#8a8784" strokeWidth={1} strokeDasharray="4 4" />
      {prepPly !== undefined && <line x1={x(prepPly)} x2={x(prepPly)} y1={0} y2={H} stroke="var(--accent2)" strokeWidth={2} />}
      {marks.map((s) => (
        <circle key={s.ply} cx={x(s.ply + 1)} cy={y(wc[s.ply + 1])} r={4} fill={s.judgement === 'blunder' ? 'var(--bad)' : 'var(--warn)'} />
      ))}
      <line x1={x(cursor)} x2={x(cursor)} y1={0} y2={H} stroke="var(--accent)" strokeWidth={2} />
    </svg>
  );
}
