import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { deletePlayer, refreshPlayerGames, savePlayer } from '../services/players';
import { otbGamesVs, pgnGamesOf } from '../lib/players';
import { readPgnGames, sameName, similarNames } from '../lib/otb';
import { href } from '../router';
import type { Color } from '../lib/chess';
import type { DbLink, Player, StoredGame } from '../lib/types';
import type { NameEntry } from '../lib/gamesdb';
import { searchPlayers } from '../services/gamesdb';
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
  /** online = downloaded from Lichess / Chess.com, db = from the over-the-board database, otb = yours vs them, pgn = pasted. */
  counts: { online: number; db: number; otb: number; pgn: number };
  newest?: number;
}

/** All games we know of a player: downloaded, your over-the-board games against them, pasted PGN. */
export function usePlayerGames(playerId: string | undefined): ScoutGames | undefined | null {
  const player = useLiveQuery(async () => (playerId ? ((await db.players.get(playerId)) ?? null) : null), [playerId]);
  const cached = useLiveQuery(() => (playerId ? db.playerGames.where('playerId').equals(playerId).toArray() : []), [playerId]);
  const myOtb = useLiveQuery(() => db.games.where('source').equals('otb').toArray(), []);
  return useMemo(() => {
    if (player === null) return null;
    if (!player || !cached || !myOtb) return undefined;
    const online = cached.filter((g) => g.source !== 'otb');
    const fromDb = cached.filter((g) => g.source === 'otb');
    const otb = otbGamesVs(player, myOtb);
    const pgn = pgnGamesOf(player).games;
    const newest = online.reduce((m, g) => Math.max(m, g.playedAt), 0) || undefined;
    return {
      player,
      games: [...cached, ...otb, ...pgn],
      counts: { online: online.length, db: fromDb.length, otb: otb.length, pgn: pgn.length },
      newest,
    };
  }, [player, cached, myOtb]);
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
    if (!hasSources(p)) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    refreshed.add(p.id);
    setErrors([]);
    setProgress('Contacting…');
    try {
      const r = await refreshPlayerGames(p, {
        signal: c.signal,
        onProgress: (x) =>
          setProgress(`${x.source === 'lichess' ? 'Lichess' : x.source === 'chesscom' ? 'Chess.com' : 'games database'}: ${x.games} games${x.detail ? ` (${x.detail})` : ''}`),
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
    if (p && !refreshed.has(p.id) && hasSources(p)) void update(p);
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
  const otbCount = c ? c.db + c.otb + c.pgn : 0;
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
          {p && hasSources(p) && (
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
              <b>Over the board:</b> {c.db ? `${c.db} from the games database, ` : ''}
              {c.otb} game{c.otb === 1 ? '' : 's'} you entered against “{p.name}”
              {c.pgn ? `, ${c.pgn} from pasted PGN` : ''}
              {!p.dbLinks?.length && (
                <>
                  {' · '}
                  <button className="linklike" onClick={() => setEditing(p)}>
                    find them in the games database
                  </button>
                </>
              )}
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
            Their games can come from:
          </span>
          <ul className="steps">
            <li>
              the over-the-board games database (13 million games) —{' '}
              <button className="linklike" onClick={() => setEditing(p)}>
                find {p.name}
              </button>
            </li>
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
  const [links, setLinks] = useState<DbLink[]>(player?.dbLinks ?? []);
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
    onDone(await savePlayer({ id: player?.id, name: name.trim() || lichess.trim() || chesscom.trim(), lichess, chesscom, pgn, dbLinks: links }));
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
              ✓ {match.count} of the over-the-board games you entered {match.count === 1 ? 'is' : 'are'} against this name.
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
              You haven’t entered any over-the-board games against this name (Games → + Over-the-board game).
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
      <DbLinker name={name} links={links} onChange={setLinks} />
      <label className="field">
        <span>Their games as PGN (optional)</span>
        <textarea rows={3} value={pgn} onChange={(e) => setPgn(e.target.value)} placeholder="Paste their games — exported from a games database, a tournament bulletin…" />
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

const hasSources = (p: Player) => !!(p.lichess || p.chesscom || p.dbLinks?.length);

/** Search the over-the-board games database and tick the names that are this player. */
function DbLinker({ name, links, onChange }: { name: string; links: DbLink[]; onChange: (l: DbLink[]) => void }) {
  const [query, setQuery] = useState(name);
  const [edited, setEdited] = useState(false);
  const [results, setResults] = useState<NameEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preselected, setPreselected] = useState(false);
  const linksRef = useRef(links);
  linksRef.current = links;
  // Follow the name field until the search box is edited.
  useEffect(() => {
    if (!edited) setQuery(name);
  }, [name, edited]);
  // Search as you type (shards are cached, so most keystrokes cost nothing).
  useEffect(() => {
    if (!query.trim() || !/\p{L}{3}/u.test(query)) {
      setResults(null);
      return;
    }
    let stale = false;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const found = (await searchPlayers(query)).slice(0, 40);
        if (stale) return;
        setResults(found);
        setError(null);
        // First search for a player with no links: tick the spellings that are clearly the same name.
        if (!linksRef.current.length && !preselected) {
          const same = found.filter(([n]) => sameName(n, name));
          if (same.length) {
            onChange(same.map(([n, id, games]) => ({ id, name: n, games })));
            setPreselected(true);
          }
        }
      } catch (e) {
        if (!stale) setError((e as Error).message);
      } finally {
        if (!stale) setBusy(false);
      }
    }, 450);
    return () => {
      stale = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  const linked = new Set(links.map((l) => l.id));
  const toggle = ([n, id, games]: NameEntry) =>
    onChange(linked.has(id) ? links.filter((l) => l.id !== id) : [...links, { id, name: n, games }]);
  const total = links.reduce((s, l) => s + l.games, 0);
  return (
    <div className="field db-linker">
      <span>Over-the-board games database</span>
      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setEdited(true);
        }}
        placeholder="Search a name, e.g. Iinuma"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {busy && !results && <div className="muted small">Searching…</div>}
      {error && <div className="muted small">{error}</div>}
      {results && !results.length && <div className="muted small">No players with that name in the database.</div>}
      {results && results.length > 0 && (
        <div className="db-results">
          {results.map((r) => (
            <label key={r[1]} className="check db-result">
              <input type="checkbox" checked={linked.has(r[1])} onChange={() => toggle(r)} />
              <span>
                <b>{r[0]}</b>{' '}
                <span className="muted">
                  {r[2]} game{r[2] === 1 ? '' : 's'}
                  {r[3] ? ` · ${r[3] === r[4] ? r[3] : `${r[3]}–${r[4]}`}` : ''}
                  {r[5] ? ` · FIDE ${r[5]}` : ''}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
      {links.length > 0 && (
        <div className="small" style={{ color: 'var(--good)' }}>
          ✓ {links.length === 1 ? links[0].name : `${links.length} names`} linked · {total} game{total === 1 ? '' : 's'}
          {preselected && ' — the spellings matching the name are ticked; untick any that are someone else.'}
        </div>
      )}
      <div className="muted small">
        From Lumbra’s Gigabase (13 million over-the-board games). Tick every spelling of this player’s name.
      </div>
    </div>
  );
}

