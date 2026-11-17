import { db } from '../db/db';
import { getSettings } from '../db/settings';
import { importLichess } from '../lib/importers/lichess';
import { importChessCom } from '../lib/importers/chesscom';
import type { ImportProgress } from '../lib/importers/common';
import type { GameSource, StoredGame } from '../lib/types';

interface SyncState {
  lastPlayedAt: number;
  lastSyncAt: number;
  since: number;
}

const stateKey = (source: GameSource, user: string) => `sync:${source}:${user.toLowerCase()}`;

async function saveNewGames(games: StoredGame[]) {
  const existing = await db.games.bulkGet(games.map((g) => g.id));
  const fresh = games.filter((_, i) => !existing[i]);
  if (fresh.length) await db.games.bulkAdd(fresh);
  return fresh.length;
}

export interface SyncResult {
  source: GameSource;
  added: number;
  error?: string;
}

export async function syncSource(
  source: GameSource,
  opts: { signal?: AbortSignal; onProgress?: (p: ImportProgress & { source: GameSource }) => void; full?: boolean } = {},
): Promise<SyncResult> {
  const s = await getSettings();
  const user = (source === 'lichess' ? s.lichessUsername : s.chesscomUsername).trim();
  if (!user) return { source, added: 0, error: 'No username set' };
  const configuredSince = new Date(`${s.importSince}T00:00:00Z`).getTime() || 0;
  const row = await db.kv.get(stateKey(source, user));
  const state = row?.value as SyncState | undefined;
  // Resume after the newest game we have, unless the user moved the start date earlier.
  let since = configuredSince;
  if (!opts.full && state && state.since <= configuredSince) {
    since = Math.max(configuredSince, source === 'lichess' ? state.lastPlayedAt + 1 : startOfMonth(state.lastPlayedAt));
  }

  let added = 0;
  let newest = state?.lastPlayedAt ?? 0;
  const onGames = async (games: StoredGame[]) => {
    added += await saveNewGames(games);
    for (const g of games) newest = Math.max(newest, g.playedAt);
  };
  const common = {
    username: user,
    since,
    timeClasses: s.importTimeClasses,
    signal: opts.signal,
    onGames,
    onProgress: (p: ImportProgress) => opts.onProgress?.({ ...p, source }),
  };
  try {
    if (source === 'lichess') await importLichess({ ...common, token: s.lichessToken || undefined });
    else await importChessCom(common);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    const msg = (e as Error).message;
    const hint = e instanceof TypeError ? ' (network error — check your connection)' : '';
    return { source, added, error: msg + hint };
  } finally {
    await db.kv.put({
      key: stateKey(source, user),
      value: { lastPlayedAt: newest, lastSyncAt: Date.now(), since: Math.min(configuredSince, state?.since ?? configuredSince) } satisfies SyncState,
    });
  }
  return { source, added };
}

function startOfMonth(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export async function lastSync(source: GameSource, user: string): Promise<number | undefined> {
  if (!user) return undefined;
  const row = await db.kv.get(stateKey(source, user));
  return (row?.value as SyncState | undefined)?.lastSyncAt;
}

/** Delete the games downloaded from Lichess and Chess.com. Over-the-board games you entered stay. */
export async function deleteAllGames() {
  await db.games.where('source').anyOf('lichess', 'chesscom').delete();
  const keys = (await db.kv.toArray()).filter((r) => r.key.startsWith('sync:')).map((r) => r.key);
  await db.kv.bulkDelete(keys);
}
