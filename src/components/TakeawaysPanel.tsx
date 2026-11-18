import { useEffect, useRef, useState } from 'react';
import { db } from '../db/db';
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
          </>
        ) : (
          <>
            <button
              className="primary small"
              title="Mark the review finished: a ✓ and the tags appear beside the game on the Games tab"
              onClick={() => void db.games.update(game.id, { takeaways: text, reviewedAt: Date.now() })}
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
