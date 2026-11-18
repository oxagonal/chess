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
}

/** What a game is checked against: in the app, each color's chapters as one union graph. */
export interface RepWithGraph {
  rep: { id: string; name: string; color: Color };
  graph: RepGraph;
}

function analyzeAgainst(game: StoredGame, graph: RepGraph): Omit<PrepResult, 'gameId'> {
  let pos: Position = startPos();
  let key = START_KEY;
  for (let i = 0; i < game.sans.length; i++) {
    const played = playSan(pos, game.sans[i]);
    if (!played) break;
    const edges = graph.childrenOf(key);
    const myTurn = turnOfKey(key) === graph.color;
    if (!edges.length) return { kind: 'end-of-prep', bookPlies: i, ply: i, key, played: played.san, playedUci: played.uci };
    const inBook = edges.some((e) => e.san === played.san) || graph.has(played.key);
    if (!inBook) {
      const base = { bookPlies: i, ply: i, key, played: played.san, playedUci: played.uci };
      if (myTurn) {
        const expected = edges.filter((e) => e.mine).map((e) => e.san);
        return i <= 1 ? { kind: 'other-opening', ...base, expected } : { kind: 'you-deviated', ...base, expected };
      }
      return { kind: 'opponent-deviated', ...base };
    }
    pos = played.pos;
    key = played.key;
  }
  return { kind: 'still-in-book', bookPlies: game.sans.length };
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
