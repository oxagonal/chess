import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { PageProps } from '../App';
import { db } from '../db/db';
import { useAllGraphs, useCards, useGames, useRepertoires, useRepGraph } from '../hooks';
import { computeInsights, type LineInsight } from '../lib/insights';
import { analyzeGame } from '../lib/prep';
import { difficultyLabel, formatInterval } from '../lib/srs';
import { formatLine } from '../lib/chess';
import { ColorPill, Empty, Stat } from '../components/ui';
import { href, navigate } from '../router';

export function InsightsPage({ route }: PageProps) {
  const reps = useRepertoires();
  const repId = route.path[1] ?? reps?.[0]?.id;
  if (!reps) return null;
  if (!reps.length) return <Empty>Create a repertoire first — <a href={href('repertoire')}>Repertoire</a>.</Empty>;
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row">
        <h1 style={{ margin: 0 }}>Insights</h1>
        <span className="spacer" />
        <select value={repId} onChange={(e) => navigate(`insights/${e.target.value}`)}>
          {reps.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} ({r.color})
            </option>
          ))}
        </select>
      </div>
      {repId && <InsightsView key={repId} repId={repId} />}
    </div>
  );
}

function masteryColor(m: number | undefined): string {
  if (m === undefined) return 'var(--muted)';
  if (m < 50) return 'var(--bad)';
  if (m < 75) return 'var(--warn)';
  return 'var(--good)';
}

function MasteryBar({ value }: { value: number | undefined }) {
  if (value === undefined) return <span className="muted small">not learned</span>;
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      <span style={{ width: 60, height: 8, background: 'var(--bg2)', borderRadius: 4, overflow: 'hidden', display: 'inline-block' }}>
        <span style={{ display: 'block', height: '100%', width: `${value}%`, background: masteryColor(value) }} />
      </span>
      <b style={{ color: masteryColor(value), minWidth: 24 }}>{value}</b>
    </span>
  );
}

const pct = (x: number | undefined) => (x === undefined ? '—' : `${Math.round(x * 100)}%`);

function InsightsView({ repId }: { repId: string }) {
  const { rep, graph } = useRepGraph(repId);
  const cards = useCards(repId);
  const logs = useLiveQuery(() => db.reviewLog.where('repId').equals(repId).toArray(), [repId]);
  const games = useGames();
  const allGraphs = useAllGraphs();

  const fromGames = useMemo(() => {
    const slips = new Map<string, number>();
    const surprises = new Map<string, number>();
    if (!games || !allGraphs || !graph) return { slips, surprises };
    for (const g of games) {
      const r = analyzeGame(g, allGraphs);
      if (r.repId !== repId || !r.key) continue;
      if (r.kind === 'you-deviated') {
        for (const m of graph.childrenOf(r.key)) if (m.mine) slips.set(m.id, (slips.get(m.id) ?? 0) + 1);
      } else if (r.kind === 'opponent-deviated') {
        surprises.set(r.key, (surprises.get(r.key) ?? 0) + 1);
      }
    }
    return { slips, surprises };
  }, [games, allGraphs, graph, repId]);

  const insights = useMemo(
    () => (graph && cards && logs ? computeInsights({ graph, cards, logs, gameSlips: fromGames.slips, surprises: fromGames.surprises }) : undefined),
    [graph, cards, logs, fromGames],
  );

  if (!rep || !graph || !insights) return <div className="muted">Loading…</div>;
  if (!graph.size) return <Empty>This repertoire is empty.</Empty>;
  const t = insights.total;
  const learnedMoves = insights.moves.filter((m) => m.mastery !== undefined);

  return (
    <>
      <div className="panel">
        <div className="row">
          <h2 style={{ margin: 0 }}>{rep.name}</h2>
          <ColorPill color={rep.color} />
          <span className="spacer" />
          <button className="primary" disabled={!learnedMoves.length} onClick={() => navigate('train', { rep: repId, mode: 'drill', t: String(Date.now()) })}>
            Drill my weakest moves
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          <b>Mastery</b> (0–100) blends how often you get a move right in training, how likely you are to remember it right now (FSRS
          recall), its difficulty (which rises each time you miss it) and how often you left your prep there in real games. Lines add up
          everything below them; the weakest are listed first.
        </p>
      </div>

      <div className="grid3">
        <Stat value={<span style={{ color: masteryColor(t.mastery) }}>{t.mastery ?? '—'}</span>} label="Mastery" />
        <Stat value={pct(insights.recentAccuracy)} label="Accuracy (30 days)" hint={`${insights.recentAttempts} training attempts in the last 30 days`} />
        <Stat value={pct(t.recall)} label="Recall now" hint="Average chance you'd remember each learned move today" />
        <Stat value={`${t.learned}/${t.moves}`} label="Moves learned" />
        <Stat value={t.gameSlips} label="Slips in games" hint="Times you left your prep in real games" />
        <Stat value={t.surprises} label="Opponent surprises" hint="Games where the opponent left your repertoire" />
      </div>

      <div className="panel">
        <h2>Lines</h2>
        {!t.learned && <div className="note">Learn some moves first — mastery appears once you've trained them.</div>}
        <table className="data">
          <thead>
            <tr>
              <th>Line</th>
              <th className="num">Learned</th>
              <th className="num">Accuracy</th>
              <th className="num">Recall</th>
              <th className="num" title="Times you left prep here in real games">Slips</th>
              <th>Mastery</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {insights.lines.map((l) => (
              <LineRow key={l.id} line={l} depth={0} repId={repId} defaultOpen />
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2>Trickiest moves</h2>
        {learnedMoves.length === 0 ? (
          <Empty>Nothing learned yet.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Position</th>
                <th>Your move</th>
                <th>Difficulty</th>
                <th className="num">Accuracy</th>
                <th className="num">Recall</th>
                <th className="num">Slips</th>
                <th>Mastery</th>
                <th>Next</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {learnedMoves.slice(0, 25).map((m) => {
                const d = difficultyLabel(m.card);
                return (
                  <tr key={m.move.id}>
                    <td className="mono small">{formatLine(m.path) || 'Start'}</td>
                    <td>
                      <b style={{ color: 'var(--mine)' }}>{m.move.san}</b>
                    </td>
                    <td>
                      <span className={`badge ${d === 'hard' ? 'bad' : d === 'medium' ? 'due' : 'good'}`} title={`FSRS difficulty ${m.card.difficulty.toFixed(1)} / 10`}>
                        {d}
                      </span>
                    </td>
                    <td className="num" title={`${m.attempts - m.misses}/${m.attempts} right first time`}>
                      {pct(m.accuracy)}
                    </td>
                    <td className="num">{pct(m.recall)}</td>
                    <td className="num">{m.gameSlips || ''}</td>
                    <td>
                      <MasteryBar value={m.mastery} />
                    </td>
                    <td className="small muted">{m.card.due <= Date.now() ? 'due' : formatInterval(m.card.due - Date.now())}</td>
                    <td>
                      <div className="list-actions">
                        <button className="small primary" onClick={() => navigate('train', { rep: repId, mode: 'drill', under: m.move.id, t: String(Date.now()) })}>
                          Drill
                        </button>
                        <button className="small" onClick={() => navigate(`repertoire/${repId}`, { line: [...m.path, m.move.san].join(' ') })}>
                          Open
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function LineRow({ line, depth, repId, defaultOpen = false }: { line: LineInsight; depth: number; repId: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const sans = line.segment.map((m) => m.san);
  const hasKids = line.children.length > 0;
  return (
    <>
      <tr>
        <td style={{ paddingLeft: 8 + depth * 18 }}>
          <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
            <button className="ghost small" style={{ visibility: hasKids ? 'visible' : 'hidden', width: 22 }} onClick={() => setOpen(!open)}>
              {open ? '▾' : '▸'}
            </button>
            <span className="mono small" style={{ cursor: hasKids ? 'pointer' : undefined }} onClick={() => hasKids && setOpen(!open)}>
              {formatLine(sans, line.prefix.length)}
              {line.transposes && <span className="muted"> (transposes)</span>}
            </span>
          </span>
        </td>
        <td className="num">
          {line.learned}/{line.moves}
        </td>
        <td className="num">{pct(line.accuracy)}</td>
        <td className="num">{pct(line.recall)}</td>
        <td className="num">{line.gameSlips || ''}</td>
        <td>
          <MasteryBar value={line.mastery} />
        </td>
        <td>
          <div className="list-actions">
            <button
              className="small"
              disabled={!line.learned}
              onClick={() => navigate('train', { rep: repId, mode: 'drill', under: line.id, t: String(Date.now()) })}
              title="Practise every learned move in this line"
            >
              Drill
            </button>
            <button className="small" onClick={() => navigate(`repertoire/${repId}`, { line: [...line.prefix, ...sans].join(' ') })}>
              Open
            </button>
          </div>
        </td>
      </tr>
      {open && line.children.map((c) => <LineRow key={c.id} line={c} depth={depth + 1} repId={repId} />)}
    </>
  );
}
