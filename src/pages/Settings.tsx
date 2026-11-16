import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { updateSettings, useSettings, type AppSettings } from '../db/settings';
import { db } from '../db/db';
import { LICHESS_BANDS, POOL_LABEL, bandLabel, toLichessRating, type RatingPool } from '../lib/ratings';
import { TIME_CLASSES } from '../lib/importers/common';
import { fetchLichessRatings } from '../lib/importers/lichess';
import { fetchChessComRatings } from '../lib/importers/chesscom';
import { effectiveBands } from '../services/coverage';
import { clearExplorerCache } from '../services/explorer';
import { deleteAllGames } from '../services/sync';
import { download, exportBackup, importBackup, wipeEverything } from '../services/backup';
import type { ProbabilitySource } from '../lib/types';

const SPEEDS = ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence'];

function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

export function SettingsPage() {
  const s = useSettings();
  const cacheCount = useLiveQuery(() => db.explorerCache.count(), []);
  const gameCount = useLiveQuery(() => db.games.count(), []);
  const [msg, setMsg] = useState<string | null>(null);
  const [detected, setDetected] = useState<string | null>(null);
  if (!s.loaded) return null;
  const set = (patch: Partial<AppSettings>) => updateSettings(patch);

  const detect = async () => {
    setDetected('Looking up ratings…');
    const parts: string[] = [];
    try {
      if (s.lichessUsername) {
        const r = await fetchLichessRatings(s.lichessUsername);
        parts.push(`Lichess: ${Object.entries(r).filter(([k]) => ['bullet', 'blitz', 'rapid', 'classical'].includes(k)).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        const best = r.rapid ?? r.blitz ?? r.classical;
        if (best) await set({ rating: best, ratingPool: 'lichess' });
      } else if (s.chesscomUsername) {
        const r = await fetchChessComRatings(s.chesscomUsername);
        parts.push(`Chess.com: ${Object.entries(r).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        if (r.rapid) await set({ rating: r.rapid, ratingPool: 'chesscom-rapid' });
        else if (r.blitz) await set({ rating: r.blitz, ratingPool: 'chesscom-blitz' });
      } else parts.push('Enter a username first.');
    } catch (e) {
      parts.push((e as Error).message);
    }
    setDetected(parts.join(' · '));
  };

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 3000);
  };

  return (
    <div className="col" style={{ gap: 16, maxWidth: 900 }}>
      <h1>Settings</h1>
      {msg && <div className="note">{msg}</div>}

      <div className="panel col">
        <h2>Accounts & game import</h2>
        <div className="row">
          <label className="field">
            <span>Lichess username</span>
            <input defaultValue={s.lichessUsername} onBlur={(e) => set({ lichessUsername: e.target.value.trim() })} />
          </label>
          <label className="field">
            <span>Chess.com username</span>
            <input defaultValue={s.chesscomUsername} onBlur={(e) => set({ chesscomUsername: e.target.value.trim() })} />
          </label>
          <label className="field">
            <span>Import games since</span>
            <input type="date" value={s.importSince} onChange={(e) => set({ importSince: e.target.value })} />
          </label>
        </div>
        <div className="row">
          <span className="muted small">Time controls:</span>
          {TIME_CLASSES.map((t) => (
            <label key={t} className="check">
              <input type="checkbox" checked={s.importTimeClasses.includes(t)} onChange={() => set({ importTimeClasses: toggle(s.importTimeClasses, t) })} />
              {t}
            </label>
          ))}
        </div>
        <label className="field">
          <span>Lichess API token (optional)</span>
          <input
            type="password"
            defaultValue={s.lichessToken}
            placeholder="lip_…  — only needed for faster downloads of very large histories"
            onBlur={(e) => set({ lichessToken: e.target.value.trim() })}
          />
        </label>
        <p className="muted small">
          Everything is stored in this browser only (IndexedDB). Usernames are only sent to lichess.org / chess.com to download your games.
        </p>
      </div>

      <div className="panel col">
        <h2>Your rating & move probabilities</h2>
        <p className="muted small">
          Used for “1 in N games” coverage and the Lichess explorer tab. Chess.com has no public opening database, so Chess.com ratings are
          converted to the equivalent Lichess bands (approximate). Alternatively use your own imported games as the source.
        </p>
        <div className="row">
          <label className="field">
            <span>Rating</span>
            <input type="number" value={s.rating} min={400} max={3200} step={10} onChange={(e) => set({ rating: Number(e.target.value) })} style={{ width: 100 }} />
          </label>
          <label className="field">
            <span>Rating pool</span>
            <select value={s.ratingPool} onChange={(e) => set({ ratingPool: e.target.value as RatingPool })}>
              {(Object.keys(POOL_LABEL) as RatingPool[]).map((p) => (
                <option key={p} value={p}>
                  {POOL_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <button onClick={detect} style={{ alignSelf: 'flex-end' }}>
            Detect from my account
          </button>
        </div>
        {detected && <div className="muted small">{detected}</div>}
        <div className="muted small">
          ≈ Lichess {toLichessRating(s.rating, s.ratingPool)} → explorer bands: <b>{effectiveBands(s).map(bandLabel).join(', ')}</b>
        </div>
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={s.bandsMode === 'manual'} onChange={(e) => set({ bandsMode: e.target.checked ? 'manual' : 'auto' })} />
            Choose bands manually
          </label>
          {s.bandsMode === 'manual' &&
            LICHESS_BANDS.map((b) => (
              <label key={b} className="check small">
                <input type="checkbox" checked={s.manualBands.includes(b)} onChange={() => set({ manualBands: toggle(s.manualBands, b) })} />
                {bandLabel(b)}
              </label>
            ))}
        </div>
        <div className="row">
          <span className="muted small">Explorer speeds:</span>
          {SPEEDS.map((sp) => (
            <label key={sp} className="check small">
              <input type="checkbox" checked={s.speeds.includes(sp)} onChange={() => set({ speeds: toggle(s.speeds, sp) })} />
              {sp}
            </label>
          ))}
        </div>
        <div className="row">
          <label className="field">
            <span>Probability source</span>
            <select value={s.probabilitySource} onChange={(e) => set({ probabilitySource: e.target.value as ProbabilitySource })}>
              <option value="lichess">Lichess games at my rating</option>
              <option value="mygames">My own opponents (imported games)</option>
              <option value="masters">Masters</option>
            </select>
          </label>
          <label className="field">
            <span>Study positions seen in at least</span>
            <select value={s.oneInN} onChange={(e) => set({ oneInN: Number(e.target.value) })}>
              {[5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200].map((n) => (
                <option key={n} value={n}>
                  1 in {n} games
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="panel col">
        <h2>Training</h2>
        <div className="row">
          <label className="field">
            <span>New moves per day</span>
            <input type="number" min={0} max={500} value={s.newPerDay} onChange={(e) => set({ newPerDay: Number(e.target.value) })} style={{ width: 100 }} />
          </label>
          <label className="field">
            <span>Target retention</span>
            <select value={s.requestRetention} onChange={(e) => set({ requestRetention: Number(e.target.value) })}>
              {[0.8, 0.85, 0.9, 0.93, 0.95, 0.97].map((r) => (
                <option key={r} value={r}>
                  {Math.round(r * 100)}%
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Max interval (days)</span>
            <input type="number" min={7} max={3650} value={s.maxIntervalDays} onChange={(e) => set({ maxIntervalDays: Number(e.target.value) })} style={{ width: 100 }} />
          </label>
          <label className="field">
            <span>Opponent move speed</span>
            <select value={s.autoPlayDelayMs} onChange={(e) => set({ autoPlayDelayMs: Number(e.target.value) })}>
              <option value={150}>Fast</option>
              <option value={350}>Normal</option>
              <option value={700}>Slow</option>
            </select>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={s.trainOnlyLikely} onChange={(e) => set({ trainOnlyLikely: e.target.checked })} />
          Only train positions I'll meet in at least 1 in {s.oneInN} games (uses the last Coverage run of each repertoire)
        </label>
        <p className="muted small">
          Higher retention means more frequent reviews. 90% is a good default; raise it before a tournament.
        </p>
      </div>

      <div className="panel col">
        <h2>Data</h2>
        <div className="row">
          <button
            onClick={async () => download(`chess-prep-backup-${new Date().toISOString().slice(0, 10)}.json`, await exportBackup())}
          >
            Export backup
          </button>
          <label className="btn">
            Restore backup…
            <input
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f || !confirm('Replace ALL current data with this backup?')) return;
                try {
                  await importBackup(await f.text());
                  flash('Backup restored.');
                } catch (err) {
                  flash(`Restore failed: ${(err as Error).message}`);
                }
              }}
            />
          </label>
          <button onClick={async () => (await clearExplorerCache(), flash('Explorer cache cleared.'))}>
            Clear explorer cache ({cacheCount ?? 0})
          </button>
          <button className="danger" onClick={async () => confirm('Delete all imported games?') && (await deleteAllGames(), flash('Games deleted.'))}>
            Delete games ({gameCount ?? 0})
          </button>
          <button
            className="danger"
            onClick={async () => confirm('Delete EVERYTHING (repertoires, progress, games, settings)?') && (await wipeEverything(), flash('All data deleted.'))}
          >
            Delete all data
          </button>
        </div>
        <p className="muted small">Your data lives only in this browser. Export a backup regularly, especially before clearing browser data.</p>
      </div>
    </div>
  );
}
