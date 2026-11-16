import { useState } from 'react';
import { checkToken, connect, currentToken, disconnect, runSync, useSyncStatus, type ConnectCheck, type SyncStatus } from '../services/cloudSync';
import { href } from '../router';
import { timeAgo } from './ui';

const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=Chess%20Prep%20sync';

function statusText(st: SyncStatus): string {
  if (st.state === 'syncing') return 'Syncing…';
  if (st.state === 'offline') return 'Offline — changes will sync when you’re back online';
  if (st.state === 'error') return 'Sync failed';
  return st.lastSyncAt ? `Synced ${timeAgo(st.lastSyncAt)}` : 'Connected';
}

/** Small dot in the top bar: syncing, failed, offline (hidden when sync is off). */
export function SyncIndicator() {
  const st = useSyncStatus();
  if (!st.connected) return null;
  return (
    <a className={`sync-dot ${st.state}`} href={href('settings')} title={st.message ? `${statusText(st)}: ${st.message}` : statusText(st)} aria-label={statusText(st)} />
  );
}

/** `embedded`: drawn inside another panel (Settings → Connections) with a smaller heading. */
export function SyncPanel({ embedded = false }: { embedded?: boolean }) {
  const st = useSyncStatus();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConnectCheck | null>(null);
  const [copied, setCopied] = useState(false);

  const finish = async (check: ConnectCheck, mode: 'merge' | 'replace-local') => {
    setBusy(true);
    try {
      await connect(check, mode);
      setPending(null);
      setToken('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const check = await checkToken(token);
      setBusy(false);
      // Both sides have data: let the user decide instead of silently mixing two different setups.
      if (check.remoteHasData && check.localHasData) setPending(check);
      else await finish(check, 'merge');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const copyToken = async () => {
    const t = currentToken();
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy this token and paste it on your other device:', t);
    }
  };

  const box = embedded ? 'col' : 'panel col';
  const heading = embedded ? <h3>Sync between devices (GitHub)</h3> : <h2>Sync between devices</h2>;

  if (st.connected) {
    return (
      <div className={box}>
        {heading}
        <div className="row">
          <span className={`sync-dot ${st.state}`} />
          <span>{statusText(st)}</span>
        </div>
        {st.message && st.state !== 'idle' && <div className={`note ${st.state === 'error' ? 'bad' : ''}`}>{st.message}</div>}
        <div className="row">
          <button className="primary" disabled={st.state === 'syncing'} onClick={() => void runSync()}>
            Sync now
          </button>
          <button onClick={copyToken}>{copied ? 'Copied ✓' : 'Copy token for another device'}</button>
          {st.gistId && (
            <a className="btn" href={`https://gist.github.com/${st.gistId}`} target="_blank" rel="noreferrer">
              View on GitHub
            </a>
          )}
          <button
            className="danger"
            onClick={() => confirm('Stop syncing this device? Its data stays here, and your other devices keep syncing.') && void disconnect()}
          >
            Disconnect this device
          </button>
        </div>
        <p className="muted small">
          Connected to GitHub as <b>{st.login}</b>. Repertoires, notes, training progress, games and settings sync automatically when you open
          the app, a few seconds after you change something, and when you switch away from it. To add another device, open Chess Prep there →
          Settings → Connections, and paste the same token. Your Lichess connection stays on each device — connect Lichess there too.
        </p>
      </div>
    );
  }

  return (
    <div className={box}>
      {heading}
      <p className="muted small">
        Use Chess Prep on your phone and your computer with the same repertoires, notes, training progress, games and settings. The data is kept
        in a secret gist in your own GitHub account — nothing goes anywhere else.
      </p>
      <ol className="steps small">
        <li>
          <a href={TOKEN_URL} target="_blank" rel="noreferrer">
            Create a GitHub token
          </a>{' '}
          (the link selects the one permission it needs, <b>gist</b>). Set <i>Expiration</i> to <i>No expiration</i> so sync keeps working, then
          click <i>Generate token</i> and copy it.
        </li>
        <li>Paste it here and connect.</li>
        <li>On your other device, open Chess Prep → Settings and paste the same token.</li>
      </ol>
      <div className="row">
        <input
          type="password"
          autoComplete="off"
          placeholder="ghp_…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && token.trim() && !busy && void start()}
          style={{ flex: 1, minWidth: 200 }}
        />
        <button className="primary" disabled={busy || !token.trim()} onClick={start}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
      {error && <div className="note bad">{error}</div>}
      {pending && (
        <div className="note col" style={{ gap: 8 }}>
          <div>
            Your GitHub account already has synced data ({pending.remoteRepertoires} repertoire{pending.remoteRepertoires === 1 ? '' : 's'}), and
            this device has data of its own. What should happen to this device’s data?
          </div>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => finish(pending, 'merge')}>
              Merge both
            </button>
            <button
              disabled={busy}
              onClick={() => confirm('Delete this device’s data and replace it with the synced data?') && void finish(pending, 'replace-local')}
            >
              Replace it with the synced data
            </button>
            <button className="ghost" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
