import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db/db';
import { RepGraph } from './lib/graph';
import type { Repertoire, RepMove } from './lib/types';
import type { RepWithGraph } from './lib/prep';
import { useSettings } from './db/settings';
import { rangeCutoff } from './lib/gameRange';

export function useRepertoires(): Repertoire[] | undefined {
  return useLiveQuery(() => db.repertoires.orderBy('color').toArray(), []);
}

export function useRepGraph(repId: string | undefined) {
  // null = loaded but missing, undefined = still loading
  const found = useLiveQuery(async () => (repId ? ((await db.repertoires.get(repId)) ?? null) : null), [repId]);
  const moves = useLiveQuery(() => (repId ? db.moves.where('repId').equals(repId).toArray() : []), [repId]);
  const rep = found ?? undefined;
  const graph = useMemo(() => (rep && moves ? new RepGraph(rep.color, moves) : undefined), [rep, moves]);
  return { rep, graph, loading: found === undefined || moves === undefined };
}

/** Every repertoire with its graph (used for prep analysis of games). */
export function useAllGraphs(): RepWithGraph[] | undefined {
  const reps = useLiveQuery(() => db.repertoires.toArray(), []);
  const moves = useLiveQuery(() => db.moves.toArray(), []);
  return useMemo(() => {
    if (!reps || !moves) return undefined;
    const by = new Map<string, RepMove[]>();
    for (const m of moves) {
      const arr = by.get(m.repId);
      if (arr) arr.push(m);
      else by.set(m.repId, [m]);
    }
    return reps.map((rep) => ({ rep, graph: new RepGraph(rep.color, by.get(rep.id) ?? []) }));
  }, [reps, moves]);
}

export function useCards(repId?: string) {
  return useLiveQuery(() => (repId ? db.cards.where('repId').equals(repId).toArray() : db.cards.toArray()), [repId]);
}

export function useCoverage(repId: string | undefined) {
  return useLiveQuery(() => (repId ? db.coverage.get(repId) : undefined), [repId]);
}

export function useGames() {
  return useLiveQuery(() => db.games.orderBy('playedAt').reverse().toArray(), []);
}

/** Your games within the shared date filter (Settings → gameRange), newest first. */
export function useRecentGames(which: 'gameRange' | 'opponentRange' = 'gameRange') {
  const s = useSettings();
  const range = s[which];
  return useLiveQuery(
    async () => (s.loaded ? db.games.where('playedAt').aboveOrEqual(rangeCutoff(range)).reverse().sortBy('playedAt') : undefined),
    [range, s.loaded],
  );
}

export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** How many new cards were introduced today (learn sessions), to honour the daily limit. */
export function useLearnedToday() {
  return useLiveQuery(async () => {
    const logs = await db.reviewLog.where('reviewedAt').aboveOrEqual(startOfToday()).toArray();
    return new Set(logs.filter((l) => l.state === 0).map((l) => l.cardId)).size;
  }, []);
}
