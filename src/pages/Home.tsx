import { useMemo } from 'react';
import { TiltNote } from '../components/TiltNote';
import { PracticeCreditNote } from '../components/PracticeCreditNote';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { useSettings } from '../db/settings';
import { useAllGraphs, useCards, useLearnedToday, useNow, useRecentGames, useRepertoires, startOfToday } from '../hooks';
import { rangeLabel } from '../lib/gameRange';
import { GameRangeSelect } from '../components/GameRangeSelect';
import { analyzeGame, summarize } from '../lib/prep';
import { isMature, isNew } from '../lib/srs';
import { loadTrainCounts, type TrainCounts } from '../db/training';
import { Stat } from '../components/ui';
import { href, navigate, scopeHref } from '../router';
import { COLORS, colorName, useChaptersAndSets } from '../db/scopes';
import { readyOf, useMapData, WeightedBar } from './RepertoireMap';
import type { Color } from '../lib/chess';
import type { Chapter, Collection } from '../lib/types';
import { scopeGaps } from './Coverage';
import { lineTarget } from '../db/repertoire';
import { oneIn } from '../lib/coverage';
import { formatLine } from '../lib/chess';

export function HomePage() {
  const reps = useRepertoires();
  const cards = useCards();
  const games = useRecentGames();
  const allGameCount = useLiveQuery(() => db.games.count(), []);
  const graphs = useAllGraphs();
  const settings = useSettings();
  const learnedToday = useLearnedToday();
  const reviewsToday = useLiveQuery(() => db.reviewLog.where('reviewedAt').aboveOrEqual(startOfToday()).count(), []);
  const coverageCount = useLiveQuery(() => db.coverage.count(), []);
  // What Review and Learn would take (not a due card of a move you've taken out of training).
  const now = useNow();
  const toTrain = useLiveQuery(() => loadTrainCounts(now), [now]);

  const recent = useMemo(() => {
    if (!games || !graphs) return undefined;
    const results = new Map(games.map((g) => [g.id, analyzeGame(g, graphs)]));
    return summarize(games, results);
  }, [games, graphs]);

  if (!reps || !cards || !toTrain) return null;
  const { due, fresh } = toTrain.all;
  const mature = cards.filter(isMature).length;
  const learned = cards.filter((c) => !isNew(c)).length;
  const newLeft = Math.max(0, settings.newPerDay - (learnedToday ?? 0));

  const steps = [
    { done: !!(settings.lichessUsername || settings.chesscomUsername), text: <>Add your Lichess / Chess.com usernames and rating in <a href={href('settings')}>Settings</a></> },
    { done: reps.length > 0, text: <>Create a chapter and add lines — or import a Lichess study (<a href={href('repertoire')}>Repertoire</a>)</> },
    { done: learned > 0, text: <>Learn your first moves (<a href={href('repertoire')}>Repertoire</a>)</> },
    { done: (coverageCount ?? 0) > 0, text: <>Run Coverage on the <a href={href('repertoire')}>Repertoire</a> tab to find the positions you'll meet often enough to prepare</> },
    { done: (allGameCount ?? 0) > 0, text: <>Import your games to see where you forget your prep (<a href={href('games')}>Games</a>)</> },
  ];
  const allDone = steps.every((s) => s.done);

  return (
    <div className="col" style={{ gap: 16 }}>
      <PracticeCreditNote />
      <TiltNote />
      <div className="hero">
        <div className="row">
          <div>
            <h1>{due ? `${due} move${due === 1 ? '' : 's'} to review` : 'All caught up'}</h1>
            <p className="muted" style={{ margin: 0 }}>
              {fresh ? `${fresh} new move${fresh === 1 ? '' : 's'} waiting to be learned.` : 'No new moves queued.'}
            </p>
          </div>
          <span className="spacer" />
          <a className={`btn primary ${due ? '' : 'disabled'}`} href={href('train', { rep: 'all', mode: 'review' })} aria-disabled={!due}>
            Review now
          </a>
          {/* Never greyed out: past today's limit it learns another batch; with nothing new, it opens the repertoires. */}
          <a
            className="btn blue"
            href={
              !fresh
                ? href('repertoire')
                : newLeft
                  ? href('train', { rep: 'all', mode: 'learn' })
                  : href('train', { rep: 'all', mode: 'learn', extra: '10' })
            }
            title={!fresh ? 'Every move is learned — add new moves to a repertoire' : newLeft ? undefined : 'Today’s new-move limit is reached — learn more anyway'}
          >
            {!fresh || newLeft ? 'Learn new' : 'Learn 10 more'}
          </a>
        </div>
      </div>

      <div className="grid3 home-stats">
        <Stat value={learned} label="Moves learned" />
        <Stat value={mature} label="Mature (21d+)" hint="Moves whose review interval is three weeks or more" />
        <Stat value={reviewsToday ?? 0} label="Reviews today" />
        {recent && <Stat value={recent.byKind['you-deviated']} label={`Forgot prep (${rangeLabel(settings.gameRange).toLowerCase()})`} />}
      </div>

      {!allDone && (
        <div className="panel">
          <h2>Getting started</h2>
          <ol className="checklist">
            {steps.map((s, i) => (
              <li key={i} className={s.done ? 'done' : ''}>
                {s.text}
              </li>
            ))}
          </ol>
        </div>
      )}

      {reps.length > 0 && <RepertoireAtAGlance toTrain={toTrain} />}

      <div className="grid2">

        <div className="panel">
          <h2>Recent games vs your prep</h2>
          {!allGameCount ? (
            <p className="muted">
              No games imported. <a href={href('games')}>Sync games</a>
            </p>
          ) : !recent || recent.games === 0 ? (
            <div className="row">
              <p className="muted">No games in this period.</p>
              <GameRangeSelect />
            </div>
          ) : (
            <>
              <GameRangeSelect count={recent.games} />
              <div className="grid3">
                <Stat value={recent.byKind['you-deviated']} label="Forgot prep" />
                <Stat value={recent.byKind['opponent-deviated']} label="Opponent surprise" />
                <Stat value={(recent.avgBookPlies / 2).toFixed(1)} label="Avg moves in book" />
              </div>
              {recent.forgotten.length > 0 && (
                <p style={{ marginTop: 10 }}>
                  Most-forgotten: <b>{recent.forgotten[0].expected.join(', ')}</b> ({recent.forgotten[0].count}×).{' '}
                  <a href={href('games')}>See all</a>
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Each color at a glance: how much you know well, what's due, and the chapters that need work. */
function RepertoireAtAGlance({ toTrain }: { toTrain: Record<Color, TrainCounts> }) {
  const { chapters, collections } = useChaptersAndSets();
  if (!chapters || !collections) return null;
  const colors = COLORS.filter((c) => chapters.some((ch) => ch.color === c));
  return (
    <div className="grid2">
      {colors.map((c) => (
        <ColorGlance key={c} color={c} chapters={chapters} collections={collections} due={toTrain[c].due} />
      ))}
    </div>
  );
}

function ColorGlance({ color, chapters, collections, due }: { color: Color; chapters: Chapter[]; collections: Collection[]; due: number }) {
  const { maps, allLines, overall, cov, uncovered, gapRun } = useMapData(color, chapters, collections);
  if (!maps) return <div className="panel" />;
  // The Map's to-dos in brief: the likeliest gap (what's due is the Review button).
  const gap = scopeGaps(gapRun)[0];
  const count = chapters.filter((ch) => ch.color === color).length;
  const weakest = maps
    .filter((m) => m.lines.length)
    .sort((a, b) => a.ready - b.ready)
    .slice(0, 3);
  return (
    <div className="panel col glance" style={{ gap: 10 }}>
      <div className="row">
        <h2 style={{ margin: 0 }}>{colorName(color)}</h2>
        <span className="muted small">
          {count} chapter{count === 1 ? '' : 's'} · {allLines.length} line{allLines.length === 1 ? '' : 's'}
        </span>
        <span className="spacer" />
        <a className="btn small" href={scopeHref(color)}>
          Map
        </a>
        {due > 0 && (
          <a className="btn small primary" href={href('train', { rep: color, mode: 'review', t: String(Date.now()) })}>
            Review {due}
          </a>
        )}
      </div>
      {allLines.length > 0 && (
        <>
          <div className="glance-ready">
            <b>{Math.round(readyOf(overall) * 100)}%</b>
            <span className="muted small">{cov ? 'of your games go down lines you know well' : 'of your lines you know well'}</span>
          </div>
          <WeightedBar s={overall} uncovered={uncovered} />
          {weakest.length > 0 && (
            <div className="glance-weak">
              <span className="muted small">Needs work</span>
              {weakest.map((m) => (
                <a key={m.chapter.id} className="chip" href={href(`repertoire/${m.chapter.id}`)} title={m.chapter.name}>
                  {m.chapter.name} · {Math.round(m.ready * 100)}%
                </a>
              ))}
            </div>
          )}
          {gap && (
            <div className="glance-weak">
              <span className="muted small">Biggest gap</span>
              <button
                className="chip"
                title={`${gap.san ? 'No answer' : 'Your move, nothing prepared'} — met ${oneIn(gap.prob)} games. Open it in the builder.`}
                onClick={async () => navigate(`repertoire/${await lineTarget(color, gap.path)}`, { line: gap.path.join(' ') })}
              >
                {formatLine(gap.path)} · {oneIn(gap.prob)}
              </button>
              <a className="small" href={scopeHref(color)}>
                all gaps →
              </a>
            </div>
          )}
        </>
      )}
    </div>
  );
}
