import { useEffect, useState } from 'react';
import { updateSettings, useSettings } from '../db/settings';
import { formatLine, playUci, posFromFen } from '../lib/chess';
import { analysePosition, formatEval, winChance, type AnalysisStatus, type EngineLine } from '../services/engine';

const LINES = 3;
const PLIES_SHOWN = 10;

/**
 * The engine box, like Lichess's or Chess.com's: the evaluation of the board's position and the
 * engine's best few lines. Click a line to play its first move.
 */
export function EnginePanel({ fenKey, ply, onPlay }: { fenKey: string; /** Plies played so far (for move numbers). */ ply: number; onPlay: (san: string) => void }) {
  const settings = useSettings();
  const on = settings.loaded && settings.engineEnabled;
  const [lines, setLines] = useState<EngineLine[]>([]);
  const [status, setStatus] = useState<AnalysisStatus | undefined>();

  useEffect(() => {
    setLines([]);
    setStatus(undefined);
    if (!on) return;
    const pos = posFromFen(fenKey);
    if (!pos || pos.isEnd()) return;
    let stop: (() => void) | undefined;
    // Small delay so stepping quickly through a line doesn't start (and abort) a search per move.
    const t = setTimeout(() => {
      stop = analysePosition(fenKey, settings.engineDepth, LINES, (l, s) => {
        setLines(l);
        setStatus(s);
      });
    }, 200);
    return () => {
      clearTimeout(t);
      stop?.();
    };
  }, [fenKey, on, settings.engineDepth]);

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
        <h3 style={{ margin: 0 }}>Engine</h3>
        {on && top && (
          <b className={`engine-eval ${(top.mate ?? top.cp ?? 0) < 0 ? 'black' : 'white'}`} title="Evaluation from White's point of view">
            {formatEval(top)}
          </b>
        )}
        <span className="spacer" />
        {on && status && (
          <span className="muted small" title="Change the depth in Settings → Engine">
            {status.source === 'cloud' ? 'Lichess cloud' : 'Stockfish 19'} · depth {status.depth}
            {!status.done && status.source === 'local' ? ` / ${settings.engineDepth}…` : ''}
          </span>
        )}
        <label className="switch small" title={on ? 'Turn the engine off' : 'Turn the engine on'}>
          <input type="checkbox" checked={on} onChange={(e) => updateSettings({ engineEnabled: e.target.checked })} />
          <span>{on ? 'On' : 'Off'}</span>
        </label>
      </div>
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
                <button key={i} className="engine-line" onClick={() => sans[0] && onPlay(sans[0])} title={`Play ${sans[0] ?? ''}`}>
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
