import { describe, expect, it } from 'vitest';
import { DEFAULT_STOP_RULE, stopCheck, stopText, type SessionGame } from '../lib/stopRule';
import { handleStop } from '../worker/stop';

const now = Date.UTC(2026, 10, 25, 20, 0);
const min = 60_000;

describe('the stop rule', () => {
  const g = (minAgo: number, score: number, rating?: number, extra: Partial<SessionGame> = {}): SessionGame => ({ at: now - minAgo * min, score, lostOnTime: false, rating, speed: 'blitz', ...extra });
  it('your numbers: games in the session, losses in a row, points down', () => {
    const rule = { games: 5, losses: 2, drop: 40, onTime: true };
    // Newest first: lost, lost, won, won — 2 losses in a row; 2000 → 1955.
    const session = [g(3, 0, 1955), g(10, 0, 1963), g(17, 1, 1971), g(24, 1, 1990), g(31, 0, 2000)];
    const c = stopCheck(session, rule, now);
    expect(c.reasons).toEqual(['2 losses in a row', '45 points down this session', '5 games in this session']);
    expect(stopText(c, rule)).toBe(
      'STOP 🛑 Time for a break\n\n• 2 losses in a row\n• 45 points down this session\n• 5 games in this session\n\nReview a game in Tabiya, or come back fresh.\nYour rule: 5 games · 2 losses in a row · 40 points down · a loss on time',
    );
    // One game in: carry on.
    expect(stopText(stopCheck([g(3, 1, 2008)], rule, now), rule)).toBe('OK ✅ 1 of 5 games this session\nYour rule: 5 games · 2 losses in a row · 40 points down · a loss on time');
    // An hour and a half without a game: a fresh session.
    expect(stopText(stopCheck(session.map((x) => ({ ...x, at: x.at - 120 * min })), rule, now), rule)).toMatch(/^OK ✅ A fresh session\n/);
    // 0 turns a part off.
    expect(stopCheck(session, { games: 0, losses: 0, drop: 0, onTime: false }, now).reasons).toEqual([]);
    // Points at the speed you're playing now only.
    expect(stopCheck([g(3, 0, 1500, { speed: 'rapid' }), g(10, 0, 2000)], { ...rule, losses: 0 }, now).reasons).toEqual([]);
  });
  it('Tabiya’s defaults are the old tilt flag: 3 losses in a row, a loss on time, 10 games', () => {
    expect(DEFAULT_STOP_RULE).toEqual({ games: 10, losses: 3, drop: 0, onTime: true });
  });
});

describe('the phone check (/api/stop)', () => {
  const sec = (minAgo: number) => Math.round((now - minAgo * min) / 1000);
  const ccGame = (minAgo: number, mine: string, rating: number) => ({
    end_time: sec(minAgo),
    rules: 'chess',
    time_class: 'blitz',
    white: { username: 'MyName', rating, result: mine },
    black: { username: 'opp', rating: 2000, result: mine === 'win' ? 'resigned' : 'win' },
  });
  const ccArchive = { games: [ccGame(200, 'win', 2010), ccGame(30, 'win', 1990), ccGame(20, 'checkmated', 1982), ccGame(8, 'timeout', 1974)] };
  const fetcher = (routes: Record<string, unknown>) => async (url: string) => {
    for (const [k, body] of Object.entries(routes)) if (url.includes(k)) return new Response(typeof body === 'string' ? body : JSON.stringify(body));
    return new Response('{}', { status: 404 });
  };
  it('reads your rule from your gist and answers STOP or OK', async () => {
    const rule = { chesscom: 'MyName', games: 5, losses: 2, drop: 0, onTime: true };
    const f = fetcher({ 'gist.githubusercontent.com/me/0123456789abcdef0123/raw/tabiya-stop-rule.json': rule, 'api.chess.com/pub/player/myname/games/2026/11': ccArchive });
    const res = await handleStop(new URL('https://x/api/stop?rule=me/0123456789abcdef0123'), now, f);
    expect(await res.text()).toMatch(/^STOP 🛑 Time for a break\n\n• 2 losses in a row\n• You just lost on time\n/);
    // Your limit raised to 3 losses in a row (and no loss-on-time rule): still fine.
    const f2 = fetcher({ 'gist.githubusercontent.com': { ...rule, losses: 3, onTime: false }, 'api.chess.com': ccArchive });
    expect(await (await handleStop(new URL('https://x/api/stop?rule=me/0123456789abcdef0123'), now, f2)).text()).toMatch(/^OK ✅ 3 of 5 games this session\n/);
  });
  it('the rule can be in the link instead; Lichess counts too; a site that is down does not block you', async () => {
    const li = [
      { createdAt: now - 20 * min, lastMoveAt: now - 15 * min, status: 'mate', speed: 'blitz', winner: 'black', players: { white: { user: { id: 'me' }, rating: 2000, ratingDiff: -6 }, black: { user: { id: 'x' } } } },
      { createdAt: now - 10 * min, lastMoveAt: now - 5 * min, status: 'resign', speed: 'blitz', winner: 'white', players: { white: { user: { id: 'x' } }, black: { user: { id: 'me' }, rating: 1994, ratingDiff: -6 } } },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n');
    const f = fetcher({ 'lichess.org/api/games/user/me': li });
    expect(await (await handleStop(new URL('https://x/api/stop?li=Me&games=5&losses=2'), now, f)).text()).toMatch(/^STOP 🛑 Time for a break\n\n• 2 losses in a row\n/);
    const down = async (url: string) => (url.includes('chess.com') ? new Response('', { status: 503 }) : new Response(li));
    expect(await (await handleStop(new URL('https://x/api/stop?cc=MyName&li=me&games=5&losses=3'), now, down)).text()).toMatch(/^OK ✅ 2 of 5 games this session\n.*\n\(Couldn't reach Chess\.com\.\)$/);
    expect(await (await handleStop(new URL('https://x/api/stop?rule=not-a-gist'), now, f)).text()).toMatch(/broken/);
    // A browser gets a page; the Shortcut (not a browser) plain text.
    const safari = new Headers({ accept: 'text/html,application/xhtml+xml', 'user-agent': 'Mozilla/5.0 (iPhone) Safari' });
    const shortcut = new Headers({ accept: '*/*', 'user-agent': 'Shortcuts/2610 CFNetwork Darwin' });
    const pageRes = await handleStop(new URL('https://x/api/stop?li=Me&games=5&losses=2'), now, f, safari);
    expect([pageRes.headers.get('content-type'), (await pageRes.text()).includes('Time for a break')]).toEqual(['text/html; charset=utf-8', true]);
    expect((await handleStop(new URL('https://x/api/stop?li=Me&games=5&losses=2'), now, f, shortcut)).headers.get('content-type')).toMatch(/^text\/plain/);
  });
});
