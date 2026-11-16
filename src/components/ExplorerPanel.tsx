import { useEffect, useMemo, useState } from 'react';
import { useSettings } from '../db/settings';
import { fetchExplorer, onExplorerStatus, paramsLabel, type ExplorerParams } from '../services/explorer';
import { lichessParams, MASTERS } from '../services/coverage';
import { GameStatsIndex } from '../lib/mygames';
import { moveGames, type PositionStats } from '../lib/types';
import type { Color } from '../lib/chess';
import { useGames } from '../hooks';
import { WdlBar } from './ui';

type Tab = 'lichess' | 'masters' | 'mine';

interface Props {
  fenKey: string;
  /** Repertoire colour — "My games" shows games where you had this colour. */
  color: Color;
  /** SANs already in the repertoire at this position. */
  repSans: Set<string>;
  onPlay: (san: string) => void;
  onAdd?: (san: string) => void;
  onOpening?: (name: string | undefined) => void;
}

export function ExplorerPanel({ fenKey, color, repSans, onPlay, onAdd, onOpening }: Props) {
  const settings = useSettings();
  const [tab, setTab] = useState<Tab>('lichess');
  const [data, setData] = useState<PositionStats | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [waitUntil, setWaitUntil] = useState<number | undefined>();
  const games = useGames();
  const mine = useMemo(() => (games ? new GameStatsIndex(games, { color }) : undefined), [games, color]);
  const params: ExplorerParams | undefined = tab === 'lichess' ? lichessParams(settings) : tab === 'masters' ? MASTERS : undefined;
  const paramsKey = params ? paramsLabel(params) : 'mine';

  useEffect(() => onExplorerStatus((s) => setWaitUntil(s.waitingUntil)), []);

  useEffect(() => {
    setError(undefined);
    if (tab === 'mine') {
      setData(mine?.get(fenKey));
      setLoading(false);
      return;
    }
    if (!settings.loaded || !params) return;
    const ctrl = new AbortController();
    setLoading(true);
    fetchExplorer(params, fenKey, ctrl.signal)
      .then((d) => {
        setData(d);
        if (tab === 'lichess' || tab === 'masters') onOpening?.(d.opening?.name);
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fenKey, tab, paramsKey, mine, settings.loaded]);

  const total = data?.total ?? 0;
  return (
    <div className="panel explorer">
      <div className="tabs">
        <button className={tab === 'lichess' ? 'active' : ''} onClick={() => setTab('lichess')} title={params && tab === 'lichess' ? paramsKey : ''}>
          Lichess
        </button>
        <button className={tab === 'masters' ? 'active' : ''} onClick={() => setTab('masters')}>
          Masters
        </button>
        <button className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>
          My games
        </button>
        <span className="spacer" />
        <span className="muted small" style={{ alignSelf: 'center' }}>
          {tab === 'lichess' && params ? `${params.ratings.join('/')} · ${params.speeds.join(', ')}` : tab === 'mine' ? `as ${color}` : ''}
        </span>
      </div>
      {waitUntil && <div className="note">Lichess rate limit — pausing about a minute before the next lookup.</div>}
      {error && <div className="error">{error}</div>}
      {loading && !data && <div className="muted">Loading…</div>}
      {!loading && !error && (!data || !data.moves.length) && (
        <div className="muted">{tab === 'mine' ? 'You have not reached this position in your imported games.' : 'No games in this position.'}</div>
      )}
      {data && data.moves.length > 0 && (
        <table className="data">
          <thead>
            <tr>
              <th>Move</th>
              <th className="num">Games</th>
              <th className="num">%</th>
              <th>Result</th>
              <th />
            </tr>
          </thead>
          <tbody style={{ opacity: loading ? 0.5 : 1 }}>
            {data.moves.map((m) => {
              const n = moveGames(m);
              const inRep = repSans.has(m.san);
              return (
                <tr key={m.san} className={`clickable ${inRep ? 'inrep' : ''}`} onClick={() => onPlay(m.san)}>
                  <td>
                    {m.san}
                    {inRep && ' ✓'}
                  </td>
                  <td className="num">{n.toLocaleString()}</td>
                  <td className="num">{total ? ((n / total) * 100).toFixed(1) : '–'}</td>
                  <td>
                    <WdlBar white={m.white} draws={m.draws} black={m.black} />
                  </td>
                  <td>
                    {onAdd && !inRep && (
                      <button
                        className="ghost small"
                        title="Add this move to the repertoire"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAdd(m.san);
                        }}
                      >
                        +
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {data && total > 0 && (
        <div className="muted small" style={{ marginTop: 6 }}>
          {total.toLocaleString()} games
          {data.opening ? ` · ${data.opening.eco} ${data.opening.name}` : ''}
        </div>
      )}
    </div>
  );
}
