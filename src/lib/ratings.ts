/** Lichess opening-explorer rating buckets: each value is the lower bound of a band. */
export const LICHESS_BANDS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500] as const;
export type LichessBand = (typeof LICHESS_BANDS)[number];

export function bandLabel(b: number): string {
  const i = LICHESS_BANDS.indexOf(b as LichessBand);
  const next = LICHESS_BANDS[i + 1];
  if (b === 0) return '<1000';
  return next ? `${b}–${next - 1}` : `${b}+`;
}

/**
 * Explorer bands for a Lichess rating: the band containing it plus one below and one above, since
 * your opponents span a range and a single band is noisy (a 1650 player gets 1400–2199). At the
 * ends of the scale you get the three nearest bands.
 */
export function bandsForRating(rating: number): number[] {
  let i = 0;
  for (let j = 0; j < LICHESS_BANDS.length; j++) if (rating >= LICHESS_BANDS[j]) i = j;
  const start = Math.max(0, Math.min(i - 1, LICHESS_BANDS.length - 3));
  return LICHESS_BANDS.slice(start, start + 3);
}

export type RatingPool = 'lichess' | 'chesscom-blitz' | 'chesscom-rapid' | 'chesscom-bullet';

/**
 * Rough Chess.com → Lichess conversion (Lichess ratings run higher, most at lower levels).
 * Fitted to commonly cited community comparison tables; good to about ±100, which is finer than
 * the explorer's 200-point bands anyway. You can always pick bands manually in Settings.
 */
export function toLichessRating(rating: number, pool: RatingPool): number {
  switch (pool) {
    case 'lichess':
      return rating;
    case 'chesscom-blitz':
    case 'chesscom-bullet':
      return Math.round(0.75 * rating + 650);
    case 'chesscom-rapid':
      return Math.round(0.6 * rating + 920);
  }
}

export const POOL_LABEL: Record<RatingPool, string> = {
  lichess: 'Lichess',
  'chesscom-blitz': 'Chess.com blitz',
  'chesscom-rapid': 'Chess.com rapid',
  'chesscom-bullet': 'Chess.com bullet',
};
