import { describe, expect, it } from 'vitest';
import { RepGraph } from '../lib/graph';
import { movesFromLines } from '../lib/lines';
import { computeInsights, mastery, movesUnder } from '../lib/insights';
import { grade, newCard, Rating } from '../lib/srs';
import type { ReviewCard, ReviewLogEntry } from '../lib/types';

const NOW = Date.UTC(2026, 5, 1);

describe('insights', () => {
  const moves = movesFromLines('r', 'white', ['e4 c5 Nf3 d6 d4 cxd4 Nxd4', 'e4 c5 Nf3 Nc6 d4', 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4']);
  const graph = new RepGraph('white', moves);
  const mine = graph.myMoves();
  const find = (san: string, after: string) => mine.find((m) => m.san === san && graph.pathTo(m.fromKey)!.map((x) => x.san).join(' ') === after)!;

  // Learn every move once with Good; then make the Najdorf-ish d4 and Ba4 hard
  const learned = (m: (typeof mine)[number]) => grade(newCard({ id: m.id, repId: 'r', fromKey: m.fromKey, san: m.san }, NOW - 20 * 86400e3), Rating.Good, undefined, NOW - 20 * 86400e3);
  const cards: ReviewCard[] = mine.map(learned);
  const logs: ReviewLogEntry[] = mine.map((m) => ({ cardId: m.id, repId: 'r', rating: 3, state: 0, reviewedAt: NOW - 20 * 86400e3, source: 'learn' }));
  const d4 = find('d4', 'e4 c5 Nf3 d6');
  const ba4 = find('Ba4', 'e4 e5 Nf3 Nc6 Bb5 a6');
  for (let i = 0; i < 3; i++) logs.push({ cardId: d4.id, repId: 'r', rating: 1, state: 2, reviewedAt: NOW - 86400e3, source: 'review' });
  const ins = computeInsights({ graph, cards, logs, gameSlips: new Map([[ba4.id, 2]]), now: NOW });

  it('ranks moves missed in training or games as weakest', () => {
    const order = ins.moves.slice(0, 2).map((m) => m.move.san).sort();
    expect(order).toEqual(['Ba4', 'd4']);
    const d4i = ins.moves.find((m) => m.move.id === d4.id)!;
    expect(d4i.attempts).toBe(4);
    expect(d4i.misses).toBe(3);
    expect(d4i.accuracy).toBeCloseTo(0.25);
  });

  it('builds a compressed line tree with subtree totals', () => {
    expect(ins.lines).toHaveLength(1); // 1.e4
    const e4 = ins.lines[0];
    expect(e4.segment.map((m) => m.san)).toEqual(['e4']);
    expect(e4.children.map((c) => c.segment.map((m) => m.san).join(' ')).sort()).toEqual(['c5 Nf3', 'e5 Nf3 Nc6 Bb5 a6 Ba4']);
    expect(e4.moves).toBe(mine.length);
    const sicilian = e4.children.find((c) => c.segment[0].san === 'c5')!;
    expect(sicilian.children.map((c) => c.segment[0].san).sort()).toEqual(['Nc6', 'd6']);
    expect(sicilian.misses).toBe(3);
  });

  it('gives untouched material high mastery and unlearned nothing', () => {
    expect(mastery({ moves: 1, learned: 1, attempts: 10, misses: 0, gameSlips: 0, surprises: 0, recallSum: 0.98, difficultySum: 3 })).toBeGreaterThan(85);
    expect(mastery({ moves: 1, learned: 0, attempts: 0, misses: 0, gameSlips: 0, surprises: 0, recallSum: 0, difficultySum: 0 })).toBeUndefined();
  });

  it('collects moves under a line', () => {
    const c5 = moves.find((m) => m.san === 'c5')!;
    const under = movesUnder(graph, c5.id);
    expect([...under].map((id) => graph.byId.get(id)!.san).sort()).toEqual(['Nc6', 'Nf3', 'Nxd4', 'c5', 'cxd4', 'd4', 'd4', 'd6'].sort());
  });
});
