import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { updateSettings, useSettings, type ExplorerColumn } from '../db/settings';
import { ConnectLichessButton } from './LichessConnect';
import { fetchExplorer, onExplorerStatus, paramsLabel, type ExplorerParams } from '../services/explorer';
import { lichessParams, MASTERS } from '../services/coverage';
import { GameStatsIndex } from '../lib/mygames';
import { moveGames, type MoveStat, type PositionStats } from '../lib/types';
import { opposite, playUci, posFromFen, turnOfKey, type Color } from '../lib/chess';
import { EQUAL_MARGIN, QUIET_MOVES } from '../lib/sharp';
import { holdingAfter } from '../services/sharpness';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { PlayersBar, filterBySource, usePlayerGames, useScoutPlayerId, type ScoutSource } from './PlayersScout';
import { useRecentGames } from '../hooks';
import { GameRangeSelect } from './GameRangeSelect';
import { TableWrap, WdlBar, agoLabel, agoShort, fmtDate, shortCount } from './ui';
import { oneIn, oneInShort } from '../lib/coverage';
import { cloudMoveEvals, engineLinesFor, evalScore, formatEval, onEngineLines, type EngineLine, type MoveEval } from '../services/engine';
import { href } from '../router';

type Tab = 'lichess' | 'masters' | 'mine' | 'players';

/** A move saved in your repertoire at this position. */
export interface SavedMove {
  id: string;
  san: string;
  mine: boolean;
  /** Standard UCI, used for engine evals of saved moves the database doesn't list. */
  uci?: string;
  /** Extra badges shown in the row (review status…). */
  extras?: ReactNode;
  /** How much of what follows the move is prepared (builder) — its own column, shown if chosen in ⚙. */
  prepared?: ReactNode;
}

const TOP_ROWS = 12;
/** The Stockfish column evaluates the most played moves (and every saved one). */
const MAX_EVAL_MOVES = 10;
/** Moves within this many centipawns of the best all count as best. */
const TIE_CP = 10;
/** The most played replies checked for sharpness (Lichess cloud analysis of the position after each). */
const SHARP_ROWS = 6;

/** The explorer table's optional columns, in table order. */
const COLUMNS: { id: ExplorerColumn; label: string; hint: string; where?: string }[] = [
  { id: 'games', label: 'Games', hint: 'How many games played the move' },
  { id: 'share', label: '%', hint: 'Share of the games in this position that played the move' },
  { id: 'reach', label: '1 in N', hint: "How often you reach the position after the opponent's move", where: "opponent's moves" },
  { id: 'eval', label: 'Stockfish', hint: "Evaluation after the move: Lichess's cloud analysis, and the Stockfish box's lines" },
  { id: 'result', label: 'Result', hint: 'White wins · draws · Black wins' },
  { id: 'last', label: 'Last played', hint: 'When the move was last played', where: 'My games, Players' },
  {
    id: 'prepared',
    label: 'Prepared',
    hint: 'Prepared from the position after your saved move: the share of games reaching it that stay in your prep',
    where: 'builder',
  },
];

/**
 * Evaluations after each move (White's point of view): Lichess's cloud analysis, plus the lines the
 * Stockfish box is working on in this position (the deeper of the two wins).
 */
function useMoveEvals(key: string, ucis: string[], enabled: boolean): Map<string, MoveEval> {
  const [cloud, setCloud] = useState<Map<string, MoveEval>>(new Map());
  const [engine, setEngine] = useState<EngineLine[] | undefined>();
  const sig = ucis.join(',');
  useEffect(() => {
    setCloud(new Map());
    if (!enabled || !ucis.length) return;
    let stop: (() => void) | undefined;
    // A moment's pause so stepping quickly through a line doesn't send requests for every position.
    const t = setTimeout(() => (stop = cloudMoveEvals(key, ucis, setCloud)), 250);
    return () => {
      clearTimeout(t);
      stop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sig, enabled]);
  useEffect(() => {
    setEngine(enabled ? engineLinesFor(key) : undefined);
    if (!enabled) return;
    return onEngineLines((k, lines) => k === key && setEngine(lines));
  }, [key, enabled]);
  return useMemo(() => {
    const out = new Map(cloud);
    for (const l of engine ?? []) {
      const u = l.moves[0];
      const c = u ? out.get(u) : undefined;
      if (u && (!c || l.eval.depth >= c.depth)) out.set(u, l.eval);
    }
    return out;
  }, [cloud, engine]);
}

/**
 * ⚙: which columns the table shows. Saved with your settings, so it follows you to other devices. The
 * menu floats over the page (the tabs row it sits in scrolls sideways and would clip it), below the
 * button or above it when there's no room — clear of the phone's tab bar — and follows the button
 * when the page or a pane scrolls.
 */
function ColumnsMenu({ value }: { value: ExplorerColumn[] }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => button.current?.contains(t as Node) || pop.current?.contains(t as Node);
    const outside = (e: Event) => !inside(e.target) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', esc);
    document.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', esc);
      document.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);
  /** Under the button (right edges lined up), or above it if it would run past the bottom. */
  const place = () => {
    const b = button.current?.getBoundingClientRect();
    const p = pop.current;
    if (!b || !p) return;
    const nav = document.querySelector('.topbar .nav');
    const bottom = nav && getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect().top : window.innerHeight;
    const { offsetWidth: w, offsetHeight: h } = p;
    const below = b.bottom + 6;
    const top = below + h <= bottom - 8 ? below : Math.max(8, b.top - 6 - h);
    setAt({ top, left: Math.max(8, Math.min(b.right - w, window.innerWidth - w - 8)) });
  };
  useLayoutEffect(() => {
    if (open) place();
    else setAt(null);
  }, [open]);
  // Ticks change at once; the saved setting catches up a moment later.
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const on = new Set(local);
  const toggle = (id: ExplorerColumn) => {
    const next = new Set(on);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    const cols = COLUMNS.map((c) => c.id).filter((c) => next.has(c));
    setLocal(cols);
    void updateSettings({ explorerColumns: cols });
  };
  return (
    <>
      <button
        ref={button}
        className={`small ghost explorer-cols ${open ? 'is-open' : ''}`}
        title="Choose columns"
        aria-label="Choose columns"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        ⚙
      </button>
      {open &&
        createPortal(
          <div ref={pop} className="menu-pop columns-pop" role="dialog" aria-label="Columns" style={at ? { top: at.top, left: at.left } : { visibility: 'hidden' }}>
            <div className="menu-note muted small">Columns</div>
            {COLUMNS.map((c) => (
              <label key={c.id} className="check" title={c.hint}>
                <input type="checkbox" checked={on.has(c.id)} onChange={() => toggle(c.id)} />
                <span>{c.label}</span>
                {c.where && <span className="muted small">{c.where}</span>}
              </label>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/** A magnifying glass (the emoji is too loud at this size). */
function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" style={{ display: 'block' }}>
      <circle cx="6.5" cy="6.5" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10.2 10.2 14.5 14.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

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
  /** The move that led here (for "your usual answer" to it). */
  lastSan?: string;
}

export function ExplorerPanel({ fenKey, color, saved = [], notes, title, onPlay, onAdd, onDelete, onOpening, reachHere, lastSan }: Props) {
  const settings = useSettings();
  const cols = new Set(settings.explorerColumns);
  // On your own turn every move you choose is reached as often as the position itself, so it's only useful for replies.
  const showReach = cols.has('reach') && reachHere !== undefined && turnOfKey(fenKey) !== color;
  const [tab, setTab] = useState<Tab>('lichess');
  // Your games and a scouted player's: when each move was last played, and a link to those games.
  const fromGames = tab === 'mine' || tab === 'players';
  const showLast = cols.has('last') && fromGames;
  const showEval = cols.has('eval');
  const showPrepared = cols.has('prepared') && saved.some((s) => s.prepared !== undefined);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [fenKey]);
  const [data, setData] = useState<PositionStats | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [needsLogin, setNeedsLogin] = useState(false);
  const [loading, setLoading] = useState(false);
  const [waitUntil, setWaitUntil] = useState<number | undefined>();
  const games = useRecentGames('opponentRange');
  // Rebuilt only when the games' moves or results change — not whenever a game's notes, side lines or
  // computer review are saved (a review saves as it goes; replaying every game again each time lags).
  const gamesKey = games?.map((g) => `${g.id}:${g.sans.length}:${g.result}:${g.userColor}:${g.playedAt}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mine = useMemo(() => (games ? new GameStatsIndex(games, { color }) : undefined), [gamesKey, color]);
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

  const rowUci = (r: (typeof rows)[number]) => r.stat?.uci ?? r.rep?.uci;
  const evalMoves = [...new Set(rows.filter((r, i) => i < MAX_EVAL_MOVES || r.rep).map(rowUci).filter((u): u is string => !!u))];
  // Your turn: a move you already play in other positions, as good as the best here (your usual move) —
  // its evaluation is fetched for that even when the Eval column is hidden.
  const theirTurn = turnOfKey(fenKey) !== color;
  const usual = useUsualMoves(color);
  const usualElsewhere = (san: string) => {
    const at = usual?.moves.get(san);
    return (at?.size ?? 0) - (at?.has(fenKey) ? 1 : 0);
  };
  // Their move that led here (the line's, else the repertoire's moves into this position).
  const theirLast = lastSan ? [bareSan(lastSan)] : [...(usual?.into.get(fenKey) ?? [])];
  /** How many other positions you answer their move here with `san` (…Bg4 → h3 elsewhere too). */
  const answeredElsewhere = (san: string) => {
    let n = 0;
    for (const t of theirLast) {
      const at = usual?.answers.get(t)?.get(bareSan(san));
      if (at) n = Math.max(n, at.size - (at.has(fenKey) ? 1 : 0));
    }
    return n;
  };
  const wantUsual =
    !theirTurn && rows.some((r, i) => (i < MAX_EVAL_MOVES || r.rep) && (answeredElsewhere(r.san) >= 1 || (!r.rep && usualElsewhere(r.san) >= 2)));
  const evals = useMoveEvals(fenKey, evalMoves, (showEval || wantUsual) && settings.loaded);
  const sign = turnOfKey(fenKey) === 'white' ? 1 : -1;
  const moverScores = [...evals.values()].map((e) => evalScore(e) * sign);
  const best = Math.max(...moverScores);
  const bestCount = moverScores.filter((x) => best - x <= TIE_CP).length;
  // The opponent's turn: replies after which only one or two of your moves hold (⚡ sharp).
  const sharpTargets = theirTurn ? visibleRows.slice(0, SHARP_ROWS).map(rowUci).filter((u): u is string => !!u).join(',') : '';
  const holding = useHoldingAfterReplies(fenKey, sharpTargets);
  // The usual move, among those rated about as good as the best here — just one, or the badge would
  // say nothing: first your usual answer to their move (what you play after it elsewhere, even if it's
  // already your move here), else the move you play in the most other positions (at least 2).
  const usualSan = (() => {
    if (theirTurn || evals.size < 2) return undefined;
    let pick: { san: string; n: number; answer: boolean; rank: number; score: number } | undefined;
    for (const r of rows) {
      const u = rowUci(r);
      const e = u ? evals.get(u) : undefined;
      if (!e) continue;
      const score = evalScore(e) * sign;
      if (best - score > EQUAL_MARGIN) continue;
      const a = answeredElsewhere(r.san);
      const n = r.rep ? 0 : usualElsewhere(r.san);
      const rank = a >= 1 ? 1000 + a : n >= 2 ? n : 0;
      if (!rank) continue;
      if (!pick || rank > pick.rank || (rank === pick.rank && score > pick.score)) pick = { san: r.san, n: a >= 1 ? a : n, answer: a >= 1, rank, score };
    }
    return pick;
  })();

  /** The games behind the table (all, or those that played `san` here), as a list on the Games page. */
  const gamesHref = (san?: string) =>
    tab === 'mine'
      ? href('games', { at: fenKey, move: san, color, range: settings.opponentRange })
      : tab === 'players' && playerId
        ? href('games', { player: playerId, as: playerAs, src: playerSource === 'all' ? undefined : playerSource, at: fenKey, move: san })
        : undefined;
  const whose = tab === 'mine' ? 'your games' : `${scout?.player.name ?? 'their'} games`;
  const search = (san?: string) => {
    const to = gamesHref(san);
    return (
      to && (
        <a className="btn ghost small icon-btn" href={to} title={san ? `List ${whose} with ${san} here` : `List ${whose} that reached this position`} onClick={(e) => e.stopPropagation()}>
          <SearchIcon />
        </a>
      )
    );
  };
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
        <ColumnsMenu value={settings.explorerColumns} />
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
              {cols.has('games') && <th className="num">Games</th>}
              {cols.has('share') && <th className="num">%</th>}
              {showReach && (
                <th className="num" title="You reach the position after this move once every this many games (saved in your repertoire or not)">
                  1 in
                </th>
              )}
              {showEval && (
                <th className="num" title="Evaluation after the move, White's point of view (Lichess cloud analysis, and the Stockfish box's lines)">
                  Eval
                </th>
              )}
              {cols.has('result') && <th className="result">Result</th>}
              {showLast && (
                <th className="nowrap" title="When the move was last played">
                  <span className="hide-sm">Last played</span>
                  <span className="show-sm">Last</span>
                </th>
              )}
              {showPrepared && (
                <th className="num" title="Prepared from the position after the move: the share of games reaching it that stay in your prep">
                  Prepared
                </th>
              )}
              <th>
                <div className="list-actions" style={{ justifyContent: 'flex-end' }}>
                  {total > 0 && search()}
                </div>
              </th>
            </tr>
          </thead>
          <tbody style={{ opacity: loading ? 0.5 : 1 }}>
            {visibleRows.map((row) => {
              const { san, stat, rep } = row;
              const n = stat ? moveGames(stat) : 0;
              const uci = rowUci(row);
              const ev = showEval && uci ? evals.get(uci) : undefined;
              // How much worse than the best move, from the mover's side: mistakes stand out.
              const loss = ev ? best - evalScore(ev) * sign : 0;
              const grade = !ev || evals.size < 2 ? '' : loss <= TIE_CP ? 'best' : loss >= 100 ? 'mistake' : loss >= 40 ? 'inaccuracy' : '';
              return (
                <tr key={san} className={`clickable ${rep ? `inrep ${rep.mine ? 'mine' : 'theirs'}` : ''}`} onClick={() => onPlay(san)}>
                  <td>
                    <b className="san">{san}</b>
                    {rep && ' ✓'}
                    {(() => {
                      const n = uci ? holding.get(uci) : undefined;
                      return n !== undefined && n < QUIET_MOVES ? (
                        <span className="move-badge sharp" title={`Sharp: after ${san} only ${n === 1 ? 'one of your moves holds' : 'two of your moves hold'}`}>
                          ⚡
                        </span>
                      ) : null;
                    })()}
                    {usualSan?.san === san && (
                      <span
                        className="move-badge usual"
                        title={
                          usualSan.answer
                            ? `Your usual answer to ${theirLast[0]}: you play ${san} after ${theirLast[0]} in ${usualSan.n === 1 ? 'another position' : `${usualSan.n} other positions`}, and here it's about as good as the best — one less thing to remember`
                            : `Your usual move: you play ${san} in ${usualSan.n} other positions, and here it's about as good as the best — one less thing to remember`
                        }
                      >
                        ↻
                      </span>
                    )}
                  </td>
                  {cols.has('games') && (
                    <td className="num" title={stat ? `${n.toLocaleString()} games` : undefined}>
                      {stat ? shortCount(n) : '—'}
                    </td>
                  )}
                  {cols.has('share') && <td className="num">{stat && total ? ((n / total) * 100).toFixed(1) : '—'}</td>}
                  {showReach && (
                    <td className="num" title={stat && total && n ? `${oneIn((reachHere! * n) / total)} games` : undefined}>
                      {stat && total ? <b>{n ? oneInShort((reachHere! * n) / total) : 'never'}</b> : '—'}
                    </td>
                  )}
                  {showEval && (
                    <td
                      className="num"
                      title={
                        ev
                          ? `${ev.source === 'cloud' ? 'Lichess cloud' : 'Stockfish'} depth ${ev.depth}${
                              grade === 'best'
                                ? bestCount > 1
                                  ? ` · one of ${bestCount} equally good moves`
                                  : ' · best move here'
                                : loss > TIE_CP
                                  ? ` · ${(loss / 100).toFixed(1)} worse than the best`
                                  : ''
                            }`
                          : 'Not evaluated (no cloud analysis; the Stockfish box covers its best lines)'
                      }
                    >
                      {ev ? <span className={`evalbox ${grade || (evalScore(ev) >= 0 ? 'white' : 'black')}`}>{formatEval(ev)}</span> : <span className="muted">—</span>}
                    </td>
                  )}
                  {cols.has('result') && (
                    <td className="result">{stat ? <WdlBar white={stat.white} draws={stat.draws} black={stat.black} /> : <span className="muted small">not in database</span>}</td>
                  )}
                  {showLast && (
                    <td className="small nowrap" title={stat?.lastPlayed ? fmtDate(stat.lastPlayed) : undefined}>
                      {stat?.lastPlayed ? (
                        <>
                          <span className="hide-sm">{agoLabel(stat.lastPlayed)}</span>
                          <span className="show-sm">{agoShort(stat.lastPlayed)}</span>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  )}
                  {showPrepared && <td className="num">{rep?.prepared}</td>}
                  <td>
                    <div className="list-actions" style={{ justifyContent: 'flex-end', alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
                      {rep?.extras}
                      {stat && n > 0 && search(san)}
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
            {fromGames && data.lastPlayed ? ` · last reached ${agoLabel(data.lastPlayed)}` : ''}
            {data.opening ? ` · ${data.opening.eco} ${data.opening.name}` : ''}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * After each reply (UCI, comma-separated in `targets`) in position `fenKey`: how many of your moves
 * hold (services/sharpness — Lichess's cloud analysis, cached). Asked a moment after you stop on a
 * position, one reply at a time, so stepping through moves doesn't fire a burst of requests.
 */
function useHoldingAfterReplies(fenKey: string, targets: string): Map<string, number> {
  const [found, setFound] = useState<{ key: string; by: Map<string, number> }>();
  useEffect(() => {
    if (!targets) return;
    let off = false;
    const t = setTimeout(async () => {
      const pos = posFromFen(fenKey);
      if (!pos) return;
      const by = new Map<string, number>();
      for (const uci of targets.split(',')) {
        const next = playUci(pos, uci);
        if (!next) continue;
        const n = await holdingAfter(fenKey, uci, next.key).catch(() => undefined);
        if (off) return;
        if (n === undefined) continue;
        by.set(uci, n);
        setFound({ key: fenKey, by: new Map(by) });
      }
    }, 400);
    return () => {
      off = true;
      clearTimeout(t);
    };
  }, [fenKey, targets]);
  return found?.key === fenKey ? found.by : EMPTY;
}
const EMPTY = new Map<string, number>();

/** A move without its check or mate sign (…Bg4 and …Bg4+ are the same idea for "your usual answer"). */
const bareSan = (san: string) => san.replace(/[+#]$/, '');

/**
 * Over all your chapters of a color: where you play each move (SAN → the positions), their moves into
 * each position, and what you answer each of their moves with (their SAN → your SAN → the positions).
 */
function useUsualMoves(color: Color) {
  return useLiveQuery(async () => {
    const reps = await db.repertoires.where('color').equals(color).primaryKeys();
    const all = reps.length ? await db.moves.where('repId').anyOf(reps).toArray() : [];
    const moves = new Map<string, Set<string>>();
    const into = new Map<string, Set<string>>();
    for (const m of all) {
      if (m.noTrain) continue;
      if (m.mine) {
        const at = moves.get(m.san) ?? new Set<string>();
        at.add(m.fromKey);
        moves.set(m.san, at);
      } else {
        const at = into.get(m.toKey) ?? new Set<string>();
        at.add(bareSan(m.san));
        into.set(m.toKey, at);
      }
    }
    const answers = new Map<string, Map<string, Set<string>>>();
    for (const m of all) {
      if (!m.mine || m.noTrain) continue;
      for (const theirs of into.get(m.fromKey) ?? []) {
        const byMine = answers.get(theirs) ?? new Map<string, Set<string>>();
        const at = byMine.get(bareSan(m.san)) ?? new Set<string>();
        at.add(m.fromKey);
        byMine.set(bareSan(m.san), at);
        answers.set(theirs, byMine);
      }
    }
    return { moves, into, answers };
  }, [color]);
}
