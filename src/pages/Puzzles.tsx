/**
 * The Puzzles tab: Lichess puzzles — the tactics third of the 1/3 rule (issue #1: openings, games and
 * their review, tactics). Picked by Lichess as a healthy mix, from your own openings or by theme, at
 * the difficulty you choose; solved here on the board. With Lichess connected (puzzle permissions)
 * they're picked around your Lichess puzzle rating, and your results can count toward it. Every
 * puzzle is kept in your history (synced), with the time it took — for the 1/3 balance.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Chess } from 'chessops/chess';
import { db } from '../db/db';
import { updateSettings, useSettings } from '../db/settings';
import { useChaptersAndSets } from '../db/scopes';
import { Board } from '../components/Board';
import { useOpeningIndex } from '../components/ChapterTree';
import { ConnectLichessButton } from '../components/LichessConnect';
import { Stat, TableWrap, fmtDate } from '../components/ui';
import { startOfToday, useChapterGraphs } from '../hooks';
import { chapterPosition } from '../lib/chapters';
import { opposite, playUci, type Color } from '../lib/chess';
import { MaterialBalance } from '../components/MaterialBalance';
import { nameParts } from '../lib/openingNames';
import { judgeMove, openingAngle, PUZZLE_DIFFICULTIES, PUZZLE_THEMES, puzzleStart, type LichessPuzzle, type PuzzleDifficulty, type PuzzleStart } from '../lib/puzzle';
import type { PuzzleAttempt } from '../lib/types';
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
  const settings = useSettings();
  const [glicko, setGlicko] = useState<Glicko>();
  if (!settings.loaded) return null;
  const canRead = hasScope(settings, 'puzzle:read');
  const canWrite = hasScope(settings, 'puzzle:write');
  return (
    <div className="col puzzles" style={{ gap: 14 }}>
      <div className="row">
        <h1 style={{ margin: 0 }}>Puzzles</h1>
        {glicko && (
          <span className="badge" title={`Your Lichess puzzle rating (±${Math.round(glicko.deviation)})`}>
            {Math.round(glicko.rating)}
            {glicko.provisional ? '?' : ''} on Lichess
          </span>
        )}
        <span className="spacer" />
        <TodayTally />
      </div>
      <ConnectionNote connected={!!settings.lichessToken} canRead={canRead} />
      <PuzzlePicker canWrite={canWrite} />
      <PuzzleSession key={`${settings.puzzleAngle}|${settings.puzzleDifficulty}`} onGlicko={setGlicko} />
      <History />
    </div>
  );
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

interface Current {
  puzzle: LichessPuzzle;
  start: PuzzleStart;
  pos: Chess;
  lastMove?: string;
  /** Index in the solution of the move you're to find (even: yours). */
  step: number;
  /** A wrong move was played, or the solution shown: the puzzle counts as lost. */
  failed: boolean;
  done: boolean;
  startedAt: number;
}

type Feedback = { kind: 'good' | 'bad' | 'info' | 'hint'; text: string } | null;

function PuzzleSession({ onGlicko }: { onGlicko: (g: Glicko) => void }) {
  const settings = useSettings();
  const angle = settings.puzzleAngle;
  const difficulty = settings.puzzleDifficulty;
  const [queue, setQueue] = useState<LichessPuzzle[]>([]);
  const [cur, setCur] = useState<Current>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [flash, setFlash] = useState<'good' | 'bad' | null>(null);
  const [result, setResult] = useState<{ ratingDiff?: number; rated: boolean }>();
  const clock = useVisibleClock();
  const seen = useRef(new Set<string>());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const later = (f: () => void, ms: number) => timers.current.push(setTimeout(f, ms));
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
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

  // Start: the opponent's move that sets the puzzle up is played, then it's your turn.
  const begin = useCallback(
    (p: LichessPuzzle) => {
      const start = puzzleStart(p);
      if (!start) {
        setQueue((q) => q.filter((x) => x !== p));
        return;
      }
      timers.current.forEach(clearTimeout);
      setResult(undefined);
      setFeedback(null);
      setCur({ puzzle: p, start, pos: start.before, step: 0, failed: false, done: false, startedAt: Date.now() });
      later(() => {
        setCur((c) => (c && c.puzzle === p ? { ...c, pos: start.pos, lastMove: start.lastMove } : c));
        setFeedback({ kind: 'info', text: `Your turn — find the best move for ${start.color === 'white' ? 'White' : 'Black'}.` });
        clock.reset();
      }, 450);
    },
    [clock],
  );

  useEffect(() => {
    if (!queue.length && !loading && !error) void load();
  }, [queue.length, loading, error, load]);
  useEffect(() => {
    if (!cur && queue.length) begin(queue[0]);
  }, [cur, queue, begin]);

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
    } catch (e) {
      setResult({ rated: false });
      setError(`Not counted on Lichess: ${(e as Error).message}`);
    }
  };

  const onMove = (uci: string) => {
    if (!cur || cur.done) return;
    const sol = cur.puzzle.puzzle.solution;
    const verdict = judgeMove(cur.pos, sol, cur.step, uci);
    const played = playUci(cur.pos, uci);
    if (verdict === 'wrong' || !played) {
      setFlash('bad');
      later(() => setFlash(null), 600);
      setCur({ ...cur, failed: true });
      setFeedback({ kind: 'bad', text: cur.failed ? 'Not that either — try again, or show the solution.' : 'That’s not it — the puzzle counts as missed. Try again, or show the solution.' });
      return;
    }
    setFlash('good');
    later(() => setFlash(null), 500);
    if (verdict === 'solved') {
      const done = { ...cur, pos: played.pos, lastMove: played.uci, step: sol.length, done: true };
      setCur(done);
      setFeedback(cur.failed ? { kind: 'hint', text: 'Solved — but after a miss, so it counts as missed.' } : { kind: 'good', text: '✓ Solved!' });
      void finish(done, !cur.failed);
      return;
    }
    // Right: the opponent's reply follows.
    const next = { ...cur, pos: played.pos, lastMove: played.uci, step: cur.step + 1 };
    setCur(next);
    setFeedback({ kind: 'good', text: '✓ Best move — keep going.' });
    later(() => {
      const reply = playUci(played.pos, sol[cur.step + 1]);
      if (!reply) return;
      setCur((c) => (c && c.puzzle === cur.puzzle ? { ...c, pos: reply.pos, lastMove: reply.uci, step: cur.step + 2 } : c));
    }, 350);
  };

  const showSolution = () => {
    if (!cur || cur.done) return;
    const sol = cur.puzzle.puzzle.solution;
    const lost = { ...cur, failed: true, done: true };
    setCur(lost);
    setFeedback({ kind: 'hint', text: 'The solution:' });
    let pos = cur.pos;
    sol.slice(cur.step).forEach((u, i) => {
      const r = playUci(pos, u);
      if (!r) return;
      pos = r.pos;
      const at = r;
      later(() => setCur((c) => (c && c.puzzle === cur.puzzle ? { ...c, pos: at.pos, lastMove: at.uci } : c)), 500 * (i + 1));
    });
    void finish(lost, false);
  };

  const next = () => {
    timers.current.forEach(clearTimeout);
    setQueue((q) => q.slice(1));
    setCur(undefined);
  };

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

  const p = cur.puzzle.puzzle;
  const yourTurn = !cur.done && cur.pos.turn === cur.start.color && cur.pos !== cur.start.before;
  // Above and below the board, as in a game review: whose side it is, and the material balance.
  const side = (c: Color) => (
    <div className={`player-strip ${!cur.done && cur.pos.turn === c ? 'to-move' : ''}`}>
      <span className={`strip-dot ${c}`} />
      <span className="strip-name">{c === cur.start.color ? 'You' : 'Opponent'}</span>
      <span className="muted small">{c === 'white' ? 'White' : 'Black'}</span>
      <MaterialBalance pos={cur.pos} color={c} />
    </div>
  );
  return (
    <div className="board-layout puzzle-layout">
      <div className="board-col col puzzle-board">
        {side(opposite(cur.start.color))}
        <Board pos={cur.pos} orientation={cur.start.color} interactive={yourTurn} lastMove={cur.lastMove} onMove={onMove} flash={flash} />
        {side(cur.start.color)}
      </div>
      <div className="col" style={{ gap: 10 }}>
        <div className={`feedback ${feedback?.kind ?? ''}`}>
          <b>{feedback?.text ?? '…'}</b>
          {cur.done && (
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
        {error && cur && <div className="error small">{error}</div>}
        <div className="row">
          {!cur.done ? (
            <button onClick={showSolution}>Show solution</button>
          ) : (
            <button className="primary" onClick={next}>
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
}

/** Today's puzzles: how many, solved, time, and the change to your Lichess rating. */
function TodayTally() {
  const today = useLiveQuery(() => db.puzzleLog.where('startedAt').aboveOrEqual(startOfToday()).toArray(), []);
  if (!today?.length) return null;
  const wins = today.filter((a) => a.win).length;
  const ms = today.reduce((a, x) => a + x.ms, 0);
  const diff = today.reduce((a, x) => a + (x.ratingDiff ?? 0), 0);
  return (
    <span className="muted small">
      Today: <b>{today.length}</b> puzzle{today.length === 1 ? '' : 's'} · {wins} solved · {Math.max(1, Math.round(ms / 60000))} min
      {today.some((a) => a.rated) && (
        <>
          {' '}
          · <b className={diff >= 0 ? 'good-text' : 'warn-text'}>{diff >= 0 ? `+${diff}` : diff}</b> on Lichess
        </>
      )}
    </span>
  );
}

/** Your recent puzzles, and totals over the last 30 days. */
function History() {
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
                <td className="num small">{a.ratingDiff === undefined ? '—' : a.ratingDiff >= 0 ? `+${a.ratingDiff}` : a.ratingDiff}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}
