import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Chess } from 'chessops/chess';
import type { PageProps } from '../App';
import { db } from '../db/db';
import { updateSettings, useSettings } from '../db/settings';
import { markForgotten } from '../db/repertoire';
import { useAllGraphs, useGames } from '../hooks';
import { syncSource, lastSync, type SyncResult } from '../services/sync';
import { analyzeGame, summarize, PREP_LABEL, type PrepKind, type PrepResult, type RepWithGraph } from '../lib/prep';
import { formatLine, playSan, startPos } from '../lib/chess';
import type { GameSource, StoredGame } from '../lib/types';
import type { ImportProgress } from '../lib/importers/common';
import { Board, type Arrow } from '../components/Board';
import { MoveNote } from '../components/MoveNote';
import { GameReviewPanel } from '../components/GameReviewPanel';
import { biggestSwings, JUDGEMENT_GLYPH, swings } from '../lib/review';
import { ColorPill, Empty, LineView, Stat, TableWrap, fmtDate, timeAgo } from '../components/ui';
import { href, navigate } from '../router';
import { rangeCutoff } from '../lib/gameRange';
import { GameRangeSelect } from '../components/GameRangeSelect';
import { LichessAccount } from '../components/LichessConnect';

export function GamesPage({ route }: PageProps) {
  const id = route.path[1];
  if (id) return <GameViewer id={id} />;
  return <GamesOverview />;
}

function usePrepResults(games: StoredGame[] | undefined, graphs: RepWithGraph[] | undefined) {
  return useMemo(() => {
    const out = new Map<string, PrepResult>();
    if (!games || !graphs) return out;
    for (const g of games) out.set(g.id, analyzeGame(g, graphs));
    return out;
  }, [games, graphs]);
}

const KIND_BADGE: Record<PrepKind, string> = {
  'you-deviated': 'bad',
  'opponent-deviated': 'due',
  'end-of-prep': 'good',
  'still-in-book': 'good',
  'other-opening': '',
  'no-repertoire': '',
};

/* ---------------------------------------------------------------- sync */

function SyncPanel() {
  const settings = useSettings();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<(ImportProgress & { source: GameSource }) | null>(null);
  const [results, setResults] = useState<SyncResult[]>([]);
  const ctrl = useRef<AbortController | null>(null);
  const last = useLiveQuery(
    async () => ({
      lichess: await lastSync('lichess', settings.lichessUsername),
      chesscom: await lastSync('chesscom', settings.chesscomUsername),
    }),
    [settings.lichessUsername, settings.chesscomUsername],
  );

  const run = async (sources: GameSource[]) => {
    setBusy(true);
    setResults([]);
    ctrl.current = new AbortController();
    const out: SyncResult[] = [];
    try {
      for (const s of sources) out.push(await syncSource(s, { signal: ctrl.current.signal, onProgress: setProgress }));
    } catch (e) {
      if ((e as Error).name !== 'AbortError') out.push({ source: sources[0], added: 0, error: (e as Error).message });
    } finally {
      setResults(out);
      setProgress(null);
      setBusy(false);
    }
  };

  const sources: GameSource[] = [];
  if (settings.lichessUsername.trim()) sources.push('lichess');
  if (settings.chesscomUsername.trim()) sources.push('chesscom');

  return (
    <div className="panel">
      <div className="row">
        <h2 style={{ margin: 0 }}>Import games</h2>
        <span className="spacer" />
        {busy ? (
          <button onClick={() => ctrl.current?.abort()}>Stop</button>
        ) : (
          <button className="primary" disabled={!sources.length} onClick={() => run(sources)}>
            Sync games
          </button>
        )}
      </div>
      <div style={{ marginTop: 10 }}>
        <LichessAccount />
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <label className="field">
          <span>Chess.com username</span>
          <input defaultValue={settings.chesscomUsername} key={`c${settings.loaded}`} onBlur={(e) => updateSettings({ chesscomUsername: e.target.value.trim() })} />
        </label>
        <div className="muted small" style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
          Since {settings.importSince} · {settings.importTimeClasses.join(', ')} · <a href={href('settings')}>change</a>
          <br />
          {last?.lichess && `Lichess synced ${timeAgo(last.lichess)}. `}
          {last?.chesscom && `Chess.com synced ${timeAgo(last.chesscom)}.`}
        </div>
      </div>
      {progress && (
        <div className="note" style={{ marginTop: 8 }}>
          {progress.source === 'lichess' ? 'Lichess' : 'Chess.com'}: {progress.phase} — {progress.games} games {progress.detail ? `(${progress.detail})` : ''}
        </div>
      )}
      {results.map((r) => (
        <div key={r.source} className={r.error ? 'error' : 'note'} style={{ marginTop: 8 }}>
          {r.source === 'lichess' ? 'Lichess' : 'Chess.com'}: {r.added} new game{r.added === 1 ? '' : 's'}
          {r.error ? ` — ${r.error}` : ''}
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- overview */

function GamesOverview() {
  const games = useGames();
  const graphs = useAllGraphs();
  const results = usePrepResults(games, graphs);
  const [source, setSource] = useState<'all' | GameSource>('all');
  const [color, setColor] = useState<'all' | 'white' | 'black'>('all');
  const [tc, setTc] = useState('all');
  const { gameRange } = useSettings();
  const [kind, setKind] = useState<'all' | PrepKind>('all');
  const [limit, setLimit] = useState(100);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [openNote, setOpenNote] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!games) return [];
    const cutoff = rangeCutoff(gameRange);
    return games.filter(
      (g) =>
        (source === 'all' || g.source === source) &&
        (color === 'all' || g.userColor === color) &&
        (tc === 'all' || g.timeClass === tc) &&
        g.playedAt >= cutoff,
    );
  }, [games, source, color, tc, gameRange]);
  const summary = useMemo(() => summarize(filtered, results), [filtered, results]);
  const shown = filtered.filter((g) => kind === 'all' || results.get(g.id)?.kind === kind);

  if (!games || !graphs) return <SyncPanel />;

  const graphOf = (repId: string) => graphs.find((x) => x.rep.id === repId);
  const pathOf = (repId: string, key: string) => (graphOf(repId)?.graph.pathTo(key) ?? []).map((m) => m.san);
  const expectedCardIds = (repId: string, key: string) =>
    (graphOf(repId)?.graph.childrenOf(key) ?? []).filter((m) => m.mine).map((m) => m.id);

  const drill = async (repId: string, key: string) => {
    await markForgotten(expectedCardIds(repId, key));
    navigate('train', { rep: repId, mode: 'review', t: String(Date.now()) });
  };

  const applyAll = async () => {
    const cardsToFail = new Set<string>();
    const gameIds: string[] = [];
    for (const g of filtered) {
      const r = results.get(g.id);
      if (g.prepApplied || r?.kind !== 'you-deviated' || !r.repId || !r.key) continue;
      for (const id of expectedCardIds(r.repId, r.key)) {
        const card = await db.cards.get(id);
        if (card && card.state !== 0 && card.createdAt < g.playedAt) cardsToFail.add(id);
      }
      gameIds.push(g.id);
    }
    await markForgotten([...cardsToFail]);
    await db.games.bulkUpdate(gameIds.map((id) => ({ key: id, changes: { prepApplied: true } })));
    setApplyMsg(
      cardsToFail.size
        ? `${cardsToFail.size} forgotten move${cardsToFail.size === 1 ? ' is' : 's are'} now due for review.`
        : 'Nothing new to schedule (moves must have been learned before the game was played).',
    );
  };

  const pendingApply = filtered.filter((g) => !g.prepApplied && results.get(g.id)?.kind === 'you-deviated').length;

  return (
    <div className="col" style={{ gap: 16 }}>
      <h1>Games</h1>
      <SyncPanel />

      {games.length === 0 ? (
        <Empty>No games yet. Enter your usernames above and press “Sync games”.</Empty>
      ) : (
        <>
          <div className="row">
            <select value={source} onChange={(e) => setSource(e.target.value as never)}>
              <option value="all">All sites</option>
              <option value="lichess">Lichess</option>
              <option value="chesscom">Chess.com</option>
            </select>
            <select value={color} onChange={(e) => setColor(e.target.value as never)}>
              <option value="all">Both colors</option>
              <option value="white">As White</option>
              <option value="black">As Black</option>
            </select>
            <select value={tc} onChange={(e) => setTc(e.target.value)}>
              <option value="all">All time controls</option>
              {['bullet', 'blitz', 'rapid', 'classical', 'correspondence'].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <GameRangeSelect />
          </div>

          <div className="grid3">
            <Stat value={summary.games} label="Games" />
            <Stat value={summary.byKind['you-deviated']} label="Forgot prep" hint="Games where you left your repertoire while it had a move for you" />
            <Stat value={summary.byKind['opponent-deviated']} label="Opponent left book" hint="Opponent played a move your repertoire does not cover" />
            <Stat value={(summary.avgBookPlies / 2).toFixed(1)} label="Avg moves in book" hint="Full moves played inside your repertoire (games with a matching repertoire)" />
          </div>

          <div className="grid2">
            <div className="panel">
              <div className="row">
                <h2 style={{ margin: 0 }}>Where you forget your prep</h2>
                <span className="spacer" />
                {pendingApply > 0 && (
                  <button className="primary small" onClick={applyAll} title="Grade each forgotten move as 'Again' so it comes back for review">
                    Schedule forgotten moves ({pendingApply})
                  </button>
                )}
              </div>
              {applyMsg && <div className="note" style={{ marginTop: 6 }}>{applyMsg}</div>}
              {summary.forgotten.length === 0 ? (
                <Empty>No forgotten prep in these games. 💪</Empty>
              ) : (
                <TableWrap>
                <table className="data" style={{ marginTop: 6 }}>
                  <thead>
                    <tr>
                      <th>Position</th>
                      <th>Prep</th>
                      <th>You played</th>
                      <th className="num hide-sm">×</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {summary.forgotten.slice(0, 25).map((f) => (
                      <Fragment key={f.repId + f.key}>
                      <tr>
                        <td className="mono small line-cell">{formatLine(pathOf(f.repId, f.key)) || 'Start'}</td>
                        <td>
                          <b style={{ color: 'var(--mine)' }}>{f.expected.join(', ')}</b>
                        </td>
                        <td>
                          {Object.entries(f.played)
                            .map(([san, n]) => (n > 1 ? `${san} ×${n}` : san))
                            .join(', ')}
                        </td>
                        <td className="num hide-sm">{f.count}</td>
                        <td>
                          <div className="list-actions">
                            <button className="small primary" onClick={() => drill(f.repId, f.key)}>
                              Drill
                            </button>
                            <button
                              className={`small ${openNote === f.repId + f.key ? 'blue' : ''}`}
                              title="Read or edit the note on your prepared move"
                              onClick={() => setOpenNote(openNote === f.repId + f.key ? null : f.repId + f.key)}
                            >
                              Note
                            </button>
                            <a className="btn small" href={href(`games/${encodeURIComponent(f.gameIds[0])}`)}>
                              Game
                            </a>
                          </div>
                        </td>
                      </tr>
                      {openNote === f.repId + f.key && (
                        <tr>
                          <td colSpan={5}>
                            {(graphOf(f.repId)?.graph.childrenOf(f.key) ?? [])
                              .filter((m) => m.mine)
                              .map((m) => (
                                <MoveNote key={m.id} id={m.id} san={m.san} compact autoFocus prompt />
                              ))}
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
                </TableWrap>
              )}
            </div>

            <div className="panel">
              <h2>Opponent moves you weren't ready for</h2>
              {summary.surprises.length === 0 ? (
                <Empty>Your opponents stayed inside your repertoire.</Empty>
              ) : (
                <TableWrap>
                <table className="data" style={{ marginTop: 6 }}>
                  <thead>
                    <tr>
                      <th>After</th>
                      <th>They played</th>
                      <th className="num hide-sm">×</th>
                      <th className="num">Score</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {summary.surprises.slice(0, 25).map((s) => {
                      const path = pathOf(s.repId, s.key);
                      return (
                        <tr key={s.repId + s.key + s.san}>
                          <td className="mono small line-cell">{formatLine(path) || 'Start'}</td>
                          <td>
                            <b>{s.san}</b>
                          </td>
                          <td className="num hide-sm">{s.count}</td>
                          <td className="num">{Math.round(s.score * 100)}%</td>
                          <td>
                            <button className="small primary" onClick={() => navigate(`repertoire/${s.repId}`, { line: [...path, s.san].join(' ') })}>
                              Prepare
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </TableWrap>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="row">
              <h2 style={{ margin: 0 }}>All games</h2>
              <span className="spacer" />
              <select value={kind} onChange={(e) => setKind(e.target.value as never)}>
                <option value="all">Any prep outcome</option>
                {(Object.keys(PREP_LABEL) as PrepKind[]).map((k) => (
                  <option key={k} value={k}>
                    {PREP_LABEL[k]} ({summary.byKind[k]})
                  </option>
                ))}
              </select>
            </div>
            <TableWrap>
            <table className="data" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="hide-sm" />
                  <th>Opponent</th>
                  <th>Result</th>
                  <th className="hide-sm">Type</th>
                  <th className="hide-sm">Opening</th>
                  <th>Prep</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, limit).map((g) => {
                  const r = results.get(g.id);
                  const opp = g.userColor === 'white' ? g.black : g.white;
                  const oppElo = g.userColor === 'white' ? g.blackElo : g.whiteElo;
                  return (
                    <tr key={g.id} className="clickable" onClick={() => navigate(`games/${encodeURIComponent(g.id)}`)}>
                      <td className="small nowrap">
                        <span className="hide-sm">{fmtDate(g.playedAt)}</span>
                        <span className="show-sm">{shortDate(g.playedAt)}</span>
                      </td>
                      <td className="hide-sm">
                        <ColorPill color={g.userColor} />
                      </td>
                      <td>
                        {opp} {oppElo ? <span className="muted small">({oppElo})</span> : null}
                      </td>
                      <td>
                        <span className={`badge ${g.userScore === 1 ? 'good' : g.userScore === 0 ? 'bad' : ''}`}>
                          {g.userScore === 1 ? 'Won' : g.userScore === 0 ? 'Lost' : g.userScore === 0.5 ? 'Draw' : '—'}
                        </span>
                      </td>
                      <td className="small muted hide-sm">
                        {g.source === 'lichess' ? 'Lichess' : 'Chess.com'} · {g.timeClass}
                      </td>
                      <td className="small hide-sm">{g.opening ?? ''}</td>
                      <td>
                        {r && (
                          <span className={`badge wrap ${KIND_BADGE[r.kind]}`} title={r.ply !== undefined ? `Move ${Math.floor(r.ply / 2) + 1}` : ''}>
                            {PREP_LABEL[r.kind]}
                            {r.ply !== undefined && r.kind !== 'other-opening' ? ` · m${Math.floor(r.ply / 2) + 1}` : ''}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </TableWrap>
            {shown.length > limit && (
              <div style={{ textAlign: 'center', marginTop: 8 }}>
                <button onClick={() => setLimit(limit + 200)}>Show more ({shown.length - limit} left)</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- viewer */

function GameViewer({ id }: { id: string }) {
  const game = useLiveQuery(() => db.games.get(id), [id]);
  const graphs = useAllGraphs();
  const result = useMemo(() => (game && graphs ? analyzeGame(game, graphs) : undefined), [game, graphs]);
  const replay = useMemo(() => {
    if (!game) return undefined;
    let pos: Chess = startPos();
    const positions: Chess[] = [pos];
    const ucis: string[] = [];
    for (const s of game.sans) {
      const r = playSan(pos, s);
      if (!r) break;
      positions.push(r.pos);
      ucis.push(r.uci);
      pos = r.pos;
    }
    return { positions, ucis };
  }, [game]);
  const [cursor, setCursor] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!replay) return;
      const max = replay.positions.length - 1;
      if (e.key === 'ArrowLeft') setCursor((c) => Math.max(0, (c ?? 0) - 1));
      else if (e.key === 'ArrowRight') setCursor((c) => Math.min(max, (c ?? 0) + 1));
      else if (e.key === 'Home') setCursor(0);
      else if (e.key === 'End') setCursor(max);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [replay]);

  if (game === undefined || !graphs || !replay) return <div className="muted">Loading…</div>;
  if (!game) return <Empty>Game not found.</Empty>;

  const r = result!;
  const devPly = r.ply;
  const cur = cursor ?? devPly ?? Math.min(r.bookPlies, replay.positions.length - 1);
  const graph = r.repId ? graphs.find((x) => x.rep.id === r.repId)?.graph : undefined;
  const pos = replay.positions[cur];
  const arrows: Arrow[] = [];
  if (devPly !== undefined && cur === devPly && graph && r.key) {
    for (const m of graph.childrenOf(r.key)) arrows.push({ uci: m.uci, brush: m.mine ? 'green' : 'paleBlue' });
    if (r.playedUci) arrows.push({ uci: r.playedUci, brush: 'red' });
  }
  // Computer review: glyphs for inaccuracies/mistakes/blunders, and at those positions the played
  // move (red) vs the engine's choice (green).
  const judged = new Map((game.review ? swings(game.review) : []).filter((s) => s.judgement).map((s) => [s.ply, s]));
  const topPlies = new Set(game.review ? biggestSwings(game.review, 3).map((s) => s.ply) : []);
  const swingHere = judged.get(cur) ?? (topPlies.has(cur) ? swings(game.review!).find((s) => s.ply === cur) : undefined);
  if (swingHere && cur < replay.ucis.length && !(devPly !== undefined && cur === devPly)) {
    arrows.push({ uci: replay.ucis[cur], brush: 'red' });
    if (swingHere.best && swingHere.best !== replay.ucis[cur]) arrows.push({ uci: swingHere.best, brush: 'green' });
  }
  const pathToDev = r.key && graph ? (graph.pathTo(r.key) ?? []).map((m) => m.san) : [];
  const moveNo = devPly !== undefined ? `${Math.floor(devPly / 2) + 1}${devPly % 2 ? '…' : '.'}` : '';
  const opp = game.userColor === 'white' ? game.black : game.white;

  return (
    <div className="board-layout">
      <div className="board-col col">
        <Board pos={pos} orientation={game.userColor} lastMove={cur > 0 ? replay.ucis[cur - 1] : undefined} arrows={arrows} />
        <div className="row">
          <button onClick={() => setCursor(0)}>⏮</button>
          <button onClick={() => setCursor(Math.max(0, cur - 1))}>◀</button>
          <button onClick={() => setCursor(Math.min(replay.positions.length - 1, cur + 1))}>▶</button>
          <button onClick={() => setCursor(replay.positions.length - 1)}>⏭</button>
          {devPly !== undefined && <button onClick={() => setCursor(devPly)}>Jump to deviation</button>}
        </div>
        {r.kind === 'you-deviated' &&
          r.key &&
          graph?.childrenOf(r.key).filter((m) => m.mine).map((m) => <MoveNote key={m.id} id={m.id} san={m.san} label="(your prep)" prompt />)}
      </div>
      <div className="col">
        <div className="panel">
          <div className="row">
            <a href={href('games')} className="btn small">
              ← Games
            </a>
            <h2 style={{ margin: 0 }}>
              {game.white} {game.whiteElo ? `(${game.whiteElo})` : ''} – {game.black} {game.blackElo ? `(${game.blackElo})` : ''}
            </h2>
          </div>
          <div className="muted small" style={{ marginTop: 6 }}>
            {fmtDate(game.playedAt)} · {game.source === 'lichess' ? 'Lichess' : 'Chess.com'} {game.timeClass} · {game.result} · {game.opening ?? ''}{' '}
            {game.url && (
              <a href={game.url} target="_blank" rel="noreferrer">
                open on site ↗
              </a>
            )}
          </div>
        </div>

        <div className={`feedback ${r.kind === 'you-deviated' ? 'bad' : r.kind === 'opponent-deviated' ? 'hint' : 'good'}`}>
          <b>{PREP_LABEL[r.kind]}</b>
          <div style={{ marginTop: 4 }}>
            {r.kind === 'you-deviated' && (
              <>
                On move {moveNo} you played <b>{r.played}</b>, but your repertoire says <b>{r.expected?.join(' or ')}</b>.
              </>
            )}
            {r.kind === 'opponent-deviated' && (
              <>
                On move {moveNo} {opp} played <b>{r.played}</b>, which your repertoire doesn't cover.
              </>
            )}
            {r.kind === 'end-of-prep' && <>You stayed in book for {Math.ceil(r.bookPlies / 2)} moves until your prepared line ended.</>}
            {r.kind === 'still-in-book' && <>The whole game stayed inside your repertoire.</>}
            {r.kind === 'other-opening' && <>You chose an opening that isn't in your repertoire ({r.played}).</>}
            {r.kind === 'no-repertoire' && (
              <>
                You have no {game.userColor} repertoire yet. <a href={href('repertoire')}>Create one</a>.
              </>
            )}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            {r.kind === 'you-deviated' && r.repId && r.key && graph && (
              <button
                className="primary small"
                onClick={async () => {
                  await markForgotten(graph.childrenOf(r.key!).filter((m) => m.mine).map((m) => m.id), game.id);
                  navigate('train', { rep: r.repId, mode: 'review', t: String(Date.now()) });
                }}
              >
                Drill this move now
              </button>
            )}
            {r.kind === 'opponent-deviated' && r.repId && (
              <button className="primary small" onClick={() => navigate(`repertoire/${r.repId}`, { line: [...pathToDev, r.played!].join(' ') })}>
                Prepare an answer to {r.played}
              </button>
            )}
            {(r.kind === 'end-of-prep' || r.kind === 'you-deviated') && r.repId && (
              <button className="small" onClick={() => navigate(`repertoire/${r.repId}`, { line: pathToDev.join(' ') })}>
                Open position in repertoire
              </button>
            )}
          </div>
        </div>

        <div className="panel">
          <h3>Moves</h3>
          <LineView
            items={game.sans.map((san, i) => {
              const j = judged.get(i)?.judgement;
              return {
                san: j ? `${san}${JUDGEMENT_GLYPH[j]}` : san,
                className: [i === devPly ? 'deviation' : i < r.bookPlies ? 'book' : '', j ? `judged ${j}` : ''].join(' '),
                title: i === devPly ? 'You left your prep here' : i < r.bookPlies ? 'In your repertoire' : j ? j : undefined,
              };
            })}
            current={cur}
            onSelect={setCursor}
          />
          <p className="muted small" style={{ marginTop: 8 }}>
            Green moves were in your repertoire; the red outline is where you left it. Use ← → to step through.
          </p>
        </div>

        <GameReviewPanel
          game={game}
          positions={replay.positions}
          sans={game.sans}
          cursor={cur}
          onJump={setCursor}
          userColor={game.userColor}
          prepPly={devPly}
        />
      </div>
    </div>
  );
}

/** "Nov 16" this year, "Nov 16, 2025" before. */
function shortDate(ts: number): string {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: '2-digit' });
}
