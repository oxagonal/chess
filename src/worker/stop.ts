/**
 * /api/stop — the phone check that runs when you open the Chess.com app (an iPhone Shortcuts
 * automation): it looks at your latest Chess.com and Lichess games and answers "STOP — …" or "OK — …"
 * by your stop rule. The rule comes from Tabiya (a secret gist of yours that the app keeps up to
 * date: `?rule=<github user>/<gist id>`), or from the link itself (`?cc=&li=&games=&losses=&drop=&ontime=`).
 * Runs on Cloudflare (worker/index.ts); `fetcher` is swappable for tests.
 */
import { normalRule, pointsLost, reasonsSentence, ruleText, sessionText, STOP_FILE, stopCheck, stopText, type SessionGame, type StopCheck, type StopRule, type StopRuleDoc } from '../lib/stopRule';

const UA = 'Tabiya stop check (+https://chess.oxagon.workers.dev)';
/** How far back to look: a session ends after STILL_PLAYING without a game, and sessions run long. */
const LOOK_BACK = 12 * 3600_000;
const DRAWS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
  });
}

/**
 * A browser (the Test link, or the link opened in Safari) gets a page; the Shortcut gets plain text.
 * `view=page` / `view=text` pick one outright.
 */
export function wantsPage(url: URL, headers?: Headers): boolean {
  const view = url.searchParams.get('view');
  if (view) return view === 'page';
  return !!headers && /text\/html/.test(headers.get('accept') ?? '') && /^Mozilla\//.test(headers.get('user-agent') ?? '');
}

export async function handleStop(url: URL, now = Date.now(), fetcher: Fetcher = fetch, headers?: Headers): Promise<Response> {
  const q = url.searchParams;
  const page = wantsPage(url, headers);
  let doc: StopRuleDoc;
  const ref = q.get('rule');
  if (ref) {
    const m = /^([A-Za-z0-9-]{1,39})\/([0-9a-f]{20,40})$/.exec(ref);
    if (!m) return text("OK. This link doesn't look right. Copy it again from Tabiya's Plan tab.", 400);
    try {
      const res = await fetcher(`https://gist.githubusercontent.com/${m[1]}/${m[2]}/raw/${STOP_FILE}?t=${Math.floor(now / 60_000)}`, {
        headers: { 'User-Agent': UA },
      });
      if (!res.ok) return text(`OK. Couldn't load your stop rule (GitHub said ${res.status}). Set it up again from Tabiya's Plan tab.`);
      doc = (await res.json()) as StopRuleDoc;
    } catch {
      return text("OK. Couldn't load your stop rule just now.");
    }
  } else {
    const n = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
    doc = { chesscom: q.get('cc') ?? undefined, lichess: q.get('li') ?? undefined, games: n('games'), losses: n('losses'), drop: n('drop'), onTime: q.has('ontime') ? q.get('ontime') !== '0' : undefined };
  }
  const rule = normalRule(doc);
  const sources: [string, Promise<SessionGame[]>][] = [];
  if (doc.chesscom?.trim()) sources.push(['Chess.com', chesscomGames(doc.chesscom.trim(), now, fetcher)]);
  if (doc.lichess?.trim()) sources.push(['Lichess', lichessGames(doc.lichess.trim(), now, fetcher)]);
  if (!sources.length) return text("OK. There's no Chess.com or Lichess username to check. Add yours in Tabiya's Settings.");
  const games: SessionGame[] = [];
  const failed: string[] = [];
  for (const [name, p] of sources) {
    try {
      games.push(...(await p));
    } catch {
      failed.push(name);
    }
  }
  const check = stopCheck(games, rule, now);
  if (q.get('format') === 'json') {
    return new Response(JSON.stringify({ stop: check.reasons.length > 0, reasons: check.reasons, games: check.session.length, rule, failed }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
    });
  }
  if (page) return new Response(stopPage(check, rule, failed), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  return text(stopText(check, rule) + (failed.length ? ` (Couldn't reach ${failed.join(' or ')}.)` : ''));
}

const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The answer as a page: stop or not, why, this session's games and your rule. */
export function stopPage(c: StopCheck, rule: StopRule, failed: string[] = []): string {
  const stop = c.reasons.length > 0;
  // Oldest first, like a scoresheet: a dot per game.
  const dots = [...c.session]
    .reverse()
    .map((g) => `<span class="dot ${g.score === 1 ? 'w' : g.score === 0 ? 'l' : 'd'}" title="${g.score === 1 ? 'Win' : g.score === 0 ? 'Loss' : 'Draw'}"></span>`)
    .join('');
  const lost = pointsLost(c.session);
  const rating = c.session[0]?.rating;
  const meta = [rating !== undefined && `Rating ${rating}`, lost && `down ${lost} since you started`].filter(Boolean).join(', ');
  const ruleLine = ruleText(rule);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1a1917"><title>${stop ? 'Time to stop' : 'OK to play'} · Tabiya</title>
<style>
:root { color-scheme: dark; --bg: #161513; --panel: #22201d; --text: #ece9e3; --muted: #9c978e; --good: #74b95a; --bad: #e05d5d; --draw: #9c978e; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: max(20px, env(safe-area-inset-top)) 16px max(20px, env(safe-area-inset-bottom));
  background: var(--bg); color: var(--text); font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif; }
.card { width: min(400px, 100%); background: var(--panel); border-radius: 16px; padding: 24px 22px 22px; text-align: center; }
h1 { margin: 0 0 12px; font-size: 26px; letter-spacing: -0.02em; color: ${stop ? 'var(--bad)' : 'var(--good)'}; }
.why { margin: 0 0 16px; font-size: 17px; }
.dots { display: flex; justify-content: center; flex-wrap: wrap; gap: 7px; margin: 4px 0 8px; }
.dot { width: 14px; height: 14px; border-radius: 50%; background: var(--draw); }
.dot.w { background: var(--good); } .dot.l { background: var(--bad); }
.meta { color: var(--muted); font-size: 14px; margin: 0; }
.rule { margin-top: 16px; padding-top: 14px; border-top: 1px solid #34312c; color: var(--muted); font-size: 14px; }
a.btn { display: inline-block; margin-top: 16px; padding: 10px 18px; border-radius: 10px; background: #34312c; color: var(--text); font-weight: 600; text-decoration: none; }
</style></head><body><main class="card">
<h1>${stop ? 'Time to stop' : esc(sessionText(c, rule))}</h1>
${stop ? `<p class="why">${esc(reasonsSentence(c.reasons))} That's where you said you'd stop.</p>` : ''}
${c.session.length ? `<div class="dots" aria-label="This session's games">${dots}</div>` : ''}
${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
${failed.length ? `<p class="meta">Couldn't reach ${esc(failed.join(' or '))} just now.</p>` : ''}
<div class="rule">Your rule: ${esc(ruleLine)}</div>
<a class="btn" href="/#/${stop ? 'games' : 'plan'}">${stop ? 'Review a game' : 'Open Tabiya'}</a>
</main></body></html>`;
}

interface ChesscomSide {
  username: string;
  rating?: number;
  result: string;
}
interface ChesscomGame {
  end_time: number;
  rules?: string;
  time_class?: string;
  white: ChesscomSide;
  black: ChesscomSide;
}

/** Your latest Chess.com games (this month's archive, and last month's just after it turns). */
export async function chesscomGames(user: string, now: number, fetcher: Fetcher = fetch): Promise<SessionGame[]> {
  const d = new Date(now);
  const months = [[d.getUTCFullYear(), d.getUTCMonth() + 1]];
  if (now - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) < LOOK_BACK) {
    const p = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
    months.push([p.getUTCFullYear(), p.getUTCMonth() + 1]);
  }
  const name = user.toLowerCase();
  const out: SessionGame[] = [];
  for (const [y, m] of months) {
    const res = await fetcher(`https://api.chess.com/pub/player/${encodeURIComponent(name)}/games/${y}/${String(m).padStart(2, '0')}`, {
      headers: { 'User-Agent': UA },
    });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`Chess.com ${res.status}`);
    const { games = [] } = (await res.json()) as { games?: ChesscomGame[] };
    for (const g of games) {
      const at = g.end_time * 1000;
      if (now - at > LOOK_BACK || (g.rules && g.rules !== 'chess') || g.time_class === 'daily') continue;
      const me = g.white.username.toLowerCase() === name ? g.white : g.black.username.toLowerCase() === name ? g.black : undefined;
      if (!me) continue;
      out.push({
        at,
        score: me.result === 'win' ? 1 : DRAWS.has(me.result) ? 0.5 : 0,
        lostOnTime: me.result === 'timeout',
        rating: me.rating,
        speed: g.time_class,
      });
    }
  }
  return out;
}

interface LichessGame {
  createdAt: number;
  lastMoveAt?: number;
  status: string;
  speed?: string;
  winner?: 'white' | 'black';
  players: Record<'white' | 'black', { user?: { id: string }; rating?: number; ratingDiff?: number }>;
}

/** Your latest Lichess games. */
export async function lichessGames(user: string, now: number, fetcher: Fetcher = fetch): Promise<SessionGame[]> {
  const id = user.toLowerCase();
  const params = new URLSearchParams({ since: String(now - LOOK_BACK), max: '60', moves: 'false', tags: 'false', clocks: 'false', evals: 'false', opening: 'false' });
  const res = await fetcher(`https://lichess.org/api/games/user/${encodeURIComponent(id)}?${params}`, {
    headers: { Accept: 'application/x-ndjson', 'User-Agent': UA },
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Lichess ${res.status}`);
  const out: SessionGame[] = [];
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue;
    const g = JSON.parse(line) as LichessGame;
    if (['created', 'started', 'aborted', 'noStart'].includes(g.status) || g.speed === 'correspondence') continue;
    const side = g.players.white.user?.id === id ? 'white' : g.players.black.user?.id === id ? 'black' : undefined;
    if (!side) continue;
    const p = g.players[side];
    out.push({
      at: g.lastMoveAt ?? g.createdAt,
      score: g.winner ? (g.winner === side ? 1 : 0) : 0.5,
      lostOnTime: g.status === 'outoftime' && !!g.winner && g.winner !== side,
      rating: p.rating !== undefined ? p.rating + (p.ratingDiff ?? 0) : undefined,
      speed: g.speed,
    });
  }
  return out;
}
