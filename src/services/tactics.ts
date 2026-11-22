/**
 * Cards of tactics to solve again (missed puzzles, mistakes in your games): adding your game's mistakes,
 * and judging a move in a game position that isn't the engine's — your games aren't curated puzzles,
 * so another good move counts too.
 */
import { db } from '../db/db';
import { playUci, posFromFen, type Color } from '../lib/chess';
import { winChanceOf, type Score } from '../lib/review';
import { GAME_MOVE_OK_LOSS, gameCards } from '../lib/tacticCards';
import type { StoredGame } from '../lib/types';
import { analyseOnce, cloudLines, winChance } from './engine';

/** Your crucial mistakes in a reviewed game, as cards (those you already have keep their progress). How many were new. */
export async function addGameCards(game: StoredGame): Promise<number> {
  const cards = gameCards(game, Date.now());
  let added = 0;
  await db.transaction('rw', db.tacticCards, async () => {
    for (const c of cards) {
      if (await db.tacticCards.get(c.id)) continue;
      await db.tacticCards.put(c);
      added++;
    }
  });
  return added;
}

/**
 * Does `uci` hold up in a position of your game (`key`) where best play scores `best` (White's view)?
 * It does if it loses less than GAME_MOVE_OK_LOSS of the win chance — Lichess's cloud analysis of the
 * position after it, else Stockfish here.
 */
export async function holdsUp(key: string, uci: string, best: Score | undefined, you: Color): Promise<boolean> {
  const pos = posFromFen(key);
  const played = pos && playUci(pos, uci);
  if (!played) return false;
  if (played.pos.isCheckmate()) return true;
  if (!best) return false;
  const cloud = await cloudLines(played.key).catch(() => undefined);
  const after = cloud?.[0]?.eval ?? (await analyseOnce(played.key, 16, 1))[0]?.eval;
  if (!after) return false;
  const loss = you === 'white' ? winChanceOf(best) - winChance(after) : winChance(after) - winChanceOf(best);
  return loss < GAME_MOVE_OK_LOSS;
}
