import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { addGameCards } from '../services/tactics';
import { gameMistakes } from '../lib/tacticCards';
import { updateSettings, useSettings } from '../db/settings';
import { tagOptions, toggleTag } from '../lib/takeaways';
import type { StoredGame } from '../lib/types';
import { fmtDate } from './ui';

/**
 * The end of a game review: your takeaways in your own words, what to work on (tags), and "Done
 * reviewing" — which puts a ✓ and the tags beside the game on the Games tab. Everything saves as
 * you go (and syncs with the game).
 */
export function TakeawaysPanel({ game }: { game: StoredGame }) {
  const settings = useSettings();
  const [text, setText] = useState(game.takeaways ?? '');
  const [adding, setAdding] = useState('');
  const latest = useRef({ text, saved: game.takeaways ?? '' });
  latest.current = { text, saved: game.takeaways ?? '' };

  // The text saves a moment after you stop typing, and when you leave.
  useEffect(() => {
    if (text === (game.takeaways ?? '')) return;
    const t = setTimeout(() => void db.games.update(game.id, { takeaways: text }), 600);
    return () => clearTimeout(t);
  }, [text, game.id, game.takeaways]);
  useEffect(
    () => () => {
      const { text: t, saved } = latest.current;
      if (t !== saved) void db.games.update(game.id, { takeaways: t });
    },
    [game.id],
  );

  const tags = game.workOn ?? [];
  const options = tagOptions(settings.workOnTags, tags);
  const setTags = (next: string[]) => void db.games.update(game.id, { workOn: next.length ? next : undefined });
  const addTag = () => {
    const t = adding.trim();
    if (!t) return;
    setAdding('');
    if (!options.some((o) => o.toLowerCase() === t.toLowerCase())) void updateSettings({ workOnTags: [...settings.workOnTags, t] });
    if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) setTags(toggleTag(tags, t, [...options, t]));
  };

  return (
    <div className="panel col takeaways" style={{ gap: 10 }}>
      <h3 style={{ margin: 0 }}>Takeaways</h3>
      <textarea
        className="takeaways-text"
        rows={4}
        placeholder="What did this game teach you? What will you do differently?"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== (game.takeaways ?? '') && void db.games.update(game.id, { takeaways: text })}
      />
      <div>
        <div className="anno-label">Work on</div>
        <div className="row tag-row">
          {options.map((t) => {
            const on = tags.some((x) => x.toLowerCase() === t.toLowerCase());
            return (
              <button key={t} className={`small tag-toggle ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => setTags(toggleTag(tags, t, options))}>
                {t}
              </button>
            );
          })}
          <form
            className="tag-add"
            onSubmit={(e) => {
              e.preventDefault();
              addTag();
            }}
          >
            <input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="+ your own" aria-label="Add a tag" />
          </form>
        </div>
      </div>
      <div className="row">
        {game.reviewedAt ? (
          <>
            <span className="badge good">✓ Reviewed {fmtDate(game.reviewedAt)}</span>
            <span className="spacer" />
            <button className="small ghost" onClick={() => void db.games.update(game.id, { reviewedAt: undefined })}>
              Not done yet
            </button>
            <MistakeCards game={game} />
          </>
        ) : (
          <>
            <button
              className="primary small"
              title="Mark the review finished: a ✓ and the tags appear beside the game on the Games tab"
              onClick={() => {
                void db.games.update(game.id, { takeaways: text, reviewedAt: Date.now() });
                // Your crucial mistakes come back as puzzles, to solve again cold (Nate Solon's spaced review).
                void addGameCards(game);
              }}
            >
              ✓ Done reviewing
            </button>
            <span className="muted small">A ✓ and the tags then show beside the game on the Games tab.</span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Your crucial mistakes in this game, as positions to solve again from tomorrow (mixed into your puzzle
 * blocks): how many there are, or a button when they aren't yet (e.g. the computer review came later).
 */
function MistakeCards({ game }: { game: StoredGame }) {
  const have = useLiveQuery(() => db.tacticCards.where('id').startsWith(`g:${game.id}:`).count(), [game.id]);
  if (have === undefined) return null;
  const possible = gameMistakes(game).length;
  if (have)
    return (
      <span className="muted small mistake-cards" title="In your puzzle blocks from the next day, then spaced out until you solve each twice in a row">
        ↻ {have} of your mistakes here come back as puzzles
      </span>
    );
  if (!possible)
    return (
      <span className="muted small mistake-cards">
        {game.review || game.liveEvals
          ? 'No crucial mistakes of yours found — mark one with ? or ?? (right-click the move) to bring it back as a puzzle.'
          : 'Run the computer review — or mark your mistakes with ? or ?? (right-click the move) — to bring them back as puzzles.'}
      </span>
    );
  return (
    <button className="small mistake-cards" onClick={() => void addGameCards(game)} title="Positions where you went wrong, to solve again from tomorrow">
      ↻ Bring my {possible} mistakes back as puzzles
    </button>
  );
}
