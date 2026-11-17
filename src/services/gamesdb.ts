/**
 * Fetching the over-the-board games database (a separate static site, see gamesdb/SPEC.md).
 * Files are gzip-compressed JSON; the release in the manifest is appended to every URL so a new
 * deploy is picked up while unchanged files stay cached.
 */
import { GAMESDB_FORMAT, matchNames, nameTokens, shardKey, type GameBucket, type GamesDbManifest, type NameEntry } from '../lib/gamesdb';

export const GAMES_DB_URL = 'https://otbdb.oxagon.workers.dev';

export class GamesDbUnavailable extends Error {
  constructor(detail: string) {
    super(`The over-the-board games database isn't available (${detail}).`);
    this.name = 'GamesDbUnavailable';
  }
}

let manifest: Promise<GamesDbManifest> | undefined;

export function getManifest(base = GAMES_DB_URL): Promise<GamesDbManifest> {
  if (!manifest || base !== GAMES_DB_URL) {
    const p = (async () => {
      let res: Response;
      try {
        res = await fetch(`${base}/manifest.json`, { cache: 'no-cache' });
      } catch {
        throw new GamesDbUnavailable('offline, or not deployed yet');
      }
      if (!res.ok) throw new GamesDbUnavailable(res.status === 404 ? 'not deployed yet' : `HTTP ${res.status}`);
      const m = (await res.json()) as GamesDbManifest;
      if (m.format > GAMESDB_FORMAT) throw new GamesDbUnavailable('it was built for a newer version of the app — reload to update');
      return m;
    })();
    if (base !== GAMES_DB_URL) return p;
    manifest = p;
    p.catch(() => (manifest = undefined)); // try again next time
  }
  return manifest;
}

async function gunzipJson<T>(res: Response): Promise<T> {
  const stream = res.body!.pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text()) as T;
}

async function getFile<T>(base: string, path: string, release: string): Promise<T | undefined> {
  const res = await fetch(`${base}/${path}?r=${encodeURIComponent(release)}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new GamesDbUnavailable(`HTTP ${res.status}`);
  return gunzipJson<T>(res);
}

const shardCache = new Map<string, Promise<NameEntry[]>>();

/** Players whose name matches what's typed (most games first). */
export async function searchPlayers(query: string, base = GAMES_DB_URL): Promise<NameEntry[]> {
  const words = nameTokens(query);
  if (!words.length) return [];
  const m = await getManifest(base);
  // The longest word is the rarest: its shard is the smallest set to filter.
  const key = shardKey([...words].sort((a, b) => b.length - a.length)[0]);
  const cacheKey = `${base}|${m.release}|${key}`;
  let shard = shardCache.get(cacheKey);
  if (!shard) {
    shard = getFile<NameEntry[]>(base, `names/${key}.bin`, m.release).then((x) => x ?? []);
    shardCache.set(cacheKey, shard);
    shard.catch(() => shardCache.delete(cacheKey));
  }
  return matchNames(await shard, query);
}

/** The bucket file holding a player's games. */
export async function getBucket(id: number, base = GAMES_DB_URL): Promise<{ bucket: GameBucket; release: string }> {
  const m = await getManifest(base);
  const bucket = await getFile<GameBucket>(base, `games/${id % m.buckets}.bin`, m.release);
  return { bucket: bucket ?? { events: [], tcs: [], players: {} }, release: m.release };
}
