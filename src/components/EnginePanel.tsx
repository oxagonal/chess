import { useEffect, useState } from 'react';
import { updateSettings, useSettings } from '../db/settings';
import { formatLine, playUci, posFromFen } from '../lib/chess';
import { analysePosition, formatEval, winChance, type AnalysisStatus, type EngineLine } from '../services/engine';

const PLIES_SHOWN = 10;
/** 0 = unlimited (keeps searching until you move on). */
const DEPTHS = [12, 15, 18, 21, 24, 0];

/**
 * The Stockfish box, like Lichess's or Chess.com's: the evaluation of the board's position and the
 * engine's best lines (click one to play its first move). ⚙ sets depth, number of lines and on/off.
 * Generic — the builder and game review both use it.
 */
export function EnginePanel({ fenKey, ply, onPlay }: { fenKey: string; /** Plies played so far (for move numbers). */ ply: number; onPlay?: (san: string) => void }) {
  const settings = useSettings();
  const on = settings.loaded && settings.engineEnabled;
  const lineCount = Math.min(5, Math.max(1, settings.engineLines));
  const [lines, setLines] = useState<EngineLine[]>([]);
  const [status, setStatus] = useState<AnalysisStatus | undefined>();
  const [showOptions, setShowOptions] = useState(false);

  useEffect(() => {
    setLines([]);
    setStatus(undefined);
    if (!on) return;
    const pos = posFromFen(fenKey);
    if (!pos || pos.isEnd()) return;
    let stop: (() => void) | undefined;
    // Small delay so stepping quickly through a line doesn't start (and abort) a search per move.
    const t = setTimeout(() => {
      stop = analysePosition(fenKey, settings.engineDepth, lineCount, (l, s) => {
        setLines(l);
        setStatus(s);
      });
    }, 200);
    return () => {
      clearTimeout(t);
      stop?.();
    };
  }, [fenKey, on, settings.engineDepth, lineCount]);

  // UCI line → SAN, numbered from the current move.
  const toSan = (moves: string[]) => {
    let pos = posFromFen(fenKey);
    const out: string[] = [];
    for (const u of moves.slice(0, PLIES_SHOWN)) {
      const r = pos && playUci(pos, u);
      if (!r) break;
      out.push(r.san);
      pos = r.pos;
    }
    return out;
  };
  const top = lines[0]?.eval;
  const over = posFromFen(fenKey)?.isEnd();

  return (
    <div className="panel engine">
      <div className="row" style={{ alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Stockfish</h3>
        {on && top && (
          <b className={`engine-eval ${(top.mate ?? top.cp ?? 0) < 0 ? 'black' : 'white'}`} title="Evaluation from White's point of view">
            {formatEval(top)}
          </b>
        )}
        <span className="spacer" />
        {on && status && (
          <span className="muted small">
            {status.source === 'cloud' ? 'Lichess cloud · ' : ''}depth {status.depth}
            {!status.done && status.source === 'local' ? (settings.engineDepth > 0 ? ` / ${settings.engineDepth}…` : ' / ∞') : ''}
          </span>
        )}
        {!on && <span className="muted small">off</span>}
        <button className={`small ${showOptions ? 'blue' : ''}`} onClick={() => setShowOptions((v) => !v)} title="Stockfish settings" aria-expanded={showOptions}>
          ⚙
        </button>
      </div>
      {showOptions && (
        <div className="engine-options row">
          <label className="check small">
            <input type="checkbox" checked={settings.engineEnabled} onChange={(e) => updateSettings({ engineEnabled: e.target.checked })} />
            On
          </label>
          <label className="small inline-field">
            Depth
            <select value={settings.engineDepth} onChange={(e) => updateSettings({ engineDepth: Number(e.target.value) })}>
              {DEPTHS.map((d) => (
                <option key={d} value={d}>
                  {d === 0 ? '∞ unlimited' : d}
                  {d === 12 ? ' (fast)' : d === 18 ? ' (default)' : d === 24 ? ' (slow)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="small inline-field">
            Lines
            <select value={lineCount} onChange={(e) => updateSettings({ engineLines: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <span className="muted small" title="Common positions come from Lichess's cloud analysis first; Stockfish 19 runs in your browser (offline too). Unlimited keeps searching until you move on — it uses more battery.">
            ⓘ
          </span>
        </div>
      )}
      {on && top && (
        <div className="evalbar" title={`White's winning chances: ${Math.round(winChance(top))}%`}>
          <div style={{ width: `${winChance(top)}%` }} />
        </div>
      )}
      {on &&
        (over ? (
          <div className="muted small">Game over in this position.</div>
        ) : !lines.length ? (
          <div className="muted small">Thinking…</div>
        ) : (
          <div className="engine-lines">
            {lines.map((l, i) => {
              const sans = toSan(l.moves);
              return (
                <button key={i} className="engine-line" onClick={() => sans[0] && onPlay?.(sans[0])} title={onPlay && sans[0] ? `Play ${sans[0]}` : undefined}>
                  <span className="engine-line-eval">{formatEval(l.eval)}</span>
                  <span className="engine-line-moves">{formatLine(sans, ply)}</span>
                </button>
              );
            })}
          </div>
        ))}
    </div>
  );
}
