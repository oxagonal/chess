import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Board } from './Board';
import { EnginePanel } from './EnginePanel';
import { MaterialBalance } from './MaterialBalance';
import { MoveTreeView } from './MoveTreeView';
import { moveNumberPrefix, opposite, playUci, type Color } from '../lib/chess';
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
}: {
  puzzle: LichessPuzzle;
  mode: 'write' | 'play';
  /** Counted toward your Lichess puzzle rating. */
  report: boolean;
  result?: { ratingDiff?: number; rated: boolean };
  error?: string;
  onResult: (win: boolean) => void;
  onNext: () => void;
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
              Your turn ({you === 'white' ? 'White' : 'Black'}). <b>Write your solution</b> on the board — your move, their best reply, your answer…
              — and at each of their turns their other sensible replies too. Nothing is checked until you say so.
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
    for (const uci of solution) id = id && tree.add(id, uci, 'solution');
    bump();
  };
  const finish = (win: boolean) => {
    setPhase('done');
    onResult(win);
  };

  /* ---- writing ---- */
  const open = mode === 'write' && phase === 'solve' ? unconsidered(tree, startId, only) : [];
  const writtenMain = tree.mainline(startId).filter((n) => n.tags.includes('mine'));
  const check = () => {
    const g = gradeWritten(tree, startId, solution);
    addSolution();
    if (g.win) {
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
    finish(g.win);
  };
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
  const forward = () => {
    const kids = tree.children(cursor);
    if (kids.length) setCursor(kids[0].id);
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
  const onOpen = open.includes(cursor);
  const hasMine = node.tags.includes('mine');
  return (
    <div className="board-layout puzzle-layout">
      <div className="board-col col puzzle-board">
        {strip(opposite(you))}
        <Board pos={node.pos} orientation={you} interactive={interactive} lastMove={node.uci || undefined} onMove={onMove} flash={flash} />
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
              {result?.rated && result.ratingDiff !== undefined && (
                <>
                  {' '}
                  · your Lichess rating{' '}
                  <b className={result.ratingDiff >= 0 ? 'good-text' : 'warn-text'}>
                    {result.ratingDiff >= 0 ? '+' : ''}
                    {result.ratingDiff}
                  </b>
                </>
              )}
              {result && !result.rated && <span className="muted"> · kept here only</span>}
            </div>
          )}
        </div>
        {error && <div className="error small">{error}</div>}
        <div className="panel col puzzle-tree" style={{ gap: 8 }}>
          <MoveTreeView tree={tree} cursor={cursor} onSelect={setCursor} wrong={wrong} />
          {mode === 'write' && phase === 'solve' && (
            <>
              {onOpen && (
                <div className="note small">
                  What else could they play here? Play it on the board — or{' '}
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
        <div className="row">
          {phase === 'done' && (
            <button className="primary" onClick={onNext}>
              Next puzzle →
            </button>
          )}
          <span className="spacer" />
          <a className="btn small" href={`${LICHESS}/training/${p.id}`} target="_blank" rel="noreferrer">
            On Lichess ↗
          </a>
        </div>
        <p className="muted small puzzle-note" style={{ margin: 0 }}>
          {report
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
