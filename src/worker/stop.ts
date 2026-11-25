/**
 * /api/stop — the phone check that runs when you open the Chess.com app (an iPhone Shortcuts
 * automation): it looks at your latest Chess.com and Lichess games and answers "STOP — …" or "OK — …"
 * by your stop rule. The rule comes from Tabiya (a secret gist of yours that the app keeps up to
 * date: `?rule=<github user>/<gist id>`), or from the link itself (`?cc=&li=&games=&losses=&drop=&ontime=`).
 * Runs on Cloudflare (worker/index.ts); `fetcher` is swappable for tests.
 */
import { normalRule, STOP_FILE, stopCheck, stopText, type SessionGame, type StopRuleDoc } from '../lib/stopRule';

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

export async function handleStop(url: URL, now = Date.now(), fetcher: Fetcher = fetch): Promise<Response> {
  const q = url.searchParams;
  let doc: StopRuleDoc;
  const ref = q.get('rule');
  if (ref) {
    const m = /^([A-Za-z0-9-]{1,39})\/([0-9a-f]{20,40})$/.exec(ref);
    if (!m) return text('OK — this stop-check link is broken: copy it again from Tabiya → Plan.', 400);
    try {
      const res = await fetcher(`https://gist.githubusercontent.com/${m[1]}/${m[2]}/raw/${STOP_FILE}?t=${Math.floor(now / 60_000)}`, {
        headers: { 'User-Agent': UA },
      });
      if (!res.ok) return text(`OK — couldn't read your stop rule (GitHub said ${res.status}). Open Tabiya → Plan to set it up again.`);
      doc = (await res.json()) as StopRuleDoc;
    } catch {
      return text("OK — couldn't read your stop rule right now.");
    }
  } else {
    const n = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
    doc = { chesscom: q.get('cc') ?? undefined, lichess: q.get('li') ?? undefined, games: n('games'), losses: n('losses'), drop: n('drop'), onTime: q.has('ontime') ? q.get('ontime') !== '0' : undefined };
  }
  const rule = normalRule(doc);
  const sources: [string, Promise<SessionGame[]>][] = [];
  if (doc.chesscom?.trim()) sources.push(['Chess.com', chesscomGames(doc.chesscom.trim(), now, fetcher)]);
  if (doc.lichess?.trim()) sources.push(['Lichess', lichessGames(doc.lichess.trim(), now, fetcher)]);
  if (!sources.length) return text('OK — no Chess.com or Lichess username in your stop rule: add one in Tabiya → Settings.');
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
  return text(stopText(check, rule) + (failed.length ? ` (Couldn't reach ${failed.join(' and ')}.)` : ''));
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
