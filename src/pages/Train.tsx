import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Chess } from 'chessops/chess';
import type { PageProps } from '../App';
import { db } from '../db/db';
import { getSettings, useSettings, type AppSettings } from '../db/settings';
import { gradeCard } from '../db/repertoire';
import { MoveNote } from '../components/MoveNote';
import { Board, type Arrow } from '../components/Board';
import { ColorPill, Empty, ProgressBar, Stat } from '../components/ui';
import { useCards, useRepertoires, startOfToday } from '../hooks';
import { href, navigate } from '../router';
import { formatLine, playUci, startPos } from '../lib/chess';
import { RepGraph } from '../lib/graph';
import { asQuiz, filterByProbability, orderCards, planLine, type PlannedStep } from '../lib/trainer';
import { computeInsights, movesForLine, movesUnder } from '../lib/insights';
import { formatInterval, isDue, isNew, Rating } from '../lib/srs';
import type { Repertoire, ReviewCard } from '../lib/types';

/** review = due moves, learn = new moves, drill = extra practice of a chosen line / your weakest moves. */
type SessionMode = 'review' | 'learn' | 'drill';

export function TrainPage({ route }: PageProps) {
  const mode = route.query.get('mode') as SessionMode | null;
  const rep = route.query.get('rep') ?? 'all';
  const under = route.query.get('under') ?? undefined;
  const at = route.query.get('at') ?? undefined;
  if (mode === 'review' || mode === 'learn' || mode === 'drill')
    return (
      <SessionLoader
        key={`${mode}|${rep}|${under}|${at}|${route.query.get('t') ?? ''}`}
        mode={mode}
        repParam={rep}
        under={under}
        at={at}
        extra={Number(route.query.get('extra')) || undefined}
      />
    );
  return <TrainChooser />;
}

/* ---------------------------------------------------------------- chooser */

function TrainChooser() {
  const reps = useRepertoires();
  const cards = useCards();
  const settings = useSettings();
  const learnedToday = useLiveQuery(learnedTodayCount, []);
  const coverage = useLiveQuery(() => db.coverage.toArray(), []);
  const now = Date.now();
  if (!reps || !cards) return null;
  if (!reps.length) return <Empty>Create a repertoire first — <a href={href('repertoire')}>Repertoire</a>.</Empty>;

  const newLeft = Math.max(0, settings.newPerDay - (learnedToday ?? 0));
  const threshold = 1 / settings.oneInN;
  const countsFor = (repIds: string[]) => {
    let rc = cards.filter((c) => repIds.includes(c.repId));
    if (settings.trainOnlyLikely) {
      rc = repIds.flatMap((id) => {
        const cov = coverage?.find((c) => c.repId === id);
        const mine = rc.filter((c) => c.repId === id);
        return cov ? filterByProbability(mine, cov.probs, threshold) : mine;
      });
    }
    return { due: rc.filter((c) => isDue(c, now)).length, fresh: rc.filter(isNew).length };
  };
  const all = countsFor(reps.map((r) => r.id));

  return (
    <div className="col" style={{ gap: 16 }}>
      <h1>Train</h1>
      <div className="grid3">
        <Stat value={all.due} label="Reviews due" />
        <Stat value={`${Math.min(newLeft, all.fresh)}`} label="New moves today" hint={`${all.fresh} unlearned in total; daily limit ${settings.newPerDay}`} />
        <Stat value={learnedToday ?? 0} label="Learned today" />
      </div>
      {settings.trainOnlyLikely && (
        <div className="note">
          Only training positions reached in at least 1 in {settings.oneInN} games (repertoires with a Coverage run). Change this in Settings.
        </div>
      )}
      <div className="panel">
        <table className="data">
          <thead>
            <tr>
              <th>Repertoire</th>
              <th>Side</th>
              <th className="num">Due</th>
              <th className="num">New</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <b>All repertoires</b>
              </td>
              <td />
              <td className="num">{all.due}</td>
              <td className="num">{all.fresh}</td>
              <td>
                <SessionButtons rep="all" due={all.due} fresh={Math.min(all.fresh, newLeft)} unlearned={all.fresh} />
              </td>
            </tr>
            {reps.map((r) => {
              const c = countsFor([r.id]);
              return (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>
                    <ColorPill color={r.color} />
                  </td>
                  <td className="num">{c.due}</td>
                  <td className="num">{c.fresh}</td>
                  <td>
                    <SessionButtons rep={r.id} due={c.due} fresh={Math.min(c.fresh, newLeft)} unlearned={c.fresh} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        <b>Learn</b> shows you new moves of your repertoire line by line, then has you replay the line from memory. <b>Review</b> quizzes
        moves that are due, always starting from the initial position so you meet them as they arise in a game. Scheduling uses FSRS:
        correct on the first try counts as “Good”, anything else as “Again”.
      </p>
    </div>
  );
}

const EXTRA_BATCH = 10;

function SessionButtons({ rep, due, fresh, unlearned }: { rep: string; due: number; fresh: number; unlearned: number }) {
  return (
    <div className="list-actions" style={{ justifyContent: 'flex-end' }}>
      <button className="primary small" disabled={!due} onClick={() => navigate('train', { rep, mode: 'review', t: String(Date.now()) })}>
        Review {due || ''}
      </button>
      <button className="blue small" disabled={!fresh} onClick={() => navigate('train', { rep, mode: 'learn', t: String(Date.now()) })}>
        Learn {fresh || ''}
      </button>
      {!fresh && unlearned > 0 && (
        <button
          className="small"
          title="Daily limit reached — learn more anyway"
          onClick={() => navigate('train', { rep, mode: 'learn', extra: String(EXTRA_BATCH), t: String(Date.now()) })}
        >
          +{Math.min(EXTRA_BATCH, unlearned)} more
        </button>
      )}
    </div>
  );
}

async function learnedTodayCount(): Promise<number> {
  const logs = await db.reviewLog.where('reviewedAt').aboveOrEqual(startOfToday()).toArray();
  return new Set(logs.filter((l) => l.state === 0).map((l) => l.cardId)).size;
}

/* ---------------------------------------------------------------- session */

interface SessionSetup {
  mode: SessionMode;
  reps: Map<string, Repertoire>;
  graphs: Map<string, RepGraph>;
  queue: ReviewCard[];
  settings: AppSettings;
  notes: string[];
}

const WEAK_DRILL_SIZE = 20;

function SessionLoader({ mode, repParam, under, at, extra }: { mode: SessionMode; repParam: string; under?: string; at?: string; extra?: number }) {
  const [setup, setSetup] = useState<SessionSetup | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await getSettings();
      const reps = repParam === 'all' ? await db.repertoires.toArray() : [await db.repertoires.get(repParam)].filter((r): r is Repertoire => !!r);
      const graphs = new Map<string, RepGraph>();
      const queue: ReviewCard[] = [];
      const notes: string[] = [];
      const now = Date.now();
      for (const rep of reps) {
        const moves = await db.moves.where('repId').equals(rep.id).toArray();
        const graph = new RepGraph(rep.color, moves);
        graphs.set(rep.id, graph);
        const cards = await db.cards.where('repId').equals(rep.id).toArray();
        // A line you picked yourself trains every move in it, learned or not.
        let pool = cards.filter((c) => (mode === 'review' ? isDue(c, now) : mode === 'learn' ? isNew(c) : at ? true : !isNew(c)));
        const cov = await db.coverage.get(rep.id);
        if (mode === 'drill') {
          if (at) {
            const ids = movesForLine(graph, at);
            pool = pool.filter((c) => ids.has(c.id));
          } else if (under) {
            const ids = movesUnder(graph, under);
            pool = pool.filter((c) => ids.has(c.id));
          } else {
            const logs = await db.reviewLog.where('repId').equals(rep.id).toArray();
            const weak = computeInsights({ graph, cards, logs }).moves.filter((m) => m.mastery !== undefined).slice(0, WEAK_DRILL_SIZE);
            const ids = new Set(weak.map((m) => m.card.id));
            pool = pool.filter((c) => ids.has(c.id));
          }
          queue.push(...orderCards(pool, graph, cov?.probs));
          continue;
        }
        if (s.trainOnlyLikely) {
          if (cov) pool = filterByProbability(pool, cov.probs, 1 / s.oneInN);
          else notes.push(`“${rep.name}” has no Coverage run yet, so all of its moves are included.`);
        }
        queue.push(...orderCards(pool, graph, cov?.probs));
      }
      let finalQueue = queue;
      if (mode === 'learn') {
        // extra: a batch on top of the daily limit, when you ask for more.
        const left = extra ?? Math.max(0, s.newPerDay - (await learnedTodayCount()));
        finalQueue = queue.slice(0, left);
      }
      if (!cancelled) setSetup({ mode, reps: new Map(reps.map((r) => [r.id, r])), graphs, queue: finalQueue, settings: s, notes });
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, repParam, under, at, extra]);

  if (!setup) return <div className="muted">Preparing session…</div>;
  if (!setup.queue.length)
    return (
      <Empty>
        {mode === 'review'
          ? 'Nothing due right now 🎉'
          : mode === 'learn'
            ? 'No new moves to learn (or the daily limit is reached).'
            : 'Nothing to drill here yet — learn some moves first.'}
        <div style={{ marginTop: 12 }}>
          <a className="btn" href={href('train')}>
            Back to Train
          </a>
        </div>
      </Empty>
    );
  return <Session setup={setup} />;
}

interface LineState {
  repId: string;
  steps: PlannedStep[];
  phase: 'show' | 'quiz';
}

type Feedback = { kind: 'good' | 'bad' | 'hint' | 'show' | 'info'; text: ReactNode } | null;

/** Steps the app plays for you: opponent/earlier moves, and later known moves while a new line is being shown. */
function playedForYou(step: PlannedStep, phase: 'show' | 'quiz'): boolean {
  return step.kind === 'auto' || (step.kind === 'practice' && !step.leadIn && phase === 'show');
}

function Session({ setup }: { setup: SessionSetup }) {
  const { mode, graphs, reps, queue, settings } = setup;
  const pendingRef = useRef(new Set(queue.map((c) => c.id)));
  const [line, setLine] = useState<LineState | null>(null);
  const [idx, setIdx] = useState(0);
  const [pos, setPos] = useState<Chess>(startPos);
  const [lastMove, setLastMove] = useState<string>();
  const [wrong, setWrong] = useState(0);
  const [hint, setHint] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [flash, setFlash] = useState<'good' | 'bad' | 'hint' | null>(null);
  const [stats, setStats] = useState({ done: 0, correct: 0, failed: 0, lines: 0 });
  const [finished, setFinished] = useState(false);
  const feedbackToken = useRef(0);
  const startedLines = useRef(0);

  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flashFor = (f: 'good' | 'bad' | 'hint') => {
    clearTimeout(flashTimer.current);
    setFlash(f);
    flashTimer.current = setTimeout(() => setFlash(null), 600);
  };

  const nextLine = useCallback(() => {
    const pending = pendingRef.current;
    for (const card of queue) {
      if (!pending.has(card.id)) continue;
      const graph = graphs.get(card.repId);
      const move = graph?.byId.get(card.id);
      if (!graph || !move) {
        pending.delete(card.id);
        continue;
      }
      // The first line of a session starts you from move 1; later lines skip ahead to what's being trained.
      const steps = planLine(graph, move, pending, mode === 'learn' ? 'learn' : 'review', !startedLines.current);
      if (!steps.some((s) => s.kind === 'quiz' || s.kind === 'show')) {
        pending.delete(card.id);
        continue;
      }
      startedLines.current++;
      setLine({ repId: card.repId, steps, phase: mode === 'learn' ? 'show' : 'quiz' });
      setIdx(0);
      setPos(startPos());
      setLastMove(undefined);
      setWrong(0);
      setHint(false);
      setFeedback(null);
      return;
    }
    setLine(null);
    setFinished(true);
  }, [graphs, mode, queue]);

  useEffect(() => {
    nextLine();
  }, [nextLine]);

  // The move you last missed — its note opens for reading/editing once the answer is revealed.
  const [noteMove, setNoteMove] = useState<{ id: string; san: string } | undefined>();
  useEffect(() => setNoteMove(undefined), [line]);
  // A line with a missed move waits at the end (note still open) until you press Continue.
  const holdAtEnd = !!line && line.phase === 'quiz' && idx >= line.steps.length && !!noteMove;
  const continueAfterLine = () => {
    setStats((s) => ({ ...s, lines: s.lines + 1 }));
    nextLine();
  };

  // Auto-play opponent moves and moves that are not being tested; handle end of line.
  useEffect(() => {
    if (!line || finished) return;
    if (idx >= line.steps.length) {
      if (holdAtEnd) return;
      const t = setTimeout(() => {
        if (line.phase === 'show') {
          setLine({ ...line, steps: asQuiz(line.steps), phase: 'quiz' });
          setIdx(0);
          setPos(startPos());
          setLastMove(undefined);
          setFeedback({ kind: 'info', text: 'Now play the line from memory.' });
        } else {
          setStats((s) => ({ ...s, lines: s.lines + 1 }));
          nextLine();
        }
      }, 800);
      return () => clearTimeout(t);
    }
    const step = line.steps[idx];
    if (!playedForYou(step, line.phase)) return;
    const beforeUser = line.steps[idx + 1] && !playedForYou(line.steps[idx + 1], line.phase);
    const delay = idx === 0 ? 350 : beforeUser ? settings.autoPlayDelayMs : Math.min(140, settings.autoPlayDelayMs);
    const t = setTimeout(() => {
      const r = playUci(pos, step.move.uci);
      if (!r) {
        nextLine();
        return;
      }
      setPos(r.pos);
      setLastMove(r.uci);
      setIdx(idx + 1);
    }, delay);
    return () => clearTimeout(t);
  }, [line, idx, pos, finished, nextLine, settings.autoPlayDelayMs, holdAtEnd]);

  const step = line && idx < line.steps.length ? line.steps[idx] : undefined;
  const waiting = !!step && !!line && !playedForYou(step, line.phase);
  const rep = line ? reps.get(line.repId) : undefined;
  const graph = line ? graphs.get(line.repId) : undefined;

  const onMove = async (uci: string) => {
    if (!line || !step || !waiting) return;
    const r = playUci(pos, uci);
    if (!r) return;
    const expected = step.move;
    if (r.san === expected.san) {
      // Move the board first so the piece never jumps back while the grade is being saved.
      flashFor('good');
      setPos(r.pos);
      setLastMove(r.uci);
      setIdx(idx + 1);
      setWrong(0);
      setHint(false);
      if (line.phase !== 'quiz') {
        setFeedback({ kind: 'good', text: <b>✓ {expected.san}</b> });
        return;
      }
      if (step.kind === 'practice') {
        // Further down the branch: you play it, but it doesn't count toward your schedule.
        if (wrong > 0 || hint) setNoteMove({ id: expected.id, san: expected.san });
        feedbackToken.current++;
        setFeedback({ kind: wrong > 0 || hint ? 'hint' : 'good', text: <b>{wrong > 0 || hint ? `${expected.san} — keep it in mind.` : `✓ ${expected.san}`}</b> });
        return;
      }
      const failed = wrong > 0 || hint;
      if (failed) setNoteMove({ id: expected.id, san: expected.san });
      pendingRef.current.delete(expected.id);
      setStats((s) => ({ ...s, done: s.done + 1, correct: s.correct + (failed ? 0 : 1), failed: s.failed + (failed ? 1 : 0) }));
      const body = (interval?: string) => (
        <>
          <b>{failed ? `${expected.san} — keep practising it.` : `✓ ${expected.san}`}</b>
          {interval && <span className="muted"> · next review in {interval}</span>}
          {expected.comment && <div style={{ marginTop: 4 }}>{expected.comment}</div>}
        </>
      );
      const token = ++feedbackToken.current;
      setFeedback({ kind: failed ? 'hint' : 'good', text: body() });
      const updated = await gradeCard(expected.id, failed ? Rating.Again : Rating.Good, mode === 'learn' ? 'learn' : 'review');
      if (updated && token === feedbackToken.current) {
        setFeedback({ kind: failed ? 'hint' : 'good', text: body(formatInterval(updated.due - Date.now())) });
      }
      return;
    }
    feedbackToken.current++;
    const alt = graph?.childrenOf(expected.fromKey).find((m) => m.mine && m.san === r.san);
    if (alt) {
      setFeedback({ kind: 'info', text: `${r.san} is also in your repertoire — here we're training your other move.` });
      return;
    }
    flashFor('bad');
    if (line.phase === 'show') {
      setFeedback({ kind: 'hint', text: `Play ${expected.san} (follow the arrow).` });
      return;
    }
    const w = wrong + 1;
    setWrong(w);
    if (w >= 2) {
      setHint(true);
      setNoteMove({ id: expected.id, san: expected.san });
    }
    setFeedback({ kind: 'bad', text: <>✗ {r.san} is not your prep. {w >= 2 ? 'The arrow shows your move.' : 'Try again.'}</> });
  };

  const showAnswer = () => {
    setHint(true);
    if (step && waiting) setNoteMove({ id: step.move.id, san: step.move.san });
    setWrong((w) => Math.max(1, w));
  };

  const skipLine = () => {
    if (!line) return;
    for (const s of line.steps) if (s.kind !== 'auto') pendingRef.current.delete(s.move.id);
    nextLine();
  };

  const arrows: Arrow[] = useMemo(() => {
    if (!step || !waiting) return [];
    if (line?.phase === 'show' || hint) return [{ uci: step.move.uci, brush: 'green' }];
    return [];
  }, [step, line?.phase, hint]);

  const total = queue.length;
  const progress = total ? (total - pendingRef.current.size) / total : 1;

  if (finished) {
    return (
      <div className="col" style={{ gap: 16, maxWidth: 640, margin: '0 auto' }}>
        <div className="hero">
          <h1>Session complete</h1>
          <p className="muted">
            {mode === 'learn' ? 'New moves are scheduled for their first reviews shortly.' : mode === 'drill' ? 'Drill finished — results feed into your schedule.' : 'All due reviews done.'}
          </p>
          <div className="grid3" style={{ marginTop: 12 }}>
            <Stat value={stats.done} label="Moves" />
            <Stat value={stats.correct} label="First try" />
            <Stat value={stats.failed} label="Missed" />
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <a className="btn primary" href={href('train')}>
              Back to Train
            </a>
            {mode === 'learn' && (
              <button
                className="blue"
                onClick={() =>
                  navigate('train', {
                    rep: setup.reps.size === 1 ? [...setup.reps.keys()][0] : 'all',
                    mode: 'learn',
                    extra: String(EXTRA_BATCH),
                    t: String(Date.now()),
                  })
                }
              >
                Learn {EXTRA_BATCH} more
              </button>
            )}
            <a className="btn" href={href('')}>
              Home
            </a>
          </div>
        </div>
      </div>
    );
  }

  const prevStep = line && idx > 0 ? line.steps[idx - 1] : undefined;
  const pathSoFar = line ? line.steps.slice(0, idx).map((s) => s.move.san) : [];

  return (
    <div className="board-layout">
      <div className="board-col col">
        <Board pos={pos} orientation={rep?.color ?? 'white'} interactive={waiting} lastMove={lastMove} onMove={onMove} arrows={arrows} flash={flash} />
        {noteMove && <MoveNote key={noteMove.id} id={noteMove.id} san={noteMove.san} label="(missed)" prompt />}
      </div>
      <div className="col">
        <div className="panel">
          <div className="row">
            <h2 style={{ margin: 0 }}>{mode === 'learn' ? 'Learn' : mode === 'drill' ? 'Drill' : 'Review'}</h2>
            {rep && <span className="muted">{rep.name}</span>}
            <span className="spacer" />
            <span className="muted small">
              {total - pendingRef.current.size} / {total}
            </span>
            <a className="btn small" href={href('train')}>
              End
            </a>
          </div>
          <div style={{ marginTop: 8 }}>
            <ProgressBar value={progress} />
          </div>
          {setup.notes.map((n) => (
            <div key={n} className="note" style={{ marginTop: 8 }}>
              {n}
            </div>
          ))}
        </div>

        <div className="panel">
          <h3>{line?.phase === 'show' ? 'New line' : 'Line'}</h3>
          <div className="mono" style={{ minHeight: 22 }}>
            {pathSoFar.length ? formatLine(pathSoFar) : <span className="muted">Starting position</span>}
          </div>
        </div>

        <div className={`feedback ${waiting && !feedback ? '' : feedback?.kind ?? ''}`}>
          {waiting && line?.phase === 'show' && (
            <div>
              <b>Play {step!.move.san}</b>
              {step!.move.comment && <div style={{ marginTop: 4 }}>{step!.move.comment}</div>}
            </div>
          )}
          {feedback && <div style={{ marginBottom: 4, marginTop: waiting && line?.phase === 'show' ? 6 : 0 }}>{feedback.text}</div>}
          {waiting && line?.phase === 'quiz' && feedback?.kind !== 'bad' && <b>Your move — what's your prep here?</b>}
          {waiting && prevStep && !prevStep.move.mine && prevStep.move.comment && (
            <div className="muted small" style={{ marginTop: 6 }}>
              After {prevStep.move.san}: {prevStep.move.comment}
            </div>
          )}
          {!waiting && !feedback && <span className="muted">…</span>}
          {holdAtEnd && (
            <div className="muted small" style={{ marginTop: 6 }}>
              Line finished. Write or edit the note under the board, then press Continue.
            </div>
          )}
        </div>

        <div className="row">
          {holdAtEnd ? (
            <button className="primary" onClick={continueAfterLine} autoFocus={false}>
              Continue →
            </button>
          ) : (
            <>
              {line?.phase === 'quiz' && (
                <button onClick={showAnswer} disabled={!waiting || hint}>
                  Show move
                </button>
              )}
              <button onClick={skipLine}>Skip line</button>
            </>
          )}
          <span className="spacer" />
          <span className="muted small">
            ✓ {stats.correct} · ✗ {stats.failed}
          </span>
        </div>
      </div>
    </div>
  );
}
