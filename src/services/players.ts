/**
 * Players you scout (Builder → Players): saving them, and downloading their online games — since the
 * date chosen for each player, in its time controls — into a local cache (`playerGames`, not synced:
 * every device downloads its own copy).
 */
import { db, uid } from '../db/db';
import { getSettings } from '../db/settings';
import { importLichess } from '../lib/importers/lichess';
import { importChessCom } from '../lib/importers/chesscom';
import type { ImportProgress, TimeClass } from '../lib/importers/common';
import type { DbLink, GameSource, Player, PlayerGame, StoredGame } from '../lib/types';
import { bucketGames } from '../lib/gamesdb';
import { onlineWindow } from '../lib/players';
import { getBucket, getManifest } from './gamesdb';

type Accounts = Pick<Player, 'lichess' | 'chesscom' | 'dbLinks' | 'since' | 'timeClasses'>;
type Online = 'lichess' | 'chesscom';

/**
 * What this device's cache holds of a player's account: every game since `from` in the time controls
 * `tc`. Later downloads only fetch newer games — unless you ask for older ones or more time controls.
 */
interface Covered {
  from: number;
  tc: TimeClass[];
}
const coveredKey = (playerId: string, source: Online) => `chess-prep:playerCovered:${playerId}:${source}`;

function getCovered(playerId: string, source: Online): Covered | undefined {
  try {
    const raw = localStorage.getItem(coveredKey(playerId, source));
    return raw ? (JSON.parse(raw) as Covered) : undefined;
  } catch {
    return undefined;
  }
}

function setCovered(playerId: string, source: Online, c: Covered | undefined) {
  try {
    if (c) localStorage.setItem(coveredKey(playerId, source), JSON.stringify(c));
    else localStorage.removeItem(coveredKey(playerId, source));
  } catch {
    /* storage unavailable: the next refresh downloads the whole period again (duplicates are merged) */
  }
}

const clean = (s: string | undefined) => s?.trim() || undefined;

export async function savePlayer(input: {
  id?: string;
  name: string;
  lichess?: string;
  chesscom?: string;
  pgn?: string;
  dbLinks?: DbLink[];
  since?: string;
  timeClasses?: TimeClass[];
}): Promise<Player> {
  const old = input.id ? await db.players.get(input.id) : undefined;
  const player: Player = {
    id: old?.id ?? uid(),
    name: input.name.trim(),
    lichess: clean(input.lichess),
    chesscom: clean(input.chesscom),
    pgn: clean(input.pgn),
    dbLinks: input.dbLinks?.length ? input.dbLinks : undefined,
    since: input.since ?? old?.since,
    timeClasses: input.timeClasses?.length ? input.timeClasses : old?.timeClasses,
    createdAt: old?.createdAt ?? Date.now(),
  };
  const linkKey = (p?: Player) => (p?.dbLinks ?? []).map((l) => l.id).sort().join(',');
  await db.transaction('rw', db.players, db.playerGames, async () => {
    // A changed username means a different account: drop the old account's games.
    for (const source of ['lichess', 'chesscom'] as const) {
      if (old && (old[source] ?? '').toLowerCase() !== (player[source] ?? '').toLowerCase()) {
        await db.playerGames.where('[playerId+source]').equals([player.id, source]).delete();
        setCovered(player.id, source, undefined);
      }
    }
    // Different database names linked: download their games afresh.
    if (old && linkKey(old) !== linkKey(player)) await db.playerGames.where('[playerId+source]').equals([player.id, 'otb']).delete();
    await db.players.put(player);
  });
  return player;
}

export async function deletePlayer(id: string) {
  await db.transaction('rw', db.players, db.playerGames, async () => {
    await db.playerGames.where('playerId').equals(id).delete();
    await db.players.delete(id);
  });
  setCovered(id, 'lichess', undefined);
  setCovered(id, 'chesscom', undefined);
}

export interface PlayerRefresh {
  added: number;
  errors: string[];
}

/**
 * Download the player's online games that aren't cached yet: everything in their window (since their
 * date, in their time controls) the first time or when the window grew, then just the newer games.
 */
export async function refreshPlayerGames(
  player: Player & Accounts,
  opts: { signal?: AbortSignal; onProgress?: (p: ImportProgress & { source: GameSource }) => void } = {},
): Promise<PlayerRefresh> {
  const settings = await getSettings();
  const want = onlineWindow(player, settings.importTimeClasses);
  let added = 0;
  const errors: string[] = [];
  const store = async (games: StoredGame[]) => {
    const rows: PlayerGame[] = games.map((g) => ({ ...g, id: `${player.id}|${g.id}`, gameId: g.id, playerId: player.id }));
    await db.playerGames.bulkPut(rows);
    added += rows.length;
  };
  for (const source of ['lichess', 'chesscom'] as const) {
    const username = player[source];
    if (!username) continue;
    const cached = await db.playerGames.where('[playerId+source]').equals([player.id, source]).toArray();
    const newest = cached.reduce((m, g) => Math.max(m, g.playedAt), 0);
    const covered = getCovered(player.id, source);
    // Asked for older games or more time controls than the cache holds: fetch the whole window again
    // (games already here are just merged). Otherwise only what's newer than the newest one cached.
    const full = !covered || want.since < covered.from || want.timeClasses.some((t) => !covered.tc.includes(t));
    const common = {
      username,
      since: full ? want.since : Math.max(want.since, newest + 1),
      timeClasses: want.timeClasses,
      signal: opts.signal,
      onGames: store,
      onProgress: (p: ImportProgress) => opts.onProgress?.({ ...p, source }),
    };
    try {
      if (source === 'lichess') await importLichess({ ...common, token: settings.lichessToken || undefined });
      else await importChessCom(common);
      if (full) setCovered(player.id, source, { from: want.since, tc: want.timeClasses });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      errors.push(`${source === 'lichess' ? 'Lichess' : 'Chess.com'}: ${(e as Error).message}`);
    }
  }
  if (player.dbLinks?.length) {
    try {
      await refreshDbGames(player, player.dbLinks, store, (games) => opts.onProgress?.({ phase: 'Over-the-board database', games, source: 'otb' }));
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      errors.push((e as Error).message);
    }
  }
  return { added, errors };
}

/** Games of the linked database players — again only when a new release of the database is out. */
async function refreshDbGames(player: Player, links: DbLink[], store: (g: StoredGame[]) => Promise<void>, progress: (n: number) => void) {
  const { release } = await getManifest();
  const cached = await db.playerGames.where('[playerId+source]').equals([player.id, 'otb']).toArray();
  if (cached.some((g) => g.account !== `lgb:${release}`)) {
    await db.playerGames.where('[playerId+source]').equals([player.id, 'otb']).delete();
    cached.length = 0;
  }
  const have = new Set(cached.map((g) => g.gameId.split(':')[1]));
  let n = 0;
  for (const link of links) {
    if (have.has(String(link.id))) continue;
    const { bucket, release: r } = await getBucket(link.id);
    const games = bucketGames(bucket, [link.name, link.id], r);
    await store(games);
    n += games.length;
    progress(n);
  }
}
