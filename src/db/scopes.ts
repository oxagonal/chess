import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { updateSettings, useSettings, type AppSettings } from './settings';
import { trainable, unionGraph } from '../lib/chapters';
import type { Color } from '../lib/chess';
import type { RepGraph } from '../lib/graph';
import type { Chapter, Collection, RepMove } from '../lib/types';

/**
 * What you train or measure: every chapter of a color ('white' / 'black'), one chapter (its id), or
 * a repertoire (`set:<id>`, a saved set of chapters). Scopes are always one color, and their graph
 * is the union of their chapters (move ids = card ids; see lib/chapters).
 */
export interface Scope {
  id: string;
  kind: 'color' | 'chapter' | 'repertoire';
  name: string;
  color: Color;
  chapterIds: string[];
  /** Latest change to any of its chapters (a coverage run older than this is stale). */
  updatedAt: number;
  /** Coverage target (1 in N games), if set for this scope. */
  oneInN?: number;
}

export const COLORS: Color[] = ['white', 'black'];
export const repertoireScopeId = (collectionId: string) => `set:${collectionId}`;
export const colorName = (c: Color) => (c === 'white' ? 'White' : 'Black');
/** Training / measuring everything: 'all' is both colors. */
export const scopeIdsFor = (param: string): string[] => (param === 'all' ? COLORS : [param]);

/** Resolve a scope id against the chapters and repertoires (pure). */
export function scopeOf(id: string, chapters: readonly Chapter[], collections: readonly Collection[], s: Pick<AppSettings, 'scopeTargets'>): Scope | undefined {
  const latest = (ids: string[]) => Math.max(0, ...chapters.filter((c) => ids.includes(c.id)).map((c) => c.updatedAt));
  if (id === 'white' || id === 'black') {
    const chapterIds = chapters.filter((c) => c.color === id).map((c) => c.id);
    return { id, kind: 'color', name: `All ${colorName(id)} chapters`, color: id, chapterIds, updatedAt: latest(chapterIds), oneInN: s.scopeTargets?.[id] };
  }
  if (id.startsWith('set:')) {
    const set = collections.find((c) => repertoireScopeId(c.id) === id);
    if (!set) return undefined;
    const chapterIds = set.chapterIds.filter((cid) => chapters.some((c) => c.id === cid && c.color === set.color));
    return { id, kind: 'repertoire', name: set.name, color: set.color, chapterIds, updatedAt: Math.max(set.updatedAt, latest(chapterIds)), oneInN: set.oneInN };
  }
  const ch = chapters.find((c) => c.id === id);
  if (!ch) return undefined;
  return { id, kind: 'chapter', name: ch.name, color: ch.color, chapterIds: [ch.id], updatedAt: ch.updatedAt, oneInN: ch.oneInN };
}

export async function loadScope(id: string): Promise<Scope | undefined> {
  const [chapters, collections, kv] = await Promise.all([db.repertoires.toArray(), db.collections.toArray(), db.kv.get('settings')]);
  const s = (kv?.value as Partial<AppSettings> | undefined) ?? {};
  return scopeOf(id, chapters, collections, { scopeTargets: s.scopeTargets ?? {} });
}

async function movesOf(chapterIds: string[]): Promise<RepMove[]> {
  return chapterIds.length ? db.moves.where('repId').anyOf(chapterIds).toArray() : [];
}

/** A scope and the union graph of its chapters. */
export async function loadScopeGraph(id: string): Promise<{ scope: Scope; graph: RepGraph } | undefined> {
  const scope = await loadScope(id);
  if (!scope) return undefined;
  return { scope, graph: unionGraph(scope.color, trainable(scope.color, await movesOf(scope.chapterIds)), scope.id) };
}

/** Set a scope's coverage target (the colors' live in Settings, a chapter's or repertoire's on itself). */
export async function setScopeTarget(scope: Scope, n: number) {
  if (scope.kind === 'color') {
    const row = await db.kv.get('settings');
    const current = ((row?.value as Partial<AppSettings> | undefined)?.scopeTargets ?? {}) as Record<string, number>;
    await updateSettings({ scopeTargets: { ...current, [scope.id]: n } });
  } else if (scope.kind === 'chapter') await db.repertoires.update(scope.id, { oneInN: n });
  else await db.collections.update(scope.id.slice(4), { oneInN: n });
}

/** Live list of chapters and repertoires. */
export function useChaptersAndSets(): { chapters?: Chapter[]; collections?: Collection[] } {
  const chapters = useLiveQuery(() => db.repertoires.orderBy('color').toArray(), []);
  const collections = useLiveQuery(() => db.collections.toArray(), []);
  return { chapters, collections };
}

/**
 * Live scope and union graph (of trained moves; `all` keeps the ones marked not to train, for the
 * builder). `loading` until both are read; `scope` undefined when it doesn't exist.
 */
export function useScopeGraph(id: string | undefined, opts: { all?: boolean } = {}): { scope?: Scope; graph?: RepGraph; loading: boolean } {
  const { chapters, collections } = useChaptersAndSets();
  const settings = useSettings();
  const scope = useMemo(
    () => (id && chapters && collections && settings.loaded ? scopeOf(id, chapters, collections, settings) : undefined),
    [id, chapters, collections, settings],
  );
  const key = scope?.chapterIds.join(',') ?? '';
  const moves = useLiveQuery(() => (scope ? movesOf(scope.chapterIds) : Promise.resolve(undefined)), [key, !!scope]);
  const all = !!opts.all;
  const graph = useMemo(() => (scope && moves ? unionGraph(scope.color, all ? moves : trainable(scope.color, moves), scope.id) : undefined), [scope, moves, all]);
  return { scope, graph, loading: !chapters || !collections || !settings.loaded || (!!scope && !moves) };
}
