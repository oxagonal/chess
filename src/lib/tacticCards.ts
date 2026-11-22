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
import type { Score } from './review';

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

/**
 * Your crucial mistakes in a game (the big swings of the quick review, by your side) as cards: the
 * position before your move, "what should you have played?" — back the next day, like a missed puzzle.
 * Mistakes in your own games show your real blind spots (Nate Solon saves them for spaced review).
 */
export function gameCards(game: StoredGame, now: number): TacticCard[] {
  const review = game.review;
  if (!review) return [];
  const you = game.userColor;
  return crucialSwings(review, game.timeClass, 8)
    .filter((s) => s.mover === you && s.best && s.ply > 0)
    .map((s) => {
      const id = `g:${game.id}:${s.ply}`;
      return {
        id,
        source: 'game' as const,
        puzzle: {
          game: {
            id: game.id,
            pgn: game.sans.slice(0, s.ply).join(' '),
            players: [
              { color: 'white' as const, name: game.white, rating: game.whiteElo },
              { color: 'black' as const, name: game.black, rating: game.blackElo },
            ],
          },
          puzzle: { id, rating: 0, plays: 0, solution: [s.best!], themes: ['your game'], initialPly: s.ply - 1 },
        },
        game: { id: game.id, played: game.sans[s.ply], best: s.scoreBefore, you, opponent: you === 'white' ? game.black : game.white, playedAt: game.playedAt },
        step: 0,
        streak: 0,
        due: dueAfter(now, REVIEW_DAYS[0]),
        createdAt: now,
      };
    });
}

/** A win chance lost (0–100, by the side to move) that still counts as a good move in your game's position. */
export const GAME_MOVE_OK_LOSS = 10;
