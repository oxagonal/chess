/**
 * Sync between devices (phone ⇄ computer) through a secret gist in the user's GitHub account.
 *
 * `syncOnce` reads both copies, merges them row by row (lib/syncMerge.ts), uploads the merged copy
 * and applies it to this device. `startAutoSync` runs it when the app opens, a few seconds after you
 * change something, when you switch away from the app, and when another device has synced.
 */
import { useSyncExternalStore } from 'react';
import type { Transaction } from 'dexie';
import { db as appDb, type ChessDB } from '../db/db';
import { markQuiet, onLocalChange } from '../db/changes';
import {
  SYNC_FORMAT,
  SYNC_TABLES,
  emptySnapshot,
  mergeSync,
  rowKey,
  rowVersion,
  type BaseKeys,
  type MergeResult,
  type Row,
  type Snapshot,
  type SyncTable,
} from '../lib/syncMerge';
import { GistTransport, GitHubError, RemoteChangedError, createSyncGist, findSyncGist, gitHubLogin, type Transport } from './gist';

interface SyncConfig {
  token: string;
  gistId: string;
  login: string;
  connectedAt: number;
}

/** Bookkeeping kept between syncs. */
interface SyncBook {
  /** Keys this device had after its last sync (to notice what it deleted since); null before the first sync. */
  base: Record<SyncTable, string[]> | null;
  /** This device's data replaces the synced copy at the next sync (after a backup restore or "Delete all data"). */
  forceLocal?: boolean;
  lastVersion?: string | null;
  lastSyncAt?: number;
}

const CONFIG = 'config';
const BOOK = 'book';
const SETTINGS_KEY = 'settings';
/** Settings that stay on this device. */
const DEVICE_SETTINGS = ['lichessToken'];

async function getState<T>(db: ChessDB, key: string): Promise<T | undefined> {
  return (await db.syncState.get(key))?.value as T | undefined;
}

// ───────────────────────── engine ─────────────────────────

interface LocalRead {
  snap: Snapshot;
  /** Review-log entries have per-device numeric ids. */
  logIds: Map<string, number>;
}

function withoutDeviceSettings(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const copy = { ...(value as Record<string, unknown>) };
  for (const k of DEVICE_SETTINGS) delete copy[k];
  return copy;
}

/** Put this device's own settings back into a settings row that came from another device. */
function withDeviceSettings(row: Row, current: Row | undefined): Row {
  if (row.key !== SETTINGS_KEY || !current?.value) return row;
  const own = Object.fromEntries(DEVICE_SETTINGS.filter((k) => k in current.value).map((k) => [k, current.value[k]]));
  return { ...row, value: { ...row.value, ...own } };
}

async function readLocal(db: ChessDB): Promise<LocalRead> {
  const snap = emptySnapshot();
  const logIds = new Map<string, number>();
  await db.transaction(
    'r',
    SYNC_TABLES.map((t) => db.table(t)),
    async () => {
      for (const t of SYNC_TABLES) {
        for (const raw of (await db.table(t).toArray()) as Row[]) {
          let row = raw;
          if (t === 'reviewLog') {
            const { id, ...rest } = raw;
            row = rest;
            logIds.set(rowKey(t, row), id);
          } else if (t === 'kv' && raw.key === SETTINGS_KEY) {
            row = { ...raw, value: withoutDeviceSettings(raw.value) };
          }
          snap[t].set(rowKey(t, row), row);
        }
      }
    },
  );
  return { snap, logIds };
}

/**
 * Write the merge result to this device. Rows the user changed while the sync was running are left
 * alone (returned as `skipped`); the next sync merges them.
 */
async function applyLocal(db: ChessDB, result: MergeResult, read: LocalRead, replace: boolean): Promise<number> {
  let skipped = 0;
  await db.transaction(
    'rw',
    SYNC_TABLES.map((t) => db.table(t)),
    async (tx: Transaction) => {
      markQuiet(tx);
      for (const t of SYNC_TABLES) {
        const table = db.table(t);
        if (replace) {
          const settings = t === 'kv' ? await table.get(SETTINGS_KEY) : undefined;
          await table.clear();
          await table.bulkAdd(result.doc.tables[t].rows.map((r) => withDeviceSettings(r, settings)));
          continue;
        }
        const puts = result.puts[t];
        const dels = result.deletes[t];
        if (!puts.length && !dels.length) continue;
        if (t === 'reviewLog') {
          // Log entries never change: add new ones, drop deleted ones.
          await table.bulkDelete(dels.map((k) => read.logIds.get(k)).filter((id): id is number => id !== undefined));
          await table.bulkAdd(puts.filter((r) => !read.logIds.has(rowKey(t, r))));
          continue;
        }
        const keys = [...puts.map((r) => rowKey(t, r)), ...dels];
        const current = (await table.bulkGet(keys)) as (Row | undefined)[];
        const touched = (i: number) => {
          const was = read.snap[t].get(keys[i]);
          const cur = current[i];
          return cur ? !was || rowVersion(t, cur) !== rowVersion(t, was) : !!was;
        };
        const toPut: Row[] = [];
        const toDelete: string[] = [];
        keys.forEach((k, i) => {
          if (touched(i)) skipped++;
          else if (i < puts.length) toPut.push(t === 'kv' ? withDeviceSettings(puts[i], current[i]) : puts[i]);
          else toDelete.push(k);
        });
        await table.bulkPut(toPut);
        await table.bulkDelete(toDelete);
      }
    },
  );
  return skipped;
}

export interface SyncReport {
  /** Rows added, changed or deleted on this device. */
  received: number;
  /** Whether the synced copy was updated. */
  sent: boolean;
  /** Local rows changed during the sync (merged next time). */
  skipped: number;
}

const toSets = (b: SyncBook['base']): BaseKeys | null => (b ? (Object.fromEntries(SYNC_TABLES.map((t) => [t, new Set(b[t] ?? [])])) as BaseKeys) : null);
const toArrays = (k: BaseKeys) => Object.fromEntries(SYNC_TABLES.map((t) => [t, [...k[t]]])) as Record<SyncTable, string[]>;

export async function syncOnce(db: ChessDB, transport: Transport, opts: { replaceLocal?: boolean; now?: () => number } = {}): Promise<SyncReport> {
  const now = opts.now ?? Date.now;
  const book: SyncBook = (await getState<SyncBook>(db, BOOK)) ?? { base: null };
  const replace = !!opts.replaceLocal;
  for (let attempt = 0; ; attempt++) {
    const remote = await transport.read();
    if (remote.doc && remote.doc.format > SYNC_FORMAT) throw new Error('Your synced data was saved by a newer version of Chess Prep — reload the app to update.');
    const read = await readLocal(db);
    const result = mergeSync({
      local: replace ? emptySnapshot() : read.snap,
      remote: remote.doc,
      base: replace ? null : toSets(book.base),
      now: now(),
      forceLocal: !replace && book.forceLocal,
    });
    let version = remote.version;
    if (result.remoteChanged.length) {
      try {
        version = await transport.write(result.doc, remote.version);
      } catch (e) {
        if (e instanceof RemoteChangedError && attempt < 3) continue;
        throw e;
      }
    }
    const skipped = await applyLocal(db, result, read, replace);
    await db.transaction('rw', db.syncState, async () => {
      // A backup restored while this sync ran still has to win next time.
      const latest = await getState<SyncBook>(db, BOOK);
      const forceLocal = !!latest?.forceLocal && !book.forceLocal;
      await db.syncState.put({ key: BOOK, value: { base: toArrays(result.keys), forceLocal, lastVersion: version, lastSyncAt: now() } satisfies SyncBook });
    });
    const received = SYNC_TABLES.reduce((n, t) => n + result.puts[t].length + result.deletes[t].length, 0);
    return { received, sent: result.remoteChanged.length > 0, skipped };
  }
}

/** After a backup restore or "Delete all data": this device's data replaces the synced copy at the next sync. */
export async function noteLocalDataReplaced(db: ChessDB = appDb) {
  const book = await getState<SyncBook>(db, BOOK);
  if (book) await db.syncState.put({ key: BOOK, value: { ...book, forceLocal: true } satisfies SyncBook });
}

// ───────────────────────── status (for the UI) ─────────────────────────

export interface SyncStatus {
  connected: boolean;
  login?: string;
  gistId?: string;
  state: 'idle' | 'syncing' | 'error' | 'offline';
  lastSyncAt?: number;
  message?: string;
}

let status: SyncStatus = { connected: false, state: 'idle' };
const subscribers = new Set<() => void>();

function setStatus(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch };
  for (const fn of subscribers) fn();
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    () => status,
  );
}

// ───────────────────────── scheduling ─────────────────────────

/** Wait this long after the last change before syncing… */
const DEBOUNCE_MS = 5_000;
/** …but never longer than this while you keep making changes. */
const MAX_WAIT_MS = 30_000;
/** How often to look for changes from other devices while the app is open. */
const POLL_MS = 60_000;

let config: SyncConfig | undefined;
let transport: GistTransport | undefined;
let running: Promise<void> | undefined;
let again = false;
let dirtySince = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
let started = false;

function transportFor(c: SyncConfig): GistTransport {
  if (!transport || transport.gistId !== c.gistId) transport = new GistTransport(c.token, c.gistId);
  return transport;
}

/** One sync at a time, across tabs too. */
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? (locks.request('chess-prep-sync', fn) as Promise<T>) : fn();
}

function schedule(delay: number) {
  clearTimeout(timer);
  timer = setTimeout(() => void runSync(), delay);
}

/** Sync now (or right after the sync that is already running). */
export function runSync(opts: { replaceLocal?: boolean } = {}): Promise<void> {
  if (!config) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    let repairedGist = false;
    do {
      again = false;
      dirtySince = 0;
      clearTimeout(timer);
      const c: SyncConfig | undefined = config;
      if (!c) break;
      setStatus({ state: 'syncing' });
      try {
        await withLock(() => syncOnce(appDb, transportFor(c), opts));
        opts = {};
        failures = 0;
        setStatus({ state: 'idle', lastSyncAt: Date.now(), message: undefined });
      } catch (e) {
        if (e instanceof GitHubError && e.status === 404 && !repairedGist && config) {
          // The gist was deleted on GitHub: start a new one from this device's data.
          repairedGist = true;
          try {
            const gistId: string = (await findSyncGist(c.token)) ?? (await createSyncGist(c.token));
            config = { ...c, gistId };
            await appDb.syncState.put({ key: CONFIG, value: config });
            setStatus({ gistId });
            again = true;
            continue;
          } catch (e2) {
            e = e2;
          }
        }
        failures++;
        const offline = e instanceof GitHubError && e.status === 0;
        setStatus({ state: offline ? 'offline' : 'error', message: (e as Error).message });
        schedule(Math.min(10 * 60_000, 30_000 * 2 ** (failures - 1)));
        break;
      }
    } while (again && config);
    running = undefined;
  })();
  return running;
}

/** Sync if this device has unsynced changes or another device synced since. */
async function checkRemote() {
  if (!config || running) return;
  if (dirtySince) return void runSync();
  try {
    const book = await getState<SyncBook>(appDb, BOOK);
    if (!book?.lastSyncAt || book.forceLocal || (await transportFor(config).latestVersion()) !== book.lastVersion) await runSync();
  } catch {
    /* offline: try again later */
  }
}

function onChange() {
  if (!config) return;
  const now = Date.now();
  if (!dirtySince) dirtySince = now;
  schedule(Math.max(0, Math.min(DEBOUNCE_MS, dirtySince + MAX_WAIT_MS - now)));
}

/** Load the sync settings and keep syncing in the background. Call once at startup. */
export async function startAutoSync() {
  if (started) return;
  started = true;
  config = await getState<SyncConfig>(appDb, CONFIG);
  const book = await getState<SyncBook>(appDb, BOOK);
  setStatus({ connected: !!config, login: config?.login, gistId: config?.gistId, lastSyncAt: book?.lastSyncAt });
  onLocalChange(onChange);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (dirtySince) void runSync(); // leaving the app: send changes now
    } else void checkRemote();
  });
  window.addEventListener('online', () => void checkRemote());
  setInterval(() => document.visibilityState === 'visible' && void checkRemote(), POLL_MS);
  if (config) void runSync();
}

// ───────────────────────── connecting ─────────────────────────

export interface ConnectCheck {
  token: string;
  login: string;
  gistId: string;
  /** Repertoires already in the synced copy (from another device). */
  remoteRepertoires: number;
  remoteHasData: boolean;
  localHasData: boolean;
}

/** Check a token and look at what is already synced, before connecting. */
export async function checkToken(token: string): Promise<ConnectCheck> {
  token = token.trim();
  if (!token) throw new Error('Paste a token first');
  const login = await gitHubLogin(token);
  const gistId = (await findSyncGist(token)) ?? (await createSyncGist(token));
  const { doc } = await new GistTransport(token, gistId).read();
  const remoteHasData = !!doc && SYNC_TABLES.some((t) => t !== 'kv' && doc.tables[t].rows.length > 0);
  const localHasData = (await appDb.repertoires.count()) + (await appDb.cards.count()) + (await appDb.games.count()) > 0;
  return { token, login, gistId, remoteRepertoires: doc?.tables.repertoires.rows.length ?? 0, remoteHasData, localHasData };
}

/**
 * Connect this device. `merge` combines this device's data with the synced copy; `replace-local`
 * throws away this device's data and takes the synced copy.
 */
export async function connect(check: ConnectCheck, mode: 'merge' | 'replace-local') {
  config = { token: check.token, gistId: check.gistId, login: check.login, connectedAt: Date.now() };
  await appDb.syncState.bulkPut([
    { key: CONFIG, value: config },
    { key: BOOK, value: { base: null } satisfies SyncBook },
  ]);
  failures = 0;
  setStatus({ connected: true, login: config.login, gistId: config.gistId, lastSyncAt: undefined, message: undefined });
  await runSync({ replaceLocal: mode === 'replace-local' });
}

/** Stop syncing this device. Its data and the synced copy are left as they are. */
export async function disconnect() {
  config = undefined;
  transport = undefined;
  clearTimeout(timer);
  await appDb.syncState.bulkDelete([CONFIG, BOOK]);
  setStatus({ connected: false, login: undefined, gistId: undefined, state: 'idle', lastSyncAt: undefined, message: undefined });
}

/** The token, to set up another device. */
export function currentToken(): string | undefined {
  return config?.token;
}
