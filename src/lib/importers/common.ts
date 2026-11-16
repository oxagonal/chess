import type { StoredGame } from '../types';

export type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'classical' | 'correspondence';
export const TIME_CLASSES: TimeClass[] = ['bullet', 'blitz', 'rapid', 'classical', 'correspondence'];

export function normalizeTimeClass(raw: string | undefined): TimeClass {
  switch ((raw ?? '').toLowerCase()) {
    case 'ultrabullet':
    case 'bullet':
      return 'bullet';
    case 'blitz':
      return 'blitz';
    case 'rapid':
      return 'rapid';
    case 'classical':
    case 'standard':
      return 'classical';
    case 'daily':
    case 'correspondence':
      return 'correspondence';
    default:
      return 'blitz';
  }
}

export function scoreFor(result: StoredGame['result'], color: 'white' | 'black'): number | undefined {
  if (result === '1/2-1/2') return 0.5;
  if (result === '1-0') return color === 'white' ? 1 : 0;
  if (result === '0-1') return color === 'black' ? 1 : 0;
  return undefined;
}

export interface ImportProgress {
  phase: string;
  games: number;
  detail?: string;
}

export interface ImportOptions {
  username: string;
  since: number; // epoch ms
  timeClasses: TimeClass[];
  signal?: AbortSignal;
  onProgress?: (p: ImportProgress) => void;
  onGames?: (games: StoredGame[]) => Promise<void>;
  /** Optional Lichess personal API token (raises rate limits). */
  token?: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
