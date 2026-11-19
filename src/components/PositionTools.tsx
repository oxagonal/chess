import { useEffect, useRef, useState } from 'react';
import type { Position } from 'chessops/chess';
import { makeFen } from 'chessops/fen';
import type { Color } from '../lib/chess';

/**
 * The position's full FEN. Positions are often rebuilt from a 4-field key (no move counters), so the
 * move number comes from `ply` (moves played to get here) when it's known.
 */
export function fullFen(pos: Position, ply?: number): string {
  const setup = pos.toSetup();
  return makeFen(ply === undefined ? setup : { ...setup, fullmoves: Math.floor(ply / 2) + 1 });
}

export function lichessAnalysisUrl(fen: string, orientation: Color): string {
  return `https://lichess.org/analysis/standard/${fen.replace(/ /g, '_')}?color=${orientation}`;
}

/** Copy text: the clipboard API where allowed, else select the shown text and use the copy command. */
async function copyText(text: string, shown: HTMLElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!shown) return false;
    const range = document.createRange();
    range.selectNodeContents(shown);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    try {
      return document.execCommand('copy');
    } catch {
      return false; // it's selected: the button says to copy it by hand
    }
  }
}

/**
 * Under a board: "Analyze on Lichess" and the position's FEN with a Copy button — e.g. to paste into
 * Chessable's search and read its notes on the position.
 */
export function PositionTools({ pos, ply, orientation }: { pos: Position; ply?: number; orientation: Color }) {
  const fen = fullFen(pos, ply);
  const field = useRef<HTMLSpanElement>(null);
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  useEffect(() => setCopied(null), [fen]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="row position-tools">
      <a className="btn small" href={lichessAnalysisUrl(fen, orientation)} target="_blank" rel="noreferrer" title="Open this position on the Lichess analysis board (new tab)">
        <span className="hide-sm">Analyze on </span>Lichess ↗
      </a>
      {/* Text, not a field: a tap selects all of it, and iPhones don't zoom in as they do for small fields. */}
      <span ref={field} className="fen-field mono" title={fen} aria-label="FEN of this position">
        {fen}
      </span>
      <button
        className={`small ${copied === 'yes' ? 'primary' : ''}`}
        title="Copy the FEN — e.g. to paste into Chessable's search"
        onClick={async () => setCopied((await copyText(fen, field.current)) ? 'yes' : 'no')}
      >
        {copied === 'yes' ? (
          'Copied ✓'
        ) : copied === 'no' ? (
          'Select & copy'
        ) : (
          <>
            Copy<span className="hide-sm"> FEN</span>
          </>
        )}
      </button>
    </div>
  );
}

/**
 * The same as menu items (the phone's ⋯ menus): Analyze on Lichess, and Copy FEN — which stays open
 * to say it copied.
 */
export function PositionMenuItems({ pos, ply, orientation }: { pos: Position; ply?: number; orientation: Color }) {
  const fen = fullFen(pos, ply);
  const [copied, setCopied] = useState(false);
  return (
    <>
      <button onClick={() => window.open(lichessAnalysisUrl(fen, orientation), '_blank', 'noreferrer')}>Analyze on Lichess ↗</button>
      <button
        title={fen}
        onClick={async (e) => {
          e.stopPropagation();
          setCopied(await copyText(fen, null));
        }}
      >
        {copied ? 'Copied ✓' : 'Copy FEN'}
      </button>
    </>
  );
}
