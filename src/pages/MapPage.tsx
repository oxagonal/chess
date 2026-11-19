/**
 * The Map tab: everything about how ready a scope is (all of a color, a repertoire, or one chapter),
 * organized by the questions it answers, not by where the numbers come from —
 *   how ready am I?   one bar: your lines by strength, the games they don't cover, rare sidelines;
 *   what next?        to-dos, each with one action: train what's due, fill the gaps, drill weak moves;
 *   where?            the chapters as strips of their lines;
 *   details           how the coverage numbers come about, and your lines in a tree (on demand).
 * It took over the Coverage and Insights tabs (their old addresses lead here) and the Repertoire's map.
 */
import { useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { PageProps } from '../App';
import { colorName, scopeOf, useChaptersAndSets, type Scope } from '../db/scopes';
import { useSettings } from '../db/settings';
import { loadScopeCounts } from '../db/training';
import { lineTarget } from '../db/repertoire';
import { defaultScope, ScopeSelect } from '../components/ScopeSelect';
import { Empty } from '../components/ui';
import { useNow } from '../hooks';
import { chapterPosition } from '../lib/chapters';
import { formatLine } from '../lib/chess';
import { oneIn } from '../lib/coverage';
import { STRENGTH_LABEL, strengthOf } from '../lib/map';
import { weakestMoves } from '../lib/insights';
import type { Chapter, Collection } from '../lib/types';
import { href, navigate } from '../router';
import { ChapterSection, Readiness, runScopeOf, useMapData, type MapData } from './RepertoireMap';
import { CoverageDetails, CoverageRunBar, scopeGaps, type ScopeGap } from './Coverage';
import { TrainingDetails, useScopeInsights, type ScopeInsights } from './Insights';

const SCOPE_KEY = 'chess-prep:mapScope';
const DETAILS_KEY = 'chess-prep:mapDetails';
/** How many items a to-do list shows before "Show all". */
const FEW = 5;

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: just not remembered */
  }
}

export function MapPage({ route }: PageProps) {
  const { chapters, collections } = useChaptersAndSets();
  const settings = useSettings();
  if (!chapters || !collections || !settings.loaded) return null;
  if (!chapters.length) return <Empty>Create a chapter first — <a href={href('repertoire')}>Repertoire</a>.</Empty>;
  // The scope in the address, else the one you last looked at (on this device), else the first color.
  const valid = (id: string | null | undefined): id is string => !!id && !!scopeOf(id, chapters, collections, settings);
  const asked = route.path[1];
  const scopeId = valid(asked) ? asked : valid(remembered(SCOPE_KEY)) ? remembered(SCOPE_KEY)! : defaultScope(chapters)!;
  if (asked === scopeId) remember(SCOPE_KEY, scopeId);
  return (
    <div className="col map-page" style={{ gap: 14 }}>
      <div className="row">
        <h1 style={{ margin: 0 }}>Map</h1>
        <span className="spacer" />
        <ScopeSelect value={scopeId} onChange={(id) => navigate(`map/${id}`)} chapters={chapters} collections={collections} />
      </div>
      <MapView key={scopeId} scopeId={scopeId} chapters={chapters} collections={collections} />
    </div>
  );
}

function MapView({ scopeId, chapters, collections }: { scopeId: string; chapters: Chapter[]; collections: Collection[] }) {
  const data = useMapData(scopeId, chapters, collections);
  const insights = useScopeInsights(scopeId);
  const now = useNow();
  const counts = useLiveQuery(() => loadScopeCounts(scopeId, now), [scopeId, now]);
  const [details, setDetails] = useState(() => remembered(DETAILS_KEY) === '1');
  const { scope, maps, graphs, names } = data;
  if (!scope || !maps || !graphs) return <div className="muted">Loading…</div>;

  const chapter = scope.kind === 'chapter' ? chapters.find((c) => c.id === scope.id) : undefined;
  const subject = scope.kind === 'color' ? colorName(scope.color) : `“${scope.name}”`;
  // A chapter's gaps are those past where its opening starts (as its "not covered" share counts them).
  const chapterGraph = chapter && graphs.get(chapter.id);
  const under = chapterGraph ? chapterPosition(chapterGraph, names, chapter.name).moves.map((m) => m.san) : undefined;
  const gaps = scopeGaps(data.gapRun, under);
  const openLine = async (sans: string[]) => navigate(`repertoire/${await lineTarget(scope.color, sans)}`, { line: sans.join(' ') });
  const toGaps = () => document.getElementById('map-gaps')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const toggleDetails = () => {
    setDetails(!details);
    remember(DETAILS_KEY, details ? '0' : '1');
  };

  if (!data.allLines.length)
    return (
      <Empty>
        No lines here yet — add moves in the <a href={href(`repertoire/${scope.kind === 'repertoire' ? scope.color : scope.id}`)}>builder</a>.
      </Empty>
    );

  return (
    <>
      <Readiness data={data} subject={subject} onGaps={data.gapRun ? toGaps : undefined}>
        <CoverageRunBar
          scopeId={runScopeOf(scope)}
          within={chapter ? `a chapter is measured within all ${colorName(scope.color)} chapters` : undefined}
        />
      </Readiness>

      <div className="map-todo">
        <TrainCard scope={scope} due={counts?.due} fresh={counts?.fresh} />
        <GapsCard data={data} gaps={gaps} onOpen={openLine} />
        <WeakCard scopeId={scopeId} insights={insights} />
      </div>

      <ChapterSection data={data} />

      <button className="map-details-toggle ghost" aria-expanded={details} onClick={toggleDetails}>
        {details ? '▾' : '▸'} Details — how the coverage numbers come about, positions to know, your lines in a tree
      </button>
      {details && (
        <>
          <Section title="Coverage">
            {insights ? (
              <CoverageDetails
                scope={scope}
                graph={insights.graph}
                run={data.gapRun}
                gaps={gaps}
                covered={data.uncovered ? 1 - data.uncovered.share : undefined}
                onOpen={openLine}
              />
            ) : (
              <div className="muted">Loading…</div>
            )}
          </Section>
          <Section title="Training">{insights ? <TrainingDetails scopeId={scopeId} data={insights} /> : <div className="muted">Loading…</div>}</Section>
        </>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel col" style={{ gap: 10 }}>
      <h2 style={{ margin: 0 }}>{title}</h2>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ to-dos */

/** What's due and what's new here — the same counts as the Train tab (db/training). */
function TrainCard({ scope, due, fresh }: { scope: Scope; due?: number; fresh?: number }) {
  const go = (mode: 'review' | 'learn') => navigate('train', { rep: scope.id, mode, t: String(Date.now()) });
  return (
    <div className="panel col todo-card">
      <h3>Train</h3>
      <p className="muted small">
        {due === undefined ? '…' : due ? `${due} move${due === 1 ? '' : 's'} due for review` : 'Nothing due right now'}
        {fresh ? ` · ${fresh} new to learn` : ''}
      </p>
      <div className="list-buttons">
        <button className="primary small" disabled={!due} onClick={() => go('review')}>
          Review {due || ''}
        </button>
        {!!fresh && (
          <button className="blue small" onClick={() => go('learn')}>
            Learn
          </button>
        )}
      </div>
    </div>
  );
}

/** The common positions your lines don't answer, likeliest first — each opens where to add the move. */
function GapsCard({ data, gaps, onOpen }: { data: MapData; gaps: ScopeGap[]; onOpen: (sans: string[]) => void }) {
  const [all, setAll] = useState(false);
  const run = data.gapRun;
  const shown = all ? gaps : gaps.slice(0, FEW);
  return (
    <div className="panel col todo-card" id="map-gaps">
      <h3>
        Gaps {run && <span className="muted">({gaps.length})</span>}
      </h3>
      {!run ? (
        <p className="muted small">Run Coverage (above) to find the common positions your lines don't answer yet.</p>
      ) : !gaps.length ? (
        <p className="muted small">None — everything you'll meet at least 1 in {Math.round(1 / run.threshold)} games has an answer.</p>
      ) : (
        <>
          <p className="muted small">Met at least 1 in {Math.round(1 / run.threshold)} games, with no answer in your lines.</p>
          <ul className="todo-list">
            {shown.map((g) => (
              <li key={g.key}>
                <span className="todo-what">
                  <span className="mono small">{g.path.length ? formatLine(g.path) : 'Start'}</span>
                  <span className="muted small">
                    {g.san ? 'no answer' : 'your move'} · {oneIn(g.prob)}
                  </span>
                </span>
                <button className="small primary" onClick={() => onOpen(g.path)}>
                  {g.san ? 'Prepare' : 'Choose a move'}
                </button>
              </li>
            ))}
          </ul>
          {gaps.length > FEW && (
            <button className="linklike small" onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `Show all ${gaps.length}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** The moves you know least (training accuracy, recall, difficulty and slips in games) — to drill. */
function WeakCard({ scopeId, insights }: { scopeId: string; insights?: ScopeInsights }) {
  const [all, setAll] = useState(false);
  const moves = insights?.insights.moves ?? [];
  const learned = moves.some((m) => m.mastery !== undefined);
  const ranked = weakestMoves(moves);
  const weak = ranked.slice(0, all ? 25 : FEW);
  const drill = (under?: string) => navigate('train', { rep: scopeId, mode: 'drill', under, t: String(Date.now()) });
  return (
    <div className="panel col todo-card">
      <h3>Weakest moves</h3>
      {!insights ? (
        <p className="muted small">…</p>
      ) : !learned ? (
        <p className="muted small">Nothing learned yet — learn some moves first.</p>
      ) : !ranked.length ? (
        <p className="muted small">Nothing weak: every move you've learned is solid, and you haven't missed one.</p>
      ) : (
        <>
          <p className="muted small">Weakest band first; within one, by how often you miss them, how likely you are to remember them now and slips in your games.</p>
          <ul className="todo-list">
            {weak.map((m) => {
              const s = strengthOf(m.card);
              return (
                <li key={m.move.id}>
                  <span className="todo-what">
                    <span className="mono small">
                      {formatLine([...m.path, m.move.san])}
                    </span>
                    <span className="muted small">
                      <span className={`str-swatch str-${s}`} /> {STRENGTH_LABEL[s]}
                      {m.attempts ? ` · missed ${m.misses} of ${m.attempts}` : ''}
                      {m.gameSlips ? ` · forgot ${m.gameSlips}× in games` : ''}
                    </span>
                  </span>
                  <button className="small" onClick={() => drill(m.move.id)} title="Drill this move and what follows it">
                    Drill
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="row">
            <button className="primary small" onClick={() => drill()}>
              Drill my weakest moves
            </button>
            {ranked.length > FEW && (
              <button className="linklike small" onClick={() => setAll(!all)}>
                {all ? 'Show fewer' : 'Show more'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
