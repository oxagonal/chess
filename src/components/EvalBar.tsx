import { useEffect, useState } from 'react';
import type { Color } from '../lib/chess';
import { formatEvalShort, type Score } from '../lib/review';
import { cloudLines, engineLinesFor, onEngineLines, winChance, type MoveEval } from '../services/engine';

/**
 * The evaluation of position `key` (White's point of view): what the Stockfish box has found there
 * (it keeps working while its tab is hidden), else Lichess's cloud analysis. It never starts an
 * engine of its own.
 */
function usePositionEval(key: string): MoveEval | undefined {
  const [ev, setEv] = useState<MoveEval | undefined>(() => engineLinesFor(key)?.[0]?.eval);
  useEffect(() => {
    setEv(engineLinesFor(key)?.[0]?.eval);
    const off = onEngineLines((k, lines) => {
      if (k === key && lines[0]) setEv(lines[0].eval);
    });
    // Nothing from the engine yet (it may be switched off): ask the cloud once things settle.
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      if (engineLinesFor(key)) return;
      cloudLines(key, ctrl.signal)
        .then((lines) => {
          if (lines?.[0] && !engineLinesFor(key)) setEv(lines[0].eval);
        })
        .catch(() => {});
    }, 400);
    return () => {
      off();
      clearTimeout(t);
      ctrl.abort();
    };
  }, [key]);
  return ev;
}

/**
 * A vertical evaluation bar beside the board, like Chess.com's: White's share from White's side of
 * the board (bottom, unless the board is flipped), the score at the end of the side that's better.
 * `fallback` is used while there's nothing better (e.g. the computer review's evaluation of a game).
 */
export function EvalBar({ fenKey, orientation, fallback }: { fenKey: string; orientation: Color; fallback?: Score }) {
  const live = usePositionEval(fenKey);
  const ev: Score | undefined = live ?? fallback;
  const white = ev ? winChance({ ...ev, depth: 0, source: 'local' }) : 50;
  const better: Color = white >= 50 ? 'white' : 'black';
  return (
    <div className={`eval-bar ${orientation === 'white' ? 'white-below' : 'white-above'}`} title={ev ? `Evaluation ${formatEvalShort(ev)} (White's point of view)` : 'No evaluation yet'} aria-hidden="true">
      <div className="eval-white" style={{ height: `${white}%` }} />
      {ev && (
        <span className={`eval-score ${better === orientation ? 'near' : 'far'} ${better}`}>
          {ev.mate !== undefined ? `M${Math.abs(ev.mate)}` : (Math.abs(ev.cp ?? 0) / 100).toFixed(1)}
        </span>
      )}
    </div>
  );
}
