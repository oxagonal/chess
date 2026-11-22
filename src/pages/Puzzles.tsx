/**
 * The Puzzles tab: Lichess puzzles — the tactics third of the 1/3 rule (issue #1: openings, games and
 * their review, tactics). Picked by Lichess as a healthy mix, from your own openings or by theme, at
 * the difficulty you choose; solved here on the board. With Lichess connected (puzzle permissions)
 * they're picked around your Lichess puzzle rating, and your results can count toward it. Every
 * puzzle is kept in your history (synced), with the time it took — for the 1/3 balance.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { updateSettings, useSettings } from '../db/settings';
import { useChaptersAndSets } from '../db/scopes';
import { useOpeningIndex } from '../components/ChapterTree';
import { ConnectLichessButton } from '../components/LichessConnect';
import { Stat, TableWrap, fmtDate } from '../components/ui';
import { PHONE_QUERY, startOfToday, useActivityClock, useChapterGraphs, useMediaQuery } from '../hooks';
import { chapterPosition } from '../lib/chapters';
import type { Color } from '../lib/chess';
import { PuzzleSolver } from '../components/PuzzleSolver';
import { nameParts } from '../lib/openingNames';
import { difficultyAdvice, openingAngle, PUZZLE_DIFFICULTIES, PUZZLE_THEMES, puzzleStart, stepDifficulty, type LichessPuzzle, type PuzzleDifficulty } from '../lib/puzzle';
import { clock as fmtClock } from '../lib/quickReview';
import type { PuzzleAttempt } from '../lib/types';
import { puzzleTilt } from '../lib/tilt';
import { cardId, isDueCard, missedCard, MISS_REASONS, reviewed, type MissReason, type TacticCard } from '../lib/tacticCards';
import { holdsUp } from '../services/tactics';
import { moveNumberPrefix } from '../lib/chess';
import { href } from '../router';
import { startLichessLogin } from '../services/lichessAuth';
import { fetchPuzzles, hasScope, reportPuzzles, type Glicko } from '../services/puzzles';

const LICHESS = 'https://lichess.org';
const DIFFICULTY_LABEL: Record<PuzzleDifficulty, string> = {
  easiest: 'Easiest (−600)',
  easier: 'Easier (−300)',
  normal: 'Normal',
  harder: 'Harder (+300)',
  hardest: 'Hardest (+600)',
};

export function PuzzlesPage() {
  // Tactics: a third of your training (the Plan tab).
  useActivityClock({ third: 'tactics', what: 'puzzles' });
  const settings = useSettings();
  const [glicko, setGlicko] = useState<Glicko>();
  const active = blockActive(useBlock());
  const phone = useMediaQuery(PHONE_QUERY);
  const [settingsOpen, setSettingsOpen] = useState(false);
  if (!settings.loaded) return null;
  const canRead = hasScope(settings, 'puzzle:read');
  const canWrite = hasScope(settings, 'puzzle:write');
  const session = <PuzzleSession key={`${settings.puzzleAngle}|${settings.puzzleDifficulty}`} onGlicko={setGlicko} toolbar={phone ? (
    <button className="small" onClick={() => setSettingsOpen(true)} aria-label="Puzzle settings, your rating and history" title="Settings, your rating and history">
      ⚙
    </button>
  ) : undefined} />;
  // Phones: one screen — the puzzle; what to solve, the time, your rating and history behind ⚙ (the
  // puzzle stays as it is underneath).
  if (phone)
    return (
      <div className="col puzzles phone">
        {settingsOpen && (
          <div className="col pz-settings">
            <div className="row">
              <h2 style={{ margin: 0 }}>Puzzles</h2>
              {glicko && !active && (
                <span className="badge" title={`Your Lichess puzzle rating (±${Math.round(glicko.deviation)})`}>
                  {Math.round(glicko.rating)}
                  {glicko.provisional ? '?' : ''} on Lichess
                </span>
              )}
              <span className="spacer" />
              <button className="primary small" onClick={() => setSettingsOpen(false)}>
                Back to the puzzle
              </button>
            </div>
            <TodayTally hideRating={active} />
            <ConnectionNote connected={!!settings.lichessToken} canRead={canRead} />
            <PuzzlePicker canWrite={canWrite} />
            <History hideRating={active} />
          </div>
        )}
        <div className="pz-live" style={settingsOpen ? { display: 'none' } : undefined}>
          {session}
        </div>
      </div>
    );
  return (
    <div className="col puzzles" style={{ gap: 14 }}>
      <div className="row">
        <h1 style={{ margin: 0 }}>Puzzles</h1>
        {active && (
          <span className="muted small" title="Play for learning, not rating: your puzzle rating and its changes show when the block ends">
            Rating hidden until the block ends
          </span>
        )}
        {glicko && !active && (
          <span className="badge" title={`Your Lichess puzzle rating (±${Math.round(glicko.deviation)})`}>
            {Math.round(glicko.rating)}
            {glicko.provisional ? '?' : ''} on Lichess
          </span>
        )}
        <span className="spacer" />
        <TodayTally hideRating={active} />
      </div>
      <ConnectionNote connected={!!settings.lichessToken} canRead={canRead} />
      <PuzzlePicker canWrite={canWrite} />
      {session}
      <History hideRating={active} />
    </div>
  );
}

/* --------------------------------------------------------------- the block */

/** A puzzle done in this block. */
interface BlockAttempt {
  puzzle: LichessPuzzle;
  win: boolean;
  soft?: boolean;
  overTime?: boolean;
  ms: number;
  rated: boolean;
  ratingDiff?: number;
}

/**
 * A block of puzzles — how many is decided before you start (Studer's rule for games, kept for
 * puzzles): what you've done, and where you are: solving, a breather when the signs of tilt show, or
 * the summary at the end; and your misses when you go over them. Kept while the app is open, so
 * leaving the tab doesn't start a new block.
 */
interface Block {
  size: number;
  startedAt: number;
  attempts: BlockAttempt[];
  /** Attempts before this index were already let go with "Keep going". */
  resumeAt: number;
  stage: 'solve' | 'breather' | 'summary';
  /** Why the breather. */
  reason?: string;
}

let currentBlock: Block | null = null;
const blockListeners = new Set<() => void>();
function setBlock(b: Block | null) {
  currentBlock = b;
  blockListeners.forEach((l) => l());
}
function subscribeBlock(l: () => void) {
  blockListeners.add(l);
  return () => {
    blockListeners.delete(l);
  };
}
function useBlock(): Block | null {
  return useSyncExternalStore(subscribeBlock, () => currentBlock);
}
/** A block is under way (not at its summary): your rating stays out of sight until it ends. */
function blockActive(b: Block | null): boolean {
  return !!b && b.stage !== 'summary';
}
/** Your misses in the block, each once. */
function blockMisses(b: Block): LichessPuzzle[] {
  const out = new Map<string, LichessPuzzle>();
  for (const a of b.attempts) if (!a.win) out.set(a.puzzle.puzzle.id, a.puzzle);
  return [...out.values()];
}

/** What connecting Lichess (with puzzle permissions) adds, when it isn't. */
function ConnectionNote({ connected, canRead }: { connected: boolean; canRead: boolean }) {
  if (canRead) return null;
  return (
    <div className="note row" style={{ gap: 10 }}>
      <span style={{ flex: 1 }}>
        {connected
          ? 'Your Lichess connection is from before puzzles: reconnect once to get puzzles at your Lichess puzzle rating (ones you haven’t played) and to count your results there.'
          : 'Connect Lichess to get puzzles at your Lichess puzzle rating and to count your results there. Without it, puzzles are picked around 1500 and kept only here.'}
      </span>
      {connected ? (
        <button className="primary small" onClick={() => startLichessLogin()}>
          Reconnect Lichess
        </button>
      ) : (
        <ConnectLichessButton />
      )}
    </div>
  );
}

/** Your openings (from your chapters), as Lichess puzzle keys: each opening and its variation. */
function useOpeningAngles(): { color: Color; name: string; angle: string }[] {
  const { chapters } = useChaptersAndSets();
  const graphs = useChapterGraphs();
  const names = useOpeningIndex();
  return useMemo(() => {
    if (!chapters || !graphs || !names) return [];
    const out = new Map<string, { color: Color; name: string; angle: string }>();
    for (const ch of chapters) {
      const g = graphs.get(ch.id);
      if (!g) continue;
      // The deepest named position of the chapter's opening.
      const { moves } = chapterPosition(g, names, ch.name);
      let name: string | undefined;
      for (const m of moves) name = names.get(m.toKey) ?? name;
      if (!name) continue;
      const { family, variation } = nameParts(name);
      for (const n of variation ? [family, `${family}: ${variation}`] : [family]) {
        const angle = openingAngle(n);
        if (!out.has(angle)) out.set(angle, { color: ch.color, name: n, angle });
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [chapters, graphs, names]);
}

function PuzzlePicker({ canWrite }: { canWrite: boolean }) {
  const settings = useSettings();
  const openings = useOpeningAngles();
  const known = settings.puzzleAngle === 'mix' || PUZZLE_THEMES.some(([k]) => k === settings.puzzleAngle) || openings.some((o) => o.angle === settings.puzzleAngle);
  return (
    <div className="panel row puzzle-picker">
      <label className="field">
        <span>Puzzles from</span>
        <select value={settings.puzzleAngle} onChange={(e) => updateSettings({ puzzleAngle: e.target.value })}>
          <option value="mix">A healthy mix</option>
          {(['white', 'black'] as Color[]).map((c) => {
            const mine = openings.filter((o) => o.color === c);
            return (
              mine.length > 0 && (
                <optgroup key={c} label={`Your ${c === 'white' ? 'White' : 'Black'} openings`}>
                  {mine.map((o) => (
                    <option key={o.angle} value={o.angle}>
                      {o.name}
                    </option>
                  ))}
                </optgroup>
              )
            );
          })}
          <optgroup label="Themes">
            {PUZZLE_THEMES.filter(([k]) => k !== 'mix').map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </optgroup>
          {!known && <option value={settings.puzzleAngle}>{settings.puzzleAngle.replace(/_/g, ' ')}</option>}
        </select>
      </label>
      <label className="field">
        <span>Difficulty</span>
        <select value={settings.puzzleDifficulty} onChange={(e) => updateSettings({ puzzleDifficulty: e.target.value as PuzzleDifficulty })}>
          {PUZZLE_DIFFICULTIES.map((d) => (
            <option key={d} value={d}>
              {DIFFICULTY_LABEL[d]}
            </option>
          ))}
        </select>
      </label>
      <label className="field" title="Decide before you start: a block of puzzles, then a short break and your misses. A change applies to the next block.">
        <span>Block</span>
        <select
          value={settings.puzzleBlock}
          onChange={(e) => {
            const size = Number(e.target.value);
            void updateSettings({ puzzleBlock: size });
            if (currentBlock && !currentBlock.attempts.length) setBlock({ ...currentBlock, size });
          }}
        >
          {[5, 10, 15, 20, 30].map((n) => (
            <option key={n} value={n}>
              {n} puzzles
            </option>
          ))}
        </select>
      </label>
      <label className="field" title="The time you aim to spend per puzzle — pick puzzles hard enough that you solve about 70% within it (Solon: 5–10 min; Studer: go easier past 15)">
        <span>Time per puzzle</span>
        <select value={settings.puzzleBudgetMin} onChange={(e) => void updateSettings({ puzzleBudgetMin: Number(e.target.value) })}>
          {[1, 2, 3, 5, 10, 15].map((m) => (
            <option key={m} value={m}>
              {m} min
            </option>
          ))}
        </select>
      </label>
      <label className="check" title="Write your line to the end — your moves and their best replies — before anything is checked (other replies optional); off: move by move, as on Lichess">
        <input type="checkbox" checked={settings.puzzleWrite} onChange={(e) => updateSettings({ puzzleWrite: e.target.checked })} />
        <span className="small">Write the line first</span>
      </label>
      <label className="check" title={canWrite ? undefined : 'Connect Lichess (with puzzle permissions) first'}>
        <input type="checkbox" disabled={!canWrite} checked={canWrite && settings.puzzleRated} onChange={(e) => updateSettings({ puzzleRated: e.target.checked })} />
        <span className="small">Count toward my Lichess puzzle rating</span>
      </label>
    </div>
  );
}

/** Time on a puzzle while the app is on screen (switching away doesn't count). */
function useVisibleClock() {
  const c = useRef<{ spent: number; since: number | null }>({ spent: 0, since: null });
  useEffect(() => {
    const on = () => {
      const now = performance.now();
      if (document.hidden) {
        if (c.current.since !== null) {
          c.current.spent += now - c.current.since;
          c.current.since = null;
        }
      } else if (c.current.since === null) c.current.since = now;
    };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  const reset = useCallback(() => {
    c.current = { spent: 0, since: document.hidden ? null : performance.now() };
  }, []);
  const elapsed = useCallback(() => c.current.spent + (c.current.since === null ? 0 : performance.now() - c.current.since), []);
  return { reset, elapsed };
}

/** The puzzle being worked on, and when it started — a card when it's one you missed before. */
interface Current {
  puzzle: LichessPuzzle;
  startedAt: number;
  card?: TacticCard;
}

function PuzzleSession({ onGlicko, toolbar }: { onGlicko: (g: Glicko) => void; toolbar?: ReactNode }) {
  const settings = useSettings();
  const angle = settings.puzzleAngle;
  const difficulty = settings.puzzleDifficulty;
  const [queue, setQueue] = useState<LichessPuzzle[]>([]);
  const [cur, setCur] = useState<Current>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<{ ratingDiff?: number; rated: boolean }>();
  const clock = useVisibleClock();
  const b = useBlock();
  const seen = useRef(new Set<string>());
  const report = settings.puzzleRated && hasScope(settings, 'puzzle:write');

  const add = useCallback((ps: LichessPuzzle[]) => {
    const fresh = ps.filter((p) => !seen.current.has(p.puzzle.id));
    fresh.forEach((p) => seen.current.add(p.puzzle.id));
    setQueue((q) => [...q, ...fresh]);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const r = await fetchPuzzles(angle, { nb: 10, difficulty });
      if (r.glicko) onGlicko(r.glicko);
      if (!r.puzzles.length) setError('Lichess sent no puzzles for that — try another opening or theme.');
      add(r.puzzles);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [angle, difficulty, add, onGlicko]);

  const begin = useCallback(
    (p: LichessPuzzle, card?: TacticCard) => {
      if (!puzzleStart(p)) {
        if (card) doneCards.current.add(card.id);
        else setQueue((q) => q.filter((x) => x !== p));
        return;
      }
      setResult(undefined);
      if (!currentBlock) setBlock({ size: settings.puzzleBlock, startedAt: Date.now(), attempts: [], resumeAt: 0, stage: 'solve' });
      setCur({ puzzle: p, startedAt: Date.now(), card });
      clock.reset();
    },
    [clock, settings.puzzleBlock],
  );
  // Puzzles you missed before, due to solve again: mixed in, every other puzzle.
  const due = useLiveQuery(async () => (await db.tacticCards.where('due').belowOrEqual(Date.now()).toArray()).filter((c) => isDueCard(c, Date.now())), []);
  const doneCards = useRef(new Set<string>());
  const lastWasCard = useRef(false);

  useEffect(() => {
    if (!queue.length && !loading && !error) void load();
  }, [queue.length, loading, error, load]);
  // The next puzzle — unless the block is at a breather or its end: a card that's due (every other
  // puzzle, while there are some), else the next from Lichess.
  const solving = !b || b.stage === 'solve';
  useEffect(() => {
    if (cur || !solving || !due) return;
    const card = due.find((c) => !doneCards.current.has(c.id));
    if (card && (!lastWasCard.current || !queue.length)) begin(card.puzzle, card);
    else if (queue.length) begin(queue[0]);
  }, [cur, queue, begin, solving, due]);

  const budgetMs = settings.puzzleBudgetMin * 60_000;
  const finish = async (c: Current, win: boolean, soft = false) => {
    const ms = clock.elapsed();
    const overTime = ms > budgetMs;
    const attempt: PuzzleAttempt = {
      id: `${c.puzzle.puzzle.id}|${c.startedAt}`,
      puzzleId: c.puzzle.puzzle.id,
      rating: c.puzzle.puzzle.rating,
      themes: c.puzzle.puzzle.themes,
      angle,
      win,
      ...(soft ? { soft: true } : {}),
      ...(overTime ? { overTime: true } : {}),
      ...(c.card ? { review: true } : {}),
      ms: Math.round(ms),
      startedAt: c.startedAt,
    };
    if (currentBlock) setBlock({ ...currentBlock, attempts: [...currentBlock.attempts, { puzzle: c.puzzle, win, soft, overTime, ms, rated: false }] });
    await db.puzzleLog.put(attempt);
    // A card: when it comes back next (or it's done). A miss: it becomes one, back tomorrow.
    const now = Date.now();
    if (c.card) await db.tacticCards.put(reviewed((await db.tacticCards.get(c.card.id)) ?? c.card, win && !overTime, now));
    else if (!win) await db.tacticCards.put(missedCard(c.puzzle, now, await db.tacticCards.get(cardId(c.puzzle.puzzle.id))));
    if (!report || c.card) {
      setResult({ rated: false });
      return;
    }
    try {
      // Lichess sends more puzzles along when the queue is getting short.
      const r = await reportPuzzles(angle, [{ id: attempt.puzzleId, win, rated: true }], { nb: queue.length < 4 ? 10 : 0, difficulty });
      const diff = r.rounds.find((x) => x.id === attempt.puzzleId)?.ratingDiff;
      await db.puzzleLog.update(attempt.id, { reported: true, rated: true, ratingDiff: diff });
      if (r.glicko) onGlicko(r.glicko);
      add(r.puzzles);
      setResult({ rated: true, ratingDiff: diff });
      if (currentBlock)
        setBlock({ ...currentBlock, attempts: currentBlock.attempts.map((a) => (a.puzzle === c.puzzle ? { ...a, rated: true, ratingDiff: diff } : a)) });
    } catch (e) {
      setResult({ rated: false });
      setError(`Not counted on Lichess: ${(e as Error).message}`);
    }
  };

  /** Why you missed it: kept with the attempt and the card (the pattern shows on this page). */
  const saveReason = async (c: Current, r: MissReason) => {
    await db.puzzleLog.update(`${c.puzzle.puzzle.id}|${c.startedAt}`, { reason: r });
    await db.tacticCards.update(cardId(c.puzzle.puzzle.id), { reason: r });
  };

  // After each puzzle: the block's end, a breather if you're tilting, or the next one.
  const next = () => {
    if (cur?.card) doneCards.current.add(cur.card.id);
    else setQueue((q) => q.slice(1));
    lastWasCard.current = !!cur?.card;
    setCur(undefined);
    const bl = currentBlock;
    if (!bl) return;
    if (bl.attempts.length >= bl.size) return setBlock({ ...bl, stage: 'summary' });
    const reason = puzzleTilt(bl.attempts.slice(bl.resumeAt));
    if (reason) setBlock({ ...bl, stage: 'breather', reason });
  };
  const mode = settings.puzzleWrite ? 'write' : 'play';

  // Phones: ⚙ always at hand (the block's bar has it while solving).
  const bar = toolbar && (
    <div className="row pz-toolbar">
      <b>Puzzles</b>
      <span className="spacer" />
      {toolbar}
    </div>
  );
  if (b?.stage === 'summary')
    return (
      <>
        {bar}
        <BlockSummary
        b={b}
        budgetMs={budgetMs}
        onAnother={() => setBlock(null)}
      />
      </>
    );
  if (b?.stage === 'breather')
    return (
      <>
      {bar}
      <div className="panel col breather" style={{ gap: 10 }}>
        <h2 style={{ margin: 0 }}>Take a breather</h2>
        <p style={{ margin: 0 }}>
          <b>{b.reason ? b.reason[0].toUpperCase() + b.reason.slice(1) : 'Time for a pause'}.</b> This is where puzzles turn into guessing, and the urge to win one back makes it worse. Stand up, get some
          water, come back calm — or stop here. Your misses come back tomorrow, to solve again cold.
        </p>
        <div className="row">
          <button className="primary" onClick={() => setBlock({ ...b, stage: 'summary' })}>
            End the block here
          </button>
          <span className="spacer" />
          <button className="small ghost" onClick={() => setBlock({ ...b, stage: 'solve', reason: undefined, resumeAt: b.attempts.length })}>
            Keep going anyway
          </button>
        </div>
      </div>
      </>
    );

  if (!cur)
    return (
      <>
      {bar}
      <div className="panel">
        {error ? (
          <div className="col" style={{ gap: 8 }}>
            <div className="error">{error}</div>
            <button className="small" style={{ alignSelf: 'flex-start' }} onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : (
          <div className="muted">Getting puzzles from Lichess…</div>
        )}
      </div>
      </>
    );

  // Has this puzzle's result gone into the block yet?
  const recorded = !!b?.attempts.some((a) => a.puzzle === cur.puzzle);
  const lastOne = !!b && b.attempts.length + (recorded ? 0 : 1) >= b.size;
  return (
    <div className="col pz-session" style={{ gap: 8 }}>
      {b ? <BlockProgress b={b} current={!recorded} review={cur.card} toolbar={toolbar} /> : bar}
      <PuzzleSolver
        key={`${cur.puzzle.puzzle.id}|${cur.startedAt}`}
        puzzle={cur.puzzle}
        mode={mode}
        report={report && !cur.card}
        review={!!cur.card}
        onReason={(r) => void saveReason(cur, r)}
        judgeAlt={cur.card?.game ? (key, uci) => holdsUp(key, uci, cur.card!.game!.best, cur.card!.game!.you) : undefined}
        gameNote={cur.card?.game && <GameNote card={cur.card} />}
        result={result}
        error={error}
        hideRating={blockActive(b)}
        timer={{ elapsed: clock.elapsed, budgetMs }}
        onResult={(win, soft) => void finish(cur, win, soft)}
        onNext={next}
        nextLabel={lastOne ? 'End of the block →' : 'Next puzzle →'}
      />
    </div>
  );
}

/** Where you are in the block: a dot per puzzle — solved, missed, this one, to come. */
function BlockProgress({ b, current, review, toolbar }: { b: Block; current: boolean; review?: TacticCard; toolbar?: ReactNode }) {
  const n = b.attempts.length + (current ? 1 : 0);
  return (
    <div className="row puzzle-block-bar">
      <b>
        Puzzle {Math.min(n, b.size)} of {b.size}
      </b>
      {review && (
        <span className="badge" title={`${review.game ? 'A mistake from your game' : 'You missed it'} ${fmtDate(review.createdAt)}${review.streak ? ` — solved again ${review.streak}× since` : ''}: solve it from scratch`}>
          {review.game ? `↻ from your game vs ${review.game.opponent}` : '↻ one you missed'}
        </span>
      )}
      <span className="block-dots" aria-hidden>
        {Array.from({ length: Math.max(b.size, b.attempts.length) }, (_, i) => (
          <span
            key={i}
            className={`block-dot ${i < b.attempts.length ? (b.attempts[i].win ? (b.attempts[i].soft ? 'win soft' : 'win') : 'miss') : i === b.attempts.length && current ? 'now' : ''}`}
          />
        ))}
      </span>
      {toolbar && (
        <>
          <span className="spacer" />
          {toolbar}
        </>
      )}
    </div>
  );
}

/** The end of a block: how it went, your misses, and a break before anything else. */
function BlockSummary({ b, budgetMs, onAnother }: { b: Block; budgetMs: number; onAnother: () => void }) {
  const settings = useSettings();
  const n = b.attempts.length;
  const advice = difficultyAdvice(b.attempts, budgetMs);
  const budgetMin = budgetMs / 60_000;
  const next = advice.step ? stepDifficulty(settings.puzzleDifficulty, advice.step) : undefined;
  const wins = b.attempts.filter((a) => a.win).length;
  const soft = b.attempts.filter((a) => a.soft).length;
  const misses = blockMisses(b);
  const minutes = Math.max(1, Math.round(b.attempts.reduce((s, a) => s + a.ms, 0) / 60_000));
  const rated = b.attempts.filter((a) => a.rated && a.ratingDiff !== undefined);
  const diff = rated.reduce((s, a) => s + (a.ratingDiff ?? 0), 0);
  return (
    <div className="panel col block-summary" style={{ gap: 12 }}>
      <h2 style={{ margin: 0 }}>{n >= b.size ? 'Block done' : `Block ended after ${n} puzzle${n === 1 ? '' : 's'}`}</h2>
      <div className="grid3">
        <Stat
          value={`${advice.inTime} / ${n}`}
          label={`Solved within ${budgetMin} min`}
          hint={`Solved ${wins} of ${n}${soft ? ` (${soft} soft — you answered a reply you hadn't written when it came up)` : ''}; ${advice.inTime} within your time per puzzle`}
        />
        <Stat value={fmtClock(advice.avgMs)} label={`Average · ${minutes} min in all`} />
        {rated.length > 0 ? (
          <Stat value={diff >= 0 ? `+${diff}` : String(diff)} label="Lichess puzzle rating" />
        ) : (
          <Stat value={misses.length} label={misses.length === 1 ? 'Miss to go over' : 'Misses to go over'} />
        )}
      </div>
      {misses.length > 0 && (
        <div className="col" style={{ gap: 4 }}>
          <b className="small">Your misses</b>
          {misses.map((p) => (
            <div key={p.puzzle.id} className="row small">
              <span className="warn-text">✗</span>
              <span>{p.puzzle.rating}</span>
              <span className="muted">{p.puzzle.themes.slice(0, 3).join(', ')}</span>
              <span className="spacer" />
              <a href={`${LICHESS}/training/${p.puzzle.id}`} target="_blank" rel="noreferrer">
                Lichess ↗
              </a>
            </div>
          ))}
        </div>
      )}
      <div className="row difficulty-advice">
        <span className="small">
          {advice.step === -1 ? (
            <>
              Under 60% solved in {budgetMin} min: the puzzles are harder than your time allows — <b>a step easier</b> next block.
            </>
          ) : advice.step === 1 ? (
            <>
              Over 85% solved, with time to spare: <b>a step harder</b> next block.
            </>
          ) : n < 3 ? (
            <>Too few puzzles to judge the difficulty.</>
          ) : (
            <>About right — around 70% solved within your time is the sweet spot.</>
          )}
        </span>
        {next && (
          <button className="small" onClick={() => void updateSettings({ puzzleDifficulty: next })}>
            {advice.step === -1 ? 'Make it easier' : 'Make it harder'} ({DIFFICULTY_LABEL[next]})
          </button>
        )}
      </div>
      <div className="note">
        Take five minutes off before anything else. Then another block only if you feel fresh and you're enjoying it.
        {misses.length > 0 && ' Your misses come back from tomorrow, mixed into your blocks, to solve again from scratch — that, not looking at the solution again, is what makes them stick.'}
      </div>
      <div className="row">
        <button className="primary" onClick={onAnother}>
          Start another block
        </button>
      </div>
    </div>
  );
}

/** Today's puzzles: how many, solved, time, and the change to your Lichess rating. */
function TodayTally({ hideRating }: { hideRating: boolean }) {
  const today = useLiveQuery(() => db.puzzleLog.where('startedAt').aboveOrEqual(startOfToday()).toArray(), []);
  if (!today?.length) return null;
  const wins = today.filter((a) => a.win).length;
  const ms = today.reduce((a, x) => a + x.ms, 0);
  const diff = today.reduce((a, x) => a + (x.ratingDiff ?? 0), 0);
  return (
    <span className="muted small">
      Today: <b>{today.length}</b> puzzle{today.length === 1 ? '' : 's'} · {wins} solved · {Math.max(1, Math.round(ms / 60000))} min
      {!hideRating && today.some((a) => a.rated) && (
        <>
          {' '}
          · <b className={diff >= 0 ? 'good-text' : 'warn-text'}>{diff >= 0 ? `+${diff}` : diff}</b> on Lichess
        </>
      )}
    </span>
  );
}

/** Your recent puzzles, and totals over the last 30 days. */
function History({ hideRating }: { hideRating: boolean }) {
  const recent = useLiveQuery(() => db.puzzleLog.orderBy('startedAt').reverse().limit(15).toArray(), []);
  const month = useLiveQuery(() => db.puzzleLog.where('startedAt').aboveOrEqual(Date.now() - 30 * 86_400_000).toArray(), []);
  const cards = useLiveQuery(() => db.tacticCards.toArray(), []);
  if (!recent || !month) return null;
  if (!recent.length) return null;
  const wins = month.filter((a) => a.win).length;
  // Why you missed (your taps), most common first — and what to do about the top one.
  const why = MISS_REASONS.map((r) => ({ ...r, n: month.filter((a) => a.reason === r.key).length }))
    .filter((r) => r.n > 0)
    .sort((x, y) => y.n - x.n);
  const waiting = (cards ?? []).filter((c) => !c.retired);
  const dueNow = waiting.filter((c) => isDueCard(c, Date.now())).length;
  const doneCount = (cards ?? []).filter((c) => c.retired).length;
  const minutes = Math.round(month.reduce((a, x) => a + x.ms, 0) / 60000);
  return (
    <div className="panel col puzzle-history" style={{ gap: 10 }}>
      <h2 style={{ margin: 0 }}>Your puzzles</h2>
      <div className="grid3">
        <Stat value={month.length} label="Puzzles (30 days)" />
        <Stat value={month.length ? `${Math.round((wins / month.length) * 100)}%` : '—'} label="Solved first time" />
        <Stat value={`${minutes} min`} label="Time on tactics (30 days)" hint="While the app was on screen — for the 1/3 balance of openings, games and tactics" />
      </div>
      {(why.length > 0 || waiting.length > 0 || doneCount > 0) && (
        <div className="col small puzzle-why" style={{ gap: 4 }}>
          {why.length > 0 && (
            <div>
              <span className="muted">Why you missed (30 days):</span>{' '}
              {why.map((r, i) => (
                <span key={r.key}>
                  {i > 0 && ' · '}
                  <b>{r.label}</b> {r.n}
                </span>
              ))}
              <div className="muted">Most often “{why[0].label.toLowerCase()}”: {why[0].tip}</div>
            </div>
          )}
          {(waiting.length > 0 || doneCount > 0) && (
            <div className="muted">
              Missed puzzles and your games' mistakes coming back: {dueNow} due now, {waiting.length - dueNow} later
              {doneCount > 0 && ` · ${doneCount} done (solved twice in a row)`}
            </div>
          )}
        </div>
      )}
      <TableWrap>
        <table className="data">
          <thead>
            <tr>
              <th>When</th>
              <th />
              <th className="num">Rating</th>
              <th className="hide-sm">Themes</th>
              <th className="num">Time</th>
              <th className="num" title="Change to your Lichess puzzle rating">
                Lichess
              </th>
            </tr>
          </thead>
          <tbody>
            {recent.map((a) => (
              <tr key={a.id}>
                <td className="small">{fmtDate(a.startedAt)}</td>
                <td>
                  <a
                    href={`${LICHESS}/training/${a.puzzleId}`}
                    target="_blank"
                    rel="noreferrer"
                    className={a.win ? (a.soft ? 'soft-text' : 'good-text') : 'warn-text'}
                    title={a.soft ? 'Solved — a soft pass: you answered a reply you hadn\u2019t written when it came up. Open on Lichess' : 'Open on Lichess'}
                  >
                    {a.win ? (a.soft ? '✓~' : '✓') : '✗'}
                  </a>
                </td>
                <td className="num">{a.rating}</td>
                <td className="small muted hide-sm">{a.themes.slice(0, 3).join(', ')}</td>
                <td className={`num small ${a.overTime ? 'warn-text' : ''}`} title={a.overTime ? 'Over your time per puzzle' : undefined}>
                  {fmtClock(a.ms)}
                </td>
                <td className="num small">{hideRating || a.ratingDiff === undefined ? '—' : a.ratingDiff >= 0 ? `+${a.ratingDiff}` : a.ratingDiff}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}

/** After a position from your game: what you played there, and the game. */
function GameNote({ card }: { card: TacticCard }) {
  const g = card.game!;
  const ply = card.puzzle.puzzle.initialPly + 1;
  return (
    <span>
      In your game vs <span className="keep-case">{g.opponent}</span> ({fmtDate(g.playedAt)}) you played{' '}
      <b className="warn-text">
        {moveNumberPrefix(ply, true)}
        {g.played}
      </b>{' '}
      ·{' '}
      <a href={href(`games/${encodeURIComponent(g.id)}`, { ply: String(ply) })} title="Open the game's review at this move">
        the game
      </a>
    </span>
  );
}
