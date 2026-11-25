/**
 * Is a position sharp — do only one or two of your moves hold (lib/sharp)? From Lichess's cloud
 * analysis when it has the position, else (where allowed) a quick Stockfish search; answers are kept
 * (engineCache) so the next coverage run doesn't ask again.
 */
import { db, type EngineCacheRow } from '../db/db';
import { legalDests, posFromFen, turnOfKey } from '../lib/chess';
import { isSharp, movesThatHold, QUIET_MOVES } from '../lib/sharp';
import { analyseOnce, cloudHasNot, cloudLines } from './engine';

/** How long a cached answer is trusted. */
const MAX_AGE = 90 * 86400_000;
/**
 * "The cloud can't tell" is kept too (as no lines), for less long — the cloud learns positions — so
 * the next run, after a reload, doesn't ask Lichess about every such position again, one by one.
 */
const UNKNOWN_MAX_AGE = 14 * 86400_000;
/** The Stockfish search when the cloud doesn't know a position: quick, enough to tell 3 moves apart. */
const LOCAL_DEPTH = 14;
/** At most this many Stockfish searches per coverage run (each takes a second or two). */
export const LOCAL_PER_RUN = 60;

type Lines = EngineCacheRow['lines'];
const memory = new Map<string, Lines | null>();

export function legalCount(key: string): number {
  const pos = posFromFen(key);
  if (!pos) return 0;
  let n = 0;
  for (const dests of legalDests(pos).values()) n += dests.length;
  return n;
}

/** The engine's best lines in a position (first move and evaluation), if it can tell 3 moves apart. */
export async function engineLines(key: string, opts: { local?: boolean; signal?: AbortSignal } = {}): Promise<Lines | undefined> {
  const known = memory.get(key);
  if (known) return known;
  // The cloud can't tell (asked already): only Stockfish might, where it's allowed.
  if (known === null && !opts.local) return undefined;
  const row = await db.engineCache.get(key);
  const unknownToCloud = !!row && !row.lines.length && Date.now() - row.fetchedAt < UNKNOWN_MAX_AGE;
  if (row && row.lines.length && Date.now() - row.fetchedAt < MAX_AGE) {
    memory.set(key, row.lines);
    return row.lines;
  }
  if (unknownToCloud && !opts.local) {
    memory.set(key, null);
    return undefined;
  }
  const legal = legalCount(key);
  const enough = (lines: Lines) => lines.length >= Math.min(QUIET_MOVES, legal) || isSharp(lines.map(asLine), turnOfKey(key), legal) !== undefined;
  const keep = async (lines: Lines, depth: number) => {
    memory.set(key, lines);
    await db.engineCache.put({ key, fetchedAt: Date.now(), lines, depth });
    return lines;
  };
  const cloud = unknownToCloud ? undefined : await cloudLines(key, opts.signal).catch(() => undefined);
  if (cloud?.length) {
    const lines = cloud.map((l) => ({ uci: l.moves[0], cp: l.eval.cp, mate: l.eval.mate }));
    if (enough(lines)) return keep(lines, cloud[0].eval.depth);
  }
  // The cloud doesn't have it (or not enough of it): remember that, not a passing failure (rate limit…).
  if (!unknownToCloud && (cloudHasNot(key) || !!cloud?.length)) await db.engineCache.put({ key, fetchedAt: Date.now(), lines: [], depth: 0 });
  if (!opts.local || opts.signal?.aborted) {
    if (cloudHasNot(key) || cloud?.length) memory.set(key, null);
    return undefined;
  }
  const local = await analyseOnce(key, LOCAL_DEPTH, QUIET_MOVES);
  if (!local.length) return undefined;
  return keep(
    local.map((l) => ({ uci: l.moves[0], cp: l.eval.cp, mate: l.eval.mate })),
    local[0].eval.depth,
  );
}

const asLine = (l: Lines[number]) => ({ eval: { cp: l.cp, mate: l.mate } });

/**
 * After the opponent's reply `uci` (from `fromKey` to `toKey`): how many of your moves hold — Lichess's
 * cloud analysis, else (with `local`) Stockfish. An obvious recapture (taking back on the square they
 * just took on) counts as quiet: it isn't a hard move to find. Undefined when it can't tell.
 */
export async function holdingAfter(fromKey: string, uci: string, toKey: string, opts: { local?: boolean; signal?: AbortSignal } = {}): Promise<number | undefined> {
  const lines = await engineLines(toKey, opts);
  if (!lines?.length) return undefined;
  const legal = legalCount(toKey);
  const n = movesThatHold(lines.map(asLine), turnOfKey(toKey), legal);
  if (n === undefined || n >= QUIET_MOVES) return n;
  const to = uci.slice(2, 4);
  const captured = !!posFromFen(fromKey)?.board.get(squareIndex(to));
  const best = [...lines].sort((a, b) => score(b, toKey) - score(a, toKey))[0];
  return captured && best.uci.slice(2, 4) === to ? QUIET_MOVES : n;
}

/** Whether something is already known about a position (no engine work needed to answer). */
async function known(key: string): Promise<boolean> {
  if (memory.get(key)) return true;
  const row = await db.engineCache.get(key);
  return !!row?.lines.length;
}

/**
 * For the coverage run: is the position after the opponent's reply sharp for you (holdingAfter)?
 * Stockfish is asked about at most `localBudget` positions per run.
 */
export function sharpProvider(opts: { local: boolean; signal?: AbortSignal; localBudget?: number }) {
  let budget = opts.localBudget ?? LOCAL_PER_RUN;
  return async (fromKey: string, uci: string, toKey: string): Promise<boolean | undefined> => {
    const cached = await known(toKey);
    const local = opts.local && (cached || budget > 0);
    if (!cached && local) budget--;
    const n = await holdingAfter(fromKey, uci, toKey, { local, signal: opts.signal });
    return n === undefined ? undefined : n < QUIET_MOVES;
  };
}

const score = (l: Lines[number], key: string) => {
  const white = l.mate !== undefined ? (l.mate > 0 ? 100000 - l.mate : -100000 - l.mate) : (l.cp ?? 0);
  return turnOfKey(key) === 'white' ? white : -white;
};

function squareIndex(name: string): number {
  return (name.charCodeAt(1) - 49) * 8 + (name.charCodeAt(0) - 97);
}
