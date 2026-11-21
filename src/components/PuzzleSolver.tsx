import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Board, type Arrow, type SquareLabel } from './Board';
import { EnginePanel } from './EnginePanel';
import { MaterialBalance } from './MaterialBalance';
import { MoveTreeView } from './MoveTreeView';
import { isPromotion, legalDests, moveNumberPrefix, opposite, playUci, type Color } from '../lib/chess';
import { updateSettings, useSettings } from '../db/settings';
import { gradeWritten, MoveTree, unconsidered } from '../lib/moveTree';
import { judgeMove, type LichessPuzzle } from '../lib/puzzle';
import { tokenizeMoveText } from '../lib/pgn';

const LICHESS = 'https://lichess.org';

type Feedback = { kind: 'good' | 'bad' | 'info' | 'hint'; text: ReactNode } | null;

/** The puzzle's game as a tree, up to the opponent's move that sets it up. */
function buildTree(p: LichessPuzzle) {
  const tree = new MoveTree();
  let id = tree.root;
  for (const san of tokenizeMoveText(p.game.pgn).slice(0, p.puzzle.initialPly + 1)) {
    const next = tree.addSan(id, san, 'game');
    if (!next) break;
    id = next;
  }
  return { tree, startId: id, beforeId: tree.get(id).parent ?? tree.root, you: tree.get(id).pos.turn };
}

/**
 * One puzzle, worked through like a study. "Write" mode: before anything is checked you write your
 * solution on the board — your move, their reply, your answer — and at each of their turns their
 * other sensible replies as branches (or say there's only one): the part Lichess and Chess.com let
 * you skip. Then it's checked against the solution. "Play" mode: the moves are judged as you play
 * them, as on Lichess. Either way it ends on an analysis board: the game from move 1 with the players,
 * your lines and the solution in one tree, Stockfish, and any move you want to try.
 */
export function PuzzleSolver({
  puzzle,
  mode,
  report,
  result,
  error,
  onResult,
  onNext,
  hideRating = false,
  practice = false,
  nextLabel = 'Next puzzle →',
}: {
  puzzle: LichessPuzzle;
  mode: 'write' | 'play';
  /** Counted toward your Lichess puzzle rating. */
  report: boolean;
  result?: { ratingDiff?: number; rated: boolean };
  error?: string;
  onResult: (win: boolean) => void;
  onNext: () => void;
  /** During a block: your rating change waits for the end of it (play for learning, not rating). */
  hideRating?: boolean;
  /** Going over a miss again: nothing is recorded. */
  practice?: boolean;
  nextLabel?: string;
}) {
  const built = useMemo(() => buildTree(puzzle), [puzzle]);
  const { tree, startId, you } = built;
  const solution = puzzle.puzzle.solution;
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const [cursor, setCursor] = useState(built.beforeId);
  const [phase, setPhase] = useState<'solve' | 'done'>('solve');
  const [only, setOnly] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [flash, setFlash] = useState<'good' | 'bad' | null>(null);
  const [wrong, setWrong] = useState<string>();
  // Play mode: where the solution has got to, and whether a wrong move was played.
  const [tip, setTip] = useState(startId);
  const failed = useRef(false);
  // Writing: the board stays on the puzzle's position. A square you picked, a promotion to choose,
  // a word about a move that isn't legal, what you're typing, and a peek (which makes it a miss).
  const settings = useSettings();
  const [picked, setPicked] = useState<string>();
  const [promoAsk, setPromoAsk] = useState<{ from: string; to: string }>();
  const [notice, setNotice] = useState<string>();
  const [typed, setTyped] = useState('');
  const [peeking, setPeeking] = useState(false);
  const peeked = useRef(false);
  useEffect(() => {
    setPicked(undefined);
    setPromoAsk(undefined);
  }, [cursor]);
  // After a miss, the next puzzle waits until you've been through the solution, move by move.
  const [won, setWon] = useState<boolean>();
  const [solutionIds, setSolutionIds] = useState<string[]>([]);
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  useEffect(() => setVisited((v) => (v.has(cursor) ? v : new Set(v).add(cursor))), [cursor]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const later = (f: () => void, ms: number) => timers.current.push(setTimeout(f, ms));
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // The opponent's move that sets it up, then your turn.
  useEffect(() => {
    const t = setTimeout(() => {
      setCursor(startId);
      setFeedback({
        kind: 'info',
        text:
          mode === 'write' ? (
            <>
              Your turn ({you === 'white' ? 'White' : 'Black'}). <b>Write your solution without moving the pieces</b>: tap a piece's square, then
              where it goes — as things stand in your line (the board stays on the puzzle). Your move, their best reply, your answer… and at each
              of their turns their other sensible replies too. Nothing is checked until you say so.
            </>
          ) : (
            <>Your turn — find the best move for {you === 'white' ? 'White' : 'Black'}.</>
          ),
      });
    }, 450);
    return () => clearTimeout(t);
  }, [startId, mode, you]);

  const node = tree.get(cursor);
  const flashFor = (f: 'good' | 'bad') => {
    setFlash(f);
    later(() => setFlash(null), 550);
  };
  /** Lichess's solution, added to the tree (from the puzzle's start). */
  const addSolution = () => {
    let id: string | undefined = startId;
    const ids: string[] = [];
    for (const uci of solution) {
      id = id && tree.add(id, uci, 'solution');
      if (id) ids.push(id);
    }
    setSolutionIds(ids);
    bump();
  };
  const finish = (win: boolean) => {
    setPhase('done');
    setWon(win);
    if (!win && !solutionIds.length) addSolution();
    onResult(win);
  };

  /* ---- writing ---- */
  const open = mode === 'write' && phase === 'solve' ? unconsidered(tree, startId, only) : [];
  const writtenMain = tree.mainline(startId).filter((n) => n.tags.includes('mine'));
  const check = () => {
    const g = gradeWritten(tree, startId, solution);
    addSolution();
    if (g.win && peeked.current) {
      setFeedback({ kind: 'hint', text: <>Right — but you peeked, so it counts as missed. Next time, all in your head.</> });
    } else if (g.win) {
      setFeedback({ kind: 'good', text: <>✓ Right — your lines have the solution, their best defence included.</> });
      flashFor('good');
    } else if (g.wrongAt) {
      const at = tree.get(g.wrongAt.nodeId);
      const exp = playUci(at.pos, g.wrongAt.expected);
      const where = at.id === startId ? 'At the start' : `After ${moveNumberPrefix(at.ply - 1, true)}${at.san}`;
      const wrongChild = tree.children(at.id).find((k) => k.tags.includes('mine') && !k.tags.includes('solution'));
      setWrong(wrongChild?.id);
      setFeedback({
        kind: 'bad',
        text: g.wrongAt.yours ? (
          <>
            ✗ {where} the solution is <b>{exp?.san}</b>.
          </>
        ) : (
          <>
            ✗ {where} you didn't consider <b>{exp?.san}</b> — their best defence.
          </>
        ),
      });
      setCursor(at.id);
      flashFor('bad');
    }
    finish(g.win && !peeked.current);
  };

  /* ---- writing without moving the pieces ---- */
  const blind = mode === 'write' && phase === 'solve' && tree.isUnder(cursor, startId);
  const write = (uci: string) => {
    const id = tree.add(cursor, uci, 'mine');
    if (id) {
      setCursor(id);
      bump();
    }
  };
  const sideName = (c: Color) => (c === 'white' ? 'White' : 'Black');
  /** A tap on a square: pick a piece (as it stands in your line), then where it goes. */
  const tap = (sq: string) => {
    setNotice(undefined);
    const pos = node.pos;
    const dests = legalDests(pos);
    if (picked && sq === picked) return setPicked(undefined);
    if (picked && dests.get(picked)?.includes(sq)) {
      setPicked(undefined);
      if (isPromotion(pos, picked, sq)) return setPromoAsk({ from: picked, to: sq });
      return write(picked + sq);
    }
    if (dests.has(sq)) return setPicked(sq);
    setNotice(
      picked
        ? `${picked}–${sq} isn't legal as things stand in your line.`
        : `No ${sideName(pos.turn)} piece on ${sq} can move, as things stand in your line (${sideName(pos.turn)} to play).`,
    );
    setPicked(undefined);
  };
  const typeMove = () => {
    const san = typed.trim();
    if (!san) return;
    const id = tree.addSan(cursor, san, 'mine');
    if (!id) return setNotice(`${san} isn't legal as things stand in your line (${sideName(node.pos.turn)} to play).`);
    setTyped('');
    setNotice(undefined);
    setCursor(id);
    bump();
  };
  // Your line so far as arrows on the still board — yours green, theirs blue — each numbered in the
  // corner of the square it lands on.
  const linePath = blind ? tree.path(cursor).filter((n) => n.id !== startId && tree.isUnder(n.id, startId)) : [];
  const lineArrows: Arrow[] = linePath.map((n) => ({ uci: n.uci, brush: n.pos.turn === you ? 'blue' : 'green' }));
  const lineLabels: SquareLabel[] = [];
  linePath.forEach((n, i) => {
    const square = n.uci.slice(2, 4);
    const color = n.pos.turn === you ? '#2b5bb5' : '#1f8a2b';
    const same = lineLabels.find((l) => l.square === square);
    if (same) {
      same.text += `·${i + 1}`;
      same.color = color;
    } else lineLabels.push({ square, text: String(i + 1), color });
  });
  const shown = blind && !peeking ? tree.get(startId) : node;
  const giveUp = () => {
    addSolution();
    setFeedback({ kind: 'hint', text: 'The solution is in green — step through it, try other moves, ask Stockfish.' });
    setCursor(startId);
    finish(false);
  };

  /* ---- playing it out (play mode) ---- */
  const playMove = (uci: string) => {
    const step = node.ply - tree.get(startId).ply;
    const verdict = judgeMove(node.pos, solution, step, uci);
    if (verdict === 'wrong') {
      flashFor('bad');
      failed.current = true;
      setFeedback({ kind: 'bad', text: 'That’s not it — the puzzle counts as missed. Try again, or show the solution.' });
      return;
    }
    const id = tree.add(cursor, uci, 'solution')!;
    setCursor(id);
    setTip(id);
    bump();
    flashFor('good');
    if (verdict === 'solved') {
      setFeedback(failed.current ? { kind: 'hint', text: 'Solved — but after a miss, so it counts as missed.' } : { kind: 'good', text: '✓ Solved!' });
      finish(!failed.current);
      return;
    }
    setFeedback({ kind: 'good', text: '✓ Best move — keep going.' });
    later(() => {
      const reply = tree.add(id, solution[step + 1], 'solution');
      if (!reply) return;
      setCursor(reply);
      setTip(reply);
      bump();
    }, 350);
  };

  /* ---- the board ---- */
  const onMove = (uci: string) => {
    if (phase === 'done') {
      const id = tree.add(cursor, uci, 'explore');
      if (id) {
        setCursor(id);
        bump();
      }
      return;
    }
    if (mode === 'play') return playMove(uci);
    const id = tree.add(cursor, uci, 'mine');
    if (id) {
      setCursor(id);
      bump();
    }
  };
  const interactive =
    phase === 'done' || (mode === 'write' ? tree.isUnder(cursor, startId) : cursor === tip && node.pos.turn === you && cursor !== built.beforeId);

  /* ---- moving around ---- */
  const back = () => node.parent && setCursor(node.parent);
  // Once it's over, ▶ follows the solution where there's a choice.
  const forward = () => {
    const kids = tree.children(cursor);
    const next = (phase === 'done' && kids.find((k) => k.tags.includes('solution'))) || kids[0];
    if (next) setCursor(next.id);
  };
  const nav = useRef({ back, forward });
  nav.current = { back, forward };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement)?.closest('input, textarea, select')) return;
      if (e.key === 'ArrowLeft') nav.current.back();
      else if (e.key === 'ArrowRight') nav.current.forward();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The players, as on Lichess: name, title, rating — and which side you are.
  const strip = (c: Color) => {
    const pl = puzzle.game.players?.find((x) => x.color === c);
    return (
      <div className={`player-strip ${node.pos.turn === c ? 'to-move' : ''}`}>
        <span className={`strip-dot ${c}`} />
        <span className="strip-name keep-case">
          {pl?.title && <span className="title-badge">{pl.title}</span>}
          {pl?.name ?? (c === you ? 'White' : 'Black')}
        </span>
        {pl?.rating && <span className="muted small">{pl.rating}</span>}
        {c === you && <span className="badge">you</span>}
        <MaterialBalance pos={node.pos} color={c} />
      </div>
    );
  };

  const p = puzzle.puzzle;
  const seenSolution = solutionIds.filter((id) => visited.has(id)).length;
  const locked = phase === 'done' && won === false && seenSolution < solutionIds.length;
  const onOpen = open.includes(cursor);
  const hasMine = node.tags.includes('mine');
  return (
    <div className="board-layout puzzle-layout">
      <div className="board-col col puzzle-board">
        {strip(opposite(you))}
        <Board
          pos={shown.pos}
          orientation={you}
          interactive={interactive && !blind}
          lastMove={shown.uci || undefined}
          onMove={onMove}
          flash={flash}
          arrows={blind && !peeking && settings.puzzleArrows ? lineArrows : undefined}
          squareLabels={blind && !peeking && settings.puzzleArrows ? lineLabels : undefined}
          circles={blind && picked ? [{ square: picked, brush: 'yellow' }] : undefined}
          onSquareClick={blind && !peeking ? tap : undefined}
        />
        {strip(you)}
        <div className="row puzzle-nav">
          <button onClick={() => setCursor(tree.root)} aria-label="Start of the game" title="Start of the game">
            ⏮
          </button>
          <button onClick={back} aria-label="Back" title="Back (←)">
            ◀
          </button>
          <button onClick={forward} aria-label="Forward" title="Forward (→)">
            ▶
          </button>
          <button onClick={() => setCursor(startId)} title="The puzzle's position">
            Puzzle
          </button>
        </div>
      </div>
      <div className="col puzzle-side" style={{ gap: 10 }}>
        <div className={`feedback ${feedback?.kind ?? ''}`}>
          <div>{feedback?.text ?? '…'}</div>
          {phase === 'done' && (
            <div className="small" style={{ marginTop: 6 }}>
              Puzzle rated <b>{p.rating}</b>
              {p.themes.length > 0 && <span className="muted"> · {p.themes.slice(0, 4).join(', ')}</span>}
              {!hideRating && result?.rated && result.ratingDiff !== undefined && (
                <>
                  {' '}
                  · your Lichess rating{' '}
                  <b className={result.ratingDiff >= 0 ? 'good-text' : 'warn-text'}>
                    {result.ratingDiff >= 0 ? '+' : ''}
                    {result.ratingDiff}
                  </b>
                </>
              )}
              {hideRating && result?.rated && <span className="muted"> · rating change at the end of the block</span>}
              {!practice && result && !result.rated && <span className="muted"> · kept here only</span>}
              {practice && <span className="muted"> · going over it again (not recorded)</span>}
            </div>
          )}
        </div>
        {error && <div className="error small">{error}</div>}
        <div className="panel col puzzle-tree" style={{ gap: 8 }}>
          <MoveTreeView tree={tree} cursor={cursor} onSelect={setCursor} wrong={wrong} />
          {mode === 'write' && phase === 'solve' && (
            <>
              {blind && (
                <div className="row write-tools">
                  {promoAsk ? (
                    <span className="row" style={{ gap: 6 }}>
                      <span className="small">Promote to</span>
                      {(['q', 'n', 'r', 'b'] as const).map((r) => (
                        <button key={r} className="small" onClick={() => (setPromoAsk(undefined), write(promoAsk.from + promoAsk.to + r))}>
                          {{ q: 'Queen', n: 'Knight', r: 'Rook', b: 'Bishop' }[r]}
                        </button>
                      ))}
                    </span>
                  ) : (
                    <form
                      className="row"
                      style={{ gap: 6 }}
                      onSubmit={(e) => {
                        e.preventDefault();
                        typeMove();
                      }}
                    >
                      <input
                        className="type-move"
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        placeholder="or type it: Qh5+"
                        aria-label="Type a move"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        onKeyDown={(e) => e.stopPropagation()}
                      />
                    </form>
                  )}
                  <label className="check small" title="Show your line as numbered arrows on the board (off: all in your head)">
                    <input type="checkbox" checked={settings.puzzleArrows} onChange={(e) => void updateSettings({ puzzleArrows: e.target.checked })} />
                    Arrows
                  </label>
                  <span className="spacer" />
                  <button
                    className={`small ghost ${peeking ? 'primary' : ''}`}
                    title="Shows the position your line has reached while you hold it — the puzzle then counts as missed"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      peeked.current = true;
                      setPeeking(true);
                    }}
                    onPointerUp={() => setPeeking(false)}
                    onPointerLeave={() => setPeeking(false)}
                    onPointerCancel={() => setPeeking(false)}
                    onContextMenu={(e) => e.preventDefault()}
                  >
                    👁 Hold to peek
                  </button>
                </div>
              )}
              {notice && <div className="small warn-text">{notice}</div>}
              {peeked.current && <div className="muted small">You peeked: this puzzle counts as missed.</div>}
              {onOpen && (
                <div className="note small">
                  What else could they play here? Enter it — or{' '}
                  <button className="small" onClick={() => setOnly(new Set(only).add(cursor))}>
                    Only one sensible reply
                  </button>
                </div>
              )}
              <div className="row">
                <button className="primary" disabled={!writtenMain.length || open.length > 0} onClick={check}>
                  Check my solution
                </button>
                {hasMine && (
                  <button
                    className="small ghost"
                    onClick={() => {
                      const parent = node.parent!;
                      tree.remove(cursor);
                      setCursor(parent);
                      bump();
                    }}
                    title="Take back this move and what follows"
                  >
                    ✕ Take back
                  </button>
                )}
                <span className="spacer" />
                <button className="small ghost" onClick={giveUp}>
                  Show solution
                </button>
              </div>
              {open.length > 0 && writtenMain.length > 0 && (
                <div className="muted small">
                  Before checking — their other replies after:{' '}
                  {open.map((id, i) => {
                    const n = tree.get(id);
                    return (
                      <span key={id}>
                        {i > 0 && ', '}
                        <button className="linklike" onClick={() => setCursor(id)}>
                          {moveNumberPrefix(n.ply - 1, true)}
                          {n.san}
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
            </>
          )}
          {mode === 'play' && phase === 'solve' && (
            <div className="row">
              <span className="spacer" />
              <button className="small ghost" onClick={giveUp}>
                Show solution
              </button>
            </div>
          )}
        </div>
        {phase === 'done' && <EnginePanel fenKey={node.key} ply={node.ply} onPlay={(san) => onSan([san])} onJump={(sans) => onSan(sans)} />}
        {locked && (
          <div className="note small">
            Before the next puzzle, go through the solution: ▶ (or →) from the puzzle's position — {seenSolution} of {solutionIds.length}{' '}
            moves seen. A miss is worth more than a solve if you see why.
          </div>
        )}
        <div className="row">
          {phase === 'done' && (
            <button className="primary" onClick={onNext} disabled={locked} title={locked ? 'Step through the solution first' : undefined}>
              {nextLabel}
            </button>
          )}
          <span className="spacer" />
          <a className="btn small" href={`${LICHESS}/training/${p.id}`} target="_blank" rel="noreferrer">
            On Lichess ↗
          </a>
        </div>
        <p className="muted small puzzle-note" style={{ margin: 0 }}>
          {practice
            ? 'Going over a puzzle you missed: nothing is recorded or counted.'
            : report
            ? 'Counted toward your Lichess puzzle rating — the first time you play a puzzle, as on Lichess.'
            : 'Kept here only (with the time it took) — your Lichess rating isn’t touched.'}
        </p>
      </div>
    </div>
  );

  function onSan(sans: string[]) {
    let id: string | undefined = cursor;
    for (const san of sans) id = id && tree.addSan(id, san, 'explore');
    if (id) {
      setCursor(id);
      bump();
    }
  }
}
