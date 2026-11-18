/**
 * Compare real games against your repertoire to find where you (or your opponent) left the book.
 */
import { playSan, START_KEY, startPos, turnOfKey, type Color } from './chess';
import type { Position } from 'chessops/chess';
import type { RepGraph } from './graph';
import type { StoredGame } from './types';

export type PrepKind =
  | 'no-repertoire' // you have no repertoire for this color
  | 'other-opening' // your very first move was not in any repertoire
  | 'you-deviated' // you were in book with a prepared move and played something else  ← forgotten prep
  | 'opponent-deviated' // opponent played a move your repertoire does not cover  ← gap / surprise
  | 'end-of-prep' // the line in your repertoire ended
  | 'still-in-book'; // the game ended while still in book

export interface PrepResult {
  gameId: string;
  repId?: string;
  kind: PrepKind;
  /** Number of plies played inside the repertoire. */
  bookPlies: number;
  /** Ply index (0-based) of the first move outside the repertoire. */
  ply?: number;
  /** Position before the deviating move. */
  key?: string;
  played?: string;
  playedUci?: string;
  /** Your prepared move(s) at `key` (for you-deviated). */
  expected?: string[];
  /**
   * Times the game came back into your prep after leaving it (usually by transposition): from the
   * move that brought it back to where it left again — or the end of the game.
   */
  rejoins?: Rejoin[];
}

export interface Rejoin {
  /** The move (0-based ply) after which the game is in your prep again. */
  ply: number;
  key: string;
  /** Plies played in prep from there (moves ply+1 … ply+inBook). */
  inBook: number;
  /** How it left the prep again (absent: the game ended in it). */
  left?: { kind: 'you-deviated' | 'opponent-deviated' | 'end-of-prep'; ply: number; key: string; played: string; expected?: string[] };
}

/** What a game is checked against: in the app, each color's chapters as one union graph. */
export interface RepWithGraph {
  rep: { id: string; name: string; color: Color };
  graph: RepGraph;
}

/** Every position of the game: keys[i] = before move i (keys[n] = after the last move). */
function replayKeys(sans: readonly string[]): { keys: string[]; played: { san: string; uci: string }[] } {
  let pos: Position = startPos();
  const keys = [START_KEY];
  const played: { san: string; uci: string }[] = [];
  for (const s of sans) {
    const r = playSan(pos, s);
    if (!r) break;
    played.push({ san: r.san, uci: r.uci });
    keys.push(r.key);
    pos = r.pos;
  }
  return { keys, played };
}

type Exit = { kind: 'you-deviated' | 'opponent-deviated' | 'end-of-prep'; ply: number; key: string; played: string; playedUci: string; expected?: string[] };

/** Follow the game in prep from ply `from` until it leaves (undefined: it never does). */
function followFrom(graph: RepGraph, keys: string[], played: { san: string; uci: string }[], from: number): Exit | undefined {
  for (let i = from; i < played.length; i++) {
    const key = keys[i];
    const edges = graph.childrenOf(key);
    const base = { ply: i, key, played: played[i].san, playedUci: played[i].uci };
    if (!edges.length) return { kind: 'end-of-prep', ...base };
    // A move into a position your prep reaches another way is still in book (a transposition).
    if (edges.some((e) => e.san === played[i].san) || graph.has(keys[i + 1])) continue;
    if (turnOfKey(key) === graph.color) return { kind: 'you-deviated', ...base, expected: edges.filter((e) => e.mine).map((e) => e.san) };
    return { kind: 'opponent-deviated', ...base };
  }
  return undefined;
}

/** After the game left prep at `exitPly`: each time it comes back (to a position with prep to follow). */
function rejoinsAfter(graph: RepGraph, keys: string[], played: { san: string; uci: string }[], exitPly: number): Rejoin[] {
  const out: Rejoin[] = [];
  for (let i = exitPly + 1; i <= played.length - 1; i++) {
    const key = keys[i];
    if (!graph.has(key) || !graph.childrenOf(key).length) continue;
    const exit = followFrom(graph, keys, played, i);
    const { kind, ply, played: san, expected } = exit ?? ({} as Partial<Exit>);
    out.push({ ply: i - 1, key, inBook: (exit ? exit.ply : played.length) - i, ...(exit ? { left: { kind: kind!, ply: ply!, key: exit.key, played: san!, ...(expected ? { expected } : {}) } } : {}) });
    if (!exit) break;
    i = exit.ply; // look for the next return after this exit
  }
  return out;
}

function analyzeAgainst(game: StoredGame, graph: RepGraph): Omit<PrepResult, 'gameId'> {
  const { keys, played } = replayKeys(game.sans);
  const exit = followFrom(graph, keys, played, 0);
  if (!exit) return { kind: 'still-in-book', bookPlies: game.sans.length };
  const base = { bookPlies: exit.ply, ply: exit.ply, key: exit.key, played: exit.played, playedUci: exit.playedUci };
  const rejoins = rejoinsAfter(graph, keys, played, exit.ply);
  const extra = rejoins.length ? { rejoins } : {};
  if (exit.kind === 'you-deviated') return exit.ply <= 1 ? { kind: 'other-opening', ...base, expected: exit.expected, ...extra } : { kind: 'you-deviated', ...base, expected: exit.expected, ...extra };
  return { kind: exit.kind, ...base, ...extra };
}

const KIND_RANK: Record<PrepKind, number> = {
  'you-deviated': 5,
  'opponent-deviated': 4,
  'end-of-prep': 3,
  'still-in-book': 2,
  'other-opening': 1,
  'no-repertoire': 0,
};

/** Analyse one game against every repertoire for the color you played; the deepest match wins. */
export function analyzeGame(game: StoredGame, reps: RepWithGraph[]): PrepResult {
  const candidates = reps.filter((r) => r.rep.color === game.userColor && r.graph.size > 0);
  if (!candidates.length) return { gameId: game.id, kind: 'no-repertoire', bookPlies: 0 };
  let best: PrepResult | undefined;
  for (const { rep, graph } of candidates) {
    const r: PrepResult = { gameId: game.id, repId: rep.id, ...analyzeAgainst(game, graph) };
    if (!best || r.bookPlies > best.bookPlies || (r.bookPlies === best.bookPlies && KIND_RANK[r.kind] > KIND_RANK[best.kind])) {
      best = r;
    }
  }
  return best!;
}

export interface ForgottenGroup {
  repId: string;
  key: string;
  expected: string[];
  played: Record<string, number>;
  count: number;
  lastPlayedAt: number;
  gameIds: string[];
  ply: number;
}

export interface SurpriseGroup {
  repId: string;
  key: string;
  san: string;
  uci: string;
  count: number;
  lastPlayedAt: number;
  gameIds: string[];
  ply: number;
  /** Your score in those games. */
  score: number;
}

export interface PrepSummary {
  games: number;
  withRepertoire: number;
  byKind: Record<PrepKind, number>;
  avgBookPlies: number;
  forgotten: ForgottenGroup[];
  surprises: SurpriseGroup[];
}

export function summarize(games: StoredGame[], results: Map<string, PrepResult>): PrepSummary {
  const byKind: Record<PrepKind, number> = {
    'no-repertoire': 0,
    'other-opening': 0,
    'you-deviated': 0,
    'opponent-deviated': 0,
    'end-of-prep': 0,
    'still-in-book': 0,
  };
  const forgotten = new Map<string, ForgottenGroup>();
  const surprises = new Map<string, SurpriseGroup & { scoreSum: number }>();
  let bookSum = 0;
  let withRep = 0;

  for (const g of games) {
    const r = results.get(g.id);
    if (!r) continue;
    byKind[r.kind]++;
    if (r.kind === 'no-repertoire' || r.kind === 'other-opening') continue;
    withRep++;
    bookSum += r.bookPlies;
    if (r.kind === 'you-deviated' && r.key && r.repId) {
      const id = `${r.repId}|${r.key}`;
      const grp = forgotten.get(id) ?? {
        repId: r.repId,
        key: r.key,
        expected: r.expected ?? [],
        played: {},
        count: 0,
        lastPlayedAt: 0,
        gameIds: [],
        ply: r.ply ?? 0,
      };
      grp.count++;
      grp.played[r.played!] = (grp.played[r.played!] ?? 0) + 1;
      grp.lastPlayedAt = Math.max(grp.lastPlayedAt, g.playedAt);
      grp.gameIds.push(g.id);
      forgotten.set(id, grp);
    }
    if (r.kind === 'opponent-deviated' && r.key && r.repId && r.played) {
      const id = `${r.repId}|${r.key}|${r.played}`;
      const grp = surprises.get(id) ?? {
        repId: r.repId,
        key: r.key,
        san: r.played,
        uci: r.playedUci ?? '',
        count: 0,
        lastPlayedAt: 0,
        gameIds: [],
        ply: r.ply ?? 0,
        score: 0,
        scoreSum: 0,
      };
      grp.count++;
      grp.scoreSum += g.userScore ?? 0;
      grp.lastPlayedAt = Math.max(grp.lastPlayedAt, g.playedAt);
      grp.gameIds.push(g.id);
      surprises.set(id, grp);
    }
  }

  const sortGroups = <T extends { count: number; lastPlayedAt: number }>(a: T, b: T) =>
    b.count - a.count || b.lastPlayedAt - a.lastPlayedAt;

  return {
    games: games.length,
    withRepertoire: withRep,
    byKind,
    avgBookPlies: withRep ? bookSum / withRep : 0,
    forgotten: [...forgotten.values()].sort(sortGroups),
    surprises: [...surprises.values()]
      .map(({ scoreSum, ...s }) => ({ ...s, score: s.count ? scoreSum / s.count : 0 }))
      .sort(sortGroups),
  };
}

export const PREP_LABEL: Record<PrepKind, string> = {
  'no-repertoire': 'No repertoire',
  'other-opening': 'Different opening',
  'you-deviated': 'Forgot prep',
  'opponent-deviated': 'Opponent left book',
  'end-of-prep': 'End of prep',
  'still-in-book': 'In book to the end',
};
