/**
 * Tactics you missed, brought back to solve again cold — spaced, not shown again right away: re-solving
 * after a delay is what makes it stick (retrieval practice); looking at the solution again only feels
 * like it does. A card comes back after 1 day, then 3, 7 and 30; solved twice in a row within your time
 * per puzzle, it's done; missed again, it starts over at a day. Pure.
 */
import type { LichessPuzzle } from './puzzle';
import type { PuzzleAttempt, StoredGame } from './types';
import type { Color } from './chess';
import { crucialSwings } from './quickReview';
import { withLiveEvals, type Score } from './review';

/** Why a puzzle was missed (the tap after a miss) — the pattern says what to work on. */
export type MissReason = NonNullable<PuzzleAttempt['reason']>;

export const MISS_REASONS: { key: MissReason; label: string; tip: string }[] = [
  { key: 'unseen', label: "Didn't see the move", tip: 'Before anything else, look at every check, capture and threat — yours first.' },
  { key: 'defence', label: 'Missed their defence', tip: "Before you commit, look for their checks, captures and threats at each step — their best reply, not the one you hope for." },
  { key: 'calc', label: 'Miscalculated', tip: 'One move at a time: picture each position you reach before going on, and write the line down to the end.' },
  { key: 'eval', label: 'Misjudged the end', tip: "At the end of the line, count the material and look for their counterplay before calling it winning." },
  { key: 'rushed', label: 'Rushed', tip: 'Use your time per puzzle: commit only when the line is clear to the end.' },
];

/** Days until a card comes back, by how many times in a row it's been solved. */
export const REVIEW_DAYS = [1, 3, 7, 30];
/** Solved this many times in a row (within your time) and a card is done. */
export const RETIRE_AFTER = 2;

const DAY = 86_400_000;

export interface TacticCard {
  /** `p:${puzzleId}` for a Lichess puzzle, `g:${gameId}:${ply}` for a mistake in one of your games. */
  id: string;
  source: 'puzzle' | 'game';
  /** The position to solve, as a puzzle (a game's: its moves up to there, the engine's move as the answer). */
  puzzle: LichessPuzzle;
  /** A mistake from your game: what you played, the evaluation with best play (White's view), against whom. */
  game?: { id: string; played: string; best?: Score; you: Color; opponent: string; playedAt: number };
  reason?: MissReason;
  /** Index into REVIEW_DAYS of the wait before it's due. */
  step: number;
  /** Solved within your time, in a row, since the last miss. */
  streak: number;
  /** When it comes back (the start of that day). */
  due: number;
  createdAt: number;
  lastAt?: number;
  /** Done: solved RETIRE_AFTER times in a row. */
  retired?: boolean;
  modifiedAt?: number;
}

/** Midnight (local) of the day `t` is in. */
export function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `days` days after the start of `t`'s day — from then on it's due (tomorrow, not in 24 hours). */
const dueAfter = (t: number, days: number) => startOfDay(t) + days * DAY + (new Date(t).getTimezoneOffset() - new Date(startOfDay(t) + days * DAY).getTimezoneOffset()) * 60_000;

export const cardId = (puzzleId: string) => `p:${puzzleId}`;

/** A puzzle you just missed, as a card (or the one you had for it, back to the start). */
export function missedCard(puzzle: LichessPuzzle, now: number, had?: TacticCard): TacticCard {
  return {
    ...(had ?? {}),
    id: cardId(puzzle.puzzle.id),
    source: 'puzzle',
    puzzle,
    step: 0,
    streak: 0,
    due: dueAfter(now, REVIEW_DAYS[0]),
    createdAt: had?.createdAt ?? now,
    lastAt: now,
    retired: undefined,
  };
}

/** A card after you solve it again: `ok` — solved (a soft pass counts) within your time. */
export function reviewed(card: TacticCard, ok: boolean, now: number): TacticCard {
  if (!ok) return { ...card, step: 0, streak: 0, due: dueAfter(now, REVIEW_DAYS[0]), lastAt: now };
  const streak = card.streak + 1;
  const step = Math.min(card.step + 1, REVIEW_DAYS.length - 1);
  return { ...card, streak, step, due: dueAfter(now, REVIEW_DAYS[step]), lastAt: now, retired: streak >= RETIRE_AFTER || undefined };
}

export const isDueCard = (c: TacticCard, now: number) => !c.retired && c.due <= now;

/** A mistake of yours in a game worth bringing back: where, the engine's move there and its evaluation. */
export interface GameMistake {
  /** The move's index in the game. */
  ply: number;
  best?: string;
  /** The evaluation with best play, before your move (White's view). */
  before?: Score;
}

/**
 * Your mistakes in a game worth solving again: your crucial swings in the quick review (with what the
 * Stockfish box found deeper, or without a computer review at all), and the moves you marked ? or ??
 * yourself. The engine's move can be missing for a marked one (no engine there yet).
 */
export function gameMistakes(game: StoredGame): GameMistake[] {
  const you = game.userColor;
  const merged = withLiveEvals(game.review, game.liveEvals, game.sans.length + 1);
  const out = new Map<number, GameMistake>();
  if (merged)
    for (const s of crucialSwings(merged, game.timeClass, 8)) if (s.mover === you && s.ply > 0) out.set(s.ply, { ply: s.ply, best: s.best, before: s.scoreBefore });
  for (const [k, a] of Object.entries(game.annotations ?? {})) {
    const ply = Number(k);
    if (!(ply > 0 && ply < game.sans.length) || (ply % 2 === 0 ? 'white' : 'black') !== you || out.has(ply)) continue;
    if (!a.glyphs?.some((g) => g === '?' || g === '??')) continue;
    out.set(ply, { ply, best: merged?.best[ply] ?? undefined, before: merged?.evals[ply] ?? undefined });
  }
  return [...out.values()].sort((x, y) => x.ply - y.ply);
}

/** One of your game's mistakes as a card: the position before your move, "what should you have played?" */
export function gameCard(game: StoredGame, m: GameMistake & { best: string }, now: number): TacticCard {
  const you = game.userColor;
  const id = `g:${game.id}:${m.ply}`;
  return {
    id,
    source: 'game',
    puzzle: {
      game: {
        id: game.id,
        pgn: game.sans.slice(0, m.ply).join(' '),
        players: [
          { color: 'white', name: game.white, rating: game.whiteElo },
          { color: 'black', name: game.black, rating: game.blackElo },
        ],
      },
      puzzle: { id, rating: 0, plays: 0, solution: [m.best], themes: ['your game'], initialPly: m.ply - 1 },
    },
    game: { id: game.id, played: game.sans[m.ply], best: m.before, you, opponent: you === 'white' ? game.black : game.white, playedAt: game.playedAt },
    step: 0,
    streak: 0,
    due: dueAfter(now, REVIEW_DAYS[0]),
    createdAt: now,
  };
}

/**
 * Your mistakes in a game as cards — those the engine's move is known for (Mistakes in your own games
 * show your real blind spots; Nate Solon saves them for spaced review.)
 */
export function gameCards(game: StoredGame, now: number): TacticCard[] {
  return gameMistakes(game)
    .filter((m): m is GameMistake & { best: string } => !!m.best)
    .map((m) => gameCard(game, m, now));
}

/** A win chance lost (0–100, by the side to move) that still counts as a good move in your game's position. */
export const GAME_MOVE_OK_LOSS = 10;
