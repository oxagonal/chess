/**
 * Which of your games count. Repertoires change, so older games can flag "forgotten prep" in lines
 * you no longer play. One setting, used everywhere your games are shown or counted.
 */
import type { StoredGame } from './types';

export type GameRange = '7d' | '1m' | '3m' | '6m' | '1y' | 'all';

export const GAME_RANGES: { value: GameRange; label: string; days?: number }[] = [
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '1m', label: 'Last month', days: 31 },
  { value: '3m', label: 'Last 3 months', days: 91 },
  { value: '6m', label: 'Last 6 months', days: 182 },
  { value: '1y', label: 'Last year', days: 365 },
  { value: 'all', label: 'All time' },
];

export function rangeCutoff(range: GameRange, now = Date.now()): number {
  const days = GAME_RANGES.find((r) => r.value === range)?.days;
  return days ? now - days * 86_400_000 : 0;
}

export function gamesInRange<T extends Pick<StoredGame, 'playedAt'>>(games: T[], range: GameRange, now = Date.now()): T[] {
  const cutoff = rangeCutoff(range, now);
  return cutoff ? games.filter((g) => g.playedAt >= cutoff) : games;
}

export function rangeLabel(range: GameRange): string {
  return GAME_RANGES.find((r) => r.value === range)?.label ?? 'All time';
}
