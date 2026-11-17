import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { deletePlayer, refreshPlayerGames, savePlayer } from '../services/players';
import { otbGamesVs, pgnGamesOf } from '../lib/players';
import { readPgnGames, sameName, similarNames } from '../lib/otb';
import { href } from '../router';
import type { Color } from '../lib/chess';
import type { Player, StoredGame } from '../lib/types';
import { MoreMenu, timeAgo } from './ui';

const STORE_KEY = 'chess-prep:scoutPlayer';

/** The player picked in the Players tab, remembered on this device. */
export function useScoutPlayerId(): [string | undefined, (id: string | undefined) => void] {
  const [id, setId] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem(STORE_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  });
  const set = useCallback((next: string | undefined) => {
    setId(next);
    try {
      if (next) localStorage.setItem(STORE_KEY, next);
      else localStorage.removeItem(STORE_KEY);
    } catch {
      /* private mode: just not remembered */
    }
  }, []);
  return [id, set];
}

export interface ScoutGames {
  player: Player;
  /** Every known game, `userColor` = the player's color. */
  games: StoredGame[];
  counts: { online: number; otb: number; pgn: number };
  newest?: number;
}

/** All games we know of a player: downloaded, your over-the-board games against them, pasted PGN. */
export function usePlayerGames(playerId: string | undefined): ScoutGames | undefined | null {
  const player = useLiveQuery(async () => (playerId ? ((await db.players.get(playerId)) ?? null) : null), [playerId]);
  const online = useLiveQuery(() => (playerId ? db.playerGames.where('playerId').equals(playerId).toArray() : []), [playerId]);
  const myOtb = useLiveQuery(() => db.games.where('source').equals('otb').toArray(), []);
  return useMemo(() => {
    if (player === null) return null;
    if (!player || !online || !myOtb) return undefined;
    const otb = otbGamesVs(player, myOtb);
    const pgn = pgnGamesOf(player).games;
    const newest = online.reduce((m, g) => Math.max(m, g.playedAt), 0) || undefined;
    return { player, games: [...online, ...otb, ...pgn], counts: { online: online.length, otb: otb.length, pgn: pgn.length }, newest };
  }, [player, online, myOtb]);
}

/** Which of a player's games to show: everything, their online games, or over-the-board ones (yours vs them + PGN). */
export type ScoutSource = 'all' | 'online' | 'otb';

export function filterBySource(games: StoredGame[], source: ScoutSource): StoredGame[] {
  if (source === 'all') return games;
  return games.filter((g) => (source === 'otb') === (g.source === 'otb'));
}

/** Players refreshed during this visit, so switching back and forth doesn't download again. */
const refreshed = new Set<string>();

interface BarProps {
  playerId: string | undefined;
  onSelect: (id: string | undefined) => void;
  /** The color the player has in the games shown. */
  as: Color;
  onAs: (c: Color) => void;
  source: ScoutSource;
  onSource: (s: ScoutSource) => void;
  scout: ScoutGames | undefined | null;
}

/** Controls above the Players tab: pick, add, edit and update players. */
export function PlayersBar({ playerId, onSelect, as, onAs, source, onSource, scout }: BarProps) {
  const players = useLiveQuery(() => db.players.orderBy('name').toArray(), []);
  const [editing, setEditing] = useState<Player | 'new' | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const ctrl = useRef<AbortController | null>(null);

  // Pick the first player when none (or a deleted one) is selected.
  useEffect(() => {
    if (!players) return;
    if (!players.length) {
      if (playerId) onSelect(undefined);
    } else if (!playerId || !players.some((p) => p.id === playerId)) onSelect(players[0].id);
  }, [players, playerId, onSelect]);

  const update = async (p: Player) => {
    if (!p.lichess && !p.chesscom) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    refreshed.add(p.id);
    setErrors([]);
    setProgress('Contacting…');
    try {
      const r = await refreshPlayerGames(p, {
        signal: c.signal,
        onProgress: (x) => setProgress(`${x.source === 'lichess' ? 'Lichess' : 'Chess.com'}: ${x.games} games${x.detail ? ` (${x.detail})` : ''}`),
      });
      setErrors(r.errors);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setErrors([(e as Error).message]);
    } finally {
      if (ctrl.current === c) setProgress(null);
    }
  };

  // Fetch new games once per visit for the selected player.
  useEffect(() => {
    const p = scout?.player;
    if (p && !refreshed.has(p.id) && (p.lichess || p.chesscom)) void update(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scout?.player.id]);
  useEffect(() => () => ctrl.current?.abort(), []);

  if (!players) return null;
  if (editing) {
    return (
      <PlayerEditor
        player={editing === 'new' ? undefined : editing}
        onDone={(saved) => {
          setEditing(null);
          if (saved) {
            onSelect(saved.id);
            refreshed.delete(saved.id);
          }
        }}
      />
    );
  }
  if (!players.length) {
    return (
      <div className="scout-intro col" style={{ gap: 8 }}>
        <div className="muted small">
          Prepare for an opponent: add them with their Lichess or Chess.com username to see what they play in this position. For
          over-the-board opponents a name is enough — your games against them and any PGN you paste are used.
        </div>
        <div>
          <button className="primary small" onClick={() => setEditing('new')}>
            + Add a player
          </button>
        </div>
      </div>
    );
  }
  const p = scout?.player;
  const c = scout?.counts;
  const otbCount = c ? c.otb + c.pgn : 0;
  const total = c ? c.online + otbCount : 0;
  const accounts = p ? [p.lichess && `Lichess ${p.lichess}`, p.chesscom && `Chess.com ${p.chesscom}`].filter(Boolean).join(', ') : '';
  return (
    <div className="col scout-bar" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 6 }}>
        <select value={playerId ?? ''} onChange={(e) => onSelect(e.target.value)} style={{ flex: '1 1 140px', minWidth: 0 }} aria-label="Player">
          {players.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <div className="segmented" title="Their color in the games shown">
          {(['white', 'black'] as Color[]).map((col) => (
            <button key={col} className={`small ${as === col ? 'active' : ''}`} onClick={() => onAs(col)}>
              as {col === 'white' ? 'White' : 'Black'}
            </button>
          ))}
        </div>
        <MoreMenu label="Player actions">
          <button onClick={() => setEditing('new')}>Add a player…</button>
          {p && <button onClick={() => setEditing(p)}>Edit {p.name}…</button>}
          {p && (p.lichess || p.chesscom) && (
            <button disabled={!!progress} onClick={() => update(p)}>
              Download new games
            </button>
          )}
          {p && (
            <button className="danger" onClick={() => confirm(`Remove ${p.name}?`) && deletePlayer(p.id)}>
              Remove {p.name}
            </button>
          )}
        </MoreMenu>
      </div>
      {c && total > 0 && (
        <div className="segmented scout-sources" role="group" aria-label="Which games">
          {(
            [
              ['all', `All ${total}`],
              ['online', `Online ${c.online}`],
              ['otb', `Over the board ${otbCount}`],
            ] as [ScoutSource, string][]
          ).map(([k, label]) => (
            <button key={k} className={`small ${source === k ? 'active' : ''}`} disabled={k !== 'all' && (k === 'online' ? !c.online : !otbCount)} onClick={() => onSource(k)}>
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="muted small scout-detail">
        {progress ? (
          <>Downloading {p?.name}’s games — {progress}</>
        ) : p && c ? (
          <>
            <div>
              <b>Online:</b>{' '}
              {accounts ? (
                <>
                  {c.online} game{c.online === 1 ? '' : 's'} from {accounts}
                  {scout?.newest ? ` · latest ${timeAgo(scout.newest)}` : ''}
                </>
              ) : (
                <>
                  no username —{' '}
                  <button className="linklike" onClick={() => setEditing(p)}>
                    add their Lichess or Chess.com
                  </button>
                </>
              )}
            </div>
            <div>
              <b>Over the board:</b> {c.otb} game{c.otb === 1 ? '' : 's'} you entered against “{p.name}”
              {c.pgn ? `, ${c.pgn} from pasted PGN` : ''}
              {' · '}
              <a href={href('games/new', { opponent: p.name })}>add a game vs {p.name}</a>
            </div>
          </>
        ) : (
          'Loading…'
        )}
      </div>
      {p && c && !progress && total === 0 && (
        <div className="note col" style={{ gap: 6 }}>
          <b>No games for {p.name} yet.</b>
          <span>
            There’s no public database of club and school over-the-board games, so a name on its own only finds games you add yourself:
          </span>
          <ul className="steps">
            <li>
              games you played against them — <a href={href('games/new', { opponent: p.name })}>add one</a> (Games → + Over-the-board game)
            </li>
            <li>
              their games as PGN, e.g. from a tournament —{' '}
              <button className="linklike" onClick={() => setEditing(p)}>
                paste PGN
              </button>
            </li>
            <li>
              their online games —{' '}
              <button className="linklike" onClick={() => setEditing(p)}>
                add a Lichess or Chess.com username
              </button>
              {(p.lichess || p.chesscom) && ' (none found in the time controls chosen in Settings)'}
            </li>
          </ul>
        </div>
      )}
      {errors.map((e) => (
        <div key={e} className="error small">
          {e}
        </div>
      ))}
    </div>
  );
}

function PlayerEditor({ player, onDone }: { player?: Player; onDone: (saved?: Player) => void }) {
  const [name, setName] = useState(player?.name ?? '');
  const [lichess, setLichess] = useState(player?.lichess ?? '');
  const [chesscom, setChesscom] = useState(player?.chesscom ?? '');
  const [pgn, setPgn] = useState(player?.pgn ?? '');
  const [busy, setBusy] = useState(false);
  const opponents = useLiveQuery(async () => {
    const games = await db.games.where('source').equals('otb').toArray();
    return games.map((g) => (g.userColor === 'white' ? g.black : g.white));
  }, []);
  const match = useMemo(() => {
    if (!opponents || !name.trim()) return null;
    const count = opponents.filter((o) => sameName(o, name)).length;
    const counts = new Map<string, number>();
    for (const o of opponents) counts.set(o, (counts.get(o) ?? 0) + 1);
    return { count, suggestions: similarNames(name, [...counts.keys()]).map((n) => ({ name: n, games: counts.get(n) ?? 0 })) };
  }, [opponents, name]);
  const pgnInfo = useMemo(() => {
    if (!pgn.trim()) return null;
    const { games } = readPgnGames(pgn);
    const named = pgnGamesOf({ id: '', name: name || lichess || chesscom, pgn, createdAt: 0 }).games.length;
    return `${games.length} game${games.length === 1 ? '' : 's'} in the PGN, ${named} with “${name || '…'}” as White or Black.`;
  }, [pgn, name, lichess, chesscom]);
  const save = async () => {
    setBusy(true);
    onDone(await savePlayer({ id: player?.id, name: name.trim() || lichess.trim() || chesscom.trim(), lichess, chesscom, pgn }));
  };
  return (
    <div className="col scout-editor" style={{ gap: 10 }}>
      <b>{player ? `Edit ${player.name}` : 'Add a player'}</b>
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="As on their score sheet or in PGN files" autoFocus />
      </label>
      {match && (
        <div className="small" style={{ marginTop: -4 }}>
          {match.count > 0 ? (
            <span style={{ color: 'var(--good)' }}>
              ✓ {match.count} of your over-the-board games {match.count === 1 ? 'is' : 'are'} against this name.
            </span>
          ) : match.suggestions.length ? (
            <span className="muted">
              None of your over-the-board games are against this exact name. Did you mean{' '}
              {match.suggestions.map((sug, i) => (
                <span key={sug.name}>
                  {i > 0 && ', '}
                  <button className="linklike" onClick={() => setName(sug.name)}>
                    {sug.name}
                  </button>{' '}
                  ({sug.games})
                </span>
              ))}
              ?
            </span>
          ) : (
            <span className="muted">
              No over-the-board games against this name yet. A name only finds games you’ve entered or paste below — there’s no public
              database of over-the-board games to search.
            </span>
          )}
        </div>
      )}
      <div className="row">
        <label className="field" style={{ flex: '1 1 140px' }}>
          <span>Lichess username</span>
          <input value={lichess} onChange={(e) => setLichess(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        </label>
        <label className="field" style={{ flex: '1 1 140px' }}>
          <span>Chess.com username</span>
          <input value={chesscom} onChange={(e) => setChesscom(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        </label>
      </div>
      <label className="field">
        <span>Their games as PGN (optional)</span>
        <textarea rows={3} value={pgn} onChange={(e) => setPgn(e.target.value)} placeholder="Paste games from a tournament bulletin, chess-results, etc." />
      </label>
      {pgnInfo && <div className="muted small">{pgnInfo}</div>}
      <div className="row">
        <button className="primary small" disabled={busy || !(name.trim() || lichess.trim() || chesscom.trim())} onClick={save}>
          {player ? 'Save' : 'Add player'}
        </button>
        <button className="ghost small" onClick={() => onDone()}>
          Cancel
        </button>
      </div>
    </div>
  );
}
