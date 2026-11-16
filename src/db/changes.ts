import type Dexie from 'dexie';
import type { Transaction } from 'dexie';
import { SYNC_TABLES } from '../lib/syncMerge';

/**
 * Change tracking for sync: every write to a synced table stamps the row with `modifiedAt` and
 * tells listeners that something changed. Writes inside a "quiet" transaction (applying data that
 * came from another device) keep the timestamps they arrived with and don't count as changes.
 */

const quiet = new WeakSet<Transaction>();

export function markQuiet(tx: Transaction) {
  quiet.add(tx);
}

const listeners = new Set<() => void>();
let pending = false;

/** Called (once per burst of writes) after the user changes anything that syncs. */
export function onLocalChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    for (const fn of listeners) fn();
  }, 0);
}

export function trackChanges(db: Dexie) {
  for (const name of SYNC_TABLES) {
    const table = db.table(name);
    table.hook('creating', (_key, obj, tx) => {
      if (quiet.has(tx)) return;
      obj.modifiedAt = Date.now();
      changed();
    });
    table.hook('updating', (_mods, _key, _obj, tx) => {
      if (quiet.has(tx)) return;
      changed();
      return { modifiedAt: Date.now() };
    });
    table.hook('deleting', (_key, _obj, tx) => {
      if (!quiet.has(tx)) changed();
    });
  }
}
