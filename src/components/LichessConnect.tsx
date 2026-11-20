import { updateSettings, useSettings } from '../db/settings';
import { disconnectLichess, startLichessLogin, useLichessLoginStatus } from '../services/lichessAuth';

/** Just the "Connect Lichess" button, e.g. next to an explorer error. */
export function ConnectLichessButton() {
  const status = useLichessLoginStatus();
  return (
    <button className="primary" disabled={status.busy} onClick={() => startLichessLogin()}>
      {status.busy ? 'Connecting…' : 'Connect Lichess'}
    </button>
  );
}

/**
 * The Lichess account: "connected as <name> · Disconnect" once connected; otherwise a Connect
 * button plus the username field (game import works with just a username).
 */
export function LichessAccount() {
  const s = useSettings();
  const status = useLichessLoginStatus();
  if (!s.loaded) return null;
  const connected = !!s.lichessToken;
  return (
    <div className="col" style={{ gap: 6 }}>
      {connected ? (
        <div className="row" style={{ alignItems: 'center', gap: 10 }}>
          <span>
            Lichess: connected{s.lichessAccount ? <> as <b>{s.lichessAccount}</b></> : ' (API token)'}
          </span>
          <button onClick={() => confirm('Disconnect your Lichess account? The Lichess opening explorer stops working until you reconnect.') && disconnectLichess()}>
            Disconnect
          </button>
        </div>
      ) : (
        <div className="row" style={{ alignItems: 'flex-end', gap: 10 }}>
          <ConnectLichessButton />
          <label className="field">
            <span>or just a Lichess username (game import only)</span>
            <input
              defaultValue={s.lichessUsername}
              key={s.lichessUsername}
              onBlur={(e) => updateSettings({ lichessUsername: e.target.value.trim() })}
            />
          </label>
        </div>
      )}
      {status.busy && <div className="muted small">Finishing the Lichess login…</div>}
      {status.error && <div className="error">{status.error}</div>}
      {!connected && (
        <div className="muted small">
          Connecting fills in your username and is required for the Lichess opening explorer. It asks to read your studies (so
          private and unlisted ones can be imported) and to read and record your puzzles — the Puzzles tab picks them at your rating,
          and counts your results on Lichess only if you let it.
        </div>
      )}
    </div>
  );
}
