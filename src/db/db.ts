import Dexie, { type EntityTable } from 'dexie';
import type { Collection, CoverageResult, Player, PlayerGame, PositionStats, Repertoire, RepMove, ReviewCard, ReviewLogEntry, StoredGame } from '../lib/types';
import { migrateCardRows } from '../lib/chapters';
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
  players: EntityTable<Player, 'id'>;
  playerGames: EntityTable<PlayerGame, 'id'>;
  collections: EntityTable<Collection, 'id'>;
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
  db.version(3).stores({ players: 'id, name', playerGames: 'id, playerId, [playerId+source]' });
  // Chapters: repertoires become chapters, and cards go from one per repertoire move to one per
  // position and move (shared by every chapter that has it). Coverage is now per color / repertoire,
  // so old per-repertoire runs are dropped; each color keeps the widest coverage target it had.
  db.version(4)
    .stores({
      moves: 'id, repId, fromKey, [repId+fromKey], [repId+toKey]',
      cards: 'id, color, due, state',
      reviewLog: '++id, cardId, color, reviewedAt',
      collections: 'id, color',
    })
    .upgrade(async (tx) => {
      const cards = await tx.table('cards').toArray();
      const logs = await tx.table('reviewLog').toArray();
      const next = migrateCardRows(cards, logs);
      await tx.table('cards').clear();
      await tx.table('cards').bulkPut(next.cards);
      await tx.table('reviewLog').clear();
      await tx.table('reviewLog').bulkPut(next.logs);
      await tx.table('coverage').clear();
      const reps = await tx.table('repertoires').toArray();
      const settings = await tx.table('kv').get('settings');
      const targets: Record<string, number> = {};
      for (const r of reps) if (r.oneInN) targets[r.color] = Math.max(targets[r.color] ?? 0, r.oneInN);
      if (Object.keys(targets).length) {
        const value = { ...(settings?.value ?? {}), scopeTargets: targets };
        await tx.table('kv').put({ ...settings, key: 'settings', value });
      }
    });
  trackChanges(db);
  return db;
}

export const db: ChessDB = openDb();

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID().slice(0, 12);
  return Math.random().toString(36).slice(2, 14);
}
