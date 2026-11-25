/**
 * The phone stop check's copy of your stop rule: a small secret gist in your GitHub account (the
 * token device sync uses), kept up to date by Tabiya, which the check at /api/stop reads each time you
 * open the Chess.com app — so it follows the rule you set here, from any device. The sync data itself
 * isn't in it (only the rule and your Chess.com / Lichess names), so its link gives nothing else away.
 */
import { gh, GitHubError } from './gist';
import { currentToken } from './cloudSync';
import { updateSettings, type AppSettings } from '../db/settings';
import { normalRule, STOP_FILE, type StopRuleDoc } from '../lib/stopRule';

const DESCRIPTION = 'Tabiya stop rule — read by the phone stop check, written by the app (please don’t edit)';
const LAST_KEY = 'chess-prep:stopRulePublished';

/** What the check reads. */
export function stopRuleDoc(s: Pick<AppSettings, 'stopRule' | 'chesscomUsername' | 'lichessUsername'>): StopRuleDoc {
  return { ...normalRule(s.stopRule), chesscom: s.chesscomUsername.trim() || undefined, lichess: s.lichessUsername.trim() || undefined };
}

/** The link the Shortcut calls: your rule from the gist. */
export function stopCheckLink(owner: string, gistId: string): string {
  return `${location.origin}/api/stop?rule=${owner}/${gistId}`;
}

/** The same check with the rule in the link itself (no sync): changing the rule means a new link. */
export function plainStopCheckLink(s: Pick<AppSettings, 'stopRule' | 'chesscomUsername' | 'lichessUsername'>): string {
  const d = stopRuleDoc(s);
  const p = new URLSearchParams();
  if (d.chesscom) p.set('cc', d.chesscom);
  if (d.lichess) p.set('li', d.lichess);
  p.set('games', String(d.games));
  p.set('losses', String(d.losses));
  p.set('drop', String(d.drop));
  p.set('ontime', d.onTime ? '1' : '0');
  return `${location.origin}/api/stop?${p}`;
}

/**
 * Write your rule to its gist (making the gist the first time — `create`), if it changed since this
 * device last wrote it. Needs device sync. The gist's id is saved in your (synced) settings, so every
 * device updates the same one.
 */
export async function publishStopRule(s: AppSettings, opts: { create?: boolean } = {}): Promise<string | undefined> {
  const token = currentToken();
  if (!token) return undefined;
  const content = JSON.stringify(stopRuleDoc(s), null, 1);
  let id = s.stopGist;
  if (!id && !opts.create) return undefined;
  const last = (() => {
    try {
      return localStorage.getItem(LAST_KEY);
    } catch {
      return null;
    }
  })();
  if (id && last === `${id}|${content}`) return id;
  const files = { [STOP_FILE]: { content } };
  if (id) {
    try {
      await gh(token, `/gists/${id}`, { method: 'PATCH', json: { files } });
    } catch (e) {
      // Deleted on GitHub: make a new one.
      if (!(e instanceof GitHubError && e.status === 404)) throw e;
      id = undefined;
    }
  }
  if (!id) {
    id = (await gh<{ id: string }>(token, '/gists', { method: 'POST', json: { description: DESCRIPTION, public: false, files } })).id;
    await updateSettings({ stopGist: id });
  }
  try {
    localStorage.setItem(LAST_KEY, `${id}|${content}`);
  } catch {
    /* written again next time */
  }
  return id;
}
