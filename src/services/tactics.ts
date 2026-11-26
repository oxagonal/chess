/**
 * Cards of tactics to solve again (missed puzzles, mistakes in your games): adding your game's mistakes,
 * and judging a move in a game position that isn't the engine's — your games aren't curated puzzles,
 * so another good move counts too.
 */
import { db } from '../db/db';
import { keyOf, playSan, playUci, posFromFen, startPos, type Color } from '../lib/chess';
import { winChanceOf, type Score } from '../lib/review';
import { cardPly, cardReady, GAME_MOVE_OK_LOSS, gameCard, gameMistakes, mistakeAt, needsLine, needsUpgrade, solutionLine, type GameMistake, type TacticCard } from '../lib/tacticCards';
import { puzzleStart } from '../lib/puzzle';
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
  const keys = keysOf(game);
  const cards: TacticCard[] = [];
  for (const m of gameMistakes(game)) {
    await fillFromEngine(m, keys);
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

/** Each position's key in a game, from the start. */
function keysOf(game: StoredGame): string[] {
  const keys: string[] = [];
  let pos = startPos();
  keys.push(keyOf(pos));
  for (const san of game.sans) {
    const r = playSan(pos, san);
    if (!r) break;
    pos = r.pos;
    keys.push(r.key);
  }
  return keys;
}

/** What the engine hasn't looked at yet: the move to find before yours, their reply after it. */
async function fillFromEngine(m: GameMistake, keys: string[]) {
  if ((!m.best || !m.before) && keys[m.ply]) {
    const e = await engineAt(keys[m.ply]);
    if (e) [m.best, m.before] = [m.best ?? e.best, m.before ?? e.eval];
  }
  if ((m.kind === 'punish' ? !m.reply || !m.after : !m.after) && keys[m.ply + 1]) {
    const e = await engineAt(keys[m.ply + 1]);
    if (e) [m.reply, m.after] = [m.reply ?? e.best, m.after ?? e.eval];
  }
}

/**
 * A game card made before blunders became punishment cards, sorted again by today's rules — a blunder
 * where many moves held becomes their punishment to find — keeping its progress (saved). As it was if
 * its game is gone or the engine can't say.
 */
export async function upgradeGameCard(card: TacticCard): Promise<TacticCard> {
  const game = card.game && (await db.games.get(card.game.id));
  let next: TacticCard = { ...card, game: { ...card.game!, kind: 'best' } };
  if (game) {
    const m = mistakeAt(game, cardPly(card));
    await fillFromEngine(m, keysOf(game)).catch(() => undefined);
    if (cardReady(m)) {
      const fresh = gameCard(game, m, card.createdAt);
      next = { ...fresh, step: card.step, streak: card.streak, due: card.due, createdAt: card.createdAt, lastAt: card.lastAt, reason: card.reason, retired: card.retired };
    }
  }
  await db.tacticCards.put(next);
  return next;
}

/**
 * Does `uci` hold up in a position of your game (`key`) where best play scores `best` (White's view)?
 * It does if it loses less than GAME_MOVE_OK_LOSS of the win chance — Lichess's cloud analysis of the
 * position after it, else Stockfish here. The engine's own choice there (`engineBest`) always does.
 * Throws when neither can say (Stockfish didn't answer): not the same as "it doesn't hold".
 */
export async function holdsUp(key: string, uci: string, best: Score | undefined, you: Color, engineBest?: string): Promise<boolean> {
  const pos = posFromFen(key);
  const played = pos && playUci(pos, uci);
  if (!played) return false;
  if (played.pos.isCheckmate()) return true;
  if (engineBest && pos && playUci(pos, engineBest)?.uci === played.uci) return true;
  if (!best) return false;
  const cloud = await cloudLines(played.key).catch(() => undefined);
  let after = cloud?.[0]?.eval;
  // Once more if the first search came back empty.
  for (let i = 0; !after && i < 2; i++) after = (await analyseOnce(played.key, 16, 1))[0]?.eval;
  if (!after) throw new Error("Stockfish didn't answer");
  const loss = you === 'white' ? winChanceOf(best) - winChance(after) : winChance(after) - winChanceOf(best);
  return loss < GAME_MOVE_OK_LOSS;
}

/** The engine's line from `key` starting with `first`: Lichess's cloud analysis, else Stockfish after that move. */
export async function engineLine(key: string, first: string): Promise<string[]> {
  const pos = posFromFen(key);
  const r = pos && playUci(pos, first);
  if (!r) return [first];
  const cloud = await cloudLines(key).catch(() => undefined);
  const hit = cloud?.find((l) => l.moves[0] === r.uci);
  if (hit && hit.moves.length >= 3) return hit.moves;
  const after = (await cloudLines(r.key).catch(() => undefined))?.[0]?.moves ?? (await analyseOnce(r.key, 16, 1))[0]?.moves ?? [];
  return [r.uci, ...after];
}

/**
 * A game card's solution as the engine's whole line — until it has won something (solutionLine) —
 * so a sacrifice asks for its follow-up too, not only the first move. Done once per card (saved);
 * as it was if the engine can't say.
 */
export async function withSolutionLine(card: TacticCard): Promise<TacticCard> {
  if (!needsLine(card)) return card;
  const start = puzzleStart(card.puzzle);
  const first = card.puzzle.puzzle.solution[0];
  if (!start || !first) return card;
  let line: string[];
  try {
    line = solutionLine(start.pos, await engineLine(keyOf(start.pos), first));
  } catch {
    return card;
  }
  if (!line.length || line[0] !== first) line = [first];
  const next: TacticCard = { ...card, puzzle: { ...card.puzzle, puzzle: { ...card.puzzle.puzzle, solution: line } }, game: { ...card.game!, lineChecked: true } };
  await db.tacticCards.put(next);
  return next;
}

/** A game card ready to solve: sorted by today's rules, with the engine's whole line. */
export async function prepareGameCard(card: TacticCard): Promise<TacticCard> {
  const sorted = needsUpgrade(card) ? await upgradeGameCard(card) : card;
  return withSolutionLine(sorted);
}
