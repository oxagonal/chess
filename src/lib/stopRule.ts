/**
 * Your stop rule for a playing session (Noël Studer: decide before you start how many games you'll
 * play, and stop after a losing streak or a loss on time): checked on your latest games by Tabiya's
 * tilt flag, and by the phone check that runs when you open the Chess.com app (the /api/stop
 * endpoint, worker/index.ts) — the same rule, set in Tabiya. Pure: no browser, no database.
 */

export interface StopRule {
  /** Games in one session (0 = no limit). */
  games: number;
  /** Losses in a row (0 = off). */
  losses: number;
  /** Rating points below where the session started (0 = off). */
  drop: number;
  /** A loss on time in your last two games. */
  onTime: boolean;
}

export const DEFAULT_STOP_RULE: StopRule = { games: 10, losses: 3, drop: 0, onTime: true };

/**
 * What the phone check reads (a file in a secret gist of yours that Tabiya keeps up to date): your
 * rule and the accounts to look at.
 */
export interface StopRuleDoc extends Partial<StopRule> {
  chesscom?: string;
  lichess?: string;
}
export const STOP_FILE = 'tabiya-stop-rule.json';

/** Games less than this apart belong to one session. */
export const SESSION_GAP = 45 * 60_000;
/** Still playing: your last game ended this recently (else the next game starts a fresh session). */
export const STILL_PLAYING = 90 * 60_000;

/** A finished game, as the rule sees it. */
export interface SessionGame {
  /** When it was played (ms). */
  at: number;
  /** Your score: 1, ½ or 0. */
  score: number;
  /** You lost on time. */
  lostOnTime: boolean;
  /** Your rating with it (as the site reports it), and its speed (ratings are per speed). */
  rating?: number;
  speed?: string;
}

export interface StopCheck {
  /** Time to stop: the reasons, in words (empty: carry on). */
  reasons: string[];
  /** This session's games, newest first (empty: not playing right now). */
  session: SessionGame[];
}

/** The rule as saved (missing or bad fields: the defaults). */
export function normalRule(r: Partial<StopRule> | undefined): StopRule {
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : d);
  return {
    games: n(r?.games, DEFAULT_STOP_RULE.games),
    losses: n(r?.losses, DEFAULT_STOP_RULE.losses),
    drop: n(r?.drop, DEFAULT_STOP_RULE.drop),
    onTime: typeof r?.onTime === 'boolean' ? r.onTime : DEFAULT_STOP_RULE.onTime,
  };
}

/** Indexes (newest first) of the session you're playing: games less than SESSION_GAP apart, the last one recent. */
export function sessionIndexes(games: readonly { at: number }[], now: number): number[] {
  const order = games.map((g, i) => [g.at, i] as const).sort((a, b) => b[0] - a[0]);
  if (!order.length || now - order[0][0] > STILL_PLAYING) return [];
  const out = [order[0][1]];
  for (let k = 1; k < order.length && order[k - 1][0] - order[k][0] < SESSION_GAP; k++) out.push(order[k][1]);
  return out;
}

/** Whether to stop now, by your rule, from your latest games (any order). */
export function stopCheck(games: readonly SessionGame[], rule: StopRule, now: number): StopCheck {
  const session = sessionIndexes(games, now).map((i) => games[i]);
  const reasons: string[] = [];
  if (!session.length) return { reasons, session };
  let streak = 0;
  while (streak < session.length && session[streak].score === 0) streak++;
  if (rule.losses > 0 && streak >= rule.losses) reasons.push(`${streak} losses in a row`);
  if (rule.onTime) {
    const flagged = session.slice(0, 2).findIndex((g) => g.lostOnTime);
    if (flagged >= 0) reasons.push(flagged === 0 ? 'you just lost on time' : 'you lost on time a game ago');
  }
  if (rule.drop > 0) {
    const lost = pointsLost(session);
    if (lost !== undefined && lost >= rule.drop) reasons.push(`${lost} points down this session`);
  }
  if (rule.games > 0 && session.length >= rule.games) reasons.push(`${session.length} games in this session`);
  return { reasons, session };
}

/** Rating points lost since the session began, at the speed you're playing now (undefined: unknown). */
export function pointsLost(session: readonly SessionGame[]): number | undefined {
  const speed = session[0]?.speed;
  const same = session.filter((g) => g.speed === speed && g.rating !== undefined);
  if (same.length < 2) return undefined;
  return Math.max(0, same[same.length - 1].rating! - same[0].rating!);
}

/** Your rule in words: "5 games · 2 losses in a row · 40 points down · a loss on time". */
export function ruleText(rule: StopRule): string {
  const parts = [
    rule.games > 0 && `${rule.games} game${rule.games === 1 ? '' : 's'}`,
    rule.losses > 0 && `${rule.losses} loss${rule.losses === 1 ? '' : 'es'} in a row`,
    rule.drop > 0 && `${rule.drop} points down`,
    rule.onTime && 'a loss on time',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'no limits';
}

/** "3 of 5 games this session" */
export function sessionText(c: StopCheck, rule: StopRule): string {
  const n = c.session.length;
  return `${n}${rule.games > 0 ? ` of ${rule.games}` : ''} game${n === 1 && rule.games <= 1 ? '' : 's'} this session`;
}

/**
 * The phone check's answer, for the Shortcut's alert: its first word is STOP or OK (the Shortcut
 * looks at that), then why, one reason a line, and your rule.
 */
export function stopText(c: StopCheck, rule: StopRule): string {
  const cap = (x: string) => x[0].toUpperCase() + x.slice(1);
  if (c.reasons.length)
    return [`STOP 🛑 Time for a break`, '', ...c.reasons.map((r) => `• ${cap(r)}`), '', 'Review a game in Tabiya, or come back fresh.', `Your rule: ${ruleText(rule)}`].join('\n');
  if (!c.session.length) return `OK ✅ A fresh session\nYour rule: ${ruleText(rule)}`;
  return `OK ✅ ${cap(sessionText(c, rule))}\nYour rule: ${ruleText(rule)}`;
}
