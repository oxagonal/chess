/**
 * Cards of tactics to solve again (missed puzzles, mistakes in your games): adding your game's mistakes,
 * and judging a move in a game position that isn't the engine's — your games aren't curated puzzles,
 * so another good move counts too.
 */
import { db } from '../db/db';
import { keyOf, playSan, playUci, posFromFen, startPos, type Color } from '../lib/chess';
import { winChanceOf, type Score } from '../lib/review';
import { GAME_MOVE_OK_LOSS, gameCard, gameMistakes, type GameMistake, type TacticCard } from '../lib/tacticCards';
import type { StoredGame } from '../lib/types';
import { analyseOnce, cloudLines, winChance } from './engine';

/**
 * Your mistakes in a game, as cards (those you already have keep their progress): your crucial swings
 * and the moves you marked ? or ??. A marked one whose position Stockfish hasn't looked at gets the
 * engine's move now (Lichess's cloud analysis, else Stockfish here). How many were new.
 */
export async function addGameCards(game: StoredGame): Promise<number> {
  const now = Date.now();
  const found = gameMistakes(game);
  const cards: TacticCard[] = [];
  for (const m of found) {
    if (!m.best) {
      let pos = startPos();
      for (const san of game.sans.slice(0, m.ply)) pos = playSan(pos, san)?.pos ?? pos;
      const key = keyOf(pos);
      const lines = (await cloudLines(key).catch(() => undefined)) ?? (await analyseOnce(key, 16, 1));
      const top = lines?.[0];
      if (!top?.moves[0]) continue;
      m.best = top.moves[0];
      m.before = { cp: top.eval.cp, mate: top.eval.mate };
    }
    cards.push(gameCard(game, m as GameMistake & { best: string }, now));
  }
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
