import { useEffect, useState } from 'react';
import { updateSettings, useSettings } from '../db/settings';
import { normalRule, type StopRule } from '../lib/stopRule';
import { useSyncStatus } from '../services/cloudSync';
import { plainStopCheckLink, publishStopRule, stopCheckLink, stopRuleDoc } from '../services/stopCheck';
import { href } from '../router';

/**
 * Your stop rule (Noël Studer: decide before you start how many games you'll play, and when a
 * session is over), and the phone check that holds you to it: an iPhone Shortcuts automation that
 * runs when you open the Chess.com app, asks /api/stop, and sends you back to the Home Screen when
 * it's time to stop. The check reads the rule from a gist Tabiya keeps up to date, so changing it
 * here is enough.
 */
export function StopRuleCard() {
  const s = useSettings();
  const sync = useSyncStatus();
  const rule = normalRule(s.stopRule);
  const [showSetup, setShowSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const doc = JSON.stringify(stopRuleDoc(s));
  // Keep the check's copy up to date (from any device with sync), a moment after a change.
  useEffect(() => {
    if (!s.loaded || !sync.connected || !s.stopGist) return;
    const t = setTimeout(() => {
      publishStopRule(s).then(
        () => setError(undefined),
        (e: Error) => setError(e.message),
      );
    }, 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, sync.connected, s.stopGist, s.loaded]);
  if (!s.loaded) return null;

  const set = (patch: Partial<StopRule>) => void updateSettings({ stopRule: { ...rule, ...patch } });
  const num = (key: 'games' | 'losses' | 'drop', label: string, after: string, title: string) => (
    <label className="inline-field small" title={title}>
      {label}
      <input
        type="number"
        min={0}
        step={key === 'drop' ? 10 : 1}
        value={rule[key]}
        onChange={(e) => set({ [key]: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
        style={{ width: 62 }}
      />
      {after}
    </label>
  );
  const names = !!(s.chesscomUsername.trim() || s.lichessUsername.trim());
  const link = sync.connected && s.stopGist && sync.login ? stopCheckLink(sync.login, s.stopGist) : !sync.connected ? plainStopCheckLink(s) : undefined;
  const setUp = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await publishStopRule(s, { create: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy the link:', link);
    }
  };

  return (
    <div className="panel col stop-rule" style={{ gap: 10 }}>
      <h3 style={{ margin: 0 }}>Stop rule</h3>
      <div className="row" style={{ gap: '8px 18px', flexWrap: 'wrap' }}>
        {num('games', 'Stop after', 'games', 'Games in one session (0 = no limit)')}
        {num('losses', 'or', 'losses in a row', 'Losses in a row (0 = off)')}
        {num('drop', 'or', 'points down', 'Rating points below where the session started, at the speed you are playing (0 = off)')}
        <label className="check small">
          <input type="checkbox" checked={rule.onTime} onChange={(e) => set({ onTime: e.target.checked })} />
          or a loss on time
        </label>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Games less than 45 minutes apart count as one session. Set a number to 0 to turn it off. Home will tell you when you hit
        your rule, and your phone can check every time you open Chess.com.{' '}
        <button className="linklike small" onClick={() => setShowSetup(!showSetup)} aria-expanded={showSetup}>
          {showSetup ? 'Hide the phone check' : 'Set up the phone check'}
        </button>
      </p>
      {showSetup && (
        <div className="col stop-setup" style={{ gap: 8 }}>
          {!names && (
            <div className="note small">
              Add your Chess.com or Lichess username in <a href={href('settings')}>Settings</a> first, so it knows whose games to look at.
            </div>
          )}
          {sync.connected && !s.stopGist ? (
            <div className="row" style={{ gap: 8 }}>
              <button className="primary small" onClick={setUp} disabled={busy || !names}>
                {busy ? 'Setting up…' : 'Make my link'}
              </button>
              <span className="muted small">This saves your rule to a private gist on your GitHub, so your phone always has your latest numbers.</span>
            </div>
          ) : (
            link && (
              <>
                <div className="row" style={{ gap: 8 }}>
                  <code className="stop-link small">{link}</code>
                  <button className="small" onClick={copy}>
                    {copied ? 'Copied ✓' : 'Copy link'}
                  </button>
                  <a className="btn small" href={`${link}${link.includes('?') ? '&' : '?'}view=page`} target="_blank" rel="noreferrer" title="What the check says right now">
                    Test ↗
                  </a>
                </div>
                {!sync.connected && (
                  <div className="muted small">
                    Your numbers are part of this link, so if you change them you'll need to paste the new link into the Shortcut. With
                    device sync on (Settings), the link keeps up by itself.
                  </div>
                )}
              </>
            )
          )}
          {error && <div className="error small">{error}</div>}
          <ol className="small stop-steps">
            <li>
              In the Shortcuts app, go to <b>Automation</b>, tap <b>+</b> and pick <b>App</b>. Choose <b>Chess.com</b>, tick <b>Is Opened</b>{' '}
              and <b>Run Immediately</b>, then tap Next and <b>New Blank Automation</b>.
            </li>
            <li>
              Add <b>Get Contents of URL</b> and paste the link.
            </li>
            <li>
              Add <b>If</b>. Tap <i>Contents of URL</i>, set its type to <b>Text</b>, then pick <b>begins with</b> and type <code>STOP</code>.
            </li>
            <li>
              Inside the If, add <b>Show Alert</b> with <i>Contents of URL</i> as the message (turn off Show Cancel Button), then add{' '}
              <b>Go to Home Screen</b>.
            </li>
          </ol>
          <div className="muted small">
            It can't actually lock Chess.com. If you close the alert and open the app again, it just checks again. Games show up a few
            seconds after they finish.
          </div>
        </div>
      )}
    </div>
  );
}
