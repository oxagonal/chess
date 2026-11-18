import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { DockviewApi, DockviewPanelApi } from 'dockview-react';
import type { Chess } from 'chessops/chess';
import { db } from '../db/db';
import { markForgotten } from '../db/repertoire';
import { chapterForLine, sourcesOf } from '../lib/chapters';
import { saveAnnotation, saveLines } from '../db/annotations';
import { uid } from '../db/db';
import { useAllGraphs, useMediaQuery } from '../hooks';
import { analyzeGame, PREP_LABEL, type PrepResult } from '../lib/prep';
import type { RepGraph } from '../lib/graph';
import { keyOf, opposite, playSan, playUci, startPos } from '../lib/chess';
import { biggestSwingsFor, formatEvalShort, JUDGEMENT_GLYPH, swings } from '../lib/review';
import { glyphClass, glyphName, moveGlyph, otherGlyphs, withLineNote, type SavedLine } from '../lib/annotations';
import { clocksAt, formatClock, formatMoveTime, moveTimes } from '../lib/clocks';
import { MATERIAL_ROLES, materialBalance, type MaterialRole } from '../lib/material';
import { Board, type Arrow } from '../components/Board';
import { MoveNote } from '../components/MoveNote';
import { MoveList } from '../components/MoveList';
import { EnginePanel } from '../components/EnginePanel';
import { ExplorerPanel } from '../components/ExplorerPanel';
import { GameReviewPanel } from '../components/GameReviewPanel';
import { AnnotationMenu, type AnnotationTarget } from '../components/AnnotationMenu';
import { annotateProps } from '../components/NotePopover';
import { Empty, fmtDate } from '../components/ui';
import type { StudioPanelDef } from '../components/Studio';
import { href, navigate } from '../router';
import type { GameSource, StoredGame } from '../lib/types';

/** Outline piece symbols for the material balance (text presentation, never emoji). */
const OUTLINE: Record<MaterialRole, string> = { queen: '♕\uFE0E', rook: '♖\uFE0E', bishop: '♗\uFE0E', knight: '♘\uFE0E', pawn: '♙\uFE0E' };

const Studio = lazy(() => import('../components/Studio').then((m) => ({ default: m.Studio })));

function sourceName(source: GameSource): string {
  return source === 'lichess' ? 'Lichess' : source === 'chesscom' ? 'Chess.com' : 'Over the board';
}

/**
 * Reviewing one of your games: the studio (board, Stockfish, the game, its moves as a scoresheet,
 * the computer review, explorers), or one column on phones. The moves are always the game itself —
 * nothing you click changes them — and right-click (long-press on touch) annotates a move.
 */
export function GameReview({ id }: { id: string }) {
  const game = useLiveQuery(() => db.games.get(id), [id]);
  const graphs = useAllGraphs();
  const stacked = useMediaQuery('(max-width: 900px)');
  const [cursor, setCursor] = useState<number | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [menu, setMenu] = useState<AnnotationTarget | null>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);
  /** Where the board is in a side line (`at` = moves into it), or null when it's on the game itself. */
  const [sel, setSel] = useState<{ id: string; at: number } | null>(null);
  /** Side lines as just changed here, until the saved copy of the game catches up. */
  const [localLines, setLocalLines] = useState<SavedLine[] | null>(null);
  useEffect(() => {
    if (localLines && JSON.stringify(game?.lines ?? []) === JSON.stringify(localLines)) setLocalLines(null);
  }, [game?.lines, localLines]);
  const nav = useRef({ back: () => {}, forward: () => {}, start: () => {}, end: () => {} });
  const closeMenu = useCallback(() => setMenu(null), []);

  const result = useMemo(() => (game && graphs ? analyzeGame(game, graphs) : undefined), [game, graphs]);
  const replay = useMemo(() => {
    if (!game) return undefined;
    let pos: Chess = startPos();
    const positions: Chess[] = [pos];
    const ucis: string[] = [];
    const sans: string[] = [];
    for (const s of game.sans) {
      const r = playSan(pos, s);
      if (!r) break;
      positions.push(r.pos);
      ucis.push(r.uci);
      sans.push(r.san);
      pos = r.pos;
    }
    return { positions, ucis, sans };
  }, [game]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!replay || (e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') nav.current.back();
      else if (e.key === 'ArrowRight') nav.current.forward();
      else if (e.key === 'Home') nav.current.start();
      else if (e.key === 'End') nav.current.end();
      else if (e.key === 'f') setFlipped((f) => !f);
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
  const last = replay.positions.length - 1;
  const cur = Math.min(cursor ?? devPly ?? Math.min(r.bookPlies, last), last);
  /** Go to a move of the game itself (side lines stay in the scoresheet). */
  const goTo = (ply: number) => {
    setCursor(Math.max(0, Math.min(last, ply)));
    setSel(null);
  };
  const graph = r.repId ? graphs.find((x) => x.rep.id === r.repId)?.graph : undefined;

  // Saved side lines (each leaves the game after `from` moves); the one the board is in, replayed.
  const lines = (localLines ?? game.lines ?? []).filter((l) => l.from <= last);
  const writeLines = (next: SavedLine[]) => {
    setLocalLines(next);
    void saveLines(game.id, next);
  };
  const selLine = sel ? lines.find((l) => l.id === sel.id) : undefined;
  const tried = selLine ? replayLine(replay.positions[selLine.from], selLine.sans) : undefined;
  const inLine = !!sel && !!selLine && !!tried && sel.at > 0;
  const at = inLine ? Math.min(sel.at, tried.positions.length - 1) : 0;
  const pos = inLine ? tried.positions[at] : replay.positions[cur];
  const lastMove = inLine ? tried.ucis[at - 1] : cur > 0 ? replay.ucis[cur - 1] : undefined;
  /** Moves played to reach the board's position (for move numbers). */
  const plyHere = inLine ? selLine.from + at : cur;

  /**
   * A move made on the board (or picked from Stockfish / the explorer). The game's own move steps
   * forward; a move a side line already has follows it; at a line's end the line goes on; anything
   * else becomes a new side line (sharing the moves before it) — nothing is ever thrown away.
   */
  const play = (move: { uci?: string; san?: string }) => {
    const played = move.uci ? playUci(pos, move.uci) : move.san ? playSan(pos, move.san) : undefined;
    if (!played) return;
    let from: number;
    let prefix: string[];
    if (!inLine) {
      if (replay.sans[cur] === played.san) return goTo(cur + 1);
      from = cur;
      prefix = [];
    } else {
      if (selLine.sans[at] === played.san) return setSel({ id: selLine.id, at: at + 1 });
      if (at === selLine.sans.length) {
        writeLines(lines.map((l) => (l.id === selLine.id ? { ...l, sans: [...l.sans, played.san] } : l)));
        return setSel({ id: selLine.id, at: at + 1 });
      }
      from = selLine.from;
      prefix = selLine.sans.slice(0, at);
    }
    const want = [...prefix, played.san];
    setCursor(from);
    const existing = lines.find((l) => l.from === from && want.every((san, k) => l.sans[k] === san));
    if (existing) return setSel({ id: existing.id, at: want.length });
    // The shared moves keep their annotations in the new line.
    const notes = inLine ? Object.fromEntries(Object.entries(selLine.notes ?? {}).filter(([k]) => Number(k) < prefix.length)) : {};
    const added: SavedLine = { id: uid(), from, sans: want, ...(Object.keys(notes).length ? { notes } : {}) };
    writeLines([...lines, added]);
    setSel({ id: added.id, at: want.length });
  };
  nav.current = {
    back: () => (inLine ? setSel({ id: selLine.id, at: at - 1 }) : goTo(cur - 1)),
    forward: () => (inLine ? at < selLine.sans.length && setSel({ id: selLine.id, at: at + 1 }) : goTo(cur + 1)),
    start: () => goTo(0),
    end: () => goTo(last),
  };
  const key = keyOf(pos);
  const opp = game.userColor === 'white' ? game.black : game.white;
  const orientation = flipped ? opposite(game.userColor) : game.userColor;

  // Arrows: where you left your prep (your prepared moves vs what was played), and at the computer's
  // swings the move played (red) vs the engine's choice (green).
  const review = game.review;
  const allSwings = review ? swings(review) : [];
  const judged = new Map(allSwings.filter((s) => s.judgement).map((s) => [s.ply, s]));
  const top = new Set(review ? [...biggestSwingsFor(review, game.userColor), ...biggestSwingsFor(review, opposite(game.userColor))].map((s) => s.ply) : []);
  const arrows: Arrow[] = [];
  if (inLine) {
    // (no game arrows while you try a line)
  } else if (devPly !== undefined && cur === devPly && graph && r.key) {
    for (const m of graph.childrenOf(r.key)) arrows.push({ uci: m.uci, brush: m.mine ? 'green' : 'paleBlue' });
    if (r.playedUci) arrows.push({ uci: r.playedUci, brush: 'red' });
  } else {
    const swingHere = judged.get(cur) ?? (top.has(cur) ? allSwings.find((s) => s.ply === cur) : undefined);
    if (swingHere && cur < replay.ucis.length) {
      arrows.push({ uci: replay.ucis[cur], brush: 'red' });
      if (swingHere.best && swingHere.best !== replay.ucis[cur]) arrows.push({ uci: swingHere.best, brush: 'green' });
    }
  }

  const annotation = (ply: number) => game.annotations?.[String(ply)];
  // Correspondence games (days per move) have no use for a clock.
  const clocks = game.clocks?.length && game.timeClass !== 'correspondence' ? game.clocks : undefined;
  const shownClocks = clocksAt(clocks, cur);
  // How long each move took, shown at the end of its row with a bar (longest move = full bar), like Chess.com.
  const times = moveTimes(clocks);
  const longest = Math.max(0, ...times.map((t) => t ?? 0));
  const timeAside = (i: number) => {
    if (!clocks) return undefined;
    const t = times[i];
    if (t === undefined) return null;
    return (
      <span className={`ml-time ${i % 2 ? 'black' : 'white'}`}>
        <span className="ml-time-bar" style={{ width: 2 + (longest ? (26 * t) / longest : 0) }} />
        {formatMoveTime(t)}
      </span>
    );
  };
  // The engine's eval of the position after each move, beside the move like Lichess.
  const evalAfter = (i: number) => {
    const e = review?.evals[i + 1];
    return e && !replay.sans[i].endsWith('#') ? formatEvalShort(e) : undefined;
  };
  // Like Lichess: the pieces each side is up (shown as the captured pieces) and +points for the side ahead.
  const material = materialBalance(pos);
  const strip = (color: 'white' | 'black') => (
    <div className={`player-strip ${pos.turn === color && cur < last ? 'to-move' : ''}`}>
      <span className={`strip-dot ${color}`} />
      <span className="keep-case strip-name">{color === 'white' ? game.white : game.black}</span>
      {(color === 'white' ? game.whiteElo : game.blackElo) ? <span className="muted small">{color === 'white' ? game.whiteElo : game.blackElo}</span> : null}
      {(material[color].up.length > 0 || material[color].plus > 0) && (
        <span className="material" title={material[color].plus ? `Up ${material[color].plus} in material` : 'Material'}>
          {MATERIAL_ROLES.filter((role) => material[color].up.includes(role)).map((role) => (
            <span key={role} className="mat-pieces" aria-hidden="true">
              {OUTLINE[role].repeat(material[color].up.filter((r) => r === role).length)}
            </span>
          ))}
          {material[color].plus > 0 && <span className="mat-plus">+{material[color].plus}</span>}
        </span>
      )}
      <span className="spacer" />
      {shownClocks[color] !== undefined && <span className="strip-clock">{formatClock(shownClocks[color]!)}</span>}
    </div>
  );

  /* ------------------------------------------------------------ panels */

  const boardPane = (
    <>
      {strip(opposite(orientation))}
      <div className="board-fit">
        <Board pos={pos} orientation={orientation} interactive lastMove={lastMove} onMove={(uci) => play({ uci })} arrows={arrows} />
      </div>
      {strip(orientation)}
      <div className="row">
        <button onClick={() => goTo(0)} title="Start (Home)" aria-label="Start">
          ⏮
        </button>
        <button onClick={() => nav.current.back()} title="Back (←)" aria-label="Back">
          ◀
        </button>
        <button onClick={() => nav.current.forward()} title="Forward (→)" aria-label="Forward">
          ▶
        </button>
        <button onClick={() => goTo(last)} title="End (End)" aria-label="End">
          ⏭
        </button>
        <button onClick={() => setFlipped(!flipped)} title="Flip board (f)" aria-label="Flip board">
          ⇅
        </button>
        {!stacked && (
          <button onClick={(e) => fitBoard(e.currentTarget)} title="Snap this pane to the board: no spare space around it">
            Fit
          </button>
        )}
        {devPly !== undefined && (
          <button className="small" onClick={() => goTo(devPly)}>
            Where you left prep
          </button>
        )}
      </div>
    </>
  );

  const movesPanel = (
    <div className="panel moves-panel review-moves">
      <div className="row moves-head">
        <h3 style={{ margin: 0 }}>Moves</h3>
        <span className="spacer" />
        <span className="muted small">Play on the board to try a line · {stacked ? 'long-press' : 'right-click'} a move to annotate it</span>
      </div>
      <div className="moves-body">
        <MoveList
          moves={replay.sans.map((san, i) => {
            const a = annotation(i);
            const mine = moveGlyph(a);
            const computer = judged.get(i)?.judgement;
            const shown = mine ?? (computer ? JUDGEMENT_GLYPH[computer] : undefined);
            const others = otherGlyphs(a);
            const titles = [
              i === devPly ? 'You left your prep here' : i < r.bookPlies ? 'In your repertoire' : '',
              mine ? glyphName(mine) : computer ? `Computer: ${computer}` : '',
              ...others.map(glyphName),
              clocks?.[i] !== undefined ? `${formatClock(clocks[i])} left${times[i] !== undefined ? ` · took ${formatMoveTime(times[i]!)}` : ''}` : '',
            ].filter(Boolean);
            return {
              san: `${san}${shown ?? ''}${others.length ? ` ${others.join(' ')}` : ''}`,
              className: [
                i === devPly ? 'deviation' : i < r.bookPlies ? 'book' : '',
                mine ? glyphClass(mine) : computer ? `${glyphClass(JUDGEMENT_GLYPH[computer])} computer` : '',
              ].join(' '),
              title: titles.join(' · ') || undefined,
              comment: a?.comment,
              extra: evalAfter(i),
              aside: timeAside(i),
              menu: annotateProps((x, y) => setMenu({ ply: i, san, x, y })),
            };
          })}
          current={inLine ? -1 : cur}
          onSelect={goTo}
          sideLines={(i) =>
            lines
              .filter((l) => l.from === i)
              .map((l) => ({
                key: l.id,
                moves: l.sans.map((san, j) => {
                  const a = l.notes?.[String(j)];
                  const mg = moveGlyph(a);
                  const others = otherGlyphs(a);
                  return {
                    san: `${san}${mg ?? ''}${others.length ? ` ${others.join(' ')}` : ''}`,
                    className: [inLine && sel?.id === l.id && j === at - 1 ? 'current' : '', glyphClass(mg)].join(' '),
                    title: [mg ? glyphName(mg) : '', ...others.map(glyphName)].filter(Boolean).join(' · ') || undefined,
                    comment: a?.comment,
                    menu: annotateProps((x, y) => setMenu({ ply: l.from + j, san, x, y, lineId: l.id, index: j })),
                  };
                }),
                onSelect: (j: number) => {
                  setCursor(l.from);
                  setSel({ id: l.id, at: j + 1 });
                },
                tail: (
                  <button
                    className="ghost small tried-remove"
                    title="Remove this line"
                    aria-label="Remove this line"
                    onClick={() => {
                      if (!confirm('Remove this side line?')) return;
                      writeLines(lines.filter((x) => x.id !== l.id));
                      if (sel?.id === l.id) setSel(null);
                    }}
                  >
                    ✕
                  </button>
                ),
              }))
          }
        />
      </div>
    </div>
  );

  const gamePanel = (
    <div className="panel col review-game" style={{ gap: 10 }}>
      <div>
        <div className="keep-case review-players">
          <b>{game.white}</b> {game.whiteElo ? <span className="muted">({game.whiteElo})</span> : null} – <b>{game.black}</b>{' '}
          {game.blackElo ? <span className="muted">({game.blackElo})</span> : null}
        </div>
        <div className="muted small">
          {fmtDate(game.playedAt)} · {sourceName(game.source)} {game.timeClass}
          {game.event ? ` · ${game.event}` : ''} · {game.result}
          {game.opening ? ` · ${game.opening}` : ''}{' '}
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
              On move {moveNumber(devPly!)} you played <b>{r.played}</b>, but your repertoire says <b>{r.expected?.join(' or ')}</b>.
            </>
          )}
          {r.kind === 'opponent-deviated' && (
            <>
              On move {moveNumber(devPly!)} {opp} played <b>{r.played}</b>, which your repertoire doesn't cover.
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
        <PrepActions game={game} r={r} graph={graph} />
      </div>
      {r.kind === 'you-deviated' &&
        r.key &&
        graph?.childrenOf(r.key).filter((m) => m.mine).map((m) => <MoveNote key={m.id} id={sourcesOf(m)[0]} san={m.san} label="(your prep)" compact prompt />)}
      <div className="row">
        <a href={href('games')} className="btn small">
          ← All games
        </a>
        {game.source === 'otb' && (
          <>
            <a className="btn small" href={href(`games/edit/${encodeURIComponent(game.id)}`)}>
              Edit game
            </a>
            <button
              className="small danger"
              onClick={async () => {
                if (!confirm('Delete this game?')) return;
                await db.games.delete(game.id);
                navigate('games');
              }}
            >
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );

  const reviewPanel = (
    <GameReviewPanel
      game={game}
      positions={replay.positions}
      sans={replay.sans}
      cursor={cur}
      onJump={goTo}
      userColor={game.userColor}
      opponentName={opp}
      prepPly={devPly}
    />
  );
  const engine = <EnginePanel fenKey={key} ply={plyHere} onPlay={(san) => play({ san })} />;
  // The explorer shows what's played here; picking a move plays it like a move on the board.
  const explorer = <ExplorerPanel fenKey={key} color={game.userColor} onPlay={(san) => play({ san })} />;
  const menuLine = menu?.lineId ? lines.find((l) => l.id === menu.lineId) : undefined;
  const annotationMenu = menu && (!menu.lineId || menuLine) && (
    <AnnotationMenu
      key={`${menu.lineId ?? 'game'}:${menu.ply}`}
      target={menu}
      annotation={menuLine ? menuLine.notes?.[String(menu.index)] : annotation(menu.ply)}
      onChange={(next) =>
        menuLine
          ? writeLines(lines.map((l) => (l.id === menuLine.id ? withLineNote(l, menu.index!, next) : l)))
          : void saveAnnotation(game.id, menu.ply, next)
      }
      onClose={closeMenu}
    />
  );

  if (stacked) {
    return (
      <div className="review-stacked col">
        {gamePanel}
        <div className="board-col col">{boardPane}</div>
        {movesPanel}
        {reviewPanel}
        {engine}
        {annotationMenu}
      </div>
    );
  }

  const panels: StudioPanelDef[] = [
    { type: 'board', title: 'Board', render: () => <div className="board-pane">{boardPane}</div> },
    { type: 'stockfish', title: 'Stockfish', fitHeight: true, render: () => engine },
    { type: 'game', title: 'Game', fitHeight: true, render: () => gamePanel },
    { type: 'moves', title: 'Moves', render: () => movesPanel },
    { type: 'review', title: 'Computer review', render: () => reviewPanel },
    { type: 'explorer', title: 'Explorer', multiple: true, render: () => explorer },
  ];
  return (
    <div className="builder studio review-studio">
      <div className="builder-head">
        <a href={href('games')} className="btn small">
          ← Games
        </a>
        <h1 className="keep-case">
          {game.white} – {game.black}
        </h1>
        <span className="muted small">{fmtDate(game.playedAt)}</span>
        <span className="spacer" />
        <button className="small ghost" onClick={() => setLayoutVersion((v) => v + 1)} title="Back to the standard arrangement of panels">
          Reset layout
        </button>
      </div>
      <div className="studio-wrap">
        <Suspense fallback={<div className="muted small">Loading the studio…</div>}>
          <Studio storageKey="review-studio-v2" panels={panels} defaultLayout={defaultReviewLayout} resetSignal={layoutVersion} />
        </Suspense>
      </div>
      {annotationMenu}
    </div>
  );
}

function moveNumber(ply: number): string {
  return `${Math.floor(ply / 2) + 1}${ply % 2 ? '…' : '.'}`;
}

function PrepActions({ game, r, graph }: { game: StoredGame; r: PrepResult; graph: RepGraph | undefined }) {
  const pathToDev = r.key && graph ? (graph.pathTo(r.key) ?? []).map((m) => m.san) : [];
  // Answers go in the chapter the game was following (graphs here are all of a color's chapters).
  const chapter = graph ? chapterForLine(graph, pathToDev) : undefined;
  return (
    <div className="row" style={{ marginTop: 8 }}>
      {r.kind === 'you-deviated' && r.repId && r.key && graph && (
        <button
          className="primary small"
          onClick={async () => {
            // A drill (not a review) so a move you never learned is included too; learned ones count as forgotten.
            await markForgotten(graph.childrenOf(r.key!).filter((m) => m.mine).map((m) => m.id), game.id);
            navigate('train', { rep: r.repId, mode: 'drill', at: r.key, t: String(Date.now()) });
          }}
        >
          Drill this move now
        </button>
      )}
      {r.kind === 'opponent-deviated' && chapter && (
        <button className="primary small" onClick={() => navigate(`repertoire/${chapter}`, { line: [...pathToDev, r.played!].join(' ') })}>
          Prepare an answer to {r.played}
        </button>
      )}
      {(r.kind === 'end-of-prep' || r.kind === 'you-deviated') && chapter && (
        <button className="small" onClick={() => navigate(`repertoire/${chapter}`, { line: pathToDev.join(' ') })}>
          Open position in repertoire
        </button>
      )}
    </div>
  );
}

/**
 * Like a Lichess study: the board in a full-height middle column, as big as the height allows; the
 * game and the computer review on the left; Stockfish and the moves on the right.
 */
function defaultReviewLayout(api: DockviewApi) {
  const add = (type: string, title: string, position?: Parameters<DockviewApi['addPanel']>[0]['position']) =>
    api.addPanel({ id: type, component: 'panel', title, params: { type }, ...(position ? { position } : {}) });
  add('board', 'Board');
  add('game', 'Game', { referencePanel: 'board', direction: 'left' });
  add('stockfish', 'Stockfish', { referencePanel: 'board', direction: 'right' });
  add('moves', 'Moves', { referencePanel: 'stockfish', direction: 'below' });
  add('review', 'Computer review', { referencePanel: 'game', direction: 'below' });
  // The board's pane: as wide as the board can be tall (tab bar, two player bars and the buttons
  // take ~130px), leaving at least 280px on each side.
  const board = Math.max(320, Math.min(api.height - 130, api.width - 2 * 280 - 16));
  const sides = api.width - (board + 16);
  api.getPanel('board')?.group.api.setSize({ width: board + 16 });
  api.getPanel('game')?.group.api.setSize({ width: Math.round(sides * 0.42) });
  api.getPanel('stockfish')?.group.api.setSize({ height: 160 });
  api.getPanel('game')?.group.api.setSize({ height: Math.round(api.height * 0.45) });
}

/** Snap the board's pane to the board (see the builder's Fit button). */
function fitBoard(from: HTMLElement) {
  const fit = from.closest('.studio-body')?.querySelector('.board-fit') as HTMLElement | null;
  const api = (from.closest('.studio-body') as (HTMLElement & { __dvPanelApi?: DockviewPanelApi }) | null)?.__dvPanelApi;
  if (!fit || !api) return;
  const { clientWidth: w, clientHeight: h } = fit;
  if (Math.abs(w - h) > 2) api.group.api.setSize({ width: api.group.api.width + (h - w) });
}

/** A side line's positions and moves, from where it leaves the game (stops at an illegal move). */
function replayLine(start: Chess, sans: string[]): { positions: Chess[]; ucis: string[] } {
  const positions: Chess[] = [start];
  const ucis: string[] = [];
  for (const san of sans) {
    const p = playSan(positions[positions.length - 1], san);
    if (!p) break;
    positions.push(p.pos);
    ucis.push(p.uci);
  }
  return { positions, ucis };
}
