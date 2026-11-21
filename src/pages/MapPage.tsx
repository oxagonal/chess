/**
 * The Repertoire tab: your chapters and everything about how ready they are, for a scope (all of a
 * color, a repertoire, or one chapter), organized by the questions it answers —
 *   what's on today?  what's due and new, to train;
 *   how ready am I?   one bar: your lines by strength, the games they don't cover, rare sidelines;
 *   what next?        to-dos, each with one action: train what's due, fill the gaps, drill weak moves;
 *   where?            the chapters as strips of their lines — each with its training buttons and a
 *                     ⋯ menu to edit, split, merge, import into, export, rename or delete it;
 *   details           how the coverage numbers come about, and your lines in a tree (on demand).
 * Plus making chapters (new, imported) and your repertoires (sets of chapters). It took over the Map
 * tab, and before it the Coverage, Insights and Train tabs (their old addresses lead here).
 */
import { useState, type ReactNode } from 'react';
import { PracticeCreditNote } from '../components/PracticeCreditNote';
import { useLiveQuery } from 'dexie-react-hooks';
import type { PageProps } from '../App';
import { colorName, scopeOf, useChaptersAndSets, type Scope } from '../db/scopes';
import { updateSettings, useSettings } from '../db/settings';
import { learnedTodayCount, loadTrainingData, trainCounts, type TrainCounts, type TrainingData } from '../db/training';
import { SessionButtons } from '../components/SessionButtons';
import { lineTarget } from '../db/repertoire';
import { defaultScope, ScopeSelect } from '../components/ScopeSelect';
import { Empty } from '../components/ui';
import { useNow } from '../hooks';
import { chapterPosition } from '../lib/chapters';
import { formatLine, START_KEY } from '../lib/chess';
import { DEEPER, oneIn } from '../lib/coverage';
import { STRENGTH_LABEL, strengthOf } from '../lib/map';
import { weakestMoves } from '../lib/insights';
import type { Chapter, Collection } from '../lib/types';
import { href, navigate, openScope } from '../router';
import { ChapterMenu, ChapterPanelView, RepertoireActions, RepertoireSets, type ChapterPanel } from './RepertoireHome';
import { ImportWizard } from '../components/ImportWizard';
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

export function RepertoireHub({ route }: PageProps) {
  const { chapters, collections } = useChaptersAndSets();
  const settings = useSettings();
  const [wizard, setWizard] = useState(false);
  if (!chapters || !collections || !settings.loaded) return null;
  // The scope in the address, else the one you last looked at (on this device), else the first color.
  const valid = (id: string | null | undefined): id is string => !!id && !!scopeOf(id, chapters, collections, settings);
  const asked = route.query.get('scope');
  const scopeId = !chapters.length ? undefined : valid(asked) ? asked : valid(remembered(SCOPE_KEY)) ? remembered(SCOPE_KEY)! : defaultScope(chapters)!;
  if (scopeId && asked === scopeId) remember(SCOPE_KEY, scopeId);
  const color = (scopeId && scopeOf(scopeId, chapters, collections, settings)?.color) || 'white';
  return (
    <div className="col map-page" style={{ gap: 14 }}>
      <div className="row rep-head">
        <h1 style={{ margin: 0 }}>Repertoire</h1>
        <RepertoireActions color={color} onImport={() => setWizard(true)} />
      </div>
      {wizard && <ImportWizard chapters={chapters} onClose={() => setWizard(false)} />}
      {!scopeId ? (
        <Empty>No chapters yet — add one with New chapter, import a Lichess study, or open all White and start playing moves.</Empty>
      ) : (
        <MapTraining>
          {(train) => (
            <>
              <TodayPanel train={train} />
              <div className="row map-scope">
                <ScopeSelect value={scopeId} onChange={(id) => openScope(id)} chapters={chapters} collections={collections} />
              </div>
              <MapView key={scopeId} scopeId={scopeId} chapters={chapters} collections={collections} train={train} />
            </>
          )}
        </MapTraining>
      )}
    </div>
  );
}

/**
 * What there is to train — the Train tab's counts, here now: worked out live from the database with
 * the same rule as every session (db/training), for any scope, with today's new-move allowance.
 */
interface Training {
  data?: TrainingData;
  now: number;
  /** New moves today's limit still allows. */
  newLeft: number;
  learnedToday?: number;
  countsOf: (scopeId: string, chapterIds?: readonly string[]) => TrainCounts | undefined;
}

function MapTraining({ children }: { children: (t: Training) => ReactNode }) {
  const settings = useSettings();
  const now = useNow();
  const data = useLiveQuery(() => loadTrainingData(), []);
  const learnedToday = useLiveQuery(learnedTodayCount, [now]);
  const newLeft = Math.max(0, settings.newPerDay - (learnedToday ?? 0));
  const countsOf = (scopeId: string, chapterIds?: readonly string[]) => (data ? trainCounts(scopeId, data, now, chapterIds) : undefined);
  return <>{children({ data, now, newLeft, learnedToday, countsOf })}</>;
}

/** Today, across everything: what's due, what's new, Review / Learn all of it, and how training works. */
function TodayPanel({ train }: { train: Training }) {
  const settings = useSettings();
  const all = train.countsOf('all');
  const [how, setHow] = useState(false);
  return (
    <div className="panel col today" style={{ gap: 8 }}>
      <PracticeCreditNote />
      <div className="row">
        <h2 style={{ margin: 0 }}>Today</h2>
        <span className="muted small">
          {all ? (
            <>
              <b>{all.due}</b> due · <b>{Math.min(train.newLeft, all.fresh)}</b> new of {settings.newPerDay} a day ·{' '}
              <b>{train.learnedToday ?? 0}</b> learned today
            </>
          ) : (
            '…'
          )}
        </span>
        <span className="spacer" />
        {all && <SessionButtons rep="all" due={all.due} fresh={Math.min(all.fresh, train.newLeft)} unlearned={all.fresh} />}
      </div>
      {/* Stop at your coverage target: a move 1 in 100,000 games deep isn't worth reviewing. */}
      <label className="check" title="Needs a Coverage run for the color or repertoire; without one, everything is trained">
        <input type="checkbox" checked={settings.trainOnlyLikely} onChange={(e) => updateSettings({ trainOnlyLikely: e.target.checked })} />
        <span className="small">Only train positions you'll meet at least as often as your coverage target</span>
      </label>
      {settings.trainOnlyLikely && (
        <div className="muted small">
          Rarer positions are left out of Learn and Review, for each color or repertoire with a Coverage run; the rest is trained as
          usual. Single moves you don't want trained at all: right-click them in the builder.
        </div>
      )}
      <button className="linklike small" style={{ alignSelf: 'flex-start' }} onClick={() => setHow(!how)} aria-expanded={how}>
        {how ? 'Hide' : 'How'} Learn and Review work
      </button>
      {how && (
        <p className="muted small" style={{ margin: 0 }}>
          <b>Learn</b> shows you new moves line by line, then has you replay them from memory — moves you already know are played for
          you. <b>Review</b> quizzes moves that are due: you play the whole line from move 1 to the end of the branch, so you meet them
          as they arise in a game — and a move on the way you haven't learned yet is taught right there (shown, then replayed from
          memory at the line's end, like Learn). <b>Drill</b> practices a chapter, a line or your weakest moves whenever you like. Scheduling uses
          FSRS; the answer timer (⚙ in a session) makes slow answers Hard and instant ones on well-known moves Easy.
        </p>
      )}
    </div>
  );
}

function MapView({ scopeId, chapters, collections, train }: { scopeId: string; chapters: Chapter[]; collections: Collection[]; train: Training }) {
  const data = useMapData(scopeId, chapters, collections);
  const insights = useScopeInsights(scopeId);
  const counts = train.countsOf(scopeId);
  const [details, setDetails] = useState(() => remembered(DETAILS_KEY) === '1');
  const [panel, setPanel] = useState<ChapterPanel>(null);
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

  const chapters_ = (
    <>
      <ChapterSection
        data={data}
        actions={(ch) => {
          const c = train.countsOf(ch.id);
          // A chapter with no moves yet only has its menu.
          const has = !!graphs.get(ch.id)?.size;
          return (
            <span className="row map-row-actions">
              {c && has && <SessionButtons compact rep={ch.id} due={c.due} fresh={Math.min(c.fresh, train.newLeft)} unlearned={c.fresh} />}
              {has && (
                <button
                  className="small ghost"
                  onClick={() => navigate('train', { rep: ch.id, mode: 'drill', at: START_KEY, t: String(Date.now()) })}
                  title="Practice the whole chapter now, due or not — every move you play counts as reviewed"
                >
                  Drill ▸
                </button>
              )}
              <a className="btn small ghost" href={href(`repertoire/${ch.id}`)} title="Open the chapter in the builder">
                Edit
              </a>
              <ChapterMenu chapter={ch} onPanel={setPanel} />
            </span>
          );
        }}
        groupExtra={(ids) => {
          const c = train.countsOf(scope.color, ids);
          return (
            c && (
              <>
                {c.due > 0 && <span className="badge due">{c.due} due</span>}
                {c.fresh > 0 && <span className="badge new">{c.fresh} new</span>}
              </>
            )
          );
        }}
      />
      <ChapterPanelView panel={panel} onClose={() => setPanel(null)} />
    </>
  );
  // Your repertoires: sets of this color's chapters.
  const sets = <RepertoireSets color={scope.color} />;

  if (!data.allLines.length)
    return (
      <>
        <Empty>
          No lines here yet — add moves in the <a href={href(`repertoire/${scope.kind === 'repertoire' ? scope.color : scope.id}`)}>builder</a>.
        </Empty>
        {chapters_}
        {sets}
      </>
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
        <TrainCard scope={scope} counts={counts} newLeft={train.newLeft} />
        <GapsCard data={data} gaps={gaps} onOpen={openLine} />
        <WeakCard scopeId={scopeId} insights={insights} />
      </div>

      {chapters_}
      {sets}

      <button className="map-details-toggle ghost" aria-expanded={details} onClick={toggleDetails}>
        {details ? '▾' : '▸'} Details — how the coverage numbers come about, positions to know, your lines in a tree
      </button>
      {details && (
        <>
          <Section title="Coverage">
            {insights ? (
              <CoverageDetails
                runScopeId={runScopeOf(scope)}
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

/** What's due and what's new here (db/training's counts) — Review it, or Learn today's share. */
function TrainCard({ scope, counts, newLeft }: { scope: Scope; counts?: TrainCounts; newLeft: number }) {
  return (
    <div className="panel col todo-card">
      <h3>Train</h3>
      <p className="muted small">
        {!counts ? '…' : counts.due ? `${counts.due} move${counts.due === 1 ? '' : 's'} due for review` : 'Nothing due right now'}
        {counts?.fresh ? ` · ${counts.fresh} not learned yet` : ''}
      </p>
      {counts && <SessionButtons rep={scope.id} due={counts.due} fresh={Math.min(counts.fresh, newLeft)} unlearned={counts.fresh} />}
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
          <p className="muted small">
            Met at least 1 in {Math.round(1 / run.threshold)} games
            {gaps.some((g) => g.boost) && <> — or 1 in {Math.round(DEEPER / run.threshold)} in sharp lines you prepare deeper (⚡)</>}, with no answer in your lines.
          </p>
          <ul className="todo-list">
            {shown.map((g) => (
              <li key={g.key}>
                <span className="todo-what">
                  <span className="mono small">{g.path.length ? formatLine(g.path) : 'Start'}</span>
                  <span className="muted small">
                    {g.san ? 'no answer' : 'your move'} · {oneIn(g.prob)}
                    {g.boost && (
                      <span className="sharp-tag" title="Rarer than your goal, but in a sharp line you prepare deeper (⚡ in the builder)">
                        {' '}
                        · ⚡ sharp line
                      </span>
                    )}
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
