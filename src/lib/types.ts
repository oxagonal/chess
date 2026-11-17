import type { GameReview } from './review';
import type { Color } from './chess';

export interface Repertoire {
  id: string;
  name: string;
  color: Color;
  createdAt: number;
  updatedAt: number;
  /** Coverage target: study positions reached in at least 1 in N games. Unset → the app default. */
  oneInN?: number;
  /** Set automatically on every write; the newer copy wins when devices sync. */
  modifiedAt?: number;
}

/** An edge in a repertoire's position graph. */
export interface RepMove {
  /** `${repId}|${fromKey}|${san}` */
  id: string;
  repId: string;
  fromKey: string;
  toKey: string;
  san: string;
  uci: string;
  /** True if this move is played by the repertoire's side (i.e. it is something you must remember). */
  mine: boolean;
  comment?: string;
  createdAt: number;
  /** Set automatically on every write; the newer copy wins when devices sync. */
  modifiedAt?: number;
}

/** Spaced-repetition state for one of *your* moves (mirrors ts-fsrs Card, dates as epoch ms). */
export interface ReviewCard {
  id: string; // same as RepMove.id
  repId: string;
  fromKey: string;
  san: string;
  due: number;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  /** 0 New, 1 Learning, 2 Review, 3 Relearning (ts-fsrs State). */
  state: number;
  lastReview?: number;
  createdAt: number;
  /** Set automatically on every write; the newer copy wins when devices sync. */
  modifiedAt?: number;
}

export type ReviewSource = 'learn' | 'review' | 'game';

export interface ReviewLogEntry {
  id?: number;
  cardId: string;
  repId: string;
  /** ts-fsrs Rating: 1 Again, 2 Hard, 3 Good, 4 Easy */
  rating: number;
  state: number;
  reviewedAt: number;
  source: ReviewSource;
  gameId?: string;
  /** Set automatically on every write; the newer copy wins when devices sync. */
  modifiedAt?: number;
}

export type GameSource = 'lichess' | 'chesscom';

export interface StoredGame {
  id: string; // `${source}:${nativeId}`
  source: GameSource;
  account: string; // lowercase username the game was imported for
  url: string;
  white: string;
  black: string;
  whiteElo?: number;
  blackElo?: number;
  userColor: Color;
  result: '1-0' | '0-1' | '1/2-1/2' | '*';
  /** 1 win, 0.5 draw, 0 loss from the user's perspective. */
  userScore?: number;
  timeClass: string; // bullet | blitz | rapid | classical | daily | correspondence
  rated: boolean;
  playedAt: number;
  eco?: string;
  opening?: string;
  sans: string[];
  /** Remaining clock in seconds after each ply, when available (for future game review). */
  clocks?: number[];
  termination?: string;
  /** Set once forgotten-prep penalties from this game were applied to review cards. */
  prepApplied?: boolean;
  /** Computer review (Stockfish eval of every position), once run. */
  review?: GameReview;
  /** Set automatically on every write; the newer copy wins when devices sync. */
  modifiedAt?: number;
}

export interface MoveStat {
  san: string;
  uci: string;
  white: number;
  draws: number;
  black: number;
  averageRating?: number;
}

export interface PositionStats {
  /** Games that reached the position. */
  total: number;
  white: number;
  draws: number;
  black: number;
  moves: MoveStat[];
  opening?: { eco: string; name: string };
}

export function moveGames(m: MoveStat): number {
  return m.white + m.draws + m.black;
}

export type ProbabilitySource = 'lichess' | 'masters' | 'mygames';

export interface CoverageGap {
  fromKey: string;
  san: string;
  uci: string;
  /** Probability (0..1) that a game reaches the position and the opponent plays this move. */
  prob: number;
  /** Share of games in the position where this move is played. */
  freq: number;
  games: number;
  path: string[];
}

export interface CoverageNode {
  key: string;
  prob: number;
  path: string[];
  myTurn: boolean;
}

export interface CoverageResult {
  repId: string;
  computedAt: number;
  threshold: number; // 1/N
  source: ProbabilitySource;
  paramsLabel: string;
  /** Reach probability for every repertoire position whose probability was determined. */
  probs: Record<string, number>;
  gaps: CoverageGap[];
  /** Your-move positions reached ≥ threshold with no prepared move. */
  unfinished: CoverageNode[];
  /** Positions where the database had no data. */
  noData: string[];
  queried: number;
  /**
   * For each repertoire position: of the games that reach it, the share that stays inside your
   * repertoire until positions rarer than the threshold (1 = fully covered). Missing on old results.
   */
  coverage?: Record<string, number>;
  /** Version of the analysis that produced this result. */
  algo?: number;
  /** Set automatically on every write; the newer copy wins when devices sync. */
  modifiedAt?: number;
}
