import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Chess } from 'chessops/chess';
import type { PageProps } from '../App';
import { db } from '../db/db';
import { getSettings, updateSettings, useSettings, type AppSettings } from '../db/settings';
import { gradeAnswer } from '../db/repertoire';
import { MoveNote } from '../components/MoveNote';
import { useBoardScale } from '../components/BoardGrip';
import { afterMove, MasterGames, PlanNote, useAllPlans } from '../components/PlanBox';
import { setPlanStill } from '../db/repertoire';
import { planAhead, planCover, type PlanRef } from '../lib/plans';
import { AnswerTimerInput } from '../components/AnswerTimerInput';
import { Board, type Arrow } from '../components/Board';
import { PositionTools } from '../components/PositionTools';
import { Empty, ProgressBar, Stat } from '../components/ui';
import { PHONE_QUERY, useActivityClock, useCards, useMediaQuery, startOfToday } from '../hooks';
import { LineCard } from '../components/LineCard';
import { mapLine } from '../lib/map';
import { colorName, loadScopeGraph, scopeIdsFor, useChaptersAndSets, type Scope } from '../db/scopes';
import { coverageFor, learnedTodayCount, trainedCards } from '../db/training';
import { EXTRA_BATCH } from '../components/SessionButtons';
import { cardsOf, chapterOfMoveId, sourcesOf } from '../lib/chapters';
import { href, navigate, scopeHref } from '../router';
import { compactLine, formatLine, playUci, startPos } from '../lib/chess';
import type { RepGraph } from '../lib/graph';
import { asQuiz, moveOrders, newMovesQuiz, orderCards, ordersFor, planLine, type PlannedStep } from '../lib/trainer';
import { Builder } from './Repertoire';
import { computeInsights, movesForLine, movesUnder, weakestMoves } from '../lib/insights';
import { formatInterval, isDue, isNew, Rating, type Grade } from '../lib/srs';
import type { RepMove, ReviewCard } from '../lib/types';

/** Where a session goes back to: the Map of what it trained ('all': the Map as you left it). */
const mapHref = (rep: string) => scopeHref(rep === 'all' ? undefined : rep);

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
  // The Train tab is part of the Map now (App sends #/train there): only sessions are shown here.
  return null;
}

/* ---------------------------------------------------------------- session */

interface SessionSetup {
  mode: SessionMode;
  /** The scopes trained (one per color), by id; lines and graphs are keyed by scope id. */
  reps: Map<string, Scope>;
  graphs: Map<string, RepGraph>;
  queue: ReviewCard[];
  settings: AppSettings;
  notes: string[];
  /** Each repertoire's last coverage run: how often positions come up (orders move orders). */
  probs: Map<string, Record<string, number>>;
  /** Your moves never learned (card ids = scope move ids): a review or drill line teaches them where it meets them. */
  unlearned: Set<string>;
}

const WEAK_DRILL_SIZE = 20;

function SessionLoader({ mode, repParam, under, at, extra }: { mode: SessionMode; repParam: string; under?: string; at?: string; extra?: number }) {
  const [setup, setSetup] = useState<SessionSetup | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await getSettings();
      const reps: Scope[] = [];
      const graphs = new Map<string, RepGraph>();
      const probs = new Map<string, Record<string, number>>();
      const queue: ReviewCard[] = [];
      const notes: string[] = [];
      const unlearned = new Set<string>();
      const now = Date.now();
      const runs = await db.coverage.toArray();
      for (const id of scopeIdsFor(repParam)) {
        const loaded = await loadScopeGraph(id);
        if (!loaded) continue;
        const { scope: rep, graph } = loaded;
        reps.push(rep);
        graphs.set(rep.id, graph);
        const colorCards = await db.cards.where('color').equals(rep.color).toArray();
        const cards = cardsOf(graph, colorCards);
        for (const c of cards) if (isNew(c)) unlearned.add(c.id);
        const cov = coverageFor(rep, runs);
        if (cov) probs.set(rep.id, cov.probs);
        if (mode === 'drill') {
          // Drilling a chosen line or move takes every move in it, learned or not (drilling one counts as
          // learning it); the weakest-moves drill only has learned moves to choose from.
          let pool = cards.filter((c) => (at || under ? true : !isNew(c)));
          if (at) {
            const ids = movesForLine(graph, at);
            pool = pool.filter((c) => ids.has(c.id));
          } else if (under) {
            const ids = movesUnder(graph, under);
            pool = pool.filter((c) => ids.has(c.id));
          } else {
            const inScope = new Set(cards.map((c) => c.id));
            const logs = (await db.reviewLog.where('color').equals(rep.color).toArray()).filter((l) => inScope.has(l.cardId));
            const weak = weakestMoves(computeInsights({ graph, cards, logs }).moves).slice(0, WEAK_DRILL_SIZE);
            const ids = new Set(weak.map((m) => m.card.id));
            pool = pool.filter((c) => ids.has(c.id));
          }
          queue.push(...orderCards(pool, graph, cov?.probs));
          continue;
        }
        // The same cards the due and new counts everywhere are taken from.
        const pool = trainedCards(rep, graph, colorCards, s, runs).filter((c) => (mode === 'review' ? isDue(c, now) : isNew(c)));
        if (s.trainOnlyLikely && !cov) notes.push(`No Coverage run for ${colorName(rep.color)} yet, so all of “${rep.name}” is included.`);
        queue.push(...orderCards(pool, graph, cov?.probs));
      }
      let finalQueue = queue;
      if (mode === 'learn') {
        // extra: a batch on top of the daily limit, when you ask for more.
        const left = extra ?? Math.max(0, s.newPerDay - (await learnedTodayCount()));
        finalQueue = queue.slice(0, left);
      }
      if (!cancelled) setSetup({ mode, reps: new Map(reps.map((r) => [r.id, r])), graphs, queue: finalQueue, settings: s, notes, probs, unlearned });
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
          <a className="btn" href={mapHref(repParam)}>
            Back to the Map
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
  /** A missed position again, at the end of the session (practice only: it was graded already). */
  repeat?: boolean;
  /** The replay after a review line that taught you new moves: just those, from memory (graded as learning them). */
  newMoves?: boolean;
}

/** A random order (Fisher–Yates). */
function shuffled<T>(xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

type Feedback = { kind: 'good' | 'bad' | 'hint' | 'show' | 'info'; text: ReactNode } | null;

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

/** After a timed answer: how the answer timer graded it, when it wasn't plain Good. */
function Speed({ grade, ms }: { grade: Grade; ms?: number }) {
  if (ms === undefined || (grade !== Rating.Easy && grade !== Rating.Hard)) return null;
  return (
    <span className="muted">
      {' '}
      · {grade === Rating.Easy ? 'quick' : 'slow'} ({seconds(ms)}): <b className={grade === Rating.Easy ? 'good-text' : 'warn-text'}>{grade === Rating.Easy ? 'Easy' : 'Hard'}</b>
    </span>
  );
}

/**
 * The answer timer on a question: a bar running down over the time you have. It reads the session's
 * clock (which only runs while the app is on screen); green while an answer would still be Easy.
 */
function AnswerClock({ limitMs, elapsed }: { limitMs: number; elapsed: () => number }) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    setMs(elapsed());
    const t = setInterval(() => setMs(elapsed()), 200);
    return () => clearInterval(t);
  }, [elapsed]);
  const left = Math.max(0, limitMs - ms);
  const phase = ms > limitMs ? 'over' : 'ok';
  // No room of its own: the seconds sit at the end of the first line, the bar along the box's top.
  return (
    <span
      className={`answer-clock ${phase}`}
      role="timer"
      title="Answer timer (⚙ Settings): a right answer in time is Good, slower Hard (and Easy when quick on a move you know well)"
    >
      <span className="answer-clock-bar" aria-hidden="true">
        <span style={{ width: `${(left / limitMs) * 100}%` }} />
      </span>
      <span className="answer-clock-time small">{phase === 'over' ? 'over time · Hard' : `${Math.ceil(left / 1000)} s`}</span>
    </span>
  );
}

/** The note to show for a move you missed: its first chapter's (a union move can stand for several). */
const noteFor = (m: RepMove) => ({ id: sourcesOf(m)[0], san: m.san });

/** Steps the app plays for you: the opponent's moves, and your moves that aren't being asked. */
function playedForYou(step: PlannedStep): boolean {
  return step.kind === 'auto';
}

function Session({ setup }: { setup: SessionSetup }) {
  const { mode, reps, queue, settings } = setup;
  // Opening training: the study third (the Plan tab).
  useActivityClock({ third: 'study', topic: 'openings', what: `train-${mode}` });
  // Graphs are refreshed after you edit a line mid-session (Edit line), so keep them in a ref.
  const graphsRef = useRef(setup.graphs);
  const [editing, setEditing] = useState<{ repId: string; chapterId: string; line: string } | null>(null);
  // Cards are per color; each color has one scope in a session.
  const scopeIdOf = useMemo(() => new Map([...reps.values()].map((r) => [r.color, r.id])), [reps]);
  const pendingRef = useRef(new Set(queue.map((c) => c.id)));
  // Moves you've never learned, until a line teaches them (then they're learning, like any other).
  const teachRef = useRef(new Set(setup.unlearned));
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
  // Phones: the board's size, chosen with the grip under it (like the builder's).
  const boardSize = useBoardScale('train');
  const [showOptions, setShowOptions] = useState(false);
  const skipRepeatsRef = useRef(false);
  skipRepeatsRef.current = live.trainSkipRepeats;
  const untilRightRef = useRef(false);
  untilRightRef.current = live.trainRepeatUntilRight;
  // Positions you missed (by card), with the moves to them — they come back at the end of the session
  // (learn, review or drill), in random order; with "until right", until a whole round goes without a miss.
  const missedPosRef = useRef(new Map<string, { scopeId: string; path: RepMove[] }>());
  const repeatRef = useRef({ started: false, queue: [] as string[], round: 0, roundMissed: false });
  const [repeatInfo, setRepeatInfo] = useState<{ left: number; total: number; round: number } | null>(null);
  // Your moves played so far in this session (Skip repeats). A new session starts empty.
  const seenRef = useRef(new Set<string>());
  // Moves graded this session: a drill grades each move you play once, wherever it comes up.
  const gradedRef = useRef(new Set<string>());

  // The answer timer (⚙): time spent on the question you're on, counting only while the app is on
  // screen — so switching away doesn't make an answer slow. It restarts with every position.
  const clockRef = useRef<{ spent: number; since: number | null }>({ spent: 0, since: null });
  const answerMs = useCallback(() => {
    const c = clockRef.current;
    return c.spent + (c.since === null ? 0 : performance.now() - c.since);
  }, []);
  useEffect(() => {
    const onVisibility = () => {
      const c = clockRef.current;
      const now = performance.now();
      if (document.hidden) {
        if (c.since !== null) (c.spent += now - c.since), (c.since = null);
      } else if (c.since === null) c.since = now;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  useEffect(() => {
    clockRef.current = { spent: 0, since: document.hidden ? null : performance.now() };
  }, [line, idx]);

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
      const scopeId = scopeIdOf.get(card.color) ?? '';
      const graph = graphsRef.current.get(scopeId);
      const move = graph?.byId.get(card.id);
      if (!graph || !move) {
        pending.delete(card.id);
        continue;
      }
      // A transposed position: each review takes the next move order into it (most common first),
      // so over time you practice reaching it every way your repertoire allows.
      const orders = ordersFor(moveOrders(graph, move.fromKey, setup.probs.get(scopeId), 16), move).slice(0, 8);
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
      const steps = planLine(graph, move, pending, learn ? 'learn' : 'review', { leadIn: !learn, via: orders[index], seen, teach: learn ? undefined : teachRef.current });
      if (!steps.some((s) => s.kind === 'quiz' || s.kind === 'show')) {
        pending.delete(card.id);
        continue;
      }
      setLine({
        repId: scopeId,
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
    // Then the positions you missed, again.
    const rr = repeatRef.current;
    const missed = [...missedPosRef.current.keys()];
    if (missed.length) {
      if (!rr.started) {
        rr.started = true;
        rr.queue = shuffled(missed);
        rr.round = 1;
        rr.roundMissed = false;
      } else if (!rr.queue.length && untilRightRef.current && rr.roundMissed) {
        rr.queue = shuffled(missed);
        rr.round++;
        rr.roundMissed = false;
      }
      const id = rr.queue.shift();
      const item = id ? missedPosRef.current.get(id) : undefined;
      if (item) {
        // Straight to the position: the moves before it are already on the board.
        let p: Chess = startPos();
        for (const m of item.path.slice(0, -1)) {
          const r = playUci(p, m.uci);
          if (r) p = r.pos;
        }
        setLine({ repId: item.scopeId, steps: item.path.map((m, i) => ({ move: m, kind: i === item.path.length - 1 ? 'practice' : 'auto' })), phase: 'quiz', repeat: true });
        setIdx(item.path.length - 1);
        setPos(p);
        setLastMove(item.path.length > 1 ? item.path[item.path.length - 2].uci : undefined);
        setWrong(0);
        setHint(false);
        setFeedback(null);
        setRepeatInfo({ left: rr.queue.length + 1, total: missed.length, round: rr.round });
        return;
      }
    }
    setLine(null);
    setFinished(true);
  }, [mode, queue, setup.probs, scopeIdOf]);

  useEffect(() => {
    nextLine();
  }, [nextLine]);

  // The move you last missed — its note opens for reading/editing once the answer is revealed.
  const [noteMove, setNoteMove] = useState<{ id: string; san: string } | undefined>();
  useEffect(() => setNoteMove(undefined), [line]);
  // A finished line waits for Continue (so you can edit it or its note) — unless Auto-advance is on,
  // which still stops after a missed move so you can write down why.
  // (Missed positions again go straight on when you get them right.)
  // A review line that taught you new moves isn't over: their replay comes next.
  const teaching = !!line && line.phase === 'quiz' && !line.repeat && !line.newMoves && line.steps.some((s) => s.kind === 'show');
  // Plans: at the line's end (its last pass — not before the replay of new moves, not missed
  // positions), its plan to recall, or a box to write one when it's a line end without any.
  const plans = useAllPlans();
  const [planShown, setPlanShown] = useState(false);
  useEffect(() => setPlanShown(false), [line]);
  const linePath = line ? line.steps.map((st) => st.move) : [];
  const lineGraph = line ? graphsRef.current.get(line.repId) : undefined;
  const atLineEnd = !!line && line.phase === 'quiz' && idx >= line.steps.length && !line.repeat && !teaching;
  const cover = plans && linePath.length ? planCover(linePath, plans) : undefined;
  const endMove = linePath[linePath.length - 1];
  const isLineEnd = !!endMove && endMove.mine && !!lineGraph && lineGraph.childrenOf(endMove.toKey).length === 0;
  const planAtEnd = atLineEnd && cover && (cover.plan || isLineEnd) ? cover : undefined;
  // Recalling a plan waits for Continue, even with Auto-advance.
  const planHold = !!planAtEnd?.plan && live.trainRecallPlans;
  const holdAtEnd =
    !!line &&
    line.phase === 'quiz' &&
    idx >= line.steps.length &&
    ((teaching ? !!noteMove : (!live.trainAutoNext && !line.repeat) || !!noteMove) || planHold);
  // Learn: where a new line is going, up front.
  const planUpFront = line?.phase === 'show' && plans && lineGraph ? planAhead(lineGraph, linePath, plans) : undefined;
  // The lines you played (with the moves you missed), for the cards at the end of the session.
  const playedRef = useRef(new Map<string, { scopeId: string; path: RepMove[]; missed: Set<string> }>());
  const missedRef = useRef(new Set<string>());
  useEffect(() => {
    missedRef.current = new Set();
  }, [line]);
  const recordLine = () => {
    if (!line || line.phase !== 'quiz' || !line.steps.length || line.repeat) return;
    const path = line.steps.map((s) => s.move);
    const key = path.map((m) => m.id).join(' ');
    const had = playedRef.current.get(key);
    playedRef.current.set(key, { scopeId: line.repId, path, missed: new Set([...(had?.missed ?? []), ...missedRef.current]) });
  };
  /** The new moves a review line just taught you, from memory: the line again from move 1, quizzing only them. */
  const replayNewMoves = () => {
    if (!line) return;
    recordLine();
    setLine({ ...line, steps: newMovesQuiz(line.steps), newMoves: true });
    setIdx(0);
    setPos(startPos());
    setLastMove(undefined);
    setWrong(0);
    setHint(false);
    setFeedback({ kind: 'info', text: 'Now the new moves from memory — the rest is played for you.' });
  };
  const continueAfterLine = () => {
    if (teaching) return replayNewMoves();
    recordLine();
    setStats((s) => ({ ...s, lines: s.lines + 1 }));
    nextLine();
  };
  // Edit line opens the line in the chapter its last move comes from.
  const editLine = () => {
    const last = line?.steps[line.steps.length - 1];
    if (!line || !last) return;
    setEditing({ repId: line.repId, chapterId: chapterOfMoveId(sourcesOf(last.move)[0]), line: line.steps.map((s) => s.move.san).join(' ') });
  };
  // Back from the builder: reload what's being trained (moves may have been added or deleted), then go on.
  const finishEditing = async () => {
    if (!editing) return;
    const loaded = await loadScopeGraph(editing.repId);
    if (loaded) graphsRef.current = new Map(graphsRef.current).set(editing.repId, loaded.graph);
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
        } else if (teaching) {
          replayNewMoves();
        } else {
          recordLine();
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
  // Timed: a question that's graded, in a review or drill (Learn has just shown you the line; missed
  // positions coming back are practice).
  const limitMs = Math.max(0, live.trainAnswerSeconds || 0) * 1000;
  const timed =
    !!limitMs &&
    !!line &&
    !!step &&
    waiting &&
    line.phase === 'quiz' &&
    !line.repeat &&
    !line.newMoves &&
    mode !== 'learn' &&
    (step.kind === 'quiz' || (mode === 'drill' && step.kind === 'practice' && !gradedRef.current.has(step.move.id)));
  const rep = line ? reps.get(line.repId) : undefined;
  const graph = line ? graphsRef.current.get(line.repId) : undefined;

  // Your whole repertoire of a color (all its chapters), to tell a transposition from a mistake.
  const colorGraphs = useRef(new Map<string, Promise<RepGraph | undefined>>());
  const transposesInto = async (key: string, color: string | undefined): Promise<string[] | undefined> => {
    if (!color) return undefined;
    if (!colorGraphs.current.has(color)) colorGraphs.current.set(color, loadScopeGraph(color).then((l) => l?.graph));
    const g = (graph?.has(key) ? graph : undefined) ?? (await colorGraphs.current.get(color));
    return g?.has(key) ? (g.pathTo(key) ?? []).map((m) => m.san) : undefined;
  };

  // (Loaded ahead, so the first move that isn't your prep doesn't wait for it.)
  const lineColor = rep?.color ?? graph?.color;
  useEffect(() => {
    if (lineColor) void transposesInto('', lineColor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineColor]);

  const onMove = async (uci: string) => {
    if (!line || !step || !waiting) return;
    const r = playUci(pos, uci);
    if (!r) return;
    const expected = step.move;
    if (r.san === expected.san) {
      const ms = timed ? answerMs() : undefined;
      seenRef.current.add(expected.id);
      // Move the board first so the piece never jumps back while the grade is being saved.
      flashFor('good');
      setPos(r.pos);
      setLastMove(r.uci);
      setIdx(idx + 1);
      setWrong(0);
      setHint(false);
      if (line.phase !== 'quiz' || step.kind === 'show') {
        setFeedback({ kind: 'good', text: <b>✓ {expected.san}</b> });
        return;
      }
      if (step.kind === 'practice') {
        const missed = wrong > 0 || hint;
        if (missed) {
          setNoteMove(noteFor(expected));
          missedRef.current.add(expected.san);
          if (line.repeat) repeatRef.current.roundMissed = true;
          else missedPosRef.current.set(expected.id, { scopeId: line.repId, path: line.steps.slice(0, idx + 1).map((s) => s.move) });
        }
        const token = ++feedbackToken.current;
        // A drill counts every move you play as reviewed: one that isn't due yet has its interval
        // restarted from today (never grown — see gradeAhead). In a review line the moves around the
        // due ones are practice only.
        const graded = mode === 'drill' && !gradedRef.current.has(expected.id);
        const show = (g?: Grade) =>
          setFeedback({
            kind: missed ? 'hint' : 'good',
            text: (
              <>
                <b>{missed ? `${expected.san} — keep it in mind.` : `✓ ${expected.san}`}</b>
                {g !== undefined && <Speed grade={g} ms={ms} />}
              </>
            ),
          });
        show();
        if (graded) {
          gradedRef.current.add(expected.id);
          setStats((s) => ({ ...s, done: s.done + 1, correct: s.correct + (missed ? 0 : 1), failed: s.failed + (missed ? 1 : 0) }));
          void gradeAnswer(expected.id, { missed, ms, limitMs }, 'review', { ahead: true }).then(({ rating }) => token === feedbackToken.current && show(rating));
        }
        return;
      }
      gradedRef.current.add(expected.id);
      const failed = wrong > 0 || hint;
      if (failed) {
        setNoteMove(noteFor(expected));
        missedRef.current.add(expected.san);
        missedPosRef.current.set(expected.id, { scopeId: line.repId, path: line.steps.slice(0, idx + 1).map((s) => s.move) });
      }
      pendingRef.current.delete(expected.id);
      setStats((s) => ({ ...s, done: s.done + 1, correct: s.correct + (failed ? 0 : 1), failed: s.failed + (failed ? 1 : 0) }));
      // The grade (and so whether a quick answer is Easy) is settled where it's saved: gradeAnswer.
      const body = (g?: Grade, interval?: string) => (
        <>
          <b>{failed ? `${expected.san} — keep practicing it.` : `✓ ${expected.san}`}</b>
          {g !== undefined && <Speed grade={g} ms={ms} />}
          {interval && <span className="muted"> · next review in {interval}</span>}
          {/* No note after a correct answer: a missed move opens its note under the board instead. */}
        </>
      );
      const token = ++feedbackToken.current;
      setFeedback({ kind: failed ? 'hint' : 'good', text: body() });
      // The new moves' replay is learning them, as in Learn.
      if (line.newMoves) teachRef.current.delete(expected.id);
      const { card: updated, rating } = await gradeAnswer(expected.id, { missed: failed, ms, limitMs }, mode === 'learn' || line.newMoves ? 'learn' : 'review', {
        ahead: mode === 'drill' && !line.newMoves,
      });
      if (updated && token === feedbackToken.current) {
        setFeedback({ kind: failed ? 'hint' : 'good', text: body(rating, formatInterval(updated.due - Date.now())) });
      }
      return;
    }
    feedbackToken.current++;
    const alt = graph?.childrenOf(expected.fromKey).find((m) => m.mine && m.san === r.san);
    if (alt) {
      setFeedback({ kind: 'info', text: `${r.san} is also in your repertoire — here we're training your other move.` });
      return;
    }
    // Not your move here, but it gets to a position that is in your repertoire (1.d4 g6 2.e4 = 1.e4 g6
    // 2.d4): not a mistake, though it's the move you've prepared here that's being trained.
    const into = await transposesInto(r.key, rep?.color ?? graph?.color);
    if (into) {
      setFeedback({
        kind: 'info',
        text: (
          <>
            {r.san} gets you to a position from your repertoire ({formatLine(into)}), so it's not wrong. Here you've prepared something
            else, though. Try again.
          </>
        ),
      });
      return;
    }
    flashFor('bad');
    if (line.phase === 'show' || step.kind === 'show') {
      setFeedback({ kind: 'hint', text: `Play ${expected.san} (follow the arrow).` });
      return;
    }
    const w = wrong + 1;
    setWrong(w);
    if (w >= 2) {
      setHint(true);
      setNoteMove(noteFor(expected));
    }
    setFeedback({ kind: 'bad', text: <>✗ {r.san} is not your prep. {w >= 2 ? 'The arrow shows your move.' : 'Try again.'}</> });
  };

  const showAnswer = () => {
    setHint(true);
    if (step && waiting) setNoteMove(noteFor(step.move));
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
    if (line?.phase === 'show' || step.kind === 'show' || hint) return [{ uci: step.move.uci, brush: 'green' }];
    return [];
  }, [step, line?.phase, hint]);

  // Looking back through the line: `view` = moves shown (null: the live position). The board is
  // read-only while you look; stepping forward to the end (or ⏭) takes you back to play.
  const [view, setView] = useState<number | null>(null);
  useEffect(() => setView(null), [line]);
  const viewed = useMemo(() => {
    if (view === null || !line) return undefined;
    let p: Chess = startPos();
    for (const s of line.steps.slice(0, view)) {
      const r = playUci(p, s.move.uci);
      if (!r) break;
      p = r.pos;
    }
    return { pos: p, lastMove: view > 0 ? line.steps[view - 1].move.uci : undefined };
  }, [view, line]);
  const stepBack = useCallback(() => setView((v) => Math.max(0, (v ?? idx) - 1)), [idx]);
  const stepForward = useCallback(() => setView((v) => (v === null || v + 1 >= idx ? null : v + 1)), [idx]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        stepBack();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepForward();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stepBack, stepForward]);

  const total = queue.length;
  const progress = total ? (total - pendingRef.current.size) / total : 1;

  if (finished) {
    return (
      <div className="col" style={{ gap: 16, maxWidth: playedRef.current.size ? 1100 : 640, margin: '0 auto' }}>
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
            <a className="btn primary" href={mapHref(setup.reps.size === 1 ? [...setup.reps.keys()][0] : 'all')}>
              Back to the Map
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
        <SessionCards played={[...playedRef.current.values()]} reps={reps} />
      </div>
    );
  }

  const prevStep = line && idx > 0 ? line.steps[idx - 1] : undefined;
  const pathSoFar = line ? line.steps.slice(0, idx).map((s) => s.move.san) : [];

  if (editing) return <Builder key={editing.line} repId={editing.chapterId} initialLine={editing.line} onDone={() => void finishEditing()} />;

  const modeName = line?.repeat ? 'Missed positions' : mode === 'learn' ? 'Learn' : mode === 'drill' ? 'Drill' : 'Review';
  const counter =
    line?.repeat && repeatInfo
      ? `${repeatInfo.left} of ${repeatInfo.total} left${repeatInfo.round > 1 ? ` · round ${repeatInfo.round}` : ''}`
      : `${total - pendingRef.current.size} / ${total}`;
  const endButton = (
    <a className="btn small" href={mapHref(reps.size === 1 ? [...reps.keys()][0] : 'all')}>
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
      <label className="check">
        <input type="checkbox" checked={live.trainRepeatUntilRight} onChange={(e) => updateSettings({ trainRepeatUntilRight: e.target.checked })} />
        <span>
          <b>Missed positions until right</b> — at the end of a session, the positions you missed come back in random order (always
          once); with this on, again until you get all of them right in a row.
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={live.thumbRight} onChange={(e) => updateSettings({ thumbRight: e.target.checked })} />
        <span>
          <b>Right thumb</b> — on a phone, the main buttons (Continue, Show move, Check, Next) on the right, where your right thumb is.
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={live.trainRecallPlans} onChange={(e) => updateSettings({ trainRecallPlans: e.target.checked })} />
        <span>
          <b>Recall plans</b> — at the end of a line with a plan, say what you're aiming for before it's shown (the line waits for
          Continue). Off: the plan is just shown.
        </span>
      </label>
      <label className="answer-timer">
        <AnswerTimerInput />
        <span>
          <b>Answer timer</b> — seconds per move in reviews and drills (0 = off). A right answer in time is Good, slower Hard — and
          Easy when you play it at once (in the first quarter of the time, 2 s at most) on a move that's already in regular reviews and
          that you didn't miss last time. Moves you know cold come back later, ones you have to dig for sooner.
        </span>
      </label>
      <div className="muted small">Changes apply from the next line.</div>
    </div>
  );
  const looking = viewed !== undefined;
  const board = (
    <Board
      pos={viewed?.pos ?? pos}
      orientation={rep?.color ?? 'white'}
      interactive={waiting && !looking}
      lastMove={looking ? viewed.lastMove : lastMove}
      onMove={onMove}
      arrows={looking ? [] : arrows}
      flash={looking ? undefined : flash}
    />
  );
  const navBar = idx > 0 && (
    <div className="row train-nav">
      <button className="small" onClick={() => setView(0)} disabled={view === 0} title="Start of the line" aria-label="Start of the line">
        ⏮
      </button>
      <button className="small" onClick={stepBack} disabled={view === 0} title="Back (←)" aria-label="Back">
        ◀
      </button>
      <button className="small" onClick={stepForward} disabled={!looking} title="Forward (→)" aria-label="Forward">
        ▶
      </button>
      <button className="small" onClick={() => setView(null)} disabled={!looking} title="Back to where you are" aria-label="Back to where you are">
        ⏭
      </button>
      {looking && (
        <span className="muted small">
          Looking back — {!view ? 'the starting position' : `after ${compactLine([pathSoFar[view - 1]], view - 1)}`}. ▶ or ⏭ to carry on.
        </span>
      )}
    </div>
  );
  // Lichess analysis and the FEN to copy (e.g. into Chessable) — only once the line is over and waits
  // for Continue, so they can't give a move away. Of the position on the board: stepping back through
  // the line (◀) shows that position's FEN, not the line's end.
  const tools = holdAtEnd && (
    <PositionTools pos={viewed?.pos ?? pos} ply={view ?? pathSoFar.length} orientation={rep?.color ?? 'white'} />
  );
  const note = noteMove && <MoveNote key={noteMove.id} id={noteMove.id} san={noteMove.san} label="(missed)" prompt compact={phone} />;
  // The plan at the line's end: recall it, then see it (with where it was written) — or, at a line end
  // without one, write it.
  const planWhere = (p: PlanRef) => {
    const i = linePath.findIndex((m) => m.toKey === p.move.toKey);
    return i >= 0 ? afterMove(linePath[i], i) : 'from a transposed line';
  };
  const planPanel = planAtEnd && endMove && (planAtEnd.plan || holdAtEnd) && (
    <div className="train-plan">
      {planAtEnd.plan ? (
        live.trainRecallPlans && !planShown ? (
          <>
            <div>
              <b>What's the plan here?</b> <span className="muted small">Put it in words — then check.</span>
            </div>
            <button className="small primary" onClick={() => setPlanShown(true)}>
              Show the plan
            </button>
          </>
        ) : (
          <>
            <div>
              <b>Plan</b>{' '}
              <span className="muted small">
                {planWhere(planAtEnd.plan)}
                {planAtEnd.status === 'far' ? ` — ${Math.ceil(planAtEnd.back! / 2)} moves back` : ''}
              </span>
            </div>
            <div className="plan-text">{planAtEnd.plan.text}</div>
            {planAtEnd.status === 'far' && isLineEnd && (
              <div className="row" style={{ gap: 6 }}>
                <button className="small" onClick={() => void setPlanStill(sourcesOf(endMove), true)} title="Counts as this line's plan">
                  Still applies
                </button>
                <span className="muted small">or write one for this line with Edit line</span>
              </div>
            )}
          </>
        )
      ) : (
        <>
          <div>
            <b>No plan for this line yet</b> <span className="muted small">— what are you aiming for once the moves run out?</span>
          </div>
          <PlanNote id={sourcesOf(endMove)[0]} placeholder="Pawn breaks, where the pieces go, what to attack…" rows={2} />
        </>
      )}
      {holdAtEnd && (planShown || !planAtEnd.plan || !live.trainRecallPlans) && <MasterGames fenKey={endMove.toKey} max={3} />}
    </div>
  );
  const lineLabel = <h3 style={{ margin: 0 }}>{line?.phase === 'show' ? 'New line' : line?.newMoves ? 'New moves, from memory' : 'Line'}</h3>;
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
      {planUpFront && (
        <div className="train-plan ahead small">
          <span className="muted">Where this line is going:</span> {planUpFront.text}
        </div>
      )}
      {waiting && (line?.phase === 'show' || step?.kind === 'show') && (
        <div>
          <b>{line?.phase === 'quiz' ? `New move — you haven't learned this one yet. Play ${step!.move.san}` : `Play ${step!.move.san}`}</b>
          {step!.move.comment && <div style={{ marginTop: 4 }}>{step!.move.comment}</div>}
        </div>
      )}
      {feedback && <div style={{ marginBottom: 4, marginTop: waiting && (line?.phase === 'show' || step?.kind === 'show') ? 6 : 0 }}>{feedback.text}</div>}
      {timed && <AnswerClock key={`${line?.steps.map((x) => x.move.id).join()}|${idx}`} limitMs={limitMs} elapsed={answerMs} />}
      {waiting && line?.phase === 'quiz' && step?.kind !== 'show' && feedback?.kind !== 'bad' && <b>Your move — what's your prep here?</b>}
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
      {planPanel}
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
            <button onClick={showAnswer} disabled={!waiting || hint || step?.kind === 'show'}>
              Show move
            </button>
          )}
          {line?.repeat ? (
            <button onClick={() => (setLine(null), setFinished(true))} title="End the session here">
              Skip the rest
            </button>
          ) : (
            <button onClick={skipLine}>Skip line</button>
          )}
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
        <div className="tp-board" ref={boardSize.boardRef} style={{ '--board-scale': boardSize.scale } as CSSProperties}>
          {board}
        </div>
        {boardSize.grip}
        {navBar}
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
              {tools}
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
        {navBar}
        {tools}
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

/**
 * The lines you played this session as cards (like the map's): what you missed, and where each line
 * stands now that this session's grades are in.
 */
function SessionCards({ played, reps }: { played: { scopeId: string; path: RepMove[]; missed: Set<string> }[]; reps: Map<string, Scope> }) {
  const cards = useCards();
  const { chapters } = useChaptersAndSets();
  if (!played.length || !cards || !chapters) return null;
  const byId = new Map(cards.map((c) => [c.id, c]));
  const now = Date.now();
  const today = startOfToday();
  // Missed lines first: they're the ones to look at.
  const sorted = [...played].sort((a, b) => (b.missed.size ? 1 : 0) - (a.missed.size ? 1 : 0));
  return (
    <div className="col" style={{ gap: 10 }}>
      <h2 style={{ margin: 0 }}>
        {played.length} line{played.length === 1 ? '' : 's'} practiced
      </h2>
      <div className="session-cards">
        {sorted.map(({ scopeId, path, missed }) => {
          const last = path[path.length - 1];
          const chapterId = chapterOfMoveId(sourcesOf(last)[0]);
          const chapter = chapters.find((c) => c.id === chapterId);
          const color = reps.get(scopeId)?.color ?? chapter?.color ?? 'white';
          const line = mapLine(path, byId, now, today);
          return (
            <LineCard
              key={path.map((m) => m.id).join(' ')}
              className={`panel ${missed.size ? 'missed' : 'clean'}`}
              eyebrow={chapter?.name ?? 'Line'}
              title={missed.size ? <span className="warn-text">✗ Missed {[...missed].join(', ')}</span> : <span className="good-text">✓ All right</span>}
              line={line}
              color={color}
              actions={
                <a className="btn small" href={href(`repertoire/${chapterId}`, { line: path.map((m) => m.san).join(' ') })}>
                  Open in builder
                </a>
              }
            />
          );
        })}
      </div>
    </div>
  );
}
