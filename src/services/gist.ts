/**
 * The synced copy of the database lives in a secret gist in the user's own GitHub account, so sync
 * needs no server of ours: the browser talks to api.github.com directly with a personal token that
 * may only touch gists.
 *
 * Layout: a manifest (`chess-prep-sync.json`) plus one gzip+base64 text file per table — split by
 * month/year for the review log and games — so a sync only uploads the parts that changed.
 */
import { SYNC_FORMAT, SYNC_TABLES, emptyDoc, rowKey, type Row, type SyncDoc, type SyncTable } from '../lib/syncMerge';

/** What the sync engine needs from wherever the synced copy is kept. */
export interface Transport {
  /** The synced copy (null if there is none yet) and its version. */
  read(): Promise<{ version: string | null; doc: SyncDoc | null }>;
  /** Current version, cheaply (to see whether another device synced). */
  latestVersion(): Promise<string | null>;
  /** Replace the synced copy; throws RemoteChangedError if it is no longer at `expectedVersion`. Returns the new version. */
  write(doc: SyncDoc, expectedVersion: string | null): Promise<string | null>;
}

/** Another device synced in between; read again and merge. */
export class RemoteChangedError extends Error {
  constructor() {
    super('Synced data changed during sync');
  }
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const API = 'https://api.github.com';
export const MANIFEST = 'chess-prep-sync.json';
const DESCRIPTION = 'Chess Prep sync data — written by the app, please don’t edit';
/** Gists return files up to 1 MB inline; stay well below. */
const CHUNK_CHARS = 700_000;

type Encoding = 'gzip-base64' | 'json';

interface Manifest {
  app: 'chess-prep';
  format: number;
  savedAt?: number;
  groups?: Record<string, { enc: Encoding; files: string[] }>;
}

interface GistFile {
  content?: string;
  truncated?: boolean;
  raw_url?: string;
}

interface Gist {
  id: string;
  files: Record<string, GistFile>;
  history?: { version: string }[];
}

async function gh<T>(token: string, path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API + path, {
      method: init.method ?? 'GET',
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
  } catch {
    throw new GitHubError('Offline — will sync when you’re back online', 0);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string }).message ?? '';
    } catch {
      /* not JSON */
    }
    throw new GitHubError(describeError(res.status, detail), res.status);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

function describeError(status: number, detail: string): string {
  if (status === 401) return 'GitHub rejected the token (expired or revoked?). Disconnect and connect again with a new token.';
  if (status === 403 && /rate limit/i.test(detail)) return 'GitHub rate limit reached — will try again in a few minutes.';
  if (status === 403 || (status === 404 && /not accessible/i.test(detail)))
    return 'This token isn’t allowed to use gists. Create one with the “gist” permission.';
  return `GitHub returned HTTP ${status}${detail ? `: ${detail}` : ''}`;
}

/** The GitHub username a token belongs to (also checks that the token works). */
export async function gitHubLogin(token: string): Promise<string> {
  return (await gh<{ login: string }>(token, '/user')).login;
}

/** Find the sync gist in the token owner's account. */
export async function findSyncGist(token: string): Promise<string | null> {
  for (let page = 1; page <= 10; page++) {
    const list = await gh<Gist[]>(token, `/gists?per_page=100&page=${page}`);
    const hit = list.find((g) => g.files[MANIFEST]);
    if (hit) return hit.id;
    if (list.length < 100) break;
  }
  return null;
}

export async function createSyncGist(token: string): Promise<string> {
  const manifest: Manifest = { app: 'chess-prep', format: SYNC_FORMAT, groups: {} };
  const g = await gh<Gist>(token, '/gists', {
    method: 'POST',
    json: { description: DESCRIPTION, public: false, files: { [MANIFEST]: { content: JSON.stringify(manifest, null, 1) } } },
  });
  return g.id;
}

export class GistTransport implements Transport {
  /** Files in the gist, and the decoded JSON of each group as last read or written. */
  private files = new Set<string>();
  private groups = new Map<string, { json: string; enc: Encoding; files: string[] }>();

  constructor(
    private readonly token: string,
    readonly gistId: string,
    private readonly chunkChars = CHUNK_CHARS,
  ) {}

  async read() {
    const g = await gh<Gist>(this.token, `/gists/${this.gistId}`);
    this.files = new Set(Object.keys(g.files));
    this.groups.clear();
    const version = g.history?.[0]?.version ?? null;
    const mf = g.files[MANIFEST];
    if (!mf) return { version, doc: null };
    const manifest = JSON.parse(await fileText(mf)) as Manifest;
    if (manifest.app !== 'chess-prep') throw new Error('The sync gist doesn’t contain Chess Prep data');
    const doc = emptyDoc(manifest.savedAt ?? 0);
    doc.format = manifest.format;
    if (manifest.format > SYNC_FORMAT) return { version, doc };
    const entries = Object.entries(manifest.groups ?? {});
    if (!entries.length) return { version, doc: null };
    for (const [group, { enc, files }] of entries) {
      const parts = await Promise.all(
        files.map((name) => {
          const f = g.files[name];
          if (!f) throw new Error(`Synced data is incomplete (missing ${name})`);
          return fileText(f);
        }),
      );
      const json = await decode(parts.join(''), enc);
      this.groups.set(group, { json, enc, files });
      const { table, tombs } = parseGroup(group);
      if (!table) continue;
      const value = JSON.parse(json);
      if (tombs) Object.assign(doc.tables[table].tombs, value);
      else doc.tables[table].rows.push(...(value as Row[]));
    }
    return { version, doc };
  }

  async latestVersion(): Promise<string | null> {
    const commits = await gh<{ version: string }[]>(this.token, `/gists/${this.gistId}/commits?per_page=1`);
    return commits[0]?.version ?? null;
  }

  async write(doc: SyncDoc, expectedVersion: string | null): Promise<string | null> {
    if ((await this.latestVersion()) !== expectedVersion) throw new RemoteChangedError();
    const files: Record<string, { content: string } | null> = {};
    const groups = new Map<string, { json: string; enc: Encoding; files: string[] }>();
    for (const [group, json] of docGroups(doc)) {
      const prev = this.groups.get(group);
      if (prev?.json === json) {
        groups.set(group, prev); // unchanged: don't upload again
        continue;
      }
      const { enc, data } = await encode(json);
      const names: string[] = [];
      const size = this.chunkChars;
      for (let i = 0; i * size < data.length; i++) {
        const name = `${group}.${i}.txt`;
        names.push(name);
        files[name] = { content: data.slice(i * size, (i + 1) * size) };
      }
      groups.set(group, { json, enc, files: names });
    }
    const keep = new Set([MANIFEST, ...[...groups.values()].flatMap((g) => g.files)]);
    for (const name of this.files) if (!keep.has(name)) files[name] = null;
    const manifest: Manifest = {
      app: 'chess-prep',
      format: doc.format,
      savedAt: doc.savedAt,
      groups: Object.fromEntries([...groups].map(([k, { enc, files }]) => [k, { enc, files }])),
    };
    files[MANIFEST] = { content: JSON.stringify(manifest, null, 1) };
    const g = await gh<Gist>(this.token, `/gists/${this.gistId}`, { method: 'PATCH', json: { files } });
    this.files = keep;
    this.groups = groups;
    return g.history?.[0]?.version ?? null;
  }
}

async function fileText(f: GistFile): Promise<string> {
  if (!f.truncated && f.content !== undefined) return f.content;
  if (!f.raw_url) throw new Error('Synced data could not be read');
  const res = await fetch(f.raw_url, { cache: 'no-store' });
  if (!res.ok) throw new GitHubError(`GitHub returned HTTP ${res.status}`, res.status);
  return res.text();
}

/** Split into groups of rows (one file each): review log by month, games by year, the rest whole; plus tombstones. */
export function docGroups(doc: SyncDoc): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of SYNC_TABLES) {
    const { rows, tombs } = doc.tables[t];
    const shards = new Map<string, Row[]>();
    for (const row of rows) {
      const name = shardOf(t, row);
      const arr = shards.get(name);
      if (arr) arr.push(row);
      else shards.set(name, [row]);
    }
    for (const [name, list] of shards) {
      list.sort((a, b) => (rowKey(t, a) < rowKey(t, b) ? -1 : 1));
      out.set(name, JSON.stringify(list));
    }
    const tombList = Object.entries(tombs).sort(([a], [b]) => (a < b ? -1 : 1));
    if (tombList.length) out.set(`${t}.tombs`, JSON.stringify(Object.fromEntries(tombList)));
  }
  return out;
}

function shardOf(t: SyncTable, row: Row): string {
  if (t === 'reviewLog') return `${t}.${new Date(row.reviewedAt ?? 0).toISOString().slice(0, 7)}`;
  if (t === 'games') return `${t}.${new Date(row.playedAt ?? 0).toISOString().slice(0, 4)}`;
  return t;
}

function parseGroup(group: string): { table?: SyncTable; tombs: boolean } {
  const [name] = group.split('.');
  const table = (SYNC_TABLES as readonly string[]).includes(name) ? (name as SyncTable) : undefined;
  return { table, tombs: group.endsWith('.tombs') };
}

export async function encode(json: string): Promise<{ enc: Encoding; data: string }> {
  if (typeof CompressionStream === 'undefined') return { enc: 'json', data: json };
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  return { enc: 'gzip-base64', data: toBase64(new Uint8Array(await new Response(stream).arrayBuffer())) };
}

export async function decode(data: string, enc: Encoding): Promise<string> {
  if (enc === 'json') return data;
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser is too old to read the synced data — update it.');
  const stream = new Blob([fromBase64(data)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
