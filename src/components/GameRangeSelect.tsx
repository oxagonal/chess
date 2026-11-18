import { updateSettings, useSettings } from '../db/settings';
import { GAME_RANGES, type GameRange } from '../lib/gameRange';

/**
 * A period filter for your games, stored in Settings so it's shared everywhere it applies.
 *  - "gameRange": your games themselves (forgot prep, slips, recent games)
 *  - "opponentRange": your games used as opponent statistics (coverage from your opponents, My games tab)
 */
export function GameRangeSelect({
  count,
  setting = 'gameRange',
  value: shown,
  onChange,
}: {
  count?: number;
  setting?: 'gameRange' | 'opponentRange';
  /** A period chosen just here (e.g. a list opened from the explorer) instead of the setting. */
  value?: GameRange;
  onChange?: (r: GameRange) => void;
}) {
  const s = useSettings();
  const value = shown ?? s[setting];
  return (
    <span
      className="row"
      style={{ gap: 6, flexWrap: 'nowrap' }}
      title={
        setting === 'gameRange'
          ? 'Which games count for forgotten prep and slips — applies everywhere. Older games may predate changes to your repertoire.'
          : 'Which of your games count as opponent statistics (coverage from your own opponents, the My games tab). Longer periods give steadier numbers.'
      }
    >
      <select value={value} onChange={(e) => (onChange ? onChange(e.target.value as GameRange) : updateSettings({ [setting]: e.target.value as GameRange }))}>
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
