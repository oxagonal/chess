import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import type { ProbabilitySource } from '../lib/types';
import type { RatingPool } from '../lib/ratings';
import type { TimeClass } from '../lib/importers/common';
import type { GameRange } from '../lib/gameRange';

export interface AppSettings {
  lichessUsername: string;
  chesscomUsername: string;
  /**
   * Lichess token from "Connect Lichess" (or a pasted personal token). Required by the Lichess
   * opening explorer; also speeds up game downloads.
   */
  lichessToken: string;
  /** Username of the connected Lichess account ('' when not connected or unknown). */
  lichessAccount: string;
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
  /** Study positions you'd meet at least once in N games. */
  oneInN: number;

  newPerDay: number;
  requestRetention: number;
  maxIntervalDays: number;
  /** Only review cards whose position is reached at least once in N games (needs a coverage run). */
  trainOnlyLikely: boolean;
  autoPlayDelayMs: number;
  /** Builder: save every move played on the board straight into the repertoire. */
  builderAutoAdd: boolean;
  /** Show Stockfish evaluations next to each move in the builder. */
  engineEnabled: boolean;
  engineDepth: number;
  /** Which of your games count everywhere (Games, Insights, Home, "My games" explorer, coverage from your opponents). */
  gameRange: GameRange;
  /**
   * Which of your games count as opponent statistics (coverage from your own opponents, the "My
   * games" explorer tab). Longer than gameRange by default: probabilities need lots of games.
   */
  opponentRange: GameRange;
}

function yearAgo(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

export const DEFAULT_SETTINGS: AppSettings = {
  lichessUsername: '',
  chesscomUsername: '',
  lichessToken: '',
  lichessAccount: '',
  importSince: yearAgo(),
  importTimeClasses: ['blitz', 'rapid', 'classical', 'correspondence'],
  rating: 1500,
  ratingPool: 'lichess',
  bandsMode: 'auto',
  manualBands: [1400, 1600],
  speeds: ['blitz', 'rapid', 'classical'],
  probabilitySource: 'lichess',
  oneInN: 200,
  newPerDay: 15,
  requestRetention: 0.9,
  maxIntervalDays: 365,
  trainOnlyLikely: false,
  autoPlayDelayMs: 350,
  builderAutoAdd: false,
  engineEnabled: true,
  engineDepth: 18,
  gameRange: '1m',
  opponentRange: '1y',
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
    await db.kv.put({ key: KEY, value: { ...((row?.value as Partial<AppSettings>) ?? {}), ...patch } });
  });
}

/** Live settings. `loaded` is false until the first read completes. */
export function useSettings(): AppSettings & { loaded: boolean } {
  const s = useLiveQuery(getSettings, []);
  return s ? { ...s, loaded: true } : { ...DEFAULT_SETTINGS, loaded: false };
}
