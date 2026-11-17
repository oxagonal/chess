import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSettings } from '../db/settings';
import { ConnectLichessButton } from './LichessConnect';
import { fetchExplorer, onExplorerStatus, paramsLabel, type ExplorerParams } from '../services/explorer';
import { lichessParams, MASTERS } from '../services/coverage';
import { GameStatsIndex } from '../lib/mygames';
import { moveGames, type MoveStat, type PositionStats } from '../lib/types';
import { opposite, turnOfKey, type Color } from '../lib/chess';
import { PlayersBar, filterBySource, usePlayerGames, useScoutPlayerId, type ScoutSource } from './PlayersScout';
import { useRecentGames } from '../hooks';
import { GameRangeSelect } from './GameRangeSelect';
import { TableWrap, WdlBar } from './ui';
import { oneInNumber } from '../lib/coverage';

type Tab = 'lichess' | 'masters' | 'mine' | 'players';

/** A move saved in your repertoire at this position. */
export interface SavedMove {
  id: string;
  san: string;
  mine: boolean;
  comment?: string;
  /** Standard UCI, used for engine evals of saved moves the database doesn't list. */
  uci?: string;
  /** Extra badges shown in the row (review status, prep score…). */
  extras?: ReactNode;
}

const TOP_ROWS = 12;

interface Props {
  fenKey: string;
  /** Repertoire color — "My games" shows games where you had this color. */
  color: Color;
  /** Moves saved in the repertoire at this position; merged into the table. */
  saved?: SavedMove[];
  /** Shown above the table (e.g. "end of line"). */
  notes?: ReactNode;
  title?: string;
  onPlay: (san: string) => void;
  onAdd?: (san: string) => void;
  onDelete?: (id: string, san: string) => void;
  onOpening?: (name: string | undefined) => void;
  /** Share of your games that reach this position — enables the per-move Reach column on the opponent's turn. */
  reachHere?: number;
}

export function ExplorerPanel({ fenKey, color, saved = [], notes, title, onPlay, onAdd, onDelete, onOpening, reachHere }: Props) {
  // On your own turn every move you choose is reached as often as the position itself, so it's only useful for replies.
  const showReach = reachHere !== undefined && turnOfKey(fenKey) !== color;
  const settings = useSettings();
  const [tab, setTab] = useState<Tab>('lichess');
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [fenKey]);
  const [data, setData] = useState<PositionStats | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [needsLogin, setNeedsLogin] = useState(false);
  const [loading, setLoading] = useState(false);
  const [waitUntil, setWaitUntil] = useState<number | undefined>();
  const games = useRecentGames('opponentRange');
  const mine = useMemo(() => (games ? new GameStatsIndex(games, { color }) : undefined), [games, color]);
  // Players tab: what a scouted player plays here — by default with the color your opponents have.
  const [playerId, setPlayerId] = useScoutPlayerId();
  const [playerAs, setPlayerAs] = useState<Color>(opposite(color));
  useEffect(() => setPlayerAs(opposite(color)), [color]);
  const scout = usePlayerGames(tab === 'players' ? playerId : undefined);
  const [playerSource, setPlayerSource] = useState<ScoutSource>('all');
  const scoutIndex = useMemo(
    () => (scout ? new GameStatsIndex(filterBySource(scout.games, playerSource), { color: playerAs }) : undefined),
    [scout, playerAs, playerSource],
  );
  const params: ExplorerParams | undefined = tab === 'lichess' ? lichessParams(settings) : tab === 'masters' ? MASTERS : undefined;
  const paramsKey = params ? paramsLabel(params) : tab;

  useEffect(() => onExplorerStatus((s) => setWaitUntil(s.waitingUntil)), []);

  useEffect(() => {
    setError(undefined);
    setNeedsLogin(false);
    if (tab === 'mine' || tab === 'players') {
      setData((tab === 'mine' ? mine : scoutIndex)?.get(fenKey));
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
        if (e.name === 'AbortError') return;
        setError(e.message);
        setNeedsLogin(e.name === 'LichessLoginRequired');
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fenKey, tab, paramsKey, mine, scoutIndex, settings.loaded, settings.lichessToken]);

  const total = data?.total ?? 0;
  // Database moves in popularity order, with your saved moves merged in; saved moves the database
  // has never seen go at the bottom.
  const bySan = new Map(saved.map((s) => [s.san, s]));
  const rows: { san: string; stat?: MoveStat; rep?: SavedMove }[] = (data?.moves ?? []).map((m) => ({ san: m.san, stat: m, rep: bySan.get(m.san) }));
  const listed = new Set(rows.map((r) => r.san));
  for (const s of saved) if (!listed.has(s.san)) rows.push({ san: s.san, rep: s });
  // Most positions list dozens of rare moves; show the popular ones plus anything you've saved.
  const visibleRows = showAll ? rows : rows.filter((r, i) => i < TOP_ROWS || r.rep);
  const hiddenCount = rows.length - visibleRows.length;
  return (
    <div className="panel explorer">
      {title && <h3>{title}</h3>}
      <div className="tabs">
        <button
          className={tab === 'lichess' ? 'active' : ''}
          onClick={() => setTab('lichess')}
          title={`Lichess games at your rating: ${lichessParams(settings).ratings.join('/')} · ${lichessParams(settings).speeds.join(', ')} (change in Settings)`}
        >
          Lichess
        </button>
        <button className={tab === 'masters' ? 'active' : ''} onClick={() => setTab('masters')}>
          Masters
        </button>
        <button className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>
          My games
        </button>
        <button className={tab === 'players' ? 'active' : ''} onClick={() => setTab('players')}>
          Players
        </button>
        <span className="spacer" />
        {/* The rating bands and speeds are in the Lichess tab's tooltip, to keep this row to one line. */}
        {tab === 'mine' && <GameRangeSelect setting="opponentRange" />}
      </div>
      {tab === 'players' && <PlayersBar
          playerId={playerId}
          onSelect={(id) => {
            setPlayerId(id);
            setPlayerSource('all');
          }}
          as={playerAs}
          onAs={setPlayerAs}
          source={playerSource}
          onSource={setPlayerSource}
          scout={scout}
        />}
      {waitUntil && <div className="note">Lichess rate limit — pausing about a minute before the next lookup.</div>}
      {error && (
        <div className="error row" style={{ alignItems: 'center', gap: 10 }}>
          <span style={{ flex: 1 }}>{error}</span>
          {needsLogin && <ConnectLichessButton />}
        </div>
      )}
      {notes}
      {loading && !data && !saved.length && <div className="muted">Loading…</div>}
      {!loading && !error && !rows.length && (
        <div className="muted">
          {tab === 'mine'
            ? 'You have not reached this position in your imported games.'
            : tab === 'players'
              ? scout
                ? `${scout.player.name} hasn't reached this position as ${playerAs} in the games we have.`
                : null
              : 'No games in this position.'}
        </div>
      )}
      {rows.length > 0 && (
        <TableWrap>
        <table className="data">
          <thead>
            <tr>
              <th>Move</th>
              <th className="num">Games</th>
              <th className="num">%</th>
              {showReach && (
                <th className="num" title="You reach the position after this move once every this many games (saved in your repertoire or not)">
                  1 in
                </th>
              )}
              <th>Result</th>
              <th />
            </tr>
          </thead>
          <tbody style={{ opacity: loading ? 0.5 : 1 }}>
            {visibleRows.map((row) => {
              const { san, stat, rep } = row;
              const n = stat ? moveGames(stat) : 0;
              return (
                <tr key={san} className={`clickable ${rep ? `inrep ${rep.mine ? 'mine' : 'theirs'}` : ''}`} onClick={() => onPlay(san)}>
                  <td>
                    <b className="san">{san}</b>
                    {rep && ' ✓'}
                    {rep?.comment && (
                      <div className="muted small explorer-comment" title={rep.comment}>
                        {rep.comment}
                      </div>
                    )}
                  </td>
                  <td className="num">{stat ? n.toLocaleString() : '—'}</td>
                  <td className="num">{stat && total ? ((n / total) * 100).toFixed(1) : '—'}</td>
                  {showReach && <td className="num">{stat && total ? <b>{n ? oneInNumber((reachHere! * n) / total) : 'never'}</b> : '—'}</td>}
                  <td>{stat ? <WdlBar white={stat.white} draws={stat.draws} black={stat.black} /> : <span className="muted small">not in database</span>}</td>
                  <td>
                    <div className="list-actions" style={{ justifyContent: 'flex-end', alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
                      {rep?.extras}
                      {rep && onDelete && (
                        <button className="ghost small danger" title="Delete this move (and what follows)" onClick={() => onDelete(rep.id, san)}>
                          🗑
                        </button>
                      )}
                      {!rep && onAdd && (
                        <button className="ghost small" title="Add this move to the repertoire" onClick={() => onAdd(san)}>
                          +
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </TableWrap>
      )}
      {hiddenCount > 0 && (
        <button className="small ghost show-all" onClick={() => setShowAll(true)}>
          Show all {rows.length} moves
        </button>
      )}
      {showAll && rows.length > TOP_ROWS && (
        <button className="small ghost show-all" onClick={() => setShowAll(false)}>
          Show fewer
        </button>
      )}
      {data && total > 0 && (
        <div className="row muted small" style={{ marginTop: 6 }}>
          <span>
            {total.toLocaleString()} games
            {data.opening ? ` · ${data.opening.eco} ${data.opening.name}` : ''}
          </span>
        </div>
      )}
    </div>
  );
}
