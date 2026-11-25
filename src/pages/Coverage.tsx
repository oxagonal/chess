/**
 * Coverage on the Map tab: the bar that runs the analysis (target, Run / Re-run, progress), the gaps it
 * finds for a scope, and the details (how the numbers come about, the positions to know).
 * The analysis itself is lib/coverage; running it, services/coverage.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { repTarget, updateSettings, useSettings } from '../db/settings';
import { setScopeTarget, useScopeGraph, type Scope } from '../db/scopes';
import { OneInNSlider } from '../components/OneInNSlider';
import { GameRangeSelect } from '../components/GameRangeSelect';
import { repertoireDepth } from '../lib/depth';
import { useCoverage } from '../hooks';
import { compareTargets, runCoverage, sourceLabel, effectiveBands, type TargetRow } from '../services/coverage';
import { COVERAGE_ALGO, likelyPositions, oneIn, pct } from '../lib/coverage';
import { formatLine } from '../lib/chess';
import type { RepGraph } from '../lib/graph';
import { Stat, TableWrap, fmtDate } from '../components/ui';
import { href } from '../router';
import type { CoverageResult, ProbabilitySource, GapBoost } from '../lib/types';
import { bandLabel } from '../lib/ratings';

/** Scopes whose coverage is being worked out right now (by any run bar). */
const activeRuns = new Set<string>();

/**
 * Running the coverage analysis of a scope (a color or a repertoire): its 1-in-N target, when it last
 * ran and with what, and Run / Re-run — with progress, and a note when the run is out of date.
 * `within`: said when the page shows a chapter, which is measured within its color's run.
 */
export function CoverageRunBar({ scopeId, within }: { scopeId: string; within?: string }) {
  const { scope, graph } = useScopeGraph(scopeId);
  const result = useCoverage(scopeId);
  const settings = useSettings();
  const [running, setRunning] = useState(false);
  const [queried, setQueried] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  const run = async () => {
    // One run per scope at a time (the bar can be on screen twice, and runs go on in the background).
    if (activeRuns.has(scopeId)) return;
    activeRuns.add(scopeId);
    setRunning(true);
    setError(null);
    setQueried(0);
    ctrl.current = new AbortController();
    try {
      await runCoverage(scopeId, { signal: ctrl.current.signal, onProgress: setQueried });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      activeRuns.delete(scopeId);
      setRunning(false);
    }
  };
  const n = scope ? repTarget(scope, settings) : 0;
  const stale = !!result && !!scope && scope.updatedAt > result.computedAt;
  const paramsChanged =
    !!result &&
    settings.loaded &&
    (result.paramsLabel !== sourceLabel(settings) ||
      Math.abs(result.threshold - 1 / n) > 1e-12 ||
      (result.chapterOneInN ?? 0) !== (settings.chapterOneInN || 0) ||
      result.algo !== COVERAGE_ALGO);
  const outdated = stale || paramsChanged;

  // Out of date (your chapters changed, here or on another device, or the settings did): it runs again
  // by itself, in the background — the explorer lookups it made before are cached, so it's quick.
  // Once per change: after a Cancel or an error it waits for you (or the next change).
  const tried = useRef<string | undefined>(undefined);
  const autoSig = result && scope ? `${scope.updatedAt}|${n}|${sourceLabel(settings)}|${settings.chapterOneInN}` : undefined;
  useEffect(() => {
    if (!outdated || running || !autoSig || !graph?.size || tried.current === autoSig) return;
    const t = setTimeout(() => {
      tried.current = autoSig;
      void run();
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outdated, running, autoSig, graph?.size]);

  if (!scope || !graph) return null;

  return (
    <div className="map-runbar col">
      <div className="row">
        <span className="small nowrap">
          Target <b>1 in {n}</b> games{' '}
          <button className="linklike small" onClick={() => setChanging(!changing)} aria-expanded={changing}>
            {changing ? 'done' : 'change'}
          </button>
        </span>
        <span className="muted small map-runbar-info">
          {result ? (
            <>
              Coverage run {fmtDate(result.computedAt)} · {result.paramsLabel}
            </>
          ) : (
            'No Coverage run yet'
          )}
          {within ? ` · ${within}` : ''}
        </span>
        <span className="spacer" />
        {!running ? (
          <button className={`small ${!result || outdated ? 'primary' : ''}`} onClick={run} disabled={graph.size === 0}>
            {result ? 'Re-run Coverage' : 'Run Coverage'}
          </button>
        ) : (
          <>
            <span className="muted small">Looked up {queried} positions…</span>
            <button className="small" onClick={() => ctrl.current?.abort()}>
              Cancel
            </button>
          </>
        )}
      </div>
      {changing && (
        <>
          <OneInNSlider value={n} onChange={(v) => void setScopeTarget(scope, v)} label={`Coverage target for ${scope.name}`} color={scope.color} />
          <label
            className="small inline-field"
            title="A rare opening (the Traxler, say) gets prepared well past the overall target: each chapter also covers the positions reached in at least 1 in this many of its own games — the games reaching its opening. Common openings are covered deeper by the overall target anyway."
          >
            Each chapter, at least 1 in
            <input
              type="number"
              min={0}
              step={10}
              value={settings.chapterOneInN}
              onChange={(e) => void updateSettings({ chapterOneInN: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
              style={{ width: 70 }}
            />
            of its own games <span className="muted">(0 = off)</span>
          </label>
        </>
      )}
      {error && <div className="error">{error}</div>}
      {outdated && (
        <div className="note">
          {stale ? 'Your chapters changed since this run. ' : ''}
          {paramsChanged ? 'Settings differ from the last run. ' : ''}
          {running ? 'Bringing the map up to date…' : tried.current === autoSig ? 'Re-run to bring the map up to date.' : 'Updating in a moment…'}
        </div>
      )}
      {settings.probabilitySource === 'lichess' && !result && !running && (
        <div className="muted small">
          Coverage works out how often each position comes up in your games, from Lichess games at your rating (Settings). The first run
          looks up every opponent position (one request at a time, cached for 30 days), so a big repertoire can take a few minutes.
        </div>
      )}
    </div>
  );
}

/** A gap (an opponent move you have no answer to) or a position where you have no move, from a run. */
export interface ScopeGap {
  key: string;
  /** The moves to it from the start; for a gap, the opponent's move last. */
  path: string[];
  /** The opponent's move (a gap); none: your move, nothing prepared. */
  san?: string;
  prob: number;
  /** Needs an answer only because the line is prepared deeper (a sharp line). */
  boost?: GapBoost;
}

/** A run's gaps and unprepared positions, likeliest first — those under `under` (a chapter's opening). */
export function scopeGaps(run: CoverageResult | undefined, under?: readonly string[]): ScopeGap[] {
  if (!run) return [];
  const inside = (path: readonly string[]) => !under || (path.length >= under.length && under.every((s, i) => path[i] === s));
  const out: ScopeGap[] = [
    ...run.gaps
      .filter((g) => inside([...g.path, g.san]))
      .map((g) => ({ key: `${g.fromKey}|${g.san}`, path: [...g.path, g.san], san: g.san, prob: g.prob, boost: g.boost })),
    ...run.unfinished.filter((u) => inside(u.path)).map((u) => ({ key: u.key, path: u.path, prob: u.prob, boost: u.boost })),
  ];
  return out.sort((a, b) => b.prob - a.prob);
}

/** The targets compared (plus the scope's own). */
const COMPARE = [100, 200, 300, 500, 1000];

/**
 * "What target do I need?": not covered, rare sidelines, gaps to fill and moves to know at several
 * targets side by side, for the scope a run is made for (a color or a repertoire) — computed on
 * demand (the deeper ones may look up more positions), nothing stored. A row sets that target.
 */
export function TargetComparison({ scopeId }: { scopeId: string }) {
  const settings = useSettings();
  const { scope } = useScopeGraph(scopeId);
  const [rows, setRows] = useState<TargetRow[]>();
  const [busy, setBusy] = useState<{ n: number; queried: number }>();
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  if (!scope) return null;
  const current = repTarget(scope, settings);
  const targets = [...new Set([...COMPARE, current])].sort((a, b) => a - b);
  const compare = async () => {
    setError(null);
    ctrl.current = new AbortController();
    setBusy({ n: targets[targets.length - 1], queried: 0 });
    try {
      setRows(await compareTargets(scopeId, targets, { signal: ctrl.current.signal, onProgress: (n, queried) => setBusy({ n, queried }) }));
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>Compare targets</h3>
        <span className="muted small">for {scope.name}</span>
        <span className="spacer" />
        {busy ? (
          <>
            <span className="muted small">
              1 in {busy.n}: looked up {busy.queried} positions…
            </span>
            <button className="small" onClick={() => ctrl.current?.abort()}>
              Cancel
            </button>
          </>
        ) : (
          <button className="small" onClick={compare}>
            {rows ? 'Compare again' : 'Compare targets'}
          </button>
        )}
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        What a run at each target would say about your lines as they are now. A deeper target turns rare sidelines into gaps to fill
        (so they only go away once you prepare them), and every gap is at least one more move to know. The deepest may look up more
        positions first.
      </p>
      {error && <div className="error">{error}</div>}
      {rows && (
        <TableWrap>
          <table className="data">
            <thead>
              <tr>
                <th>Target</th>
                <th className="num">Not covered</th>
                <th className="num">Rare sidelines</th>
                <th className="num" title="Gaps and unprepared positions — each at least one more move">
                  Gaps to fill
                </th>
                <th className="num hide-sm" title="Your-move positions you have now that come up at least that often">
                  Moves to know
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.n} className={r.n === current ? 'current-row' : ''}>
                  <td>
                    <b>1 in {r.n}</b>
                    {r.n === current && <span className="muted small"> · yours</span>}
                  </td>
                  <td className="num">{pct(r.notCovered, 0)}</td>
                  <td className="num">{pct(r.sidelines, 0)}</td>
                  <td className="num">{r.open}</td>
                  <td className="num hide-sm">{r.moves}</td>
                  <td>
                    {r.n !== current && (
                      <button className="small" onClick={() => void setScopeTarget(scope, r.n)} title={`Make 1 in ${r.n} the target for ${scope.name} (then re-run Coverage)`}>
                        Use
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </div>
  );
}

/**
 * How the coverage numbers come about, for the Map's details: what's assumed, where opponents' moves
 * come from, a few totals and the positions worth knowing cold.
 */
export function CoverageDetails({
  scope,
  graph,
  run,
  gaps,
  covered,
  onOpen,
  runScopeId,
}: {
  /** The scope runs are made for (a chapter's is its color's): compared at other targets. */
  runScopeId: string;
  scope: Scope;
  graph: RepGraph;
  run?: CoverageResult;
  gaps: ScopeGap[];
  /** Share of the scope's games your lines cover (1 − not covered). */
  covered?: number;
  onOpen: (sans: string[]) => void;
}) {
  const settings = useSettings();
  const positions = useMemo(() => (run ? likelyPositions(graph, run).filter((p) => graph.has(p.key)) : []), [graph, run]);
  const myPositions = positions.filter((p) => p.myTurn);
  const mine = run ? repertoireDepth(graph, run) : undefined;
  const n = run ? Math.round(1 / run.threshold) : repTarget(scope, settings);
  const open = gaps.length;

  return (
    <div className="col" style={{ gap: 12 }}>
      <p className="muted small" style={{ margin: 0 }}>
        Assuming you always play your prepared moves and opponents answer like the players below, how often does each position show up?
        Anything you'll meet in at least <b>1 in {n}</b> games is worth knowing — and opponent moves that common which your lines don't
        answer are the <b>gaps</b>.
      </p>
      <div className="row">
        <label className="field">
          <span>Opponent moves from</span>
          <select value={settings.probabilitySource} onChange={(e) => updateSettings({ probabilitySource: e.target.value as ProbabilitySource })}>
            <option value="lichess">Lichess games at my rating</option>
            <option value="mygames">My own opponents (imported games)</option>
            <option value="masters">Masters</option>
          </select>
        </label>
        {settings.probabilitySource === 'lichess' && (
          <div className="field small">
            <span>Rating bands · speeds</span>
            <div style={{ padding: '7px 0' }}>
              {effectiveBands(settings).map(bandLabel).join(', ')} · {settings.speeds.join(', ')}{' '}
              <a href={href('settings')} className="small">
                change
              </a>
            </div>
          </div>
        )}
        {settings.probabilitySource === 'mygames' && (
          <div className="field">
            <span>Opponent games from</span>
            <GameRangeSelect setting="opponentRange" />
          </div>
        )}
      </div>
      <TargetComparison scopeId={runScopeId} />
      {run && (
        <>
          <div className="grid3">
            <Stat value={myPositions.length} label="Your moves to know" hint={`Your-turn positions reached at least 1 in ${n} games`} />
            <Stat
              value={`${mine?.lines ?? 0} + ${open}`}
              label="Lines done + open"
              hint={`Done: your lines that end at a position reached at least 1 in ${n} games. Open: gaps and unprepared positions — each becomes at least one more line once you prepare it.`}
            />
            <Stat
              value={mine && mine.lines ? `${mine.avgMoves.toFixed(1)} moves` : '—'}
              label="Your average line length"
              hint={`Your finished lines (reached at least 1 in ${n} games), weighted by how often you reach them. Longest: ${mine ? Math.ceil(mine.maxMoves) : 0} moves.`}
            />
            <Stat
              value={covered ? `${(myPositions.length / (covered * 100)).toFixed(2)}` : '—'}
              label="Moves per 1% covered"
              hint={`Efficiency: your ${myPositions.length} moves at positions reached at least 1 in ${n} games, divided by the ${pct(covered ?? 0, 0)} of games they keep in your prep. Lower is better — lines where opponents' replies are concentrated buy more coverage per move.`}
            />
          </div>
          <div className="muted small">
            {fmtDate(run.computedAt)} · {run.paramsLabel} · {run.queried} positions looked up
            {run.noData.length ? ` · ${run.noData.length} with no database games` : ''}
          </div>
          <h3 style={{ margin: 0 }}>Positions to know ({myPositions.length})</h3>
          <p className="muted small" style={{ margin: 0 }}>
            Your move in each, at least 1 in {n} games. To train only these, turn on “Only train positions you'll meet…” on the Train tab.
          </p>
          <TableWrap>
            <table className="data">
              <thead>
                <tr>
                  <th>Your move after</th>
                  <th className="num">How often</th>
                  <th className="num" title="Of the games reaching it, the share your lines cover from there">
                    Covered
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {myPositions.map((p) => (
                  <tr key={p.key}>
                    <td className="mono small line-cell">{p.path.length ? formatLine(p.path) : 'Start'}</td>
                    <td className="num">{oneIn(p.prob)}</td>
                    <td className="num">{run.coverage?.[p.key] !== undefined ? pct(run.coverage[p.key], 0) : '—'}</td>
                    <td>
                      <button className="small" onClick={() => onOpen(p.path)}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </>
      )}
    </div>
  );
}
