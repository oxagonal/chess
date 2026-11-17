import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Chess } from 'chessops/chess';
import type { PageProps } from '../App';
import { db } from '../db/db';
import { getSettings, repTarget, updateSettings, useSettings, type AppSettings } from '../db/settings';
import { gradeCard } from '../db/repertoire';
import { MoveNote } from '../components/MoveNote';
import { Board, type Arrow } from '../components/Board';
import { ColorPill, Empty, ProgressBar, Stat } from '../components/ui';
import { PHONE_QUERY, useCards, useMediaQuery, useRepertoires, startOfToday } from '../hooks';
import { href, navigate } from '../router';
import { formatLine, playUci, startPos } from '../lib/chess';
import { RepGraph } from '../lib/graph';
import { asQuiz, filterByProbability, moveOrders, orderCards, planLine, type PlannedStep } from '../lib/trainer';
import { Builder } from './Repertoire';
import { computeInsights, movesForLine, movesUnder } from '../lib/insights';
import { formatInterval, isDue, isNew, Rating } from '../lib/srs';
import type { Repertoire, RepMove, ReviewCard } from '../lib/types';

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
  const countsFor = (repIds: string[]) => {
    let rc = cards.filter((c) => repIds.includes(c.repId));
    if (settings.trainOnlyLikely) {
      rc = repIds.flatMap((id) => {
        const cov = coverage?.find((c) => c.repId === id);
        const mine = rc.filter((c) => c.repId === id);
        return cov ? filterByProbability(mine, cov.probs, 1 / repTarget(reps.find((r) => r.id === id), settings)) : mine;
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
          Only training positions reached at least as often as each repertoire's coverage target (repertoires with a Coverage run). Change this
          in Settings.
        </div>
      )}
      <div className="panel list">
        <div className="list-item">
          <div className="list-main">
            <div className="list-head">
              <span className="list-title">All repertoires</span>
            </div>
            <Counts due={all.due} fresh={all.fresh} />
          </div>
          <SessionButtons rep="all" due={all.due} fresh={Math.min(all.fresh, newLeft)} unlearned={all.fresh} />
        </div>
        {reps.map((r) => {
          const c = countsFor([r.id]);
          return (
            <div key={r.id} className="list-item">
              <div className="list-main">
                <div className="list-head">
                  <ColorPill color={r.color} />
                  <span className="list-title">{r.name}</span>
                </div>
                <Counts due={c.due} fresh={c.fresh} />
              </div>
              <SessionButtons rep={r.id} due={c.due} fresh={Math.min(c.fresh, newLeft)} unlearned={c.fresh} />
            </div>
          );
        })}
      </div>
      <p className="muted small">
        <b>Learn</b> shows you new moves of your repertoire line by line, then has you replay them from memory — moves you already know
        are played for you. <b>Review</b> quizzes moves that are due: you play the whole line from move 1 to the end of the branch, so
        you meet them as they arise in a game. Scheduling uses FSRS:
        correct on the first try counts as “Good”, anything else as “Again”.
      </p>
    </div>
  );
}

const EXTRA_BATCH = 10;

function Counts({ due, fresh }: { due: number; fresh: number }) {
  if (!due && !fresh) return <div className="list-meta">Nothing due, nothing new</div>;
  return (
    <div className="list-meta">
      {due > 0 && <span className="badge due">{due} due</span>}
      {fresh > 0 && <span className="badge new">{fresh} new</span>}
    </div>
  );
}

function SessionButtons({ rep, due, fresh, unlearned }: { rep: string; due: number; fresh: number; unlearned: number }) {
  // Learn is never greyed out: past today's limit it learns another batch anyway, and with every
  // move learned it opens the builder to add more.
  const learn = () => {
    if (fresh) navigate('train', { rep, mode: 'learn', t: String(Date.now()) });
    else if (unlearned) navigate('train', { rep, mode: 'learn', extra: String(EXTRA_BATCH), t: String(Date.now()) });
    else navigate(rep === 'all' ? 'repertoire' : `repertoire/${rep}`);
  };
  return (
    <div className="list-buttons">
      <button className="primary small" disabled={!due} onClick={() => navigate('train', { rep, mode: 'review', t: String(Date.now()) })}>
        Review {due || ''}
      </button>
      <button
        className="blue small"
        onClick={learn}
        title={fresh ? undefined : unlearned ? 'Today’s new-move limit is reached — learn more anyway' : 'Every move is learned — add new moves in the builder'}
      >
        {fresh ? `Learn ${fresh}` : unlearned ? `Learn ${Math.min(EXTRA_BATCH, unlearned)} more` : 'Learn'}
      </button>
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
  /** Each repertoire's last coverage run: how often positions come up (orders move orders). */
  probs: Map<string, Record<string, number>>;
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
      const probs = new Map<string, Record<string, number>>();
      const queue: ReviewCard[] = [];
      const notes: string[] = [];
      const now = Date.now();
      for (const rep of reps) {
        const moves = await db.moves.where('repId').equals(rep.id).toArray();
        const graph = new RepGraph(rep.color, moves);
        graphs.set(rep.id, graph);
        const cards = await db.cards.where('repId').equals(rep.id).toArray();
        // A line you picked yourself trains every move in it, learned or not.
        // Drilling a chosen line or move takes every move in it, learned or not (drilling one counts as
        // learning it); the weakest-moves drill only has learned moves to choose from.
        let pool = cards.filter((c) => (mode === 'review' ? isDue(c, now) : mode === 'learn' ? isNew(c) : at || under ? true : !isNew(c)));
        const cov = await db.coverage.get(rep.id);
        if (cov) probs.set(rep.id, cov.probs);
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
          if (cov) pool = filterByProbability(pool, cov.probs, 1 / repTarget(rep, s));
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
      if (!cancelled) setSetup({ mode, reps: new Map(reps.map((r) => [r.id, r])), graphs, queue: finalQueue, settings: s, notes, probs });
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
  /** The trained position can be reached by several move orders: which one this is (0-based) of how many. */
  order?: { index: number; count: number };
}

type Feedback = { kind: 'good' | 'bad' | 'hint' | 'show' | 'info'; text: ReactNode } | null;

/** Steps the app plays for you: the opponent's moves, and your moves that aren't being asked. */
function playedForYou(step: PlannedStep): boolean {
  return step.kind === 'auto';
}

function Session({ setup }: { setup: SessionSetup }) {
  const { mode, reps, queue, settings } = setup;
  // Graphs are refreshed after you edit a line mid-session (Edit line), so keep them in a ref.
  const graphsRef = useRef(setup.graphs);
  const [editing, setEditing] = useState<{ repId: string; line: string } | null>(null);
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
  // Trainer options (⚙): read live, so a change applies from the next line.
  const live = useSettings();
  const [showOptions, setShowOptions] = useState(false);
  const skipRepeatsRef = useRef(false);
  skipRepeatsRef.current = live.trainSkipRepeats;
  // Your moves played so far in this session (Skip repeats). A new session starts empty.
  const seenRef = useRef(new Set<string>());
  // Moves graded this session: a drill grades each move you play once, wherever it comes up.
  const gradedRef = useRef(new Set<string>());

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
      const graph = graphsRef.current.get(card.repId);
      const move = graph?.byId.get(card.id);
      if (!graph || !move) {
        pending.delete(card.id);
        continue;
      }
      // A transposed position: each review takes the next move order into it (most common first),
      // so over time you practice reaching it every way your repertoire allows.
      const orders = moveOrders(graph, move.fromKey, setup.probs.get(card.repId));
      let index = orders.length ? card.reps % orders.length : 0;
      const learn = mode === 'learn';
      const seen = !learn && skipRepeatsRef.current ? seenRef.current : undefined;
      if (seen && orders.length > 1) {
        // Skip repeats: take the move order with the most of your moves not yet played this session
        // (ties keep the rotation), e.g. into the Four Knights via 2.Nc3 once 2.Nf3 has been played.
        const fresh = (o: RepMove[]) => o.filter((m) => m.mine && !seen.has(m.id)).length;
        let best = index;
        for (let k = 1; k < orders.length; k++) {
          const i = (index + k) % orders.length;
          if (fresh(orders[i]) > fresh(orders[best])) best = i;
        }
        index = best;
      }
      // Review and drills: every line is played from move 1 (your earlier moves too) to the end of the
      // branch — with Skip repeats, minus what you've already played this session. Learn: only the new
      // moves are asked; the moves you already know are played for you.
      const steps = planLine(graph, move, pending, learn ? 'learn' : 'review', { leadIn: !learn, via: orders[index], seen });
      if (!steps.some((s) => s.kind === 'quiz' || s.kind === 'show')) {
        pending.delete(card.id);
        continue;
      }
      setLine({
        repId: card.repId,
        steps,
        phase: mode === 'learn' ? 'show' : 'quiz',
        order: orders.length > 1 ? { index, count: orders.length } : undefined,
      });
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
  }, [mode, queue, setup.probs]);

  useEffect(() => {
    nextLine();
  }, [nextLine]);

  // The move you last missed — its note opens for reading/editing once the answer is revealed.
  const [noteMove, setNoteMove] = useState<{ id: string; san: string } | undefined>();
  useEffect(() => setNoteMove(undefined), [line]);
  // A finished line waits for Continue (so you can edit it or its note) — unless Auto-advance is on,
  // which still stops after a missed move so you can write down why.
  const holdAtEnd = !!line && line.phase === 'quiz' && idx >= line.steps.length && (!live.trainAutoNext || !!noteMove);
  const continueAfterLine = () => {
    setStats((s) => ({ ...s, lines: s.lines + 1 }));
    nextLine();
  };
  const editLine = () => line && setEditing({ repId: line.repId, line: line.steps.map((s) => s.move.san).join(' ') });
  // Back from the builder: reload that repertoire (moves may have been added or deleted), then go on.
  const finishEditing = async () => {
    if (!editing) return;
    const rep = reps.get(editing.repId);
    if (rep) {
      const moves = await db.moves.where('repId').equals(rep.id).toArray();
      graphsRef.current = new Map(graphsRef.current).set(rep.id, new RepGraph(rep.color, moves));
    }
    setEditing(null);
    continueAfterLine();
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
    if (!playedForYou(step)) return;
    const beforeUser = line.steps[idx + 1] && !playedForYou(line.steps[idx + 1]);
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
  const waiting = !!step && !!line && !playedForYou(step);
  const rep = line ? reps.get(line.repId) : undefined;
  const graph = line ? graphsRef.current.get(line.repId) : undefined;

  const onMove = async (uci: string) => {
    if (!line || !step || !waiting) return;
    const r = playUci(pos, uci);
    if (!r) return;
    const expected = step.move;
    if (r.san === expected.san) {
      seenRef.current.add(expected.id);
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
        const missed = wrong > 0 || hint;
        if (missed) setNoteMove({ id: expected.id, san: expected.san });
        feedbackToken.current++;
        setFeedback({ kind: missed ? 'hint' : 'good', text: <b>{missed ? `${expected.san} — keep it in mind.` : `✓ ${expected.san}`}</b> });
        // A drill counts every move you play as reviewed: one that isn't due yet has its interval
        // restarted from today (never grown — see gradeAhead). In a review line the moves around the
        // due ones are practice only.
        if (mode === 'drill' && !gradedRef.current.has(expected.id)) {
          gradedRef.current.add(expected.id);
          setStats((s) => ({ ...s, done: s.done + 1, correct: s.correct + (missed ? 0 : 1), failed: s.failed + (missed ? 1 : 0) }));
          void gradeCard(expected.id, missed ? Rating.Again : Rating.Good, 'review', undefined, { ahead: true });
        }
        return;
      }
      gradedRef.current.add(expected.id);
      const failed = wrong > 0 || hint;
      if (failed) setNoteMove({ id: expected.id, san: expected.san });
      pendingRef.current.delete(expected.id);
      setStats((s) => ({ ...s, done: s.done + 1, correct: s.correct + (failed ? 0 : 1), failed: s.failed + (failed ? 1 : 0) }));
      const body = (interval?: string) => (
        <>
          <b>{failed ? `${expected.san} — keep practicing it.` : `✓ ${expected.san}`}</b>
          {interval && <span className="muted"> · next review in {interval}</span>}
          {/* No note after a correct answer: a missed move opens its note under the board instead. */}
        </>
      );
      const token = ++feedbackToken.current;
      setFeedback({ kind: failed ? 'hint' : 'good', text: body() });
      const updated = await gradeCard(expected.id, failed ? Rating.Again : Rating.Good, mode === 'learn' ? 'learn' : 'review', undefined, {
        ahead: mode === 'drill',
      });
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

  // Phones get their own arrangement (see the end of this component).
  const phone = useMediaQuery(PHONE_QUERY);
  const movesRef = useRef<HTMLDivElement>(null);
  // The phone's one-row move strip keeps the latest move in view.
  useEffect(() => {
    const el = movesRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [idx, line, phone]);

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
            {mode === 'learn' ? 'New moves are scheduled for their first reviews shortly.' : mode === 'drill' ? 'Drill finished — each move you got right restarts its review interval from today (drilling early never pushes it further away); misses come back soon.' : 'All due reviews done.'}
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

  if (editing) return <Builder key={editing.line} repId={editing.repId} initialLine={editing.line} onDone={() => void finishEditing()} />;

  const modeName = mode === 'learn' ? 'Learn' : mode === 'drill' ? 'Drill' : 'Review';
  const counter = `${total - pendingRef.current.size} / ${total}`;
  const endButton = (
    <a className="btn small" href={href('train')}>
      End
    </a>
  );
  const optionsButton = (
    <button className={`small ${showOptions ? 'primary' : ''}`} onClick={() => setShowOptions((v) => !v)} title="Training options" aria-expanded={showOptions}>
      ⚙ Settings
    </button>
  );
  const optionsPanel = showOptions && (
    <div className="panel col train-options" style={{ gap: 10 }}>
      <label className="check">
        <input type="checkbox" checked={live.trainAutoNext} onChange={(e) => updateSettings({ trainAutoNext: e.target.checked })} />
        <span>
          <b>Auto-advance</b> — next line without pressing Continue. Still stops after a miss, so you can write the note.
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={live.trainSkipRepeats} onChange={(e) => updateSettings({ trainSkipRepeats: e.target.checked })} />
        <span>
          <b>Skip repeats</b> — moves you've already played this session are played for you, and lines head for positions you haven't
          seen yet. Due moves are always asked; a new session starts fresh. (Review and drills.)
        </span>
      </label>
      <div className="muted small">Changes apply from the next line.</div>
    </div>
  );
  const board = <Board pos={pos} orientation={rep?.color ?? 'white'} interactive={waiting} lastMove={lastMove} onMove={onMove} arrows={arrows} flash={flash} />;
  const note = noteMove && <MoveNote key={noteMove.id} id={noteMove.id} san={noteMove.san} label="(missed)" prompt compact={phone} />;
  const lineLabel = <h3 style={{ margin: 0 }}>{line?.phase === 'show' ? 'New line' : 'Line'}</h3>;
  const orderBadge = line?.order && (
    <span
      className="badge"
      title="This position can be reached by more than one move order. Each review takes the next one (most common first), so you practice them all."
    >
      {phone ? 'Order' : 'Move order'} {line.order.index + 1} {phone ? '/' : 'of'} {line.order.count}
    </span>
  );
  const lineText = pathSoFar.length ? formatLine(pathSoFar) : <span className="muted">Starting position</span>;
  const notes = setup.notes.map((n) => (
    <div key={n} className="note">
      {n}
    </div>
  ));
  const feedbackBox = (
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
      {holdAtEnd && !phone && (
        <div className="muted small" style={{ marginTop: 6 }}>
          Line finished. {noteMove ? 'Write or edit the note under the board, or edit' : 'Edit'} the line in the builder, then press Continue.
        </div>
      )}
      {/* On phones a missed move's note lives here, inside the feedback, instead of under the board. */}
      {phone && note}
    </div>
  );
  const actions = (
    <div className="row train-actions">
      {holdAtEnd ? (
        <>
          <button className="primary" onClick={continueAfterLine} autoFocus={false}>
            Continue →
          </button>
          <button onClick={editLine} title="Open this line in the repertoire builder — add, change or delete moves and notes — then continue training">
            Edit line
          </button>
        </>
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
      {phone && endButton}
    </div>
  );

  // Phones: one screen between the header and the tab bar. The board's size depends only on the
  // screen (styles.css, .tp-board), never on what's under it, so it doesn't jump while you play;
  // the line is one sideways-scrolling row, and feedback + note share a fixed box above the buttons.
  if (phone)
    return (
      <div className="train-phone">
        <div className="tp-status">
          <div className="row">
            <b>{modeName}</b>
            {rep && <span className="muted">{rep.name}</span>}
            <span className="spacer" />
            <span className="muted small">{counter}</span>
            {optionsButton}
          </div>
          <ProgressBar value={progress} />
        </div>
        <div className="tp-board">{board}</div>
        <div className="tp-line">
          {lineLabel}
          {orderBadge}
          <div className="mono tp-moves" ref={movesRef}>
            {lineText}
          </div>
        </div>
        <div className="tp-info">
          {optionsPanel || (
            <>
              {feedbackBox}
              {notes}
            </>
          )}
        </div>
        {actions}
      </div>
    );

  return (
    <div className="board-layout">
      <div className="board-col col">
        {board}
        {note}
      </div>
      <div className="col">
        <div className="panel">
          <div className="row">
            <h2 style={{ margin: 0 }}>{modeName}</h2>
            {rep && <span className="muted">{rep.name}</span>}
            <span className="spacer" />
            <span className="muted small">{counter}</span>
            {optionsButton}
            {endButton}
          </div>
          <div style={{ marginTop: 8 }}>
            <ProgressBar value={progress} />
          </div>
          {notes.length > 0 && (
            <div className="col" style={{ marginTop: 8, gap: 8 }}>
              {notes}
            </div>
          )}
        </div>

        {optionsPanel}

        <div className="panel">
          <div className="row" style={{ marginBottom: 8 }}>
            {lineLabel}
            {orderBadge}
          </div>
          <div className="mono" style={{ minHeight: 22 }}>
            {lineText}
          </div>
        </div>

        {feedbackBox}
        {actions}
      </div>
    </div>
  );
}
