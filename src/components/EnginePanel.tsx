import { useEffect, useState } from 'react';
import { updateSettings, useSettings, type AppSettings } from '../db/settings';
import { formatLine, playUci, posFromFen } from '../lib/chess';
import { analysePosition, formatEval, winChance, type AnalysisStatus, type EngineLine } from '../services/engine';
import { PHONE_QUERY, useMediaQuery } from '../hooks';

const PLIES_SHOWN = 10;
/** 0 = unlimited (keeps searching until you move on). */
const DEPTHS = [12, 15, 18, 21, 24, 0];

/** Phones keep their own Stockfish settings: a couple of lines fit above a phone's board, not five. */
const KEYS = {
  computer: { enabled: 'engineEnabled', depth: 'engineDepth', lines: 'engineLines' },
  phone: { enabled: 'phoneEngineEnabled', depth: 'phoneEngineDepth', lines: 'phoneEngineLines' },
} as const satisfies Record<string, { enabled: keyof AppSettings; depth: keyof AppSettings; lines: keyof AppSettings }>;

/**
 * The Stockfish box, like Lichess's or Chess.com's: the evaluation of the board's position and the
 * engine's best lines (click one to play its first move). ⚙ sets depth, number of lines and on/off —
 * kept apart on phones and computers. `top`: the phone's strip above the board, like Chess.com's —
 * a switch, a bar with the evaluation, and the lines under it. Generic — the builder and game review
 * both use it.
 */
export function EnginePanel({
  fenKey,
  ply,
  onPlay,
  top: atTop = false,
}: {
  fenKey: string;
  /** Plies played so far (for move numbers). */
  ply: number;
  onPlay?: (san: string) => void;
  top?: boolean;
}) {
  const settings = useSettings();
  const k = KEYS[useMediaQuery(PHONE_QUERY) ? 'phone' : 'computer'];
  const enabled = settings[k.enabled];
  const depth = settings[k.depth];
  const on = settings.loaded && enabled;
  const lineCount = Math.min(5, Math.max(1, settings[k.lines]));
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
      stop = analysePosition(fenKey, depth, lineCount, (l, s) => {
        setLines(l);
        setStatus(s);
      });
    }, 200);
    return () => {
      clearTimeout(t);
      stop?.();
    };
  }, [fenKey, on, depth, lineCount]);

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
  const best = lines[0]?.eval;
  const over = posFromFen(fenKey)?.isEnd();
  const depthText =
    status &&
    `${status.source === 'cloud' ? (atTop ? 'cloud · ' : 'Lichess cloud · ') : ''}depth ${status.depth}${
      !status.done && status.source === 'local' ? (depth > 0 ? ` / ${depth}…` : ' / ∞') : ''
    }`;

  const optionsRow = showOptions && (
    <div className="engine-options row">
      <label className="check small">
        <input type="checkbox" checked={enabled} onChange={(e) => updateSettings({ [k.enabled]: e.target.checked })} />
        On
      </label>
      <label className="small inline-field">
        Depth
        <select value={depth} onChange={(e) => updateSettings({ [k.depth]: Number(e.target.value) })}>
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
        <select value={lineCount} onChange={(e) => updateSettings({ [k.lines]: Number(e.target.value) })}>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <span
        className="muted small"
        title={`Settings for ${k === KEYS.phone ? 'phones' : 'computers'} (each keeps its own). Common positions come from Lichess's cloud analysis first; Stockfish 19 runs in your browser (offline too). Unlimited keeps searching until you move on — it uses more battery.`}
      >
        {k === KEYS.phone ? 'phone' : ''} ⓘ
      </span>
    </div>
  );
  const linesList =
    on &&
    (over ? (
      <div className="muted small">Game over in this position.</div>
    ) : !lines.length ? (
      atTop ? null : <div className="muted small">Thinking…</div>
    ) : (
      <div className="engine-lines">
        {lines.map((l, i) => {
          const sans = toSan(l.moves);
          return (
            <button key={i} className="engine-line" onClick={() => sans[0] && onPlay?.(sans[0])} title={onPlay && sans[0] ? `Play ${sans[0]}` : undefined}>
              <span className={`engine-line-eval ${(l.eval.mate ?? l.eval.cp ?? 0) < 0 ? 'black' : 'white'}`}>{formatEval(l.eval)}</span>
              <span className="engine-line-moves">{formatLine(sans, ply)}</span>
            </button>
          );
        })}
      </div>
    ));

  if (atTop)
    return (
      <div className="engine engine-top">
        <div className="row engine-top-head">
          <button
            role="switch"
            aria-checked={!!on}
            className={`engine-switch ${on ? 'on' : ''}`}
            onClick={() => updateSettings({ [k.enabled]: !enabled })}
            title={on ? 'Turn Stockfish off' : 'Turn Stockfish on'}
            aria-label="Stockfish"
          >
            <span />
          </button>
          {on ? (
            best ? (
              <div className="evalbar engine-top-bar" title={`White's winning chances: ${Math.round(winChance(best))}%`}>
                <div style={{ width: `${winChance(best)}%` }} />
                <b className={`engine-top-eval ${winChance(best) >= 50 ? 'on-white' : 'on-black'}`}>{formatEval(best)}</b>
              </div>
            ) : (
              <span className="muted small engine-top-note">{over ? 'Game over' : 'Stockfish is thinking…'}</span>
            )
          ) : (
            <span className="muted small engine-top-note">Stockfish off</span>
          )}
          {on && depthText && <span className="muted small nowrap">{depthText}</span>}
          <button className={`small ghost ${showOptions ? 'blue' : ''}`} onClick={() => setShowOptions((v) => !v)} title="Stockfish settings (phone)" aria-expanded={showOptions}>
            ⚙
          </button>
        </div>
        {optionsRow}
        {linesList}
      </div>
    );

  return (
    <div className="panel engine">
      <div className="row" style={{ alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Stockfish</h3>
        {on && best && (
          <b className={`engine-eval ${(best.mate ?? best.cp ?? 0) < 0 ? 'black' : 'white'}`} title="Evaluation from White's point of view">
            {formatEval(best)}
          </b>
        )}
        <span className="spacer" />
        {on && depthText && <span className="muted small">{depthText}</span>}
        {!on && <span className="muted small">off</span>}
        <button className={`small ${showOptions ? 'blue' : ''}`} onClick={() => setShowOptions((v) => !v)} title="Stockfish settings" aria-expanded={showOptions}>
          ⚙
        </button>
      </div>
      {optionsRow}
      {on && best && (
        <div className="evalbar" title={`White's winning chances: ${Math.round(winChance(best))}%`}>
          <div style={{ width: `${winChance(best)}%` }} />
        </div>
      )}
      {linesList}
    </div>
  );
}
