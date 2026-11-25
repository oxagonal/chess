/**
 * Keeps each color's Coverage up to date by itself, wherever you are in the app: when your chapters
 * change (here, from training, or from another device), or the coverage settings do — or there's no
 * run yet — it runs again in the background a few seconds later. Home's "lines you know well" bar,
 * the Map and the builder all read that run. Lookups are cached, so an update after an edit is quick;
 * a first run takes longer. After an error (offline, Lichess not connected) it waits until something
 * changes.
 */
import { liveQuery } from 'dexie';
import { db } from '../db/db';
import { getSettings, repTarget } from '../db/settings';
import { loadScope } from '../db/scopes';
import { coverageRunProgress, isCoverageFresh, runCoverage, sourceLabel } from './coverage';
const COLORS = ['white', 'black'] as const;

const SETTLE_MS = 3_000;

let started = false;

export function startAutoCoverage() {
  if (started) return;
  started = true;
  // Where each color stood when a run was last tried: not tried again until something changes.
  const tried = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const s = await getSettings();
      for (const color of COLORS) {
        const scope = await loadScope(color);
        if (!scope?.chapterIds.length) continue;
        const run = await db.coverage.get(color);
        if (isCoverageFresh(run, scope, s) || coverageRunProgress(color) !== undefined) continue;
        if (!(await db.moves.where('repId').anyOf(scope.chapterIds).count())) continue;
        const sig = `${scope.updatedAt}|${repTarget(scope, s)}|${sourceLabel(s)}|${s.chapterOneInN}`;
        if (tried.get(color) === sig) continue;
        tried.set(color, sig);
        // Lichess's cloud analysis only for sharp lines: the background mustn't take over Stockfish.
        await runCoverage(color, { localEngine: false }).catch(() => undefined);
      }
    } finally {
      checking = false;
    }
  };
  liveQuery(async () => {
    // What makes a run out of date: the chapters, the results, the settings.
    const [reps, covs, kv] = await Promise.all([db.repertoires.toArray(), db.coverage.bulkGet([...COLORS]), db.kv.get('settings')]);
    return `${reps.map((r) => `${r.id}:${r.updatedAt}:${r.oneInN ?? ''}`).join()}|${covs.map((c) => c?.computedAt ?? 0).join()}|${JSON.stringify(kv?.value ?? {}).length}`;
  }).subscribe({
    next: () => {
      clearTimeout(timer);
      timer = setTimeout(() => void check(), SETTLE_MS);
    },
    error: () => {},
  });
}
