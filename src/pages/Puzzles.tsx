/**
 * The Puzzles tab: Lichess puzzles — the tactics third of the 1/3 rule (issue #1: openings, games and
 * their review, tactics). Picked by Lichess as a healthy mix, from your own openings or by theme, at
 * the difficulty you choose; solved here on the board. With Lichess connected (puzzle permissions)
 * they're picked around your Lichess puzzle rating, and your results can count toward it. Every
 * puzzle is kept in your history (synced), with the time it took — for the 1/3 balance.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { updateSettings, useSettings } from '../db/settings';
import { useChaptersAndSets } from '../db/scopes';
import { useOpeningIndex } from '../components/ChapterTree';
import { ConnectLichessButton } from '../components/LichessConnect';
import { Stat, TableWrap, fmtDate } from '../components/ui';
import { startOfToday, useActivityClock, useChapterGraphs } from '../hooks';
import { chapterPosition } from '../lib/chapters';
import type { Color } from '../lib/chess';
import { PuzzleSolver } from '../components/PuzzleSolver';
import { nameParts } from '../lib/openingNames';
import { openingAngle, PUZZLE_DIFFICULTIES, PUZZLE_THEMES, puzzleStart, type LichessPuzzle, type PuzzleDifficulty } from '../lib/puzzle';
import type { PuzzleAttempt } from '../lib/types';
import { puzzleTilt } from '../lib/tilt';
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
  if (!settings.loaded) return null;
  const canRead = hasScope(settings, 'puzzle:read');
  const canWrite = hasScope(settings, 'puzzle:write');
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
      <PuzzleSession key={`${settings.puzzleAngle}|${settings.puzzleDifficulty}`} onGlicko={setGlicko} />
      <History hideRating={active} />
    </div>
  );
}

/* --------------------------------------------------------------- the block */

/** A puzzle done in this block. */
interface BlockAttempt {
  puzzle: LichessPuzzle;
  win: boolean;
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
  /** Going over your misses: the list, and which one. */
  retry?: { list: LichessPuzzle[]; i: number };
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
      <label className="check" title="Write your whole solution first — your moves, their replies, and their other sensible replies as branches — before anything is checked">
        <input type="checkbox" checked={settings.puzzleWrite} onChange={(e) => updateSettings({ puzzleWrite: e.target.checked })} />
        <span className="small">Write the solution first (with branches)</span>
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

/** The puzzle being worked on, and when it started. */
interface Current {
  puzzle: LichessPuzzle;
  startedAt: number;
}

function PuzzleSession({ onGlicko }: { onGlicko: (g: Glicko) => void }) {
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
    (p: LichessPuzzle) => {
      if (!puzzleStart(p)) {
        setQueue((q) => q.filter((x) => x !== p));
        return;
      }
      setResult(undefined);
      if (!currentBlock) setBlock({ size: settings.puzzleBlock, startedAt: Date.now(), attempts: [], resumeAt: 0, stage: 'solve' });
      setCur({ puzzle: p, startedAt: Date.now() });
      clock.reset();
    },
    [clock, settings.puzzleBlock],
  );

  useEffect(() => {
    if (!queue.length && !loading && !error) void load();
  }, [queue.length, loading, error, load]);
  // The next puzzle — unless the block is at a breather or its end, or you're going over misses.
  const solving = !b || (b.stage === 'solve' && !b.retry);
  useEffect(() => {
    if (!cur && queue.length && solving) begin(queue[0]);
  }, [cur, queue, begin, solving]);

  const finish = async (c: Current, win: boolean) => {
    const ms = clock.elapsed();
    const attempt: PuzzleAttempt = {
      id: `${c.puzzle.puzzle.id}|${c.startedAt}`,
      puzzleId: c.puzzle.puzzle.id,
      rating: c.puzzle.puzzle.rating,
      themes: c.puzzle.puzzle.themes,
      angle,
      win,
      ms: Math.round(ms),
      startedAt: c.startedAt,
    };
    if (currentBlock) setBlock({ ...currentBlock, attempts: [...currentBlock.attempts, { puzzle: c.puzzle, win, ms, rated: false }] });
    await db.puzzleLog.put(attempt);
    if (!report) {
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

  // After each puzzle: the block's end, a breather if you're tilting, or the next one.
  const next = () => {
    setQueue((q) => q.slice(1));
    setCur(undefined);
    const bl = currentBlock;
    if (!bl) return;
    if (bl.attempts.length >= bl.size) return setBlock({ ...bl, stage: 'summary' });
    const reason = puzzleTilt(bl.attempts.slice(bl.resumeAt));
    if (reason) setBlock({ ...bl, stage: 'breather', reason });
  };
  const goOverMisses = (bl: Block) => {
    const list = blockMisses(bl);
    if (list.length) setBlock({ ...bl, retry: { list, i: 0 } });
  };
  const mode = settings.puzzleWrite ? 'write' : 'play';

  if (b?.retry) {
    const { list, i } = b.retry;
    const last = i + 1 >= list.length;
    return (
      <div className="col" style={{ gap: 8 }}>
        <div className="row puzzle-block-bar">
          <b>Going over your misses</b>
          <span className="muted small">
            {i + 1} of {list.length} · not recorded
          </span>
        </div>
        <PuzzleSolver
          key={`retry|${list[i].puzzle.id}|${i}`}
          puzzle={list[i]}
          mode={mode}
          report={false}
          practice
          result={{ rated: false }}
          onResult={() => {}}
          onNext={() => setBlock({ ...b, retry: last ? undefined : { list, i: i + 1 } })}
          nextLabel={last ? (b.stage === 'summary' ? 'Back to the summary →' : 'Done →') : 'Next miss →'}
        />
      </div>
    );
  }
  if (b?.stage === 'summary')
    return (
      <BlockSummary
        b={b}
        onRetry={() => goOverMisses(b)}
        onAnother={() => setBlock(null)}
      />
    );
  if (b?.stage === 'breather')
    return (
      <div className="panel col breather" style={{ gap: 10 }}>
        <h2 style={{ margin: 0 }}>Take a breather</h2>
        <p style={{ margin: 0 }}>
          <b>{b.reason ? b.reason[0].toUpperCase() + b.reason.slice(1) : 'Time for a pause'}.</b> This is where puzzles turn into guessing, and the urge to win one back makes it worse. Stand up, get some
          water, come back calm — or stop here: going over your misses is worth more than new puzzles now.
        </p>
        <div className="row">
          <button className="primary" onClick={() => setBlock({ ...b, stage: 'summary' })}>
            End the block here
          </button>
          {blockMisses(b).length > 0 && <button onClick={() => goOverMisses(b)}>Go over the misses</button>}
          <span className="spacer" />
          <button className="small ghost" onClick={() => setBlock({ ...b, stage: 'solve', reason: undefined, resumeAt: b.attempts.length })}>
            Keep going anyway
          </button>
        </div>
      </div>
    );

  if (!cur)
    return (
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
    );

  // Has this puzzle's result gone into the block yet?
  const recorded = !!b?.attempts.some((a) => a.puzzle === cur.puzzle);
  const lastOne = !!b && b.attempts.length + (recorded ? 0 : 1) >= b.size;
  return (
    <div className="col" style={{ gap: 8 }}>
      {b && <BlockProgress b={b} current={!recorded} />}
      <PuzzleSolver
        key={`${cur.puzzle.puzzle.id}|${cur.startedAt}`}
        puzzle={cur.puzzle}
        mode={mode}
        report={report}
        result={result}
        error={error}
        hideRating={blockActive(b)}
        onResult={(win) => void finish(cur, win)}
        onNext={next}
        nextLabel={lastOne ? 'End of the block →' : 'Next puzzle →'}
      />
    </div>
  );
}

/** Where you are in the block: a dot per puzzle — solved, missed, this one, to come. */
function BlockProgress({ b, current }: { b: Block; current: boolean }) {
  const n = b.attempts.length + (current ? 1 : 0);
  return (
    <div className="row puzzle-block-bar">
      <b>
        Puzzle {Math.min(n, b.size)} of {b.size}
      </b>
      <span className="block-dots" aria-hidden>
        {Array.from({ length: Math.max(b.size, b.attempts.length) }, (_, i) => (
          <span key={i} className={`block-dot ${i < b.attempts.length ? (b.attempts[i].win ? 'win' : 'miss') : i === b.attempts.length && current ? 'now' : ''}`} />
        ))}
      </span>
    </div>
  );
}

/** The end of a block: how it went, your misses, and a break before anything else. */
function BlockSummary({ b, onRetry, onAnother }: { b: Block; onRetry: () => void; onAnother: () => void }) {
  const n = b.attempts.length;
  const wins = b.attempts.filter((a) => a.win).length;
  const misses = blockMisses(b);
  const minutes = Math.max(1, Math.round(b.attempts.reduce((s, a) => s + a.ms, 0) / 60_000));
  const rated = b.attempts.filter((a) => a.rated && a.ratingDiff !== undefined);
  const diff = rated.reduce((s, a) => s + (a.ratingDiff ?? 0), 0);
  return (
    <div className="panel col block-summary" style={{ gap: 12 }}>
      <h2 style={{ margin: 0 }}>{n >= b.size ? 'Block done' : `Block ended after ${n} puzzle${n === 1 ? '' : 's'}`}</h2>
      <div className="grid3">
        <Stat value={`${wins} / ${n}`} label="Solved first time" />
        <Stat value={`${minutes} min`} label="Time" />
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
      <div className="note">
        Take five minutes off before anything else. Then another block only if you feel fresh and you're enjoying it{misses.length ? ' — and going over your misses first is worth more than new puzzles' : ''}.
      </div>
      <div className="row">
        {misses.length > 0 && (
          <button className="primary" onClick={onRetry}>
            Go over your misses
          </button>
        )}
        <button className={misses.length ? '' : 'primary'} onClick={onAnother}>
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
  if (!recent || !month) return null;
  if (!recent.length) return null;
  const wins = month.filter((a) => a.win).length;
  const minutes = Math.round(month.reduce((a, x) => a + x.ms, 0) / 60000);
  return (
    <div className="panel col puzzle-history" style={{ gap: 10 }}>
      <h2 style={{ margin: 0 }}>Your puzzles</h2>
      <div className="grid3">
        <Stat value={month.length} label="Puzzles (30 days)" />
        <Stat value={month.length ? `${Math.round((wins / month.length) * 100)}%` : '—'} label="Solved first time" />
        <Stat value={`${minutes} min`} label="Time on tactics (30 days)" hint="While the app was on screen — for the 1/3 balance of openings, games and tactics" />
      </div>
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
                  <a href={`${LICHESS}/training/${a.puzzleId}`} target="_blank" rel="noreferrer" className={a.win ? 'good-text' : 'warn-text'} title="Open on Lichess">
                    {a.win ? '✓' : '✗'}
                  </a>
                </td>
                <td className="num">{a.rating}</td>
                <td className="small muted hide-sm">{a.themes.slice(0, 3).join(', ')}</td>
                <td className="num small">{Math.round(a.ms / 1000)} s</td>
                <td className="num small">{hideRating || a.ratingDiff === undefined ? '—' : a.ratingDiff >= 0 ? `+${a.ratingDiff}` : a.ratingDiff}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}
