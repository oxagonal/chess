/**
 * Players you scout (Builder → Players): saving them, and downloading their recent online games into
 * a local cache (`playerGames`, not synced — every device downloads its own copy).
 */
import { db, uid } from '../db/db';
import { getSettings } from '../db/settings';
import { importLichess } from '../lib/importers/lichess';
import { importChessCom } from '../lib/importers/chesscom';
import type { ImportProgress } from '../lib/importers/common';
import type { GameSource, Player, PlayerGame, StoredGame } from '../lib/types';

/** First download: the newest this many Lichess games… */
const LICHESS_FIRST_MAX = 600;
/** …and this many months of Chess.com games. */
const CHESSCOM_FIRST_MONTHS = 6;

type Accounts = Pick<Player, 'lichess' | 'chesscom'>;

const clean = (s: string | undefined) => s?.trim() || undefined;

export async function savePlayer(input: { id?: string; name: string; lichess?: string; chesscom?: string; pgn?: string }): Promise<Player> {
  const old = input.id ? await db.players.get(input.id) : undefined;
  const player: Player = {
    id: old?.id ?? uid(),
    name: input.name.trim(),
    lichess: clean(input.lichess),
    chesscom: clean(input.chesscom),
    pgn: clean(input.pgn),
    createdAt: old?.createdAt ?? Date.now(),
  };
  await db.transaction('rw', db.players, db.playerGames, async () => {
    // A changed username means a different account: drop the old account's games.
    for (const source of ['lichess', 'chesscom'] as const) {
      if (old && (old[source] ?? '').toLowerCase() !== (player[source] ?? '').toLowerCase()) {
        await db.playerGames.where('[playerId+source]').equals([player.id, source]).delete();
      }
    }
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
  return { added, errors };
}
