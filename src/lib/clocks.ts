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

/**
 * The increment, worked out from the clocks: a player's time can only go up between their moves by
 * the increment (minus the time the move took), so the biggest rise, rounded up, is a good guess.
 * 0 when no clock ever rises.
 */
export function inferIncrement(clocks: readonly number[] | undefined): number {
  let rise = 0;
  for (let i = 2; clocks && i < clocks.length; i++) rise = Math.max(rise, clocks[i] - clocks[i - 2]);
  return rise > 0.05 ? Math.ceil(rise - 0.05) : 0;
}

/**
 * How long each move took (seconds), counting the increment like Chess.com's move times. Undefined for
 * each side's first move (the starting time isn't recorded) and wherever a clock is missing.
 */
export function moveTimes(clocks: readonly number[] | undefined): (number | undefined)[] {
  if (!clocks) return [];
  const inc = inferIncrement(clocks);
  return clocks.map((c, i) => {
    if (i < 2 || c === undefined || clocks[i - 2] === undefined) return undefined;
    return Math.max(0, clocks[i - 2] - c + inc);
  });
}

/** A move's time the way Chess.com lists it: 0.8s, 10.5s, 1:05. */
export function formatMoveTime(sec: number): string {
  if (sec < 60) return `${(Math.round(sec * 10) / 10).toFixed(1)}s`;
  return formatClock(sec);
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
