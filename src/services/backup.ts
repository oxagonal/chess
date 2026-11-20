import { db } from '../db/db';
import { noteLocalDataReplaced } from './cloudSync';
import { migrateCardRows } from '../lib/chapters';

/** The Lichess login is a credential: kept out of backup files, and kept on this device across restores. */
const CREDENTIALS = ['lichessToken', 'lichessAccount', 'lichessScopes'] as const;
const SETTINGS_KEY = 'settings';

type KvRow = { key: string; value: unknown };
function withoutCredentials(row: KvRow): KvRow {
  if (row.key !== SETTINGS_KEY || !row.value || typeof row.value !== 'object') return row;
  const value = { ...(row.value as Record<string, unknown>) };
  for (const k of CREDENTIALS) delete value[k];
  return { ...row, value };
}

const TABLES = ['repertoires', 'moves', 'cards', 'reviewLog', 'games', 'coverage', 'kv', 'players', 'collections', 'puzzleLog'] as const;

/** 2: chapters (cards per position and move, repertoires as collections). Version 1 files are upgraded on restore. */
const BACKUP_VERSION = 2;

export async function exportBackup(): Promise<string> {
  const out: Record<string, unknown> = { app: 'chess-prep', version: BACKUP_VERSION, exportedAt: new Date().toISOString() };
  for (const t of TABLES) out[t] = await db.table(t).toArray();
  out.kv = (out.kv as KvRow[]).map(withoutCredentials);
  return JSON.stringify(out);
}

export async function importBackup(json: string): Promise<void> {
  const data = JSON.parse(json) as Record<string, unknown[]>;
  if ((data as unknown as { app?: string }).app !== 'chess-prep') throw new Error('Not a Chess Prep backup file');
  const version = Number((data as unknown as { version?: number }).version ?? 1);
  if (version > BACKUP_VERSION) throw new Error('This backup was made by a newer version of Chess Prep — reload the app to update.');
  if (version < 2) {
    // From before chapters: cards per position and move; old per-repertoire coverage runs dropped.
    const next = migrateCardRows((data.cards ?? []) as Record<string, unknown>[], (data.reviewLog ?? []) as Record<string, unknown>[]);
    data.cards = next.cards;
    data.reviewLog = next.logs;
    data.coverage = [];
  }
  await db.transaction('rw', [...TABLES.map((t) => db.table(t)), db.syncState], async () => {
    const current = (await db.kv.get(SETTINGS_KEY))?.value as Record<string, unknown> | undefined;
    for (const t of TABLES) {
      await db.table(t).clear();
      if (!Array.isArray(data[t])) continue;
      await db.table(t).bulkAdd(t === 'kv' ? (data[t] as KvRow[]).map(withoutCredentials) : data[t]);
    }
    // Stay connected to Lichess on this device.
    const keep = Object.fromEntries(CREDENTIALS.filter((k) => current?.[k]).map((k) => [k, current![k]]));
    if (Object.keys(keep).length) {
      const restored = (await db.kv.get(SETTINGS_KEY))?.value as Record<string, unknown> | undefined;
      await db.kv.put({ key: SETTINGS_KEY, value: { ...restored, ...keep } });
    }
    // With sync on, the backup becomes what every device has.
    await noteLocalDataReplaced();
  });
}

export async function wipeEverything(): Promise<void> {
  await db.transaction('rw', [...TABLES.map((t) => db.table(t)), db.explorerCache, db.playerGames, db.syncState], async () => {
    for (const t of TABLES) await db.table(t).clear();
    await db.explorerCache.clear();
    await db.playerGames.clear();
    await noteLocalDataReplaced();
  });
}

export function download(filename: string, text: string, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
