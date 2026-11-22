import Dexie, { type EntityTable } from 'dexie';
import type { Collection, CoverageResult, Player, PlayerGame, PositionStats, PuzzleAttempt, Repertoire, RepMove, ReviewCard, ReviewLogEntry, StoredGame, Activity } from '../lib/types';
import { migrateCardRows } from '../lib/chapters';
import { trackChanges } from './changes';
import type { TacticCard } from '../lib/tacticCards';

export interface ExplorerCacheRow {
  key: string;
  fetchedAt: number;
  data: PositionStats;
}

/** The engine's best lines in a position, kept for the coverage run's sharpness checks (a cache: not synced). */
export interface EngineCacheRow {
  key: string;
  fetchedAt: number;
  /** Each line's first move and evaluation (White's point of view). */
  lines: { uci: string; cp?: number; mate?: number }[];
  depth: number;
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
  puzzleLog: EntityTable<PuzzleAttempt, 'id'>;
  engineCache: EntityTable<EngineCacheRow, 'key'>;
  activity: EntityTable<Activity, 'id'>;
  tacticCards: EntityTable<TacticCard, 'id'>;
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
  // Puzzles you did (the Puzzles tab).
  db.version(5).stores({ puzzleLog: 'id, startedAt, puzzleId' });
  // The engine's lines in positions checked for sharpness (a cache, like explorerCache).
  db.version(6).stores({ engineCache: 'key, fetchedAt' });
  // Time spent on your training, by third (the Plan tab).
  db.version(7).stores({ activity: 'id, start, third, refId' });
  // Tactics you missed, to solve again cold, spaced (the Puzzles tab).
  db.version(8).stores({ tacticCards: 'id, due' });
  trackChanges(db);
  return db;
}

export const db: ChessDB = openDb();

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID().slice(0, 12);
  return Math.random().toString(36).slice(2, 14);
}
