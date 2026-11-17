/**
 * Players you scout (Builder → Players): saving them, and downloading their recent online games into
 * a local cache (`playerGames`, not synced — every device downloads its own copy).
 */
import { db, uid } from '../db/db';
import { getSettings } from '../db/settings';
import { importLichess } from '../lib/importers/lichess';
import { importChessCom } from '../lib/importers/chesscom';
import type { ImportProgress } from '../lib/importers/common';
import type { DbLink, GameSource, Player, PlayerGame, StoredGame } from '../lib/types';
import { bucketGames } from '../lib/gamesdb';
import { getBucket, getManifest } from './gamesdb';

/** First download: the newest this many Lichess games… */
const LICHESS_FIRST_MAX = 600;
/** …and this many months of Chess.com games. */
const CHESSCOM_FIRST_MONTHS = 6;

type Accounts = Pick<Player, 'lichess' | 'chesscom' | 'dbLinks'>;

const clean = (s: string | undefined) => s?.trim() || undefined;

export async function savePlayer(input: { id?: string; name: string; lichess?: string; chesscom?: string; pgn?: string; dbLinks?: DbLink[] }): Promise<Player> {
  const old = input.id ? await db.players.get(input.id) : undefined;
  const player: Player = {
    id: old?.id ?? uid(),
    name: input.name.trim(),
    lichess: clean(input.lichess),
    chesscom: clean(input.chesscom),
    pgn: clean(input.pgn),
    dbLinks: input.dbLinks?.length ? input.dbLinks : undefined,
    createdAt: old?.createdAt ?? Date.now(),
  };
  const linkKey = (p?: Player) => (p?.dbLinks ?? []).map((l) => l.id).sort().join(',');
  await db.transaction('rw', db.players, db.playerGames, async () => {
    // A changed username means a different account: drop the old account's games.
    for (const source of ['lichess', 'chesscom'] as const) {
      if (old && (old[source] ?? '').toLowerCase() !== (player[source] ?? '').toLowerCase()) {
        await db.playerGames.where('[playerId+source]').equals([player.id, source]).delete();
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
}

export interface PlayerRefresh {
  added: number;
  errors: string[];
}

/** Download the player's games that aren't cached yet (incremental after the first time). */
export async function refreshPlayerGames(
  player: Player & Accounts,
  opts: { signal?: AbortSignal; onProgress?: (p: ImportProgress & { source: GameSource }) => void } = {},
): Promise<PlayerRefresh> {
  const settings = await getSettings();
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
    const common = {
      username,
      timeClasses: settings.importTimeClasses,
      signal: opts.signal,
      onGames: store,
      onProgress: (p: ImportProgress) => opts.onProgress?.({ ...p, source }),
    };
    try {
      if (source === 'lichess') {
        await importLichess({
          ...common,
          token: settings.lichessToken || undefined,
          ...(newest ? { since: newest + 1 } : { since: 0, max: LICHESS_FIRST_MAX }),
        });
      } else {
        const d = new Date();
        d.setMonth(d.getMonth() - CHESSCOM_FIRST_MONTHS);
        await importChessCom({ ...common, since: newest ? newest + 1 : d.getTime() });
      }
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
