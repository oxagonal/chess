/**
 * Tilt: signs from your latest games that it's time for a break (Noël Studer: play only when you're
 * fresh, decide how many games before you start, and stop after a big blunder or losing on time).
 * Pure — the games come from the database (imported from Lichess / Chess.com).
 */
import type { StoredGame } from './types';

/** Games less than this apart belong to one session. */
export const SESSION_GAP = 45 * 60_000;
/** The flag only shows while you're likely still playing: your last game ended this recently. */
export const STILL_PLAYING = 90 * 60_000;
/** Losses in a row that make a streak worth a pause. */
export const LOSS_STREAK = 3;
/** Games in one session after which you're probably not fresh any more. */
export const LONG_SESSION = 10;

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

/** Your current session's warning signs, if you've played recently and there are any. */
export function tiltCheck(games: readonly StoredGame[], now = Date.now()): Tilt | undefined {
  const online = games.filter((g) => g.source !== 'otb').sort((a, b) => b.playedAt - a.playedAt);
  if (!online.length || now - online[0].playedAt > STILL_PLAYING) return undefined;
  const session = [online[0]];
  for (let i = 1; i < online.length && session[session.length - 1].playedAt - online[i].playedAt < SESSION_GAP; i++) session.push(online[i]);

  const reasons: string[] = [];
  let streak = 0;
  while (streak < session.length && session[streak].userScore === 0) streak++;
  if (streak >= LOSS_STREAK) reasons.push(`${streak} losses in a row`);
  const flagged = session.slice(0, 2).find(lostOnTime);
  if (flagged) reasons.push(flagged === session[0] ? 'you just lost on time' : 'you lost on time a game ago');
  if (session.length >= LONG_SESSION) reasons.push(`${session.length} games in this session`);
  return reasons.length ? { session, reasons } : undefined;
}
