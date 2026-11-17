/**
 * Game clocks: `clocks[i]` is the time (seconds) the player who made move i had left after it.
 * Pure helpers for showing them during a review.
 */

/** Each side's clock at the position after `cur` moves (before a side's first move: its first recorded time). */
export function clocksAt(clocks: readonly number[] | undefined, cur: number): { white?: number; black?: number } {
  if (!clocks?.length) return {};
  const side = (first: 0 | 1) => {
    let shown: number | undefined;
    for (let i = first; i < cur && i < clocks.length; i += 2) shown = clocks[i];
    return shown ?? clocks[first];
  };
  return { white: side(0), black: side(1) };
}

/** How long move `ply` took (needs the same player's previous move; increments make it approximate). */
export function timeSpent(clocks: readonly number[] | undefined, ply: number): number | undefined {
  if (!clocks || ply < 2 || clocks[ply] === undefined || clocks[ply - 2] === undefined) return undefined;
  const spent = clocks[ply - 2] - clocks[ply];
  return spent >= 0 ? spent : undefined;
}

/** 1:05:03, 4:07, or 0:08.4 in the last ten seconds. */
export function formatClock(sec: number): string {
  if (sec < 10) return `0:0${Math.max(0, sec).toFixed(1)}`;
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
