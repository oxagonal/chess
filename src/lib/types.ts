import type { GameReview } from './review';
import type { MoveAnnotation, SavedLine } from './annotations';
import type { Color } from './chess';
import type { TimeClass } from './importers/common';

/**
 * A chapter: one color's move tree from the starting position, with its notes — e.g. "Italian" or
 * "Caro-Kann, Exchange". (Stored in the `repertoires` table, its name from before chapters existed;
 * a repertoire is now a `Collection` of chapters.) Moves (`RepMove.repId`) belong to a chapter.
 */
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
  /** Annotation symbols (!?, ±, N …), in the order sortGlyphs gives. */
  glyphs?: string[];
  /**
   * Kept in the chapter but not trained (an example of what not to play, or a line too deep to
   * review): it and whatever only it leads to are left out of training, coverage and game checks.
   */
  noTrain?: boolean;
  /**
   * A sharp line: prepare deeper from here. After this move the coverage goal is DEEPER times
   * stricter (1 in 800 becomes 1 in 8,000), for lines where not knowing a rare move loses at once.
   */
  deeper?: boolean;
  createdAt: number;
  /** Set automatically on every write; the newer copy wins when devices sync. */
  modifiedAt?: number;
}

export type Chapter = Repertoire;

/** A repertoire: a named set of chapters of one color — e.g. what you'll play at a tournament. */
export interface Collection {
  id: string;
  name: string;
  color: Color;
  chapterIds: string[];
  /** Coverage target (1 in N games) for this repertoire. Unset → the app default. */
  oneInN?: number;
  createdAt: number;
  updatedAt: number;
  modifiedAt?: number;
}

/**
 * Spaced-repetition state for one of *your* moves (mirrors ts-fsrs Card, dates as epoch ms). One
 * card per position and move (`cardIdOf`), shared by every chapter of that color that has the move:
 * knowing your move in a position is the same knowledge whichever chapter it's in.
 */
export interface ReviewCard {
  /** `${fromKey}|${san}` (see cardIdOf). */
  id: string;
  /** Your color in this position (= the side to move in fromKey). */
  color: Color;
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
  color: Color;
  /** ts-fsrs Rating: 1 Again, 2 Hard, 3 Good, 4 Easy */
  rating: number;
  state: number;
  reviewedAt: number;
  source: ReviewSource;
  gameId?: string;
  /** Set automatically on every write; the newer copy wins when devices sync. */
  modifiedAt?: number;
}

/** Where a game came from: downloaded from a site, or entered by hand after an over-the-board game. */
export type GameSource = 'lichess' | 'chesscom' | 'otb';

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
  /** Tournament / event name (over-the-board games). */
  event?: string;
  /** Your annotations (symbols, comments), by the move's index in `sans` (as a string key). */
  annotations?: Record<string, MoveAnnotation>;
  /** Lines you tried in the review (side lines off the game's moves), with their own annotations. */
  lines?: SavedLine[];
  /** Your takeaways from the game, written in the review. */
  takeaways?: string;
  /** What the game says to work on (Tactics, Endgames, Time management…). */
  workOn?: string[];
  /** When you marked the review done — a ✓ beside the game on the Games tab. */
  reviewedAt?: number;
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
  /** When it was last played here (explorers built from your or a scouted player's games). */
  lastPlayed?: number;
}

export interface PositionStats {
  /** Games that reached the position. */
  total: number;
  white: number;
  draws: number;
  black: number;
  moves: MoveStat[];
  opening?: { eco: string; name: string };
  /** When the position was last reached (explorers built from games). */
  lastPlayed?: number;
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
  /** Needs an answer only because the line goes deeper here: marked so ('deeper'), or sharp. */
  boost?: 'deeper' | 'sharp';
}

export interface CoverageNode {
  key: string;
  prob: number;
  path: string[];
  myTurn: boolean;
  /** As for gaps: needs a move only because the line goes deeper here. */
  boost?: 'deeper' | 'sharp';
}

export interface CoverageResult {
  /** What it was computed for: a scope id ('white', 'black', a chapter or a repertoire; see db/scopes). */
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
  /**
   * The likeliest holes rarer than the target (a few hundred at most), among the positions looked
   * up — so a chapter can show its real biggest gap even when it's beyond the target.
   */
  minorGaps?: CoverageGap[];
  minorUnfinished?: CoverageNode[];
  /** Positions where the database had no data. */
  noData: string[];
  queried: number;
  /**
   * For each repertoire position: of the games that reach it, the share that stays inside your
   * repertoire until positions rarer than the threshold (1 = fully covered). Missing on old results.
   */
  coverage?: Record<string, number>;
  /**
   * For each repertoire position (only where it isn't 0): of the games that reach it, the share that
   * leave your lines by an opponent move rarer than the threshold before they reach your target depth
   * (where some reply still needs an answer) — counted as covered above, but out of your prep even
   * once every gap is filled: the map's "rare sidelines". Missing on older results (an earlier `rare`
   * field also counted the games past your lines' end, so it isn't used).
   */
  sidelines?: Record<string, number>;
  /**
   * Positions prepared deeper than the goal (only where it isn't 1): the factor the goal is stricter
   * by there (see coverage DEEPER) — after a move marked "prepare deeper". Missing on older results.
   */
  boost?: Record<string, number>;
  /** Version of the analysis that produced this result. */
  algo?: number;
  /** Set automatically on every write; the newer copy wins when devices sync. */
  modifiedAt?: number;
}

/**
 * A Lichess puzzle you did on the Puzzles tab — your history, and the time you spend on tactics (the
 * tactics third of the 1/3 rule). Synced between devices.
 */
export interface PuzzleAttempt {
  /** `${puzzleId}|${startedAt}`. */
  id: string;
  puzzleId: string;
  /** The puzzle's rating on Lichess, and its themes. */
  rating: number;
  themes: string[];
  /** What it was picked by: 'mix', a theme or an opening's key. */
  angle: string;
  /** Solved without a wrong move or showing the solution. */
  win: boolean;
  /** Time spent on it while the app was on screen. */
  ms: number;
  startedAt: number;
  /** Sent to Lichess, whether it counted toward your Lichess puzzle rating, and the change it made. */
  reported?: boolean;
  rated?: boolean;
  ratingDiff?: number;
  modifiedAt?: number;
}

/** A player in the over-the-board games database (gamesdb). */
export interface DbLink {
  id: number;
  name: string;
  games: number;
}

/** Someone you want to prepare against (Builder → Players). */
export interface Player {
  id: string;
  name: string;
  lichess?: string;
  chesscom?: string;
  /** Their games added by hand as PGN (tournament bulletins and the like). */
  pgn?: string;
  /** Names in the over-the-board games database that are this player (often several spellings). */
  dbLinks?: DbLink[];
  /**
   * Their online games to download: played since this date (YYYY-MM-DD), '' = all of them; unset =
   * a year back. (Over-the-board database games always come in full.)
   */
  since?: string;
  /** …in these time controls (unset = the ones you import for yourself). */
  timeClasses?: TimeClass[];
  createdAt: number;
  /** Set automatically on every write; the newer copy wins when devices sync. */
  modifiedAt?: number;
}

/**
 * A downloaded game of a scouted player: a local cache (not synced — it can be downloaded again).
 * `userColor` is the scouted player's color. `id` is `${playerId}|${gameId}`.
 */
export interface PlayerGame extends StoredGame {
  playerId: string;
  gameId: string;
}

