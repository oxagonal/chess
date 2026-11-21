// "Connect Lichess": OAuth 2 with PKCE, which Lichess supports without registering an app.
// Since 2026 the Lichess opening explorer only answers requests carrying a Lichess token. The token
// asks for study:read, so your private and unlisted studies can be imported, and puzzle:read /
// puzzle:write, so the Puzzles tab gets puzzles at your rating and can record your results on Lichess
// (only when you let it count them). The same token speeds up game downloads, and /api/account
// tells us the username so it doesn't have to be typed.
import { useSyncExternalStore } from 'react';
import { getSettings, updateSettings } from '../db/settings';

export const LICHESS = 'https://lichess.org';
/** The app's name on Lichess's "allow access" page. */
const CLIENT_ID = 'tabiya';
const PENDING_KEY = 'chess-prep:lichess-login';
/** What the login asks for: reading your studies (to import private ones), reading and recording puzzles. */
export const LICHESS_SCOPES = 'study:read puzzle:read puzzle:write';

interface Pending {
  verifier: string;
  state: string;
  redirectUri: string;
  /** The hash route to return to after Lichess sends us back. */
  returnTo: string;
}

/* ------------------------------------------------------------ status (for the UI) */

export interface LoginStatus {
  busy?: boolean;
  error?: string;
}
let status: LoginStatus = {};
const listeners = new Set<() => void>();
function setStatus(s: LoginStatus) {
  status = s;
  listeners.forEach((l) => l());
}
export function useLichessLoginStatus(): LoginStatus {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => status,
  );
}

/* ------------------------------------------------------------ PKCE */

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** S256 code challenge for a PKCE verifier (RFC 7636). */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/* ------------------------------------------------------------ flow */

/** Sends the browser to lichess.org to approve; Lichess redirects back to this page. */
export async function startLichessLogin(): Promise<void> {
  const pending: Pending = {
    verifier: randomToken(32),
    state: randomToken(16),
    redirectUri: window.location.origin + window.location.pathname,
    returnTo: window.location.hash || '#/settings',
  };
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    setStatus({ error: 'This browser blocks site storage, so the Lichess login cannot complete.' });
    return;
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: pending.redirectUri,
    code_challenge_method: 'S256',
    code_challenge: await codeChallenge(pending.verifier),
    state: pending.state,
    scope: LICHESS_SCOPES,
  });
  window.location.assign(`${LICHESS}/oauth?${params}`);
}

/**
 * Finishes a login when Lichess has just redirected back with ?code=…&state=….
 * Call before the first render: the URL is cleaned up synchronously, before any await.
 */
export async function completeLichessLogin(): Promise<void> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!code && !error) return;

  let pending: Pending | null = null;
  try {
    pending = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null') as Pending | null;
    localStorage.removeItem(PENDING_KEY);
  } catch {
    /* storage unavailable: handled below */
  }
  window.history.replaceState(null, '', url.pathname + (pending?.returnTo ?? '#/settings'));

  if (error) {
    setStatus({ error: error === 'access_denied' ? 'Lichess connection cancelled.' : `Lichess login failed (${error}).` });
    return;
  }
  if (!pending || pending.state !== url.searchParams.get('state')) {
    setStatus({ error: 'That Lichess login could not be matched to this page — please try connecting again.' });
    return;
  }

  setStatus({ busy: true });
  try {
    const res = await fetch(`${LICHESS}/api/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        code_verifier: pending.verifier,
        redirect_uri: pending.redirectUri,
        client_id: CLIENT_ID,
      }),
    });
    if (!res.ok) throw new Error(`Lichess login failed (HTTP ${res.status}) — please try again.`);
    const { access_token } = (await res.json()) as { access_token: string };
    const account = await fetch(`${LICHESS}/api/account`, { headers: { Authorization: `Bearer ${access_token}` } });
    const username = account.ok ? ((await account.json()) as { username?: string }).username ?? '' : '';
    await updateSettings({ lichessToken: access_token, lichessAccount: username, lichessScopes: LICHESS_SCOPES, ...(username ? { lichessUsername: username } : {}) });
    setStatus({});
  } catch (e) {
    setStatus({ error: (e as Error).message });
  }
}

/** Revokes the token at Lichess (best effort) and forgets it. Keeps the username for game sync. */
export async function disconnectLichess(): Promise<void> {
  const { lichessToken } = await getSettings();
  if (lichessToken) {
    fetch(`${LICHESS}/api/token`, { method: 'DELETE', headers: { Authorization: `Bearer ${lichessToken}` } }).catch(() => {});
  }
  await updateSettings({ lichessToken: '', lichessAccount: '', lichessScopes: '' });
  setStatus({});
}

/** Thrown by Lichess calls that need a connected account. */
export class LichessLoginRequired extends Error {
  constructor(expired = false) {
    super(
      expired
        ? 'Your Lichess connection has expired — reconnect Lichess to use the opening explorer.'
        : 'The Lichess opening explorer needs your Lichess account — connect Lichess (Settings → Connections).',
    );
    this.name = 'LichessLoginRequired';
  }
}
