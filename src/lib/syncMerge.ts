/**
 * Merging two copies of the database (this device and the synced copy), record by record.
 *
 * Every row carries `modifiedAt` (stamped on each local write, see db/changes.ts); when both sides
 * changed the same row, the newer one wins. Deletions are kept as tombstones (key → time deleted)
 * so a row deleted on one device is deleted everywhere instead of being copied back. A device
 * notices its own deletions by comparing what it has now with the keys it had after its last sync.
 *
 * Pure: no DOM, no database. The sync service reads both sides, calls `mergeSync`, then writes the
 * result to the device and to the synced copy.
 */
import { RepGraph } from './graph';
import type { Color } from './chess';
import type { RepMove } from './types';

export const SYNC_TABLES = ['repertoires', 'moves', 'cards', 'reviewLog', 'games', 'coverage', 'kv', 'players'] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

export type Row = Record<string, any>;

export const SYNC_FORMAT = 1;

/** Tombstones older than this are forgotten (a device that stays offline longer may bring deleted rows back). */
export const TOMB_TTL_MS = 180 * 86_400_000;

export interface TableDoc {
  rows: Row[];
  /** Row key → when it was deleted (epoch ms). */
  tombs: Record<string, number>;
}

/** The synced copy of the database. */
export interface SyncDoc {
  format: number;
  savedAt: number;
  tables: Record<SyncTable, TableDoc>;
}

/** One side's rows, by key. */
export type Snapshot = Record<SyncTable, Map<string, Row>>;
/** Keys of the rows a device had right after its last sync. */
export type BaseKeys = Record<SyncTable, Set<string>>;

export function emptySnapshot(): Snapshot {
  return Object.fromEntries(SYNC_TABLES.map((t) => [t, new Map()])) as Snapshot;
}

export function emptyDoc(now = 0): SyncDoc {
  const tables = Object.fromEntries(SYNC_TABLES.map((t): [SyncTable, TableDoc] => [t, { rows: [], tombs: {} }]));
  return { format: SYNC_FORMAT, savedAt: now, tables: tables as SyncDoc['tables'] };
}

/** Identity of a row across devices. Review-log ids are per-device counters, so log entries use card + time. */
export function rowKey(table: SyncTable, row: Row): string {
  switch (table) {
    case 'reviewLog':
      return `${row.cardId}|${row.reviewedAt}`;
    case 'coverage':
      return String(row.repId);
    case 'kv':
      return String(row.key);
    default:
      return String(row.id);
  }
}

/** When a row last changed. Rows written before sync existed have no `modifiedAt`; use their own dates. */
export function rowVersion(table: SyncTable, row: Row): number {
  if (typeof row.modifiedAt === 'number') return row.modifiedAt;
  switch (table) {
    case 'repertoires':
      return row.updatedAt ?? row.createdAt ?? 0;
    case 'moves':
      return row.createdAt ?? 0;
    case 'cards':
      return Math.max(row.lastReview ?? 0, row.createdAt ?? 0);
    case 'reviewLog':
      return row.reviewedAt ?? 0;
    case 'games':
      return Math.max(row.playedAt ?? 0, row.review?.analyzedAt ?? 0);
    case 'coverage':
      return row.computedAt ?? 0;
    default:
      return 0;
  }
}

/**
 * When a row came into existence. A deletion removes every copy born before it: training a card or
 * editing a note on a move that another device deleted doesn't bring it back, but adding the move
 * again (a new row, born later) does.
 */
function rowBirth(table: SyncTable, row: Row): number {
  switch (table) {
    case 'repertoires':
    case 'moves':
    case 'cards':
    case 'players':
      return row.createdAt ?? rowVersion(table, row);
    case 'reviewLog':
      return row.reviewedAt ?? 0;
    default:
      return rowVersion(table, row);
  }
}

function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]])) : val,
  );
}

export function sameRow(a: Row | undefined, b: Row | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return canonical(a) === canonical(b);
}

/** Both sides have the row and (maybe) differ: newer wins, except a few fields that only ever get added. */
function resolve(table: SyncTable, l: Row, r: Row): Row {
  const vl = rowVersion(table, l);
  const vr = rowVersion(table, r);
  if (vl === vr) return r;
  const newer = vl > vr ? l : r;
  const older = newer === l ? r : l;
  if (table === 'games') {
    // A computer review run on one device and "prep applied" on another must both survive.
    const g = { ...newer };
    if (older.prepApplied && !g.prepApplied) g.prepApplied = true;
    if (!g.review && older.review) g.review = older.review;
    // Cleared annotations / side lines are stored as {} / [], so only a copy that never had them takes the other's.
    if (g.annotations === undefined && older.annotations) g.annotations = older.annotations;
    if (g.lines === undefined && older.lines) g.lines = older.lines;
    return sameRow(g, newer) ? newer : g;
  }
  return newer;
}

export interface MergeInput {
  local: Snapshot;
  remote: SyncDoc | null;
  /** Keys this device had after its last sync; null if it never synced. */
  base: BaseKeys | null;
  now: number;
  /**
   * This device's data replaces the synced copy outright (after restoring a backup or deleting
   * everything): rows only the synced copy has are deleted on every device.
   */
  forceLocal?: boolean;
}

export interface MergeResult {
  /** The new synced copy. */
  doc: SyncDoc;
  /** Rows to write on this device (new or changed). */
  puts: Record<SyncTable, Row[]>;
  /** Keys to delete on this device. */
  deletes: Record<SyncTable, string[]>;
  /** Tables whose synced copy changed. */
  remoteChanged: SyncTable[];
  /** Keys present after the merge — this device's next `base`. */
  keys: BaseKeys;
}

export function mergeSync({ local, remote, base, now, forceLocal }: MergeInput): MergeResult {
  const merged = emptySnapshot();
  const tombs = {} as Record<SyncTable, Map<string, number>>;
  const remoteRows = emptySnapshot();

  for (const t of SYNC_TABLES) {
    const L = local[t];
    const R = remoteRows[t];
    for (const row of remote?.tables[t]?.rows ?? []) R.set(rowKey(t, row), row);
    const T = new Map<string, number>(Object.entries(remote?.tables[t]?.tombs ?? {}));
    tombs[t] = T;

    if (forceLocal) {
      for (const k of R.keys()) if (!L.has(k)) T.set(k, now);
      for (const [k, row] of L) {
        T.delete(k);
        merged[t].set(k, row);
      }
      continue;
    }

    // Rows this device deleted since its last sync.
    for (const k of base?.[t] ?? []) if (!L.has(k)) T.set(k, now);

    for (const k of new Set([...L.keys(), ...R.keys()])) {
      const l = L.get(k);
      const r = R.get(k);
      const pick = l && r ? resolve(t, l, r) : (l ?? r)!;
      const deletedAt = T.get(k);
      if (deletedAt !== undefined) {
        if (deletedAt >= rowBirth(t, pick)) continue;
        T.delete(k); // added again after it was deleted
      }
      merged[t].set(k, pick);
    }
  }

  // Concurrent edits can leave dangling rows (a line added on the phone under a move deleted on the
  // computer); remove them the way deleting on one device would have.
  for (const [t, k] of danglingRows(merged, local, remoteRows)) {
    merged[t].delete(k);
    tombs[t].set(k, now);
  }

  const doc = emptyDoc(now);
  const puts = {} as MergeResult['puts'];
  const deletes = {} as MergeResult['deletes'];
  const keys = {} as BaseKeys;
  const remoteChanged: SyncTable[] = [];
  for (const t of SYNC_TABLES) {
    const L = local[t];
    const R = remoteRows[t];
    const M = merged[t];
    const T = tombs[t];
    for (const [k, at] of T) if (at < now - TOMB_TTL_MS) T.delete(k);

    puts[t] = [];
    for (const [k, row] of M) if (!sameRow(L.get(k), row)) puts[t].push(row);
    deletes[t] = [...L.keys()].filter((k) => !M.has(k));
    keys[t] = new Set(M.keys());
    doc.tables[t] = { rows: [...M.values()], tombs: Object.fromEntries(T) };

    const oldTombs = remote?.tables[t]?.tombs ?? {};
    const changed =
      !remote ||
      M.size !== R.size ||
      [...M].some(([k, row]) => !sameRow(R.get(k), row)) ||
      T.size !== Object.keys(oldTombs).length ||
      [...T].some(([k, at]) => oldTombs[k] !== at);
    if (changed) remoteChanged.push(t);
  }
  return { doc, puts, deletes, remoteChanged, keys };
}

/** Moves cut off from their repertoire's start position, and rows belonging to repertoires or moves that are gone. */
function danglingRows(merged: Snapshot, local: Snapshot, remote: Snapshot): [SyncTable, string][] {
  const out: [SyncTable, string][] = [];
  const reps = merged.repertoires;
  const unreachable = (side: Snapshot) => {
    const ids = new Set<string>();
    for (const [repId, moves] of movesByRep(side)) {
      const color = (side.repertoires.get(repId) ?? reps.get(repId))?.color as Color | undefined;
      if (color) for (const m of new RepGraph(color, moves).orphanMoves()) ids.add(m.id);
    }
    return ids;
  };
  // Only prune moves the merge cut off — never ones that were already unreachable on either side.
  const before = new Set([...unreachable(local), ...unreachable(remote)]);
  const after = unreachable(merged);
  for (const [k, m] of merged.moves) {
    if (!reps.has(m.repId) || (after.has(k) && !before.has(k))) out.push(['moves', k]);
  }
  const goneMoves = new Set(out.map(([, k]) => k));
  for (const [k, c] of merged.cards) if (!reps.has(c.repId) || !merged.moves.has(k) || goneMoves.has(k)) out.push(['cards', k]);
  for (const [k, l] of merged.reviewLog) if (!reps.has(l.repId)) out.push(['reviewLog', k]);
  for (const [k, c] of merged.coverage) if (!reps.has(c.repId)) out.push(['coverage', k]);
  return out;
}

function movesByRep(side: Snapshot): Map<string, RepMove[]> {
  const by = new Map<string, RepMove[]>();
  for (const m of side.moves.values()) {
    const arr = by.get(m.repId);
    if (arr) arr.push(m as RepMove);
    else by.set(m.repId, [m as RepMove]);
  }
  return by;
}
