import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { patchSettings } from '../lib/settingsMerge';
import { DEFAULT_STOP_RULE, type StopRule } from '../lib/stopRule';
import type { ProbabilitySource, StudyTopic, Third } from '../lib/types';
import type { RatingPool } from '../lib/ratings';
import type { TimeClass } from '../lib/importers/common';
import type { GameRange } from '../lib/gameRange';
import type { Repertoire } from '../lib/types';

/** Columns the explorer table can show (chosen with its ⚙ button). */
export type ExplorerColumn = 'games' | 'share' | 'reach' | 'result' | 'eval' | 'last' | 'prepared';

export interface AppSettings {
  lichessUsername: string;
  chesscomUsername: string;
  /** Your name as written in over-the-board PGNs (tells which side you played). */
  otbName: string;
  /**
   * Lichess token from "Connect Lichess" (or a pasted personal token). Required by the Lichess
   * opening explorer; also speeds up game downloads.
   */
  lichessToken: string;
  /** Username of the connected Lichess account ('' when not connected or unknown). */
  lichessAccount: string;
  /** Permissions the Lichess token was granted (space-separated, e.g. "study:read"); '' for none. */
  lichessScopes: string;
  /** ISO date (YYYY-MM-DD): only import games played after this. */
  importSince: string;
  importTimeClasses: TimeClass[];

  rating: number;
  ratingPool: RatingPool;
  bandsMode: 'auto' | 'manual';
  manualBands: number[];
  /** Lichess explorer speeds used for probabilities. */
  speeds: string[];
  probabilitySource: ProbabilitySource;
  /**
   * Default coverage target (1 in N games) for repertoires that haven't set their own. Each
   * repertoire's target is set on the Coverage page — use repTarget() rather than reading this.
   */
  oneInN: number;
  /** Coverage targets of "all White" / "all Black" ('white' / 'black' → N), set on the Coverage page. */
  scopeTargets: Record<string, number>;

  newPerDay: number;
  requestRetention: number;
  maxIntervalDays: number;
  /** Only review cards whose position is reached at least once in N games (needs a coverage run). */
  trainOnlyLikely: boolean;
  autoPlayDelayMs: number;
  /** Trainer: go straight to the next line instead of waiting for Continue (still waits after a miss). */
  trainAutoNext: boolean;
  /**
   * Trainer "Skip repeats": moves you've already played in this session are played for you, the
   * move order with the most new positions is chosen, and lines carry on into what you haven't played.
   */
  trainSkipRepeats: boolean;
  /**
   * Trainer: at the end of a session (learn, review or drill) the positions you missed come back (random order); with
   * this on, again and again until you get every one of them right in a row.
   */
  trainRepeatUntilRight: boolean;
  /**
   * Trainer's answer timer, in seconds (0 = off): in reviews and drills a correct answer within it is
   * Good and slower Hard; Easy only when quick on a move in regular reviews you didn't miss last time
   * (see lib/srs gradeForAnswer and easyAllowed).
   */
  trainAnswerSeconds: number;
  /** Puzzles: count them toward your Lichess puzzle rating (needs Lichess connected with puzzle permissions). */
  puzzleRated: boolean;
  /** Puzzles: what they're picked by ('mix', a theme or an opening's key) and how hard, around your rating. */
  puzzleAngle: string;
  puzzleDifficulty: 'easiest' | 'easier' | 'normal' | 'harder' | 'hardest';
  /** Puzzles: write the whole solution first (with the opponent's other replies) before it's checked. */
  puzzleWrite: boolean;
  /** Touch screens: draw arrows and circles with two fingers (one held on the board, the other drawing). */
  twoFingerDraw: boolean;
  /** Puzzles: how many in a block, decided before you start (then a breather and your misses). */
  puzzleBlock: number;
  /** Puzzles, writing the solution: show your line as numbered arrows on the still board. */
  puzzleArrows: boolean;
  /** Puzzles: minutes per puzzle you aim for (a soft budget — the difficulty follows from it). */
  puzzleBudgetMin: number;
  /** Training: at a line's end, recall its plan before it's shown (and wait for Continue). */
  trainRecallPlans: boolean;
  /** Phones: the main buttons of a bottom row on the right, for your right thumb. */
  thumbRight: boolean;
  /** Builder: save every move played on the board straight into the repertoire. */
  builderAutoAdd: boolean;
  /** Show Stockfish evaluations next to each move in the builder. */
  engineEnabled: boolean;
  engineDepth: number;
  /** How many best lines the Stockfish box shows (1–5). */
  engineLines: number;
  /** The same three on phones, set apart (fewer lines fit above a phone's board). */
  phoneEngineEnabled: boolean;
  phoneEngineDepth: number;
  phoneEngineLines: number;
  /** Builder moves panel: a scoresheet with side lines, or inline notation (one block of text) — like a Lichess study. */
  builderNav: 'scoresheet' | 'inline';
  /** Which of your games count everywhere (Games, Insights, Home, "My games" explorer, coverage from your opponents). */
  gameRange: GameRange;
  /**
   * Which of your games count as opponent statistics (coverage from your own opponents, the "My
   * games" explorer tab). Longer than gameRange by default: probabilities need lots of games.
   */
  opponentRange: GameRange;
  /** Explorer table: which columns are shown (synced with your other settings). */
  explorerColumns: ExplorerColumn[];
  /** Game review: "work on" tags you've added yourself (offered after the built-in ones). */
  workOnTags: string[];
  /**
   * Each chapter also covers the positions reached in at least 1 in this many of its own games (the
   * games reaching its opening), where that goes deeper than the overall goal; 0 = off.
   */
  chapterOneInN: number;
  /** Plan: chess training a week, in minutes (split into thirds: tactics, your games, study). */
  weeklyMinutes: number;
  /** Plan: what the study third works on now — one thing at a time. */
  studyFocus: StudyTopic;
  /** Plan: your week's training slots. */
  planSlots: PlanSlot[];
  /** Plan: the speeds whose games count as training games (time spent playing). */
  trainingSpeeds: string[];
  /**
   * When to stop a playing session (games, losses in a row, points down, a loss on time): Tabiya's
   * tilt flag, and the phone check that runs when you open the Chess.com app.
   */
  stopRule: StopRule;
  /** The secret gist the phone check reads your stop rule from (in your GitHub account, via sync). */
  stopGist?: string;
}

/** A slot in your weekly plan: a day, a time, a third and the exact task (Studer: plan it beforehand). */
export interface PlanSlot {
  id: string;
  /** 0 = Monday … 6 = Sunday. */
  day: number;
  /** "18:30". */
  time: string;
  minutes: number;
  third: Third;
  task: string;
}

function yearAgo(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

export const DEFAULT_SETTINGS: AppSettings = {
  lichessUsername: '',
  chesscomUsername: '',
  otbName: '',
  lichessToken: '',
  lichessAccount: '',
  lichessScopes: '',
  importSince: yearAgo(),
  importTimeClasses: ['blitz', 'rapid', 'classical', 'correspondence'],
  rating: 1500,
  ratingPool: 'lichess',
  bandsMode: 'auto',
  manualBands: [1400, 1600],
  speeds: ['blitz', 'rapid', 'classical'],
  probabilitySource: 'lichess',
  oneInN: 200,
  scopeTargets: {},
  newPerDay: 15,
  requestRetention: 0.9,
  maxIntervalDays: 365,
  trainOnlyLikely: false,
  autoPlayDelayMs: 350,
  trainAutoNext: false,
  trainSkipRepeats: false,
  trainRepeatUntilRight: false,
  trainAnswerSeconds: 10,
  puzzleRated: true,
  puzzleAngle: 'mix',
  puzzleDifficulty: 'normal',
  puzzleWrite: true,
  twoFingerDraw: true,
  puzzleBlock: 10,
  puzzleArrows: true,
  puzzleBudgetMin: 5,
  trainRecallPlans: true,
  thumbRight: false,
  builderAutoAdd: false,
  engineEnabled: true,
  engineDepth: 18,
  engineLines: 3,
  phoneEngineEnabled: true,
  phoneEngineDepth: 18,
  phoneEngineLines: 2,
  builderNav: 'scoresheet',
  gameRange: '1m',
  opponentRange: '1y',
  explorerColumns: ['games', 'share', 'reach', 'result', 'last'],
  workOnTags: [],
  chapterOneInN: 100,
  weeklyMinutes: 420,
  studyFocus: 'openings',
  planSlots: [],
  stopRule: DEFAULT_STOP_RULE,
  trainingSpeeds: ['blitz', 'rapid', 'classical'],
};

const KEY = 'settings';

/** Range of the "study positions seen in at least 1 in N games" slider. */
export const ONE_IN_N_MIN = 100;
export const ONE_IN_N_MAX = 1000;

/** Named depths, matching the scale Chessbook uses. */
export const ONE_IN_N_PRESETS: { n: number; label: string }[] = [
  { n: 150, label: 'Standard' },
  { n: 200, label: 'Advanced' },
  { n: 300, label: 'Tournament ready' },
  { n: 800, label: 'Overkill' },
];

const clampN = (n: number) => Math.min(ONE_IN_N_MAX, Math.max(ONE_IN_N_MIN, Math.round(n)));

/** A repertoire's coverage target N ("positions reached in at least 1 in N games"). */
export function repTarget(rep: Pick<Repertoire, 'oneInN'> | undefined, s: Pick<AppSettings, 'oneInN'>): number {
  return clampN(rep?.oneInN ?? s.oneInN);
}

export async function getSettings(): Promise<AppSettings> {
  const row = await db.kv.get(KEY);
  const s = { ...DEFAULT_SETTINGS, ...((row?.value as Partial<AppSettings>) ?? {}) };
  // 1 in 200 is the shallowest depth on offer.
  s.oneInN = Math.min(ONE_IN_N_MAX, Math.max(ONE_IN_N_MIN, s.oneInN));
  return s;
}

/** Stores only what you changed, so improved defaults still reach settings you never touched. */
export async function updateSettings(patch: Partial<AppSettings>): Promise<void> {
  await db.transaction('rw', db.kv, async () => {
    const row = await db.kv.get(KEY);
    // With when each setting changed: devices merge settings one by one (src/lib/settingsMerge.ts).
    await db.kv.put({ key: KEY, value: patchSettings(row?.value as Record<string, unknown> | undefined, row?.modifiedAt, patch, Date.now()) });
  });
}

/** Live settings. `loaded` is false until the first read completes. */
export function useSettings(): AppSettings & { loaded: boolean } {
  const s = useLiveQuery(getSettings, []);
  return s ? { ...s, loaded: true } : { ...DEFAULT_SETTINGS, loaded: false };
}
