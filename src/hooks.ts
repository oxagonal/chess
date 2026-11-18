import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db/db';
import { RepGraph } from './lib/graph';
import type { Repertoire, RepMove } from './lib/types';
import { unionGraph } from './lib/chapters';
import { COLORS, colorName } from './db/scopes';
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

/**
 * Each color's chapters as one union graph (scope 'white' / 'black'), for checking games against
 * your prep: a game is in your prep if any chapter of your color has it.
 */
export function useAllGraphs(): RepWithGraph[] | undefined {
  const reps = useLiveQuery(() => db.repertoires.toArray(), []);
  const moves = useLiveQuery(() => db.moves.toArray(), []);
  return useMemo(() => {
    if (!reps || !moves) return undefined;
    const colorOf = new Map(reps.map((r) => [r.id, r.color]));
    return COLORS.map((color) => ({
      rep: { id: color, name: `All ${colorName(color)} chapters`, color },
      graph: unionGraph(color, moves.filter((m: RepMove) => colorOf.get(m.repId) === color)),
    }));
  }, [reps, moves]);
}

/** Each chapter's own graph, by chapter id (for per-chapter counts; cardsOf gives its cards). */
export function useChapterGraphs(): Map<string, RepGraph> | undefined {
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
    return new Map(reps.map((r) => [r.id, new RepGraph(r.color, by.get(r.id) ?? [])]));
  }, [reps, moves]);
}

/** Every card (filter to a graph's with cardsOf). */
export function useCards() {
  return useLiveQuery(() => db.cards.toArray(), []);
}

/** The stored coverage run of a scope ('white', 'black', a chapter or `set:<id>`). */
export function useCoverage(scopeId: string | undefined) {
  return useLiveQuery(() => (scopeId ? db.coverage.get(scopeId) : undefined), [scopeId]);
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

/** Whether a CSS media query matches, kept up to date (e.g. the phone layout: PHONE_QUERY). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/** Same breakpoint as the phone rules in styles.css. */
export const PHONE_QUERY = '(max-width: 700px)';
