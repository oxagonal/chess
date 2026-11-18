import type { Color } from '../lib/chess';

const GLYPH: Record<string, string> = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };

/** A small static board from a position key (FEN), for previews — no chessground, no interaction. */
export function MiniBoard({ fen, orientation = 'white', size = 152 }: { fen: string; orientation?: Color; size?: number }) {
  const rows = fen.split(' ')[0].split('/');
  const grid: (string | null)[][] = rows.map((r) => {
    const out: (string | null)[] = [];
    for (const ch of r) {
      if (/\d/.test(ch)) for (let i = 0; i < Number(ch); i++) out.push(null);
      else out.push(ch);
    }
    return out;
  });
  const ranks = orientation === 'white' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  return (
    <div className="miniboard" style={{ width: size, height: size, fontSize: size / 8 - 3 }} role="img" aria-label="Position after the line">
      {ranks.flatMap((r) =>
        ranks.map((_, fi) => {
          const f = orientation === 'white' ? fi : 7 - fi;
          const p = grid[r]?.[f] ?? null;
          const light = (r + f) % 2 === 0;
          return (
            <span key={`${r}${f}`} className={light ? 'mb-l' : 'mb-d'}>
              {p && <span className={p === p.toUpperCase() ? 'mb-w' : 'mb-b'}>{GLYPH[p.toLowerCase()]}</span>}
            </span>
          );
        }),
      )}
    </div>
  );
}
