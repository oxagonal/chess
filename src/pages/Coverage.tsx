import { useMemo, useRef, useState } from 'react';
import type { PageProps } from '../App';
import { repTarget, updateSettings, useSettings } from '../db/settings';
import { setScopeTarget, useChaptersAndSets, useScopeGraph } from '../db/scopes';
import { lineTarget } from '../db/repertoire';
import { defaultScope, ScopeSelect } from '../components/ScopeSelect';
import { OneInNSlider } from '../components/OneInNSlider';
import { GameRangeSelect } from '../components/GameRangeSelect';
import { repertoireDepth } from '../lib/depth';
import { useCoverage } from '../hooks';
import { runCoverage, sourceLabel, effectiveBands } from '../services/coverage';
import { likelyPositions, oneIn, pct } from '../lib/coverage';
import { formatLine } from '../lib/chess';
import { ColorPill, Empty, Stat, TableWrap, fmtDate } from '../components/ui';
import { href, navigate } from '../router';
import type { ProbabilitySource } from '../lib/types';
import { bandLabel } from '../lib/ratings';

export function CoveragePage({ route }: PageProps) {
  const { chapters, collections } = useChaptersAndSets();
  if (!chapters || !collections) return null;
  const repId = route.path[1] ?? defaultScope(chapters);
  if (!chapters.length) return <Empty>Create a chapter first — <a href={href('repertoire')}>Repertoire</a>.</Empty>;
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row">
        <h1 style={{ margin: 0 }}>Coverage</h1>
        <span className="spacer" />
        {repId && <ScopeSelect value={repId} onChange={(id) => navigate(`coverage/${id}`)} chapters={chapters} collections={collections} />}
      </div>
      {repId && <CoverageView key={repId} repId={repId} />}
    </div>
  );
}

type Tab = 'gaps' | 'unfinished' | 'positions';

function CoverageView({ repId }: { repId: string }) {
  const { scope: rep, graph } = useScopeGraph(repId);
  const result = useCoverage(repId);
  const settings = useSettings();
  const [running, setRunning] = useState(false);
  const [queried, setQueried] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('gaps');
  const ctrl = useRef<AbortController | null>(null);

  const positions = useMemo(() => (graph && result ? likelyPositions(graph, result) : []), [graph, result]);
  if (!rep || !graph) return null;

  const run = async () => {
    setRunning(true);
    setError(null);
    setQueried(0);
    ctrl.current = new AbortController();
    try {
      await runCoverage(repId, { signal: ctrl.current.signal, onProgress: setQueried });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const n = repTarget(rep, settings);
  const stale = result && rep.updatedAt > result.computedAt;
  const paramsChanged = result && (result.paramsLabel !== sourceLabel(settings) || Math.abs(result.threshold - 1 / n) > 1e-12);
  // Open a line in the chapter it belongs to (the deepest of its moves that a chapter has).
  const openLine = async (sans: string[]) => navigate(`repertoire/${await lineTarget(rep.color, sans)}`, { line: sans.join(' ') });
  const myPositions = positions.filter((p) => p.myTurn);
  const mine = result ? repertoireDepth(graph, result) : undefined;
  const linesDone = mine?.lines ?? 0;
  const rootCoverage = result
    ? (result.coverage?.[graph.root] ?? 1 - result.gaps.reduce((a, g) => a + g.prob, 0) - result.unfinished.reduce((a, u) => a + u.prob, 0))
    : 0;

  return (
    <>
      <div className="panel">
        <div className="row">
          <h2 style={{ margin: 0 }}>{rep.name}</h2>
          <ColorPill color={rep.color} />
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          Assuming you always play your prepared moves and opponents answer like players at your level, how often does each position show up?
          Anything you'll meet in at least <b>1 in {n}</b> games is worth knowing — and opponent moves that common which your
          repertoire doesn't answer are <b>gaps</b>.
        </p>
        <div className="row" style={{ marginTop: 8 }}>
          <OneInNSlider value={n} onChange={(v) => void setScopeTarget(rep, v)} label={`Coverage target for ${rep.name}`} color={rep.color} />
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
          <span className="spacer" />
          {!running ? (
            <button className="primary" onClick={run} disabled={graph.size === 0}>
              {result ? 'Re-run analysis' : 'Run analysis'}
            </button>
          ) : (
            <>
              <span className="muted">Looked up {queried} positions…</span>
              <button onClick={() => ctrl.current?.abort()}>Cancel</button>
            </>
          )}
        </div>
        {settings.probabilitySource === 'lichess' && !result && (
          <p className="muted small" style={{ marginTop: 8 }}>
            The first run looks up every opponent position in the Lichess explorer (one request at a time, cached for 30 days), so a big
            repertoire can take a few minutes. Re-runs are instant for positions already looked up.
          </p>
        )}
        {error && <div className="error">{error}</div>}
        {(stale || paramsChanged) && !running && (
          <div className="note" style={{ marginTop: 8 }}>
            {stale ? 'The repertoire changed since this analysis was run. ' : ''}
            {paramsChanged ? 'Settings differ from the last run. ' : ''}Re-run to refresh.
          </div>
        )}
      </div>

      {graph.size === 0 && <Empty>This repertoire is empty — add some moves first.</Empty>}

      {result && (
        <>
          <div className="grid3">
            <Stat value={result.gaps.length} label={`Gaps ≥ 1 in ${Math.round(1 / result.threshold)}`} hint="Common opponent moves you have no answer for" />
            <Stat value={result.unfinished.length} label="Unprepared positions" hint="Your turn, common position, no move prepared" />
            <Stat value={myPositions.length} label="Your moves to know" hint="Your-turn positions reached at least 1 in N games" />
            <Stat
              value={`${linesDone} + ${result.gaps.length + result.unfinished.length}`}
              label="Lines done + open"
              hint="Done: your lines that end at a position reached at least 1 in N games. Open: gaps and unprepared positions — each becomes at least one more line once you prepare it."
            />
            <Stat
              value={mine && mine.lines ? `${mine.avgMoves.toFixed(1)} moves` : '—'}
              label="Your average line length"
              hint={`Your finished lines (reached at least 1 in ${Math.round(1 / result.threshold)} games), weighted by how often you reach them. Longest: ${mine ? Math.ceil(mine.maxMoves) : 0} moves.`}
            />
            <Stat
              value={rootCoverage > 0 ? `${(myPositions.length / (rootCoverage * 100)).toFixed(2)}` : '—'}
              label="Moves per 1% covered"
              hint={`Efficiency: your ${myPositions.length} moves at positions reached at least 1 in ${Math.round(1 / result.threshold)} games, divided by the ${pct(rootCoverage, 0)} of games they keep in your prep. Lower is better — choosing lines where opponents' replies are concentrated buys more coverage per move.`}
            />
            <Stat
              value={pct(result.coverage?.[graph.root] ?? 1 - result.gaps.reduce((a, g) => a + g.prob, 0) - result.unfinished.reduce((a, u) => a + u.prob, 0), 0)}
              label="Coverage"
              hint={`Share of your games that stay inside your repertoire until positions get rarer than 1 in ${Math.round(1 / result.threshold)} games`}
            />
          </div>
          <div className="muted small">
            {fmtDate(result.computedAt)} · {result.paramsLabel} · {result.queried} positions looked up
            {result.noData.length ? ` · ${result.noData.length} with no database games` : ''}
          </div>

          <div className="panel">
            <div className="tabs">
              <button className={tab === 'gaps' ? 'active' : ''} onClick={() => setTab('gaps')}>
                Gaps ({result.gaps.length})
              </button>
              <button className={tab === 'unfinished' ? 'active' : ''} onClick={() => setTab('unfinished')}>
                Unprepared ({result.unfinished.length})
              </button>
              <button className={tab === 'positions' ? 'active' : ''} onClick={() => setTab('positions')}>
                Positions to know ({myPositions.length})
              </button>
            </div>

            {tab === 'gaps' &&
              (result.gaps.length ? (
                <TableWrap>
                <table className="data">
                  <thead>
                    <tr>
                      <th>After</th>
                      <th>Opponent plays</th>
                      <th className="num">How often</th>
                      <th className="num hide-sm">Of games there</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {result.gaps.map((g) => (
                      <tr key={g.fromKey + g.san}>
                        <td className="mono small line-cell">{g.path.length ? formatLine(g.path) : 'Start'}</td>
                        <td>
                          <b>{g.san}</b>
                        </td>
                        <td className="num">
                          <b>{oneIn(g.prob)}</b>
                        </td>
                        <td className="num hide-sm">{pct(g.freq)}</td>
                        <td>
                          <button className="small primary" onClick={() => openLine([...g.path, g.san])}>
                            Prepare<span className="hide-sm">&nbsp;answer</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </TableWrap>
              ) : (
                <Empty>No gaps at this threshold. Try a larger N to dig deeper.</Empty>
              ))}

            {tab === 'unfinished' &&
              (result.unfinished.length ? (
                <TableWrap>
                <table className="data">
                  <thead>
                    <tr>
                      <th>Position after</th>
                      <th className="num">How often</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {result.unfinished.map((u) => (
                      <tr key={u.key}>
                        <td className="mono small line-cell">{formatLine(u.path)}</td>
                        <td className="num">
                          <b>{oneIn(u.prob)}</b>
                        </td>
                        <td>
                          <button className="small primary" onClick={() => openLine(u.path)}>
                            Choose a move
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </TableWrap>
              ) : (
                <Empty>Every common position where it's your move has a prepared answer.</Empty>
              ))}

            {tab === 'positions' && (
              <>
                <p className="muted small">
                  Train only these by enabling “Only train likely positions” in Settings — Review and Learn will then skip rarer lines.
                </p>
                <TableWrap>
                <table className="data">
                  <thead>
                    <tr>
                      <th>Your move after</th>
                      <th className="num">How often</th>
                      <th className="num" title="Coverage from this position">Covered</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {myPositions.map((p) => (
                      <tr key={p.key}>
                        <td className="mono small line-cell">{p.path.length ? formatLine(p.path) : 'Start'}</td>
                        <td className="num">{oneIn(p.prob)}</td>
                        <td className="num">{result.coverage?.[p.key] !== undefined ? pct(result.coverage[p.key], 0) : '—'}</td>
                        <td>
                          <button className="small" onClick={() => openLine(p.path)}>
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
        </>
      )}
    </>
  );
}
