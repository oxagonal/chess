/**
 * Training insights on the Map tab: your weakest moves (ranked by lib/insights' mastery — the score
 * itself isn't shown: how well you know something is always the map's strength bands) and, in the
 * details, the totals and your lines as a tree.
 */
import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { useAllGraphs, useCards, useRecentGames } from '../hooks';
import { useScopeGraph } from '../db/scopes';
import { cardIdOf, cardsOf, chapterOfMoveId, sourcesOf } from '../lib/chapters';
import { useSettings } from '../db/settings';
import { rangeLabel } from '../lib/gameRange';
import { GameRangeSelect } from '../components/GameRangeSelect';
import { computeInsights, movesUnder, type Insights, type LineInsight } from '../lib/insights';
import { analyzeGame } from '../lib/prep';
import { STRENGTHS, strengthOf, type Strength } from '../lib/map';
import { formatLine } from '../lib/chess';
import type { RepGraph } from '../lib/graph';
import type { ReviewCard } from '../lib/types';
import { Stat, TableWrap } from '../components/ui';
import { navigate } from '../router';
import { WeightedBar } from './RepertoireMap';

const pct = (x: number | undefined) => (x === undefined ? '—' : `${Math.round(x * 100)}%`);

export interface ScopeInsights {
  graph: RepGraph;
  insights: Insights;
  cardById: Map<string, ReviewCard>;
  /** The chapter to open a move in (the builder opens a line in the chapter its move comes from). */
  chapterFor: (moveId: string) => string;
  recentGames: number;
}

/** Training insights for a scope: accuracy, recall and slips in real games, per move and per line. */
export function useScopeInsights(scopeId: string): ScopeInsights | undefined {
  const { scope, graph } = useScopeGraph(scopeId);
  const allCards = useCards();
  const cards = useMemo(() => (graph && allCards ? cardsOf(graph, allCards) : undefined), [graph, allCards]);
  const color = scope?.color;
  const colorLogs = useLiveQuery(async () => (color ? await db.reviewLog.where('color').equals(color).toArray() : undefined), [color]);
  const logs = useMemo(() => {
    if (!cards || !colorLogs) return undefined;
    const ids = new Set(cards.map((c) => c.id));
    return colorLogs.filter((l) => ids.has(l.cardId));
  }, [cards, colorLogs]);
  const recentGames = useRecentGames();
  const allGraphs = useAllGraphs();

  const fromGames = useMemo(() => {
    const slips = new Map<string, number>();
    const surprises = new Map<string, number>();
    if (!recentGames || !allGraphs || !graph) return { slips, surprises };
    for (const g of recentGames) {
      const r = analyzeGame(g, allGraphs);
      if (r.repId !== color || !r.key) continue;
      if (r.kind === 'you-deviated') {
        for (const m of graph.childrenOf(r.key)) if (m.mine) slips.set(m.id, (slips.get(m.id) ?? 0) + 1);
      } else if (r.kind === 'opponent-deviated') {
        surprises.set(r.key, (surprises.get(r.key) ?? 0) + 1);
      }
    }
    return { slips, surprises };
  }, [recentGames, allGraphs, graph, color]);

  return useMemo(() => {
    if (!scope || !graph || !cards || !logs) return undefined;
    const insights = computeInsights({ graph, cards, logs, gameSlips: fromGames.slips, surprises: fromGames.surprises });
    const chapterFor = (moveId: string) => {
      const m = graph.byId.get(moveId);
      return m ? chapterOfMoveId(sourcesOf(m)[0]) : (scope.chapterIds[0] ?? '');
    };
    return { graph, insights, cardById: new Map(cards.map((c) => [c.id, c])), chapterFor, recentGames: recentGames?.length ?? 0 };
  }, [scope, graph, cards, logs, fromGames, recentGames]);
}

/** How many of a line's moves (yours, below and including its first) are at each strength. */
function lineStrengths(graph: RepGraph, line: LineInsight, cardById: ReadonlyMap<string, ReviewCard>): Record<Strength, number> {
  const out = Object.fromEntries(STRENGTHS.map((s) => [s, 0])) as Record<Strength, number>;
  let n = 0;
  for (const id of movesUnder(graph, line.id)) {
    const m = graph.byId.get(id);
    if (!m?.mine) continue;
    const card = cardById.get(cardIdOf(m));
    out[card ? strengthOf(card) : 'new']++;
    n++;
  }
  for (const s of STRENGTHS) out[s] = n ? out[s] / n : 0;
  return out;
}

/** The Map's training details: totals, and every line as a tree with its moves by strength. */
export function TrainingDetails({ scopeId, data }: { scopeId: string; data: ScopeInsights }) {
  const { gameRange } = useSettings();
  const { insights, graph } = data;
  const t = insights.total;
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="grid3">
        <Stat value={pct(insights.recentAccuracy)} label="Accuracy (30 days)" hint={`${insights.recentAttempts} training attempts in the last 30 days`} />
        <Stat value={pct(t.recall)} label="Recall now" hint="Average chance you'd remember each learned move today (FSRS)" />
        <Stat value={`${t.learned}/${t.moves}`} label="Moves learned" />
        <Stat value={t.gameSlips} label="Forgot prep in games" hint={`Times you played something other than your prepared move in real games (${rangeLabel(gameRange).toLowerCase()})`} />
        <Stat value={t.surprises} label="Opponent surprises" hint={`Games where the opponent left your repertoire (${rangeLabel(gameRange).toLowerCase()})`} />
      </div>
      <div className="row small">
        <span>Games counted for forgotten prep &amp; surprises</span>
        <GameRangeSelect count={data.recentGames} />
      </div>
      <h3 style={{ margin: 0 }}>Lines</h3>
      {!t.learned && <div className="note">Learn some moves first — accuracy and recall appear once you've trained them.</div>}
      <TableWrap>
        <table className="data">
          <thead>
            <tr>
              <th>Line</th>
              <th title="Your moves in it, by strength (as on the map)">Moves</th>
              <th className="num hide-sm">Accuracy</th>
              <th className="num hide-sm">Recall</th>
              <th className="num hide-sm" title="Times you played something other than your prepared move here in real games">
                Forgot in games
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {insights.lines.map((l) => (
              <LineRow key={l.id} line={l} depth={0} scopeId={scopeId} data={data} graph={graph} defaultOpen />
            ))}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}

function LineRow({
  line,
  depth,
  scopeId,
  data,
  graph,
  defaultOpen = false,
}: {
  line: LineInsight;
  depth: number;
  scopeId: string;
  data: ScopeInsights;
  graph: RepGraph;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const sans = line.segment.map((m) => m.san);
  const hasKids = line.children.length > 0;
  const s = useMemo(() => lineStrengths(graph, line, data.cardById), [graph, line, data.cardById]);
  return (
    <>
      <tr>
        <td className="line-cell" style={{ paddingLeft: 4 + depth * 14 }}>
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
        <td>
          <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }} title={`${line.learned}/${line.moves} learned`}>
            <WeightedBar s={s} slim />
          </span>
        </td>
        <td className="num hide-sm">{pct(line.accuracy)}</td>
        <td className="num hide-sm">{pct(line.recall)}</td>
        <td className="num hide-sm">{line.gameSlips || ''}</td>
        <td>
          <div className="list-actions">
            <button
              className="small"
              onClick={() => navigate('train', { rep: scopeId, mode: 'drill', under: line.id, t: String(Date.now()) })}
              title="Practice every move in this line, learned or not — each one you play counts as reviewed"
            >
              Drill
            </button>
            <button className="small" onClick={() => navigate(`repertoire/${data.chapterFor(line.id)}`, { line: [...line.prefix, ...sans].join(' ') })}>
              Open
            </button>
          </div>
        </td>
      </tr>
      {open && line.children.map((c) => <LineRow key={c.id} line={c} depth={depth + 1} scopeId={scopeId} data={data} graph={graph} />)}
    </>
  );
}
