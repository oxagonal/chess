/**
 * Tilt: signs from your latest games that it's time for a break (Noël Studer: play only when you're
 * fresh, decide how many games before you start, and stop after a big blunder or losing on time).
 * Pure — the games come from the database (imported from Lichess / Chess.com).
 */
import type { StoredGame } from './types';
import { DEFAULT_STOP_RULE, sessionIndexes, stopCheck, type SessionGame, type StopRule } from './stopRule';

export { SESSION_GAP, STILL_PLAYING } from './stopRule';

export interface Tilt {
  /** The session's games, newest first. */
  session: StoredGame[];
  /** Why it's time for a break, in words. */
  reasons: string[];
}

/** Lost on time (Lichess "outoftime", Chess.com "timeout"). */
export function lostOnTime(g: StoredGame): boolean {
  return g.userScore === 0 && (g.termination === 'outoftime' || g.termination === 'timeout');
}

/** A game as the stop rule sees it. */
export function asSessionGame(g: StoredGame): SessionGame {
  const rating = g.userColor === 'white' ? g.whiteElo : g.blackElo;
  return { at: g.playedAt, score: g.userScore ?? 0.5, lostOnTime: lostOnTime(g), rating, speed: g.timeClass };
}

/** Your current session's warning signs by your stop rule, if you've played recently and there are any. */
export function tiltCheck(games: readonly StoredGame[], now = Date.now(), rule: StopRule = DEFAULT_STOP_RULE): Tilt | undefined {
  const online = games.filter((g) => g.source !== 'otb');
  const check = stopCheck(online.map(asSessionGame), rule, now);
  if (!check.reasons.length) return undefined;
  const idx = sessionIndexes(online.map((g) => ({ at: g.playedAt })), now);
  return { session: idx.map((i) => online[i]), reasons: check.reasons };
}

/** Puzzles: misses in a row that call for a breather. */
export const PUZZLE_MISS_STREAK = 3;
/** A miss this quick, right after another miss, is rushing to win it back. */
export const PUZZLE_RUSH_MS = 15_000;

/**
 * Puzzles: the sign, in words, that it's time for a breather — three misses in a row, or a quick miss
 * straight after a miss (the "one more, quickly" urge Studer warns about in games).
 */
export function puzzleTilt(attempts: readonly { win: boolean; ms: number }[]): string | undefined {
  let streak = 0;
  for (let i = attempts.length - 1; i >= 0 && !attempts[i].win; i--) streak++;
  if (streak >= PUZZLE_MISS_STREAK) return `${streak} misses in a row`;
  const n = attempts.length;
  if (streak >= 2 && attempts[n - 1].ms < PUZZLE_RUSH_MS) return `a quick miss (${Math.round(attempts[n - 1].ms / 1000)} s) right after a miss — rushing to win it back`;
  return undefined;
}
