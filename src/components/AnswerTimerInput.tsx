import { updateSettings, useSettings } from '../db/settings';

/** The trainer's answer timer, in seconds (0 = off) — in the trainer's ⚙ and in Settings → Training. */
export function AnswerTimerInput() {
  const s = useSettings();
  return (
    <input
      type="number"
      min={0}
      max={300}
      inputMode="numeric"
      aria-label="Answer timer (seconds, 0 = off)"
      value={s.trainAnswerSeconds}
      onChange={(e) => void updateSettings({ trainAnswerSeconds: Math.min(300, Math.max(0, Math.round(Number(e.target.value) || 0))) })}
      style={{ width: 72 }}
    />
  );
}
