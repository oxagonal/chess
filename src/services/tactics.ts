/**
 * Cards of tactics to solve again (missed puzzles, mistakes in your games): adding your game's mistakes,
 * and judging a move in a game position that isn't the engine's — your games aren't curated puzzles,
 * so another good move counts too.
 */
import { db } from '../db/db';
import { keyOf, playSan, playUci, posFromFen, startPos, type Color } from '../lib/chess';
import { winChanceOf, type Score } from '../lib/review';
import { cardReady, GAME_MOVE_OK_LOSS, gameCard, gameMistakes, type TacticCard } from '../lib/tacticCards';
import type { StoredGame } from '../lib/types';
import { analyseOnce, cloudLines, winChance } from './engine';

/** The engine's best move in a position, and its evaluation (White's view): Lichess's cloud analysis, else here. */
async function engineAt(key: string): Promise<{ best: string; eval: Score } | undefined> {
  const lines = (await cloudLines(key).catch(() => undefined)) ?? (await analyseOnce(key, 16, 1));
  const top = lines?.[0];
  return top?.moves[0] ? { best: top.moves[0], eval: { cp: top.eval.cp, mate: top.eval.mate } } : undefined;
}

/**
 * Your mistakes in a game, as cards (those you already have keep their progress): your crucial swings,
 * the tactics you missed and the moves you marked ? or ??. What the engine hasn't looked at yet (the
 * move to find, their punishing reply) it finds now. How many were new.
 */
export async function addGameCards(game: StoredGame): Promise<number> {
  const now = Date.now();
  const keys: string[] = [];
  let pos = startPos();
  keys.push(keyOf(pos));
  for (const san of game.sans) {
    const r = playSan(pos, san);
    if (!r) break;
    pos = r.pos;
    keys.push(r.key);
  }
  const cards: TacticCard[] = [];
  for (const m of gameMistakes(game)) {
    if (!m.best && keys[m.ply]) {
      const e = await engineAt(keys[m.ply]);
      if (e) [m.best, m.before] = [e.best, m.before ?? e.eval];
    }
    if (m.kind === 'punish' && !m.reply && keys[m.ply + 1]) {
      const e = await engineAt(keys[m.ply + 1]);
      if (e) [m.reply, m.after] = [e.best, m.after ?? e.eval];
    }
    if (cardReady(m)) cards.push(gameCard(game, m, now));
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
