import { useState } from 'react';
import { loadDueCount } from '../db/training';
import { allowBadge, badgePermission, isInstalled, setDueBadge, type BadgePermission } from '../services/appBadge';

/** Settings → Training: the number of moves due on the app's icon, and the permission it needs. */
export function AppBadgeSetting() {
  const [state, setState] = useState<BadgePermission>(badgePermission);
  if (state === 'unsupported')
    return (
      <p className="muted small">
        {isInstalled()
          ? 'This browser can’t put a number on the app’s icon.'
          : 'Install the app (Share → Add to Home Screen on an iPhone) to see how many moves are due on its icon.'}
      </p>
    );
  if (state === 'granted')
    return <p className="muted small">The app’s icon shows how many moves are due — updated whenever the app is open.</p>;
  if (state === 'denied')
    return (
      <p className="muted small">
        Notifications are off for Tabiya, so the icon can’t show how many moves are due. To get the number, allow them in the
        phone’s Settings → Notifications → Tabiya (it never sends any).
      </p>
    );
  return (
    <div className="row" style={{ gap: 10 }}>
      <button
        className="small"
        onClick={async () => {
          const next = await allowBadge();
          setState(next);
          if (next === 'granted') setDueBadge(await loadDueCount());
        }}
      >
        Show due moves on the app icon
      </button>
      <span className="muted small">
        iPhone and iPad show an app’s number only if it may send notifications. Tabiya never sends any — it only sets the number.
      </span>
    </div>
  );
}
