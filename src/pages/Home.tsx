import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { useSettings } from '../db/settings';
import { useAllGraphs, useCards, useGames, useRepertoires, startOfToday } from '../hooks';
import { analyzeGame, summarize } from '../lib/prep';
import { isDue, isMature, isNew } from '../lib/srs';
import { ColorPill, Stat } from '../components/ui';
import { href } from '../router';

export function HomePage() {
  const reps = useRepertoires();
  const cards = useCards();
  const games = useGames();
  const graphs = useAllGraphs();
  const settings = useSettings();
  const reviewsToday = useLiveQuery(() => db.reviewLog.where('reviewedAt').aboveOrEqual(startOfToday()).count(), []);
  const coverageCount = useLiveQuery(() => db.coverage.count(), []);

  const recent = useMemo(() => {
    if (!games || !graphs) return undefined;
    const last = games.slice(0, 30);
    const results = new Map(last.map((g) => [g.id, analyzeGame(g, graphs)]));
    return summarize(last, results);
  }, [games, graphs]);

  if (!reps || !cards) return null;
  const now = Date.now();
  const due = cards.filter((c) => isDue(c, now)).length;
  const fresh = cards.filter(isNew).length;
  const mature = cards.filter(isMature).length;
  const learned = cards.length - fresh;

  const steps = [
    { done: !!(settings.lichessUsername || settings.chesscomUsername), text: <>Add your Lichess / Chess.com usernames and rating in <a href={href('settings')}>Settings</a></> },
    { done: reps.length > 0, text: <>Create a repertoire and add lines — or import a PGN / Lichess study (<a href={href('repertoire')}>Repertoire</a>)</> },
    { done: learned > 0, text: <>Learn your first moves (<a href={href('train')}>Train</a>)</> },
    { done: (coverageCount ?? 0) > 0, text: <>Run <a href={href('coverage')}>Coverage</a> to find the positions you'll meet in 1 in {settings.oneInN} games</> },
    { done: (games?.length ?? 0) > 0, text: <>Import your games to see where you forget your prep (<a href={href('games')}>Games</a>)</> },
  ];
  const allDone = steps.every((s) => s.done);

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="hero">
        <div className="row">
          <div>
            <h1>{due ? `${due} move${due === 1 ? '' : 's'} to review` : 'All caught up'}</h1>
            <p className="muted" style={{ margin: 0 }}>
              {fresh ? `${fresh} new move${fresh === 1 ? '' : 's'} waiting to be learned.` : 'No new moves queued.'}
            </p>
          </div>
          <span className="spacer" />
          <a className="btn primary" href={href('train', { rep: 'all', mode: 'review' })} style={{ pointerEvents: due ? 'auto' : 'none', opacity: due ? 1 : 0.5 }}>
            Review now
          </a>
          <a className="btn blue" href={href('train', { rep: 'all', mode: 'learn' })} style={{ pointerEvents: fresh ? 'auto' : 'none', opacity: fresh ? 1 : 0.5 }}>
            Learn new
          </a>
        </div>
      </div>

      <div className="grid3">
        <Stat value={learned} label="Moves learned" />
        <Stat value={mature} label="Mature (21d+)" hint="Moves whose review interval is three weeks or more" />
        <Stat value={reviewsToday ?? 0} label="Reviews today" />
        {recent && <Stat value={recent.byKind['you-deviated']} label="Forgot prep (last 30 games)" />}
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

      <div className="grid2">
        <div className="panel">
          <h2>Repertoires</h2>
          {reps.length === 0 && <p className="muted">None yet.</p>}
          <div className="col">
            {reps.map((r) => {
              const rc = cards.filter((c) => c.repId === r.id);
              const d = rc.filter((c) => isDue(c, now)).length;
              const n = rc.filter(isNew).length;
              return (
                <div key={r.id} className="moverow">
                  <ColorPill color={r.color} />
                  <a href={href(`repertoire/${r.id}`)} style={{ flex: 1 }}>
                    {r.name}
                  </a>
                  <span className="muted small">{rc.length} moves</span>
                  {d > 0 && <span className="badge due">{d} due</span>}
                  {n > 0 && <span className="badge new">{n} new</span>}
                </div>
              );
            })}
          </div>
        </div>

        <div className="panel">
          <h2>Recent games vs your prep</h2>
          {!recent || recent.games === 0 ? (
            <p className="muted">
              No games imported. <a href={href('games')}>Sync games</a>
            </p>
          ) : (
            <>
              <p className="muted small">Last {recent.games} games</p>
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
