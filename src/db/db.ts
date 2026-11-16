import Dexie, { type EntityTable } from 'dexie';
import type { CoverageResult, PositionStats, Repertoire, RepMove, ReviewCard, ReviewLogEntry, StoredGame } from '../lib/types';
import { trackChanges } from './changes';

export interface ExplorerCacheRow {
  key: string;
  fetchedAt: number;
  data: PositionStats;
}

export interface KvRow {
  key: string;
  value: unknown;
  /** Set on every write (for sync). */
  modifiedAt?: number;
}

/** This device's sync settings and bookkeeping. Never synced, never in backups. */
export interface SyncStateRow {
  key: string;
  value: unknown;
}

export type ChessDB = Dexie & {
  repertoires: EntityTable<Repertoire, 'id'>;
  moves: EntityTable<RepMove, 'id'>;
  cards: EntityTable<ReviewCard, 'id'>;
  reviewLog: EntityTable<ReviewLogEntry, 'id'>;
  games: EntityTable<StoredGame, 'id'>;
  explorerCache: EntityTable<ExplorerCacheRow, 'key'>;
  coverage: EntityTable<CoverageResult, 'repId'>;
  kv: EntityTable<KvRow, 'key'>;
  syncState: EntityTable<SyncStateRow, 'key'>;
};

export function openDb(name = 'chess-prep'): ChessDB {
  const db = new Dexie(name) as ChessDB;
  db.version(1).stores({
    repertoires: 'id, color',
    moves: 'id, repId, [repId+fromKey], [repId+toKey]',
    cards: 'id, repId, due, state, [repId+state]',
    reviewLog: '++id, cardId, repId, reviewedAt',
    games: 'id, playedAt, source, account, userColor',
    explorerCache: 'key, fetchedAt',
    coverage: 'repId',
    kv: 'key',
  });
  db.version(2).stores({ syncState: 'key' });
  trackChanges(db);
  return db;
}

export const db: ChessDB = openDb();

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID().slice(0, 12);
  return Math.random().toString(36).slice(2, 14);
}
