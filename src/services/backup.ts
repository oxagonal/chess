import { db } from '../db/db';

const TABLES = ['repertoires', 'moves', 'cards', 'reviewLog', 'games', 'coverage', 'kv'] as const;

export async function exportBackup(): Promise<string> {
  const out: Record<string, unknown> = { app: 'chess-prep', version: 1, exportedAt: new Date().toISOString() };
  for (const t of TABLES) out[t] = await db.table(t).toArray();
  return JSON.stringify(out);
}

export async function importBackup(json: string): Promise<void> {
  const data = JSON.parse(json) as Record<string, unknown[]>;
  if ((data as unknown as { app?: string }).app !== 'chess-prep') throw new Error('Not a Chess Prep backup file');
  await db.transaction('rw', TABLES.map((t) => db.table(t)), async () => {
    for (const t of TABLES) {
      await db.table(t).clear();
      if (Array.isArray(data[t])) await db.table(t).bulkAdd(data[t]);
    }
  });
}

export async function wipeEverything(): Promise<void> {
  await db.transaction('rw', [...TABLES.map((t) => db.table(t)), db.explorerCache], async () => {
    for (const t of TABLES) await db.table(t).clear();
    await db.explorerCache.clear();
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
