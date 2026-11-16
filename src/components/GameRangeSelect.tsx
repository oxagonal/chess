import { updateSettings, useSettings } from '../db/settings';
import { GAME_RANGES, type GameRange } from '../lib/gameRange';

/** The shared "which games count" filter. Changing it here changes it everywhere. */
export function GameRangeSelect({ count }: { count?: number }) {
  const { gameRange } = useSettings();
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }} title="Applies everywhere your games are used. Older games may predate changes to your repertoire.">
      <select value={gameRange} onChange={(e) => updateSettings({ gameRange: e.target.value as GameRange })}>
        {GAME_RANGES.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>
      {count !== undefined && (
        <span className="muted small">
          {count} game{count === 1 ? '' : 's'}
        </span>
      )}
    </span>
  );
}
