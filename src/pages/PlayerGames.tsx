import { useMemo, useState } from 'react';
import { filterBySource, usePlayerGames, type ScoutSource } from '../components/PlayersScout';
import { ColorPill, Empty, TableWrap, fmtDate } from '../components/ui';
import { formatLine, type Color } from '../lib/chess';
import { pathToPosition } from '../lib/mygames';
import type { StoredGame } from '../lib/types';
import { href, navigate } from '../router';
import { PositionFilterNote } from '../components/PositionFilterNote';

/**
 * A scouted player's games (the explorer's Players tab → 🔍): those with the color and source picked
 * there, that reached its position (and played its move), newest first. A game opens where it can:
 * on Lichess or Chess.com, in your review if it's one of your over-the-board games against them, or
 * else on Lichess's analysis board from its moves.
 */
export function PlayerGames({ query }: { query: URLSearchParams }) {
  const id = query.get('player') ?? undefined;
  const asParam = query.get('as');
  const as: Color | undefined = asParam === 'white' || asParam === 'black' ? asParam : undefined;
  const srcParam = query.get('src');
  const src: ScoutSource = srcParam === 'online' || srcParam === 'otb' ? srcParam : 'all';
  const at = query.get('at') ?? undefined;
  const move = query.get('move') ?? undefined;
  const scout = usePlayerGames(id);
  const [limit, setLimit] = useState(100);

  const list = useMemo(() => {
    if (!scout) return undefined;
    const out: { g: StoredGame; path: string[] }[] = [];
    for (const g of filterBySource(scout.games, src)) {
      if (as && g.userColor !== as) continue;
      const path = at === undefined ? [] : pathToPosition(g.sans, at, move);
      if (path) out.push({ g, path });
    }
    return out.sort((a, b) => b.g.playedAt - a.g.playedAt);
  }, [scout, as, src, at, move]);

  if (scout === null) return <Empty>That player isn't saved any more. <a href={href('games')}>Your games</a></Empty>;
  if (!scout || !list) return <div className="muted">Loading…</div>;
  const p = scout.player;
  const allHref = href('games', { player: p.id, as, src: src === 'all' ? undefined : src });

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row">
        <h1 style={{ margin: 0 }}>{p.name}’s games</h1>
        {as && <ColorPill color={as} />}
        <span className="muted small">{src === 'online' ? 'online' : src === 'otb' ? 'over the board' : 'online and over the board'}</span>
        <span className="spacer" />
        <a className="btn small" href={href('games')}>
          Your games
        </a>
      </div>
      {at !== undefined && (
        <PositionFilterNote path={list[0]?.path} move={move} count={list.length} clearHref={allHref} whose={`${p.name}’s`} />
      )}
      <div className="panel">
        {list.length === 0 ? (
          <Empty>No games{at !== undefined ? ' reached this position' : ''}.</Empty>
        ) : (
          <div className="recent-games">
            <TableWrap>
              <table className="data">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Opponent</th>
                    <th>Result</th>
                    <th className="hide-sm">Where</th>
                    <th className="hide-sm">Moves</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.slice(0, limit).map(({ g, path }) => {
                    const opp = g.userColor === 'white' ? g.black : g.white;
                    const oppElo = g.userColor === 'white' ? g.blackElo : g.whiteElo;
                    const open = opener(g, path.length);
                    return (
                      <tr key={g.id} className="clickable" onClick={open.go} title={open.label}>
                        <td className="small nowrap">{g.playedAt ? fmtDate(g.playedAt) : '—'}</td>
                        <td>
                          <ColorPill color={g.userColor === 'white' ? 'black' : 'white'} /> {opp}{' '}
                          {oppElo ? <span className="muted small">({oppElo})</span> : null}
                        </td>
                        <td>
                          <span className={`badge ${g.userScore === 1 ? 'good' : g.userScore === 0 ? 'bad' : ''}`}>
                            {g.userScore === 1 ? 'Won' : g.userScore === 0 ? 'Lost' : g.userScore === 0.5 ? 'Draw' : g.result}
                          </span>
                        </td>
                        <td className="small muted hide-sm">{where(g)}</td>
                        <td className="small mono hide-sm line-cell">{formatLine(g.sans.slice(0, Math.min(g.sans.length, Math.max(path.length + 2, 8))))}…</td>
                        <td className="small muted nowrap">{open.label}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          </div>
        )}
        {list.length > limit && (
          <div style={{ textAlign: 'center', marginTop: 8 }}>
            <button onClick={() => setLimit(limit + 200)}>Show more ({list.length - limit} left)</button>
          </div>
        )}
      </div>
    </div>
  );
}

function where(g: StoredGame): string {
  if (g.source === 'lichess') return `Lichess · ${g.timeClass}`;
  if (g.source === 'chesscom') return `Chess.com · ${g.timeClass}`;
  return g.event || 'Over the board';
}

/** How a game in the list opens (at `ply` where the site allows it). */
function opener(g: StoredGame, ply: number): { label: string; go: () => void } {
  if (g.url) {
    const url = g.source === 'lichess' && ply ? `${g.url}#${ply}` : g.url;
    return { label: g.source === 'lichess' ? 'Lichess ↗' : g.source === 'chesscom' ? 'Chess.com ↗' : 'Open ↗', go: () => window.open(url, '_blank', 'noreferrer') };
  }
  // Your own over-the-board game against them (the same game, seen from their side).
  if (!('playerId' in g) && !g.id.startsWith('pgn:')) {
    return { label: 'Your game', go: () => navigate(`games/${encodeURIComponent(g.id)}`, ply ? { ply: String(ply) } : undefined) };
  }
  const pgn = encodeURIComponent(formatLine(g.sans));
  return { label: 'Lichess board ↗', go: () => window.open(`https://lichess.org/analysis/pgn/${pgn}`, '_blank', 'noreferrer') };
}
