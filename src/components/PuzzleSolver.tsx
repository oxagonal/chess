import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useBoardScale } from './BoardGrip';
import { Board, type Arrow, type SquareLabel } from './Board';
import { EnginePanel } from './EnginePanel';
import { MaterialBalance } from './MaterialBalance';
import { MoveTreeView } from './MoveTreeView';
import { isPromotion, legalDests, moveNumberPrefix, opposite, playUci, type Color } from '../lib/chess';
import { updateSettings, useSettings } from '../db/settings';
import { gradeWritten, MoveTree, sameAnswer } from '../lib/moveTree';
import { judgeMove, type LichessPuzzle } from '../lib/puzzle';
import { tokenizeMoveText } from '../lib/pgn';
import { clock as fmtClock } from '../lib/quickReview';
import { MISS_REASONS, type MissReason } from '../lib/tacticCards';
import { parseSquare } from 'chessops/util';
import { PHONE_QUERY, useMediaQuery } from '../hooks';

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
 * line to the end — your moves and their best replies (Studer: "any solution not written down until
 * the end is not correct"); other replies are optional branches. Then it's checked against the
 * solution, and a reply of theirs you didn't write is played for you to answer on the spot. "Play"
 * mode: the moves are judged as you play them, as on Lichess. Either way it ends on an analysis board: the game from move 1 with the players,
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
  review = false,
  onReason,
  nextLabel = 'Next puzzle →',
  timer,
  judgeAlt,
  gameNote,
}: {
  puzzle: LichessPuzzle;
  mode: 'write' | 'play';
  /** Counted toward your Lichess puzzle rating. */
  report: boolean;
  result?: { ratingDiff?: number; rated: boolean };
  error?: string;
  /** The result: solved or not — `soft` when solved by finding a reply you hadn't written, on the spot. */
  onResult: (win: boolean, soft?: boolean) => void;
  onNext: () => void;
  /** During a block: your rating change waits for the end of it (play for learning, not rating). */
  hideRating?: boolean;
  /** A puzzle you missed before, solved again (a card): not sent to Lichess. */
  review?: boolean;
  /** Missed: why (the tap afterwards). */
  onReason?: (r: MissReason) => void;
  nextLabel?: string;
  /** The time on this puzzle (while the app is on screen) and your budget per puzzle. */
  timer?: { elapsed: () => number; budgetMs: number };
  /**
   * A position from your game: whether a first move that isn't the engine's holds up too (your games
   * aren't curated puzzles — another good move counts).
   */
  judgeAlt?: (fromKey: string, uci: string) => Promise<boolean>;
  /** Shown once it's over: what you played in the game. */
  gameNote?: ReactNode;
}) {
  const built = useMemo(() => buildTree(puzzle), [puzzle]);
  const { tree, startId, you } = built;
  const solution = puzzle.puzzle.solution;
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const [cursor, setCursor] = useState(built.beforeId);
  /**
   * Go to a move (the list, ◀ ▶). While you write, that's only where your next move goes: the board
   * stays on the puzzle (your line up to there is drawn as arrows); afterwards the board shows it.
   */
  const go = (id: string) => setCursor(id);
  // Writing (or playing), then — when your lines missed one of their replies — Lichess's line played
  // through to it, for you to answer on the spot; then the study.
  const [phase, setPhase] = useState<'solve' | 'replay' | 'done'>('solve');
  /** The replay has reached the reply you didn't write: your move. */
  const [replayReady, setReplayReady] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [flash, setFlash] = useState<'good' | 'bad' | null>(null);
  const [wrong, setWrong] = useState<string>();
  // Play mode: where the solution has got to, and whether a wrong move was played.
  const [tip, setTip] = useState(startId);
  const failed = useRef(false);
  // Writing: the board stays on the puzzle's position. A square you picked, a promotion to choose,
  // a word about a move that isn't legal, and what you're typing.
  const settings = useSettings();
  const phone = useMediaQuery(PHONE_QUERY);
  const boardSize = useBoardScale('puzzles');
  const [picked, setPicked] = useState<string>();
  const [promoAsk, setPromoAsk] = useState<{ from: string; to: string }>();
  const [notice, setNotice] = useState<string>();
  const [info, setInfo] = useState<string>();
  const [typed, setTyped] = useState('');
  useEffect(() => {
    setPicked(undefined);
    setPromoAsk(undefined);
    setInfo(undefined);
  }, [cursor]);
  // After a miss: why (one tap), then you replay the solution yourself — your moves, their replies
  // played for you — before the next puzzle. Doing it beats watching it.
  const [won, setWon] = useState<boolean>();
  const [relearn, setRelearn] = useState<'todo' | 'active' | 'done'>('todo');
  const [hint, setHint] = useState<string>();
  const [reason, setReason] = useState<MissReason>();
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
          mode === 'write' && phone ? (
            <>
              Your turn ({you === 'white' ? 'White' : 'Black'}). <b>Write your line to the end</b> — tap or drag each move as things stand in your
              line (the board stays put), or type it.
            </>
          ) : mode === 'write' ? (
            <>
              Your turn ({you === 'white' ? 'White' : 'Black'}). <b>Write your line to the end without moving the pieces</b>: tap a piece's square,
              then where it goes, as things stand in your line (the board stays on the puzzle) — your moves and their best replies, until the
              outcome is clear. Other replies are optional. Nothing is checked until you say so.
            </>
          ) : (
            <>Your turn — find the best move for {you === 'white' ? 'White' : 'Black'}.</>
          ),
      });
    }, 450);
    return () => clearTimeout(t);
  }, [startId, mode, you, phone]);

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
  const finish = (win: boolean, soft = false) => {
    setPhase('done');
    setWon(win);
    if (!win) addSolution();
    onResult(win, soft);
  };

  /* ---- writing ---- */
  const writtenMain = tree.mainline(startId).filter((n) => n.tags.includes('mine'));
  const [checking, setChecking] = useState(false);
  // "Show solution" asks first: it ends the puzzle as a miss, and it sits next to the arrows.
  const [confirmGiveUp, setConfirmGiveUp] = useState(false);
  useEffect(() => setConfirmGiveUp(false), [cursor]);
  /** Your game's position: a first move that isn't the engine's, checked with Stockfish. */
  const altHolds = async (uci: string, san: string): Promise<boolean> => {
    if (!judgeAlt) return false;
    setChecking(true);
    setFeedback({ kind: 'info', text: <>Checking {san} with Stockfish…</> });
    const ok = await judgeAlt(tree.get(startId).key, uci).catch(() => false);
    setChecking(false);
    if (ok) {
      const best = playUci(tree.get(startId).pos, solution[0]);
      addSolution();
      setFeedback({
        kind: 'good',
        text: (
          <>
            ✓ Good — {san} holds up too. The engine's choice was <b>{best?.san}</b>.
          </>
        ),
      });
      flashFor('good');
    }
    return ok;
  };
  const check = async () => {
    const g = gradeWritten(tree, startId, solution);
    if (!g.win && g.wrongAt?.yours && g.wrongAt.nodeId === startId && judgeAlt) {
      const first = tree.children(startId).find((k) => k.tags.includes('mine'));
      if (first && (await altHolds(first.uci, first.san))) return finish(true);
    }
    if (g.win) {
      addSolution();
      setFeedback({ kind: 'good', text: <>✓ Right — your lines have the solution, their best defence included.</> });
      flashFor('good');
      return finish(true);
    }
    if (!g.wrongAt) return;
    // A reply of theirs you didn't write: play Lichess's line through to it, and you answer it here.
    if (!g.wrongAt.yours) return replayTo(g.wrongAt.nodeId);
    addSolution();
    const at = tree.get(g.wrongAt.nodeId);
    const exp = playUci(at.pos, g.wrongAt.expected);
    const where = at.id === startId ? 'At the start' : `After ${moveNumberPrefix(at.ply - 1, true)}${at.san}`;
    const wrongChild = tree.children(at.id).find((k) => k.tags.includes('mine') && !k.tags.includes('solution'));
    setWrong(wrongChild?.id);
    setFeedback({
      kind: 'bad',
      text: (
        <>
          ✗ {where} the solution is <b>{exp?.san}</b>.
        </>
      ),
    });
    setCursor(at.id);
    flashFor('bad');
    finish(false);
  };

  /* ---- Lichess's line, through to the reply you didn't write ---- */
  const replayTo = (missedAt: string) => {
    setPhase('replay');
    setReplayReady(false);
    setFeedback({ kind: 'info', text: <>Lichess's line…</> });
    const steps: string[] = [];
    let id = startId;
    for (const uci of solution) {
      const before = id;
      const next = tree.add(id, uci, 'solution');
      if (!next) break;
      steps.push(next);
      id = next;
      if (before === missedAt) break;
    }
    bump();
    setCursor(startId);
    steps.forEach((step, i) => later(() => go(step), 500 * (i + 1)));
    const reply = tree.get(id);
    later(() => {
      setTip(id);
      setReplayReady(true);
      setFeedback({
        kind: 'hint',
        text: (
          <>
            You didn't write {moveNumberPrefix(reply.ply - 1, true)}
            <b>{reply.san}</b>. What do you play? Find it here and it still counts — a soft pass.
          </>
        ),
      });
    }, 500 * steps.length + 300);
  };
  const replayMove = (uci: string) => {
    const step = node.ply - tree.get(startId).ply;
    const verdict = judgeMove(node.pos, solution, step, uci);
    if (verdict === 'wrong') {
      const exp = playUci(node.pos, solution[step]);
      addSolution();
      setFeedback({
        kind: 'bad',
        text: (
          <>
            ✗ Here the solution is <b>{exp?.san}</b> — that reply needed answering.
          </>
        ),
      });
      flashFor('bad');
      return finish(false);
    }
    const id = tree.add(cursor, uci, 'solution')!;
    go(id);
    setTip(id);
    bump();
    flashFor('good');
    if (verdict === 'solved') {
      setFeedback({ kind: 'good', text: <>✓ Solved — you hadn't written their reply, but you found the answer here, so it counts (a soft pass).</> });
      return finish(true, true);
    }
    setFeedback({ kind: 'good', text: '✓ Right — keep going.' });
    setReplayReady(false);
    later(() => {
      const reply = tree.add(id, solution[step + 1], 'solution');
      if (!reply) return;
      go(reply);
      setTip(reply);
      bump();
      setReplayReady(true);
    }, 400);
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
  /** A move from one square to another, as things stand in your line (false: not legal there). */
  const tryMove = (from: string, to: string): boolean => {
    const pos = node.pos;
    if (!legalDests(pos).get(from)?.includes(to)) return false;
    setPicked(undefined);
    if (isPromotion(pos, from, to)) setPromoAsk({ from, to });
    else write(from + to);
    return true;
  };
  /** Dragged on the board (like drawing an arrow): that move. */
  const drag = (from: string, to: string) => {
    setNotice(undefined);
    if (!tryMove(from, to)) setNotice(`${from}–${to} isn't legal as things stand in your line (${sideName(node.pos.turn)} to play).`);
  };
  /** A tap on a square: pick a piece (as it stands in your line), then where it goes. */
  const tap = (sq: string) => {
    setNotice(undefined);
    const pos = node.pos;
    const dests = legalDests(pos);
    if (picked && sq === picked) return setPicked(undefined);
    if (picked && tryMove(picked, sq)) return;
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
  const shown = blind ? tree.get(startId) : node;

  // "Same answer to…": at your answer to one of their moves, write it against their other moves too.
  const theirMove = blind && node.tags.includes('mine') && node.pos.turn !== you && node.parent ? tree.get(node.parent) : undefined;
  const answerable = !!theirMove?.parent && tree.isUnder(theirMove.parent, startId);
  const movedPiece = theirMove && answerable ? tree.get(theirMove.parent!).pos.board.get(parseSquare(theirMove.uci.slice(0, 2))!)?.role : undefined;
  const writeSameAnswer = (scope: 'piece' | 'all') => {
    const { added, skipped } = sameAnswer(tree, cursor, scope);
    bump();
    setNotice(undefined);
    const what = scope === 'piece' ? `${movedPiece} move${added.length === 1 ? '' : 's'}` : `repl${added.length === 1 ? 'y' : 'ies'}`;
    setInfo(
      `${node.san} against ${added.length ? `${added.length} more ${what}` : `no other ${scope === 'piece' ? `${movedPiece} moves` : 'replies'}`}` +
        (skipped.length ? `. Not possible after ${skipped.join(', ')} — think about ${skipped.length === 1 ? 'that one' : 'those'}.` : '.'),
    );
  };
  const giveUp = () => {
    setConfirmGiveUp(false);
    addSolution();
    setFeedback({ kind: 'hint', text: 'The solution is in green — step through it, try other moves, ask Stockfish.' });
    setCursor(startId);
    finish(false);
  };

  /* ---- playing it out (play mode) ---- */
  const playMove = async (uci: string) => {
    const step = node.ply - tree.get(startId).ply;
    const verdict = judgeMove(node.pos, solution, step, uci);
    if (verdict === 'wrong' && step === 0 && judgeAlt && !failed.current) {
      const played = playUci(node.pos, uci);
      if (played && (await altHolds(uci, played.san))) {
        const id = tree.add(cursor, uci, 'mine')!;
        setCursor(id);
        setTip(id);
        bump();
        return finish(true);
      }
    }
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

  /* ---- after a miss: replaying the solution yourself ---- */
  const startRelearn = () => {
    setRelearn('active');
    setHint(undefined);
    setCursor(startId);
    setTip(startId);
    setFeedback({ kind: 'info', text: <>Play the solution — your moves; their replies come by themselves.</> });
  };
  const relearnMove = (uci: string) => {
    const step = node.ply - tree.get(startId).ply;
    const verdict = judgeMove(node.pos, solution, step, uci);
    if (verdict === 'wrong') {
      const exp = playUci(node.pos, solution[step]);
      setHint(solution[step]);
      flashFor('bad');
      setFeedback({
        kind: 'bad',
        text: (
          <>
            Not that one — it's <b>{exp?.san}</b>. Play it.
          </>
        ),
      });
      return;
    }
    const id = tree.add(cursor, uci, 'solution')!;
    setCursor(id);
    setTip(id);
    setHint(undefined);
    bump();
    flashFor('good');
    if (verdict === 'solved' || step + 1 >= solution.length) {
      setRelearn('done');
      setFeedback({ kind: 'good', text: <>✓ That's the solution. It comes back tomorrow, to solve again from scratch.</> });
      return;
    }
    setFeedback({ kind: 'good', text: '✓ Right — on.' });
    later(() => {
      const reply = tree.add(id, solution[step + 1], 'solution');
      if (!reply) return;
      setCursor(reply);
      setTip(reply);
      bump();
    }, 400);
  };

  /* ---- the board ---- */
  const onMove = (uci: string) => {
    if (phase === 'done' && relearn === 'active') return relearnMove(uci);
    if (phase === 'done') {
      const id = tree.add(cursor, uci, 'explore');
      if (id) {
        setCursor(id);
        bump();
      }
      return;
    }
    if (phase === 'replay') return replayMove(uci);
    if (mode === 'play') return playMove(uci);
    const id = tree.add(cursor, uci, 'mine');
    if (id) {
      setCursor(id);
      bump();
    }
  };
  const relearning = phase === 'done' && relearn === 'active';
  const interactive =
    !checking &&
    ((phase === 'done' && (!relearning || (cursor === tip && node.pos.turn === you))) ||
    (phase === 'replay'
      ? replayReady && cursor === tip && node.pos.turn === you
      : mode === 'write'
        ? tree.isUnder(cursor, startId)
        : cursor === tip && node.pos.turn === you && cursor !== built.beforeId));

  /* ---- moving around ---- */
  const back = () => node.parent && go(node.parent);
  // Once it's over, ▶ follows the solution where there's a choice.
  const forward = () => {
    const kids = tree.children(cursor);
    const next = (phase === 'done' && kids.find((k) => k.tags.includes('solution'))) || kids[0];
    if (next) go(next.id);
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
  const strip = (c: Color, extra?: ReactNode) => {
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
        {extra}
      </div>
    );
  };

  const p = puzzle.puzzle;
  // A miss: the next puzzle waits until you've replayed the solution.
  const locked = phase === 'done' && won === false && relearn !== 'done';
  const hasMine = node.tags.includes('mine');

  /* ---- the pieces, laid out for a computer or a phone below ---- */
  const clockEl = timer && <PuzzleClock timer={timer} running={phase !== 'done'} compact={phone} />;
  const boardEl = (
    <Board
      pos={shown.pos}
      orientation={you}
      interactive={interactive && !blind}
      lastMove={shown.uci || undefined}
      onMove={onMove}
      flash={flash}
      arrows={blind && settings.puzzleArrows ? lineArrows : relearning && hint ? [{ uci: hint, brush: 'green' }] : undefined}
      squareLabels={blind && settings.puzzleArrows ? lineLabels : undefined}
      circles={blind && picked ? [{ square: picked, brush: 'yellow' }] : undefined}
      onSquareClick={blind ? tap : undefined}
      onSquareDrag={blind ? drag : undefined}
    />
  );
  const feedbackEl = (
        <div className={`feedback ${feedback?.kind ?? ''}`}>
          <div>{feedback?.text ?? '…'}</div>
          {phase === 'done' && gameNote && <div className="small" style={{ marginTop: 6 }}>{gameNote}</div>}
          {phase === 'done' && !gameNote && (
            <div className="small" style={{ marginTop: 6 }}>
              Puzzle rated <b>{p.rating}</b>
              {p.themes.length > 0 && <span className="muted puzzle-themes"> · {p.themes.slice(0, 4).join(', ')}</span>}
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
              {!review && result && !result.rated && <span className="muted"> · kept here only</span>}
              {review && <span className="muted"> · a puzzle you missed before (not rated)</span>}
            </div>
          )}
        </div>
  );
  const writeTools = mode === 'write' && phase === 'solve' && (
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
                </div>
              )}
              {theirMove && answerable && (
                <div className="row same-answer">
                  <span className="small muted">Same answer ({node.san}) to</span>
                  {movedPiece && (
                    <button className="small" onClick={() => writeSameAnswer('piece')} title={`Write ${node.san} against every other ${movedPiece} move too`}>
                      every {movedPiece} move
                    </button>
                  )}
                  <button className="small" onClick={() => writeSameAnswer('all')} title={`Write ${node.san} against every other legal reply too`}>
                    every other reply
                  </button>
                </div>
              )}
              {notice && <div className="small warn-text">{notice}</div>}
              {info && !notice && <div className="small muted">{info}</div>}
    </>
  );
  const takeBack = mode === 'write' && phase === 'solve' && hasMine && (
    <button
      className="small ghost"
      onClick={() => {
        const parent = node.parent!;
        tree.remove(cursor);
        setCursor(parent);
        bump();
      }}
      title="Take back this move and what follows"
      aria-label="Take back"
    >
      {phone ? '✕' : '✕ Take back'}
    </button>
  );
  const checkBtn = mode === 'write' && phase === 'solve' && (
    <button className="primary" disabled={!writtenMain.length || checking} onClick={check} title="When you've written your line to the end">
      {phone ? 'Check' : 'Check my solution'}
    </button>
  );
  const showSolutionBtn = phase === 'solve' && !confirmGiveUp && (
    <button className="small ghost" onClick={() => setConfirmGiveUp(true)}>
      Show solution
    </button>
  );
  const giveUpConfirm = phase === 'solve' && confirmGiveUp && (
    <div className="row give-up-confirm">
      <span className="small">Show the solution? It counts as a miss.</span>
      <span className="spacer" />
      <button className="small" onClick={() => setConfirmGiveUp(false)} autoFocus>
        Keep trying
      </button>
      <button className="small danger-ghost" onClick={giveUp}>
        Yes, show it
      </button>
    </div>
  );
  const replayBtn = phase === 'done' && won === false && relearn === 'todo' && (
    <button className="primary" onClick={startRelearn} title="You play your moves, their replies come by themselves — doing it sticks better than watching">
      Replay the solution
    </button>
  );
  const nextBtn = phase === 'done' && (
    <button className="primary" onClick={onNext} disabled={locked} title={locked ? 'Replay the solution first' : undefined}>
      {nextLabel}
    </button>
  );
  const lichessLink = (
    <a className="btn small" href={`${LICHESS}/training/${p.id}`} target="_blank" rel="noreferrer">
      On Lichess ↗
    </a>
  );
  const missReview =
    phase === 'done' && won === false && (
          <div className="panel col miss-review" style={{ gap: 8 }}>
            {onReason && (
              <div className="row reason-chips">
                <span className="small">Why did you miss it?</span>
                {MISS_REASONS.map((r) => (
                  <button
                    key={r.key}
                    className={`small chip ${reason === r.key ? 'active' : ''}`}
                    title={r.tip}
                    onClick={() => {
                      setReason(r.key);
                      onReason(r.key);
                    }}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            )}
            {reason && <div className="small muted">{MISS_REASONS.find((r) => r.key === reason)!.tip}</div>}
            {relearn === 'todo' && !phone && (
              <div className="row">
                <button className="primary" onClick={startRelearn}>
                  Replay the solution
                </button>
                <span className="muted small">You play your moves, their replies come by themselves — doing it sticks better than watching.</span>
              </div>
            )}
          </div>
        );
  const engineEl = phase === 'done' && <EnginePanel fenKey={node.key} ply={node.ply} onPlay={(san) => onSan([san])} onJump={(sans) => onSan(sans)} />;
  const treeEl = <MoveTreeView tree={tree} cursor={cursor} onSelect={go} wrong={wrong} from={phone ? built.beforeId : undefined} />;

  // Phones: one screen between the header and the tab bar, like training — the board as big as the
  // screen allows (players above and below, your clock in your strip), what to do and your line in a
  // box under it that scrolls on its own, and the buttons always at the bottom.
  if (phone)
    return (
      <div className="puzzle-phone">
        <div className="pp-board" ref={boardSize.boardRef} style={{ '--board-scale': boardSize.scale } as CSSProperties}>
          {strip(opposite(you))}
          {boardEl}
          {strip(you, clockEl)}
        </div>
        {boardSize.grip}
        <div className="pp-info">
          {/* The instructions step aside once you've started writing: room for your line. */}
          {!(mode === 'write' && phase === 'solve' && writtenMain.length > 0 && feedback?.kind === 'info') && feedbackEl}
          {error && <div className="error small">{error}</div>}
          {missReview}
          <div className="pp-tree">{treeEl}</div>
          {writeTools}
          {engineEl}
          {phase === 'done' && <div className="row">{lichessLink}</div>}
        </div>
        {giveUpConfirm || (
          <div className="pp-actions">
            {checkBtn}
            {/* After a miss: replay the solution first, then the next puzzle. */}
            {replayBtn || (!relearning && nextBtn)}
            {takeBack}
            <span className="spacer" />
            <span className="pp-nav">
              <button onClick={() => go(startId)} aria-label="The puzzle's position" title="The puzzle's position">
                ⏮
              </button>
              <button onClick={back} aria-label="Back">
                ◀
              </button>
              <button onClick={forward} aria-label="Forward">
                ▶
              </button>
            </span>
            {showSolutionBtn}
          </div>
        )}
      </div>
    );

  return (
    <div className="board-layout puzzle-layout">
      <div className="board-col col puzzle-board">
        {strip(opposite(you))}
        {boardEl}
        {strip(you)}
        <div className="row puzzle-nav">
          <button onClick={() => go(tree.root)} aria-label="Start of the game" title="Start of the game">
            ⏮
          </button>
          <button onClick={back} aria-label="Back" title="Back (←)">
            ◀
          </button>
          <button onClick={forward} aria-label="Forward" title="Forward (→)">
            ▶
          </button>
          <button onClick={() => go(startId)} title="The puzzle's position">
            Puzzle
          </button>
        </div>
      </div>
      <div className="col puzzle-side" style={{ gap: 10 }}>
        {clockEl}
        {feedbackEl}
        {error && <div className="error small">{error}</div>}
        <div className="panel col puzzle-tree" style={{ gap: 8 }}>
          {treeEl}
          {writeTools}
          {phase === 'solve' &&
            (giveUpConfirm || (
              <div className="row">
                {checkBtn}
                {takeBack}
                <span className="spacer" />
                {showSolutionBtn}
              </div>
            ))}
        </div>
        {engineEl}
        {missReview}
        <div className="row">
          {nextBtn}
          <span className="spacer" />
          {lichessLink}
        </div>
        <p className="muted small puzzle-note" style={{ margin: 0 }}>
          {review && judgeAlt
            ? 'A position from your game, to solve again cold (not rated) — another good move counts too. Solved twice in a row within your time, it’s done.'
            : review
            ? 'A puzzle you missed before, to solve again cold: it stays here (not rated). Solved twice in a row within your time, it’s done.'
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

/**
 * The time on a puzzle against your budget: quiet while you're within it, a nudge past it (commit to
 * your best line, or see the solution) — never a penalty. Stops when the puzzle is done.
 */
function PuzzleClock({ timer, running, compact = false }: { timer: { elapsed: () => number; budgetMs: number }; running: boolean; compact?: boolean }) {
  const { elapsed, budgetMs } = timer;
  const [ms, setMs] = useState(() => elapsed());
  useEffect(() => {
    setMs(elapsed());
    if (!running) return;
    const t = setInterval(() => setMs(elapsed()), 1000);
    return () => clearInterval(t);
  }, [elapsed, running]);
  const over = ms > budgetMs;
  // A phone: just the time, in your player strip like a game clock (amber past your budget).
  if (compact)
    return (
      <span className={`puzzle-clock compact ${over ? 'over' : ''}`} title={over ? 'Over your time — commit to your best line, or see the solution' : `Your time per puzzle: ${fmtClock(budgetMs)}`}>
        <span>{fmtClock(ms)}</span>
      </span>
    );
  return (
    <div className={`puzzle-clock ${over ? 'over' : ''}`} title="Time on this puzzle while the app is on screen — your time per puzzle is set above">
      <span>
        ⏱ {fmtClock(ms)} <span className="muted">/ {fmtClock(budgetMs)}</span>
      </span>
      {over && running && <span className="small">Over your time — commit to your best line, or see the solution.</span>}
    </div>
  );
}
