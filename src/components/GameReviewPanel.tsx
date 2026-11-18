import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Chess } from 'chessops/chess';
import { db } from '../db/db';
import { fenOf, opposite, playUci, type Color } from '../lib/chess';
import { biggestSwingsFor, formatEvalShort, JUDGEMENT_GLYPH, swings, winChanceOf, type GameReview, type Score, type Swing } from '../lib/review';
import type { StoredGame } from '../lib/types';
import { evaluatePosition } from '../services/engine';

const DEPTHS = [10, 12, 14, 16];

/** Engine score of a finished position (no legal moves): mate or draw. */
function terminalScore(pos: Chess): Score {
  // The side to move has been mated: a win for the other side.
  if (pos.isCheckmate()) return { mate: pos.turn === 'white' ? -1 : 1 };
  return { cp: 0 }; // stalemate / insufficient material
}

/** Save the analysis every this many positions, so leaving the page loses at most a few. */
const SAVE_EVERY = 6;

/**
 * Runs Stockfish over every position of a game and saves the result on the game as it goes (an
 * interrupted analysis continues where it stopped next time the game is opened). Shows the eval graph
 * and each side's three biggest swings.
 */
export function GameReviewPanel({
  game,
  positions,
  sans,
  cursor,
  onJump,
  userColor,
  opponentName,
  prepPly,
}: {
  game: StoredGame;
  positions: Chess[];
  sans: string[];
  cursor: number;
  onJump: (ply: number) => void;
  userColor: Color;
  opponentName: string;
  prepPly?: number;
}) {
  const review = game.review;
  const partial = review?.complete === false;
  const [depth, setDepth] = useState(12);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /** The analysis running now; each run has its own token so a stopped one can't get in a new one's way. */
  const run = useRef<{ cancelled: boolean } | null>(null);
  useEffect(() => () => void (run.current && (run.current.cancelled = true)), []);

  const analyze = async (resume?: GameReview) => {
    if (run.current && !run.current.cancelled) return;
    const token = { cancelled: false };
    run.current = token;
    const d = resume?.depth ?? depth;
    const total = positions.length;
    const evals: (Score | null)[] = resume ? resume.evals.slice(0, total) : [];
    const best: (string | null)[] = resume ? resume.best.slice(0, total) : [];
    // A run stopped because another took over doesn't save (the new one owns the result).
    const save = async (complete: boolean) =>
      (run.current === token || !token.cancelled) &&
      db.games.update(game.id, { review: { depth: d, analyzedAt: Date.now(), evals: [...evals], best: [...best], ...(complete ? {} : { complete: false }) } });
    setProgress({ done: evals.length, total });
    try {
      for (let i = evals.length; i < total; i++) {
        if (token.cancelled) break;
        const pos = positions[i];
        if (pos.isEnd()) {
          evals.push(terminalScore(pos));
          best.push(null);
        } else {
          const r = await evaluatePosition(fenOf(pos), d);
          if (token.cancelled) break;
          evals.push(r ? { cp: r.eval.cp, mate: r.eval.mate } : null);
          best.push(r?.best ?? null);
        }
        if (run.current === token) setProgress({ done: i + 1, total });
        if ((i + 1) % SAVE_EVERY === 0 && i + 1 < total) await save(false);
      }
      await save(evals.length >= total);
    } finally {
      if (run.current === token) {
        run.current = null;
        setProgress(null);
      }
    }
  };

  // An analysis that was interrupted (you left the page) carries on by itself.
  useEffect(() => {
    if (partial && review) void analyze(review);
    return () => void (run.current && (run.current.cancelled = true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id, partial]);

  const progressBar = progress && (
    <div style={{ marginTop: 10 }}>
      <div className="progress">
        <div style={{ width: `${(progress.done / progress.total) * 100}%` }} />
      </div>
      <div className="row muted small" style={{ marginTop: 4 }}>
        <span>
          Stockfish is going through the game… {progress.done}/{progress.total} positions (saved as it goes)
        </span>
        <span className="spacer" />
        <button className="small" onClick={() => run.current && (run.current.cancelled = true)}>
          Pause
        </button>
      </div>
    </div>
  );

  if (!review) {
    return (
      <div className="panel review-panel">
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
              <button className="primary small" onClick={() => analyze()}>
                Analyze game
              </button>
            </>
          )}
        </div>
        {progressBar ?? (
          <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
            Runs Stockfish on every position (in your browser) and finds each side’s three biggest swings. Saved with the game as it goes.
          </p>
        )}
      </div>
    );
  }

  const mine = biggestSwingsFor(review, userColor, 3);
  const theirs = biggestSwingsFor(review, opposite(userColor), 3);
  const list = (items: Swing[], empty: string) =>
    items.length === 0 ? (
      <div className="muted small">{empty}</div>
    ) : (
      <div className="col" style={{ gap: 6 }}>
        {items.map((s) => (
          <SwingRow key={s.ply} s={s} san={sans[s.ply]} pos={positions[s.ply]} active={cursor === s.ply} onJump={onJump} />
        ))}
      </div>
    );
  return (
    <div className="panel review-panel">
      <div className="row">
        <h3 style={{ margin: 0 }}>Computer review</h3>
        <span className="spacer" />
        <span className="muted small">Stockfish depth {review.depth}</span>
        {partial && !progress && (
          <button className="small primary" onClick={() => analyze(review)}>
            Continue ({review.evals.length}/{positions.length})
          </button>
        )}
        {!progress && (
          <button className="small ghost" onClick={() => db.games.update(game.id, { review: undefined })} title="Discard and analyze again">
            Re-analyze
          </button>
        )}
      </div>
      {progressBar}
      <EvalGraph review={review} cursor={cursor} onJump={onJump} prepPly={prepPly} />
      <div className="swing-columns">
        <div className="col" style={{ gap: 6 }}>
          <h3 style={{ margin: 0 }}>Your biggest mistakes</h3>
          {list(mine, partial ? 'None so far.' : 'No real swings — a clean game for you.')}
        </div>
        <div className="col" style={{ gap: 6 }}>
          <h3 style={{ margin: 0 }}>
            <span className="keep-case">{opponentName}’s</span> biggest mistakes
          </h3>
          {list(theirs, partial ? 'None so far.' : 'No real swings.')}
        </div>
      </div>
    </div>
  );
}

function SwingRow({ s, san, pos, active, onJump }: { s: Swing; san: string; pos: Chess; active: boolean; onJump: (ply: number) => void }) {
  const bestSan = s.best ? playUci(pos, s.best)?.san : undefined;
  const moveNo = `${Math.floor(s.ply / 2) + 1}${s.mover === 'white' ? '.' : '…'}`;
  return (
    <button className={`swing ${s.judgement ?? ''} ${active ? 'active' : ''}`} onClick={() => onJump(s.ply)} title="Show the position before this move">
      <span className={`swing-glyph ${s.judgement ?? ''}`}>{s.judgement ? JUDGEMENT_GLYPH[s.judgement] : '·'}</span>
      <span>
        <b>
          {moveNo} <span className="keep-case">{san}</span>
        </b>
        <br />
        <span className="small muted">
          {/* The evaluation before → after, White's point of view (like Lichess): +3.5 → −9.0. */}
          {formatEvalShort(s.scoreBefore)} → {formatEvalShort(s.scoreAfter)}
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

/**
 * White's win chance across the game; click to jump. Marks the swings and where you left prep. Drawn
 * at the width it's shown at (measured as its pane is resized), so dots stay round and lines keep
 * their thickness however wide or narrow the pane is.
 */
function EvalGraph({ review, cursor, onJump, prepPly }: { review: GameReview; cursor: number; onJump: (ply: number) => void; prepPly?: number }) {
  const box = useRef<SVGSVGElement>(null);
  const [W, setW] = useState(600);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => el.clientWidth > 0 && setW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [review.evals.length >= 2]);
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
      ref={box}
      viewBox={`0 0 ${W} ${H}`}
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
