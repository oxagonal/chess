import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { DockviewApi, DockviewPanelApi } from 'dockview-react';
import type { Chess } from 'chessops/chess';
import { db } from '../db/db';
import { lineTarget, markForgotten } from '../db/repertoire';
import { sourcesOf } from '../lib/chapters';
import { saveAnnotation, saveLines } from '../db/annotations';
import { uid } from '../db/db';
import { PHONE_QUERY, useActivityClock, useAllGraphs, useMediaQuery } from '../hooks';
import { analyzeGame, PREP_LABEL, type PrepResult } from '../lib/prep';
import type { RepGraph } from '../lib/graph';
import { keyOf, opposite, playSan, playUci, startPos } from '../lib/chess';
import { biggestSwingsFor, formatEvalShort, JUDGEMENT_GLYPH, swings } from '../lib/review';
import {
  canPromote,
  deleteFromMove,
  deleteLosesNotes,
  glyphClass,
  glyphName,
  lineTree,
  moveGlyph,
  otherGlyphs,
  promoteLine,
  withSharedLineNote,
  type LineTreeNode,
  type SavedLine,
} from '../lib/annotations';
import { clocksAt, formatClock, formatMoveTime, moveTimes } from '../lib/clocks';
import { MaterialBalance } from '../components/MaterialBalance';
import { Board, type Arrow } from '../components/Board';
import { PhoneStudio } from '../components/PhoneStudio';
import { EvalBar } from '../components/EvalBar';
import { PositionMenuItems, PositionTools } from '../components/PositionTools';
import { MoveNote } from '../components/MoveNote';
import { MoveList, type SideNode } from '../components/MoveList';
import { EnginePanel } from '../components/EnginePanel';
import { ExplorerPanel } from '../components/ExplorerPanel';
import { ChaptersPanel } from '../components/ChaptersPanel';
import { GameReviewPanel } from '../components/GameReviewPanel';
import { TakeawaysPanel } from '../components/TakeawaysPanel';
import { AnnotationMenu, type AnnotationTarget } from '../components/AnnotationMenu';
import { annotateProps } from '../components/NotePopover';
import { Empty, MoreMenu, fmtDate } from '../components/ui';
import type { StudioPanelDef } from '../components/Studio';
import { href, navigate } from '../router';
import type { GameSource, StoredGame } from '../lib/types';

/** Outline piece symbols for the material balance (text presentation, never emoji). */

const Studio = lazy(() => import('../components/Studio').then((m) => ({ default: m.Studio })));

/** Where each game's review was left this session (move, side line, board flipped). */
const reviewPlaces = new Map<string, { cursor: number | null; flipped: boolean; sel: { id: string; at: number } | null }>();

function sourceName(source: GameSource): string {
  return source === 'lichess' ? 'Lichess' : source === 'chesscom' ? 'Chess.com' : 'Over the board';
}

/**
 * Reviewing one of your games: the studio (board, Stockfish, the game, its moves as a scoresheet,
 * the computer review, explorers), or one column on phones. The moves are always the game itself —
 * nothing you click changes them — and right-click (long-press on touch) annotates a move.
 */
export function GameReview({ id, initialPly }: { id: string; initialPly?: number }) {
  const game = useLiveQuery(() => db.games.get(id), [id]);
  const graphs = useAllGraphs();
  // Reviewing your games: the games third (the Plan tab), per game — for its review timer too.
  useActivityClock({ third: 'games', what: 'review', refId: id });
  const stacked = useMediaQuery('(max-width: 900px)');
  const phone = useMediaQuery(PHONE_QUERY);
  // Coming back to a game (e.g. from the builder) finds it where you left it.
  const place = `${id}|${initialPly ?? ''}`;
  const left = reviewPlaces.get(place);
  const [cursor, setCursor] = useState<number | null>(left ? left.cursor : (initialPly ?? null));
  const [flipped, setFlipped] = useState(left?.flipped ?? false);
  const [menu, setMenu] = useState<AnnotationTarget | null>(null);
  /** Phones: the card about your prep, closed with its ✕ until the board leaves that move. */
  const [prepClosed, setPrepClosed] = useState(false);
  const [layoutVersion, setLayoutVersion] = useState(0);
  /** Where the board is in a side line (`at` = moves into it), or null when it's on the game itself. */
  const [sel, setSel] = useState<{ id: string; at: number } | null>(left?.sel ?? null);
  useEffect(() => {
    reviewPlaces.set(place, { cursor, flipped, sel });
  }, [place, cursor, flipped, sel]);
  /** Side lines as just changed here, until the saved copy of the game catches up. */
  const [localLines, setLocalLines] = useState<SavedLine[] | null>(null);
  useEffect(() => {
    if (localLines && JSON.stringify(game?.lines ?? []) === JSON.stringify(localLines)) setLocalLines(null);
  }, [game?.lines, localLines]);
  const nav = useRef({ back: () => {}, forward: () => {}, start: () => {}, end: () => {} });
  const closeMenu = useCallback(() => setMenu(null), []);

  // Redone when the game's moves (or your repertoire) change — not when its notes, side lines or
  // computer review are saved, which happens as you go.
  const movesKey = game ? `${game.id}|${game.userColor}|${game.sans.join(' ')}` : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const result = useMemo(() => (game && graphs ? analyzeGame(game, graphs) : undefined), [movesKey, graphs]);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movesKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not with Ctrl / ⌘ / Alt: those are the browser's (Ctrl+F finds, Alt+← goes back).
      if (!replay || e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') nav.current.back();
      else if (e.key === 'ArrowRight') nav.current.forward();
      else if (e.key === 'Home') nav.current.start();
      else if (e.key === 'End') nav.current.end();
      else if (e.key === 'x' || e.key === 'X') setFlipped((f) => !f);
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
   * A move made on the board (or picked from Stockfish / the explorer), or several (a move further along
   * a Stockfish line). The game's own moves step forward; moves a side line already has follow it; at a
   * line's end the line goes on; anything else becomes a new side line (sharing the moves before it) —
   * nothing is ever thrown away.
   */
  const playLine = (moves: string[]) => {
    // One move at a time, exactly as if each were played on the board.
    let ls = lines;
    let place = { cur, sel: inLine ? { id: selLine.id, at } : null };
    let p = pos;
    for (const m of moves) {
      const r = playSan(p, m);
      if (!r) break;
      p = r.pos;
      const san = r.san;
      const line = place.sel && place.sel.at > 0 ? ls.find((l) => l.id === place.sel!.id) : undefined;
      const at = line ? place.sel!.at : 0;
      let from: number;
      let prefix: string[];
      if (!line) {
        if (replay.sans[place.cur] === san) {
          place = { cur: place.cur + 1, sel: null };
          continue;
        }
        from = place.cur;
        prefix = [];
      } else {
        if (line.sans[at] === san) {
          place = { ...place, sel: { id: line.id, at: at + 1 } };
          continue;
        }
        if (at === line.sans.length) {
          ls = ls.map((l) => (l.id === line.id ? { ...l, sans: [...l.sans, san] } : l));
          place = { ...place, sel: { id: line.id, at: at + 1 } };
          continue;
        }
        from = line.from;
        prefix = line.sans.slice(0, at);
      }
      const want = [...prefix, san];
      const existing = ls.find((l) => l.from === from && want.every((x, k) => l.sans[k] === x));
      if (existing) {
        place = { cur: from, sel: { id: existing.id, at: want.length } };
        continue;
      }
      // The shared moves keep their annotations in the new line.
      const notes = line ? Object.fromEntries(Object.entries(line.notes ?? {}).filter(([k]) => Number(k) < prefix.length)) : {};
      const added: SavedLine = { id: uid(), from, sans: want, ...(Object.keys(notes).length ? { notes } : {}) };
      ls = [...ls, added];
      place = { cur: from, sel: { id: added.id, at: want.length } };
    }
    if (ls !== lines) writeLines(ls);
    if (place.sel) {
      setCursor(place.cur);
      setSel(place.sel);
    } else goTo(place.cur);
  };
  const play = (move: { uci?: string; san?: string }) => {
    const played = move.uci ? playUci(pos, move.uci) : move.san ? playSan(pos, move.san) : undefined;
    if (played) playLine([played.san]);
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
  const strip = (color: 'white' | 'black') => (
    <div className={`player-strip ${pos.turn === color && cur < last ? 'to-move' : ''}`}>
      <span className={`strip-dot ${color}`} />
      <span className="keep-case strip-name">{color === 'white' ? game.white : game.black}</span>
      {(color === 'white' ? game.whiteElo : game.blackElo) ? <span className="muted small">{color === 'white' ? game.whiteElo : game.blackElo}</span> : null}
      {/* Like Lichess: the pieces each side is up, and +points for the side ahead. */}
      <MaterialBalance pos={pos} color={color} />
      <span className="spacer" />
      {shownClocks[color] !== undefined && <span className="strip-clock">{formatClock(shownClocks[color]!)}</span>}
    </div>
  );

  /* ------------------------------------------------------------ panels */

  const board = <Board pos={pos} orientation={orientation} interactive lastMove={lastMove} onMove={(uci) => play({ uci })} arrows={arrows} />;
  const navButtons = (
    <>
      <button onClick={() => goTo(0)} title="Start (Home)" aria-label="Start">
        ⏮
      </button>
      <button className="ps-step" onClick={() => nav.current.back()} title="Back (←)" aria-label="Back">
        ◀
      </button>
      <button className="ps-step" onClick={() => nav.current.forward()} title="Forward (→)" aria-label="Forward">
        ▶
      </button>
      <button onClick={() => goTo(last)} title="End (End)" aria-label="End">
        ⏭
      </button>
      <button onClick={() => setFlipped(!flipped)} title="Flip board (x)" aria-label="Flip board">
        ⇅
      </button>
    </>
  );
  const boardPane = (
    <>
      {strip(opposite(orientation))}
      <div className="board-fit">{board}</div>
      {strip(orientation)}
      <div className="row">
        {navButtons}
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
      <PositionTools pos={pos} ply={plyHere} orientation={orientation} />
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
            // Back in prep after a transposition: the move that rejoined it, and the moves played in it.
            const rj = r.rejoins?.find((x) => i >= x.ply && i <= x.ply + x.inBook);
            const leftAgain = r.rejoins?.find((x) => x.left?.kind === 'you-deviated' && x.left.ply === i);
            const titles = [
              i === devPly || leftAgain
                ? 'You left your prep here'
                : i < r.bookPlies
                  ? 'In your repertoire'
                  : rj?.ply === i
                    ? 'Back in your prep — the game transposed into it'
                    : rj
                      ? 'In your repertoire (back in prep)'
                      : '',
              mine ? glyphName(mine) : computer ? `Computer: ${computer}` : '',
              ...others.map(glyphName),
              clocks?.[i] !== undefined ? `${formatClock(clocks[i])} left${times[i] !== undefined ? ` · took ${formatMoveTime(times[i]!)}` : ''}` : '',
            ].filter(Boolean);
            return {
              san: `${san}${shown ?? ''}${others.length ? ` ${others.join(' ')}` : ''}`,
              className: [
                i === devPly || leftAgain ? 'deviation' : i < r.bookPlies || rj ? 'book' : '',
                rj?.ply === i ? 'rejoin' : '',
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
          // Lines tried here, as inline notation: each alternative in ( … ), later branches nested
          // where they split off. The board is on a move when the line you're in goes through it.
          sideTree={(i) => {
            const toNode = (n: LineTreeNode): SideNode => {
              const onIt = inLine && !!sel && n.through.includes(sel.id);
              const a = n.line.notes?.[String(n.index)];
              const mg = moveGlyph(a);
              const others = otherGlyphs(a);
              return {
                san: `${n.san}${mg ?? ''}${others.length ? ` ${others.join(' ')}` : ''}`,
                className: glyphClass(mg),
                current: onIt && n.index === at - 1,
                title: [mg ? glyphName(mg) : '', ...others.map(glyphName)].filter(Boolean).join(' · ') || undefined,
                comment: a?.comment,
                menu: annotateProps((x, y) => setMenu({ ply: n.line.from + n.index, san: n.san, x, y, lineId: n.line.id, index: n.index })),
                onSelect: () => {
                  setCursor(n.line.from);
                  // Stay in the line you're in where it goes through this move.
                  setSel({ id: onIt ? sel!.id : n.line.id, at: n.index + 1 });
                },
                next: n.next.map(toNode),
              };
            };
            return lineTree(lines.filter((l) => l.from === i)).map(toNode);
          }}
        />
      </div>
    </div>
  );

  // Where the game left your prep (or your prep ended), and the note on your prepared move: in the
  // Game panel — and on a phone, popping up when the board reaches that move.
  const prepOutcome = (popup = false) => (
    <>
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
        {r.rejoins?.map((x) => (
          <div key={x.ply} className="rejoin-note">
            <b>Back in your prep</b> after {moveNumber(x.ply)} {replay.sans[x.ply]} — the game transposed into it.{' '}
            {x.left?.kind === 'you-deviated' && (
              <>
                Then on move {moveNumber(x.left.ply)} you played <b>{x.left.played}</b>, but your repertoire says <b>{x.left.expected?.join(' or ')}</b>.
              </>
            )}
            {x.left?.kind === 'opponent-deviated' && (
              <>
                Then on move {moveNumber(x.left.ply)} {opp} played <b>{x.left.played}</b>, which your repertoire doesn't cover.
              </>
            )}
            {x.left?.kind === 'end-of-prep' && <>Your prep from there ran {Math.ceil(x.inBook / 2)} more move{x.inBook > 2 ? 's' : ''}.</>}
            {!x.left && <>It stayed in your prep to the end.</>}{' '}
            <button className="small ghost" onClick={() => goTo(x.ply + 1)}>
              Go there
            </button>
          </div>
        ))}
        <PrepActions game={game} r={r} graph={graph} />
      </div>
      {r.kind === 'you-deviated' &&
        r.key &&
        graph
          ?.childrenOf(r.key)
          .filter((m) => m.mine)
          // In the phone's pop-up the box doesn't grab the cursor: that would bring up the keyboard
          // every time the board passes the move.
          .map((m) => <MoveNote key={m.id} id={sourcesOf(m)[0]} san={m.san} label="(your prep)" compact prompt autoFocus={popup ? false : undefined} />)}
    </>
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
      {prepOutcome()}
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
  const engine = <EnginePanel fenKey={key} ply={plyHere} onPlay={(san) => play({ san })} onJump={playLine} />;
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
          ? // A move several lines share reads the same in all of them.
            writeLines(withSharedLineNote(lines, menuLine, menu.index!, next))
          : void saveAnnotation(game.id, menu.ply, next)
      }
      extra={
        <div className="row anno-actions">
          {menuLine && canPromote(lines, menuLine, menu.index!) && (
            <button
              className="small"
              title="List this variation first among the moves tried here (the game's own move stays the main line)"
              onClick={() => {
                writeLines(promoteLine(lines, menuLine, menu.index!));
                closeMenu();
              }}
            >
              ↑ Promote variation
            </button>
          )}
          {menuLine && (
            <button
              className="small danger"
              title="Delete this move and everything after it in the lines you tried (the game itself isn't changed)"
              onClick={() => {
                const i = menu.index!;
                if (deleteLosesNotes(lines, menuLine, i) && !confirm(`Delete ${menu.san} and what follows? Notes on those moves go too.`)) return;
                const r = deleteFromMove(lines, menuLine, i);
                writeLines(r.lines);
                // The board stays where the deleted move was played from.
                if (r.keep && i > 0) setSel({ id: r.keep.id, at: i });
                else {
                  setSel(null);
                  setCursor(menuLine.from);
                }
                closeMenu();
              }}
            >
              🗑 Delete from here
            </button>
          )}
          {/* The position after this move in your whole repertoire of this color, ready to add moves. */}
          <button
            className="small"
            title={`Open the position after this move with all your ${game.userColor === 'white' ? 'White' : 'Black'} chapters, to add your prep there`}
            onClick={() => {
              const sans = menuLine ? [...replay.sans.slice(0, menuLine.from), ...menuLine.sans.slice(0, menu.index! + 1)] : replay.sans.slice(0, menu.ply + 1);
              closeMenu();
              navigate(`repertoire/${game.userColor}`, { line: sans.join(' ') });
            }}
          >
            Open in all {game.userColor === 'white' ? 'White' : 'Black'}
          </button>
        </div>
      }
      onClose={closeMenu}
    />
  );

  // Your takeaways, what to work on, and "Done reviewing" (the ✓ on the Games tab).
  const takeaways = <TakeawaysPanel key={game.id} game={game} />;
  // Your chapters of this color — those with the game's position first — to open in the builder.
  const chapters = <ChaptersPanel color={game.userColor} line={replay.sans.slice(0, cur)} />;

  // Phones: the players and the board stay on screen; the moves, computer review, Stockfish,
  // explorer, your takeaways and the game's prep are tabs under it, the move buttons at the bottom.
  if (phone) {
    // What the game did with your prep matters at one move — where it left your prep (or your prep
    // ran out) — so instead of a tab it pops up over the tabs when the board gets there.
    const prepPly = devPly ?? (r.kind === 'end-of-prep' ? r.bookPlies : undefined);
    const atPrep = !inLine && prepPly !== undefined && cur === prepPly;
    // Closed for this visit: coming back to the move shows it again.
    if (prepClosed && !atPrep) setPrepClosed(false);
    const prepCard = atPrep && !prepClosed && (
      <>
        <button className="ghost small ps-popup-close" onClick={() => setPrepClosed(true)} aria-label="Close" title="Close (it comes back when you return to this move)">
          ✕
        </button>
        <div className="ps-popup-body">{prepOutcome(true)}</div>
      </>
    );
    return (
      <>
        <PhoneStudio
          page="review"
          className="review-phone"
          top={strip(opposite(orientation))}
          board={board}
          bottom={strip(orientation)}
          // (the computer review's evaluation of a game position until Stockfish has one)
          evalBar={<EvalBar fenKey={key} orientation={orientation} fallback={inLine ? undefined : (review?.evals[cur] ?? undefined)} />}
          // Stockfish at the top, like Chess.com
          engine={<EnginePanel top fenKey={key} ply={plyHere} onPlay={(san) => play({ san })} onJump={playLine} />}
          tabs={[
            { id: 'moves', label: 'Moves', content: movesPanel },
            { id: 'review', label: 'Review', content: reviewPanel },
            { id: 'explorer', label: 'Explorer', content: explorer },
            { id: 'notes', label: 'Notes', mark: game.reviewedAt ? <span className="ps-mark" title="Reviewed">✓</span> : undefined, content: takeaways },
          ]}
          popup={prepCard || undefined}
          controls={
            <>
              {navButtons}
              {/* The game itself: when and where it was played, and its links. */}
              <MoreMenu label="Game">
                <div className="menu-note muted small keep-case">
                  {fmtDate(game.playedAt)} · {sourceName(game.source)} {game.timeClass}
                  {game.event ? ` · ${game.event}` : ''} · {game.result}
                  {game.opening ? ` · ${game.opening}` : ''}
                </div>
                {game.url && <button onClick={() => window.open(game.url, '_blank', 'noreferrer')}>Open on {sourceName(game.source)} ↗</button>}
                {game.source === 'otb' && (
                  <>
                    <button onClick={() => navigate(`games/edit/${encodeURIComponent(game.id)}`)}>Edit game</button>
                    <button
                      className="danger"
                      onClick={async () => {
                        if (!confirm('Delete this game?')) return;
                        await db.games.delete(game.id);
                        navigate('games');
                      }}
                    >
                      Delete game…
                    </button>
                  </>
                )}
                <PositionMenuItems pos={pos} ply={plyHere} orientation={orientation} />
                <button onClick={() => navigate('games')}>All games</button>
              </MoreMenu>
            </>
          }
        />
        {annotationMenu}
      </>
    );
  }

  if (stacked) {
    return (
      <div className="review-stacked col">
        {gamePanel}
        <div className="board-col col">{boardPane}</div>
        {movesPanel}
        {reviewPanel}
        {engine}
        {takeaways}
        {annotationMenu}
      </div>
    );
  }

  const panels: StudioPanelDef[] = [
    // What you take from the game; it joins layouts saved before it existed, beside the computer review.
    { type: 'takeaways', title: 'Takeaways', joins: 'review', render: () => takeaways },
    { type: 'board', title: 'Board', render: () => <div className="board-pane">{boardPane}</div> },
    { type: 'stockfish', title: 'Stockfish', fitHeight: true, render: () => engine },
    { type: 'game', title: 'Game', fitHeight: true, render: () => gamePanel },
    { type: 'moves', title: 'Moves', render: () => movesPanel },
    { type: 'review', title: 'Computer review', render: () => reviewPanel },
    { type: 'explorer', title: 'Explorer', multiple: true, render: () => explorer },
    // Your chapters of this color — those with the game's position first — to open in the builder.
    { type: 'chapters', title: 'Chapters', render: () => chapters },
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
  // The game's own moves to where it left your prep (its move order, not the repertoire's).
  const pathToDev = r.ply !== undefined ? game.sans.slice(0, r.ply) : [];
  // Open it where it belongs: the chapter whose opening the line goes through, or all your chapters
  // of the color when that's unclear (adding a move there asks, or starts the right chapter).
  const open = async (sans: string[]) => navigate(`repertoire/${await lineTarget(game.userColor, sans)}`, { line: sans.join(' ') });
  const chapter = !!graph;
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
        <button className="primary small" onClick={() => void open([...pathToDev, r.played!])}>
          Prepare an answer to {r.played}
        </button>
      )}
      {(r.kind === 'end-of-prep' || r.kind === 'you-deviated') && chapter && (
        <button className="small" onClick={() => void open(pathToDev)}>
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
  add('chapters', 'Chapters', { referencePanel: 'review', direction: 'within' });
  add('takeaways', 'Takeaways', { referencePanel: 'review', direction: 'within' });
  api.getPanel('review')?.api.setActive();
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
