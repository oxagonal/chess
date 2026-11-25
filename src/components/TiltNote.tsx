import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { useNow } from '../hooks';
import { tiltCheck } from '../lib/tilt';
import { checkRecentGames } from '../services/sync';
import { useSettings } from '../db/settings';
import { normalRule } from '../lib/stopRule';

const DISMISSED_KEY = 'chess-prep:tiltDismissed';

/**
 * "Maybe stop for now": shown on Home while you're playing (your latest imported games) when there
 * are signs of tilt — losses in a row, a loss on time, a long session. Closing it hides it until
 * your next game.
 */
export function TiltNote() {
  useEffect(() => void checkRecentGames(), []);
  const now = useNow(60_000);
  const recent = useLiveQuery(() => db.games.where('playedAt').above(Date.now() - 12 * 3600_000).toArray(), [now]);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISSED_KEY);
    } catch {
      return null;
    }
  });
  const rule = normalRule(useSettings().stopRule);
  const tilt = recent && tiltCheck(recent, now, rule);
  if (!tilt || dismissed === tilt.session[0].id) return null;
  const close = () => {
    setDismissed(tilt.session[0].id);
    try {
      sessionStorage.setItem(DISMISSED_KEY, tilt.session[0].id);
    } catch {
      /* not remembered: it just shows again */
    }
  };
  const why = tilt.reasons.join(', ');
  return (
    <div className="panel row tilt-note" role="status">
      <span className="tilt-icon" aria-hidden="true">
        ☕
      </span>
      <span className="small">
        <b>Time to stop, by your rule:</b> {why[0].toUpperCase() + why.slice(1)}. Play only when you're fresh, decide how many games
        before you start, and stop after a big blunder or a loss on time — review a game instead, or come back later.
      </span>
      <span className="spacer" />
      <button className="small ghost" aria-label="Close" onClick={close}>
        ✕
      </button>
    </div>
  );
}
