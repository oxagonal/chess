import { describe, expect, it } from 'vitest';
import { RepGraph } from '../lib/graph';
import { movesFromLines } from '../lib/lines';
import { lineEnds, PLAN_REACH, planAhead, planCover, plansByKey } from '../lib/plans';
import type { RepMove } from '../lib/types';

/** White lines; a plan on the last move of the line given (by its SANs). */
function setup(lines: string[], plansAt: Record<string, string> = {}, still: string[] = []) {
  const moves = movesFromLines('r', 'white', lines);
  const graph = new RepGraph('white', moves);
  const at = (line: string) => {
    let key = graph.root;
    let m: RepMove | undefined;
    for (const san of line.split(' ')) {
      m = graph.edge(key, san)!;
      key = m.toKey;
    }
    return m!;
  };
  for (const [line, text] of Object.entries(plansAt)) at(line).plan = text;
  for (const line of still) at(line).planStill = true;
  return { graph, at, plans: plansByKey(graph.byId.values()) };
}

describe('plans at line ends', () => {
  it('finds your line ends — not lines that end on their move — and the plan that covers each', () => {
    const { graph, plans } = setup(['e4 e5 Nf3 Nc6 Bc4', 'e4 e5 Nf3 d6 d4', 'e4 c5'], { 'e4 e5 Nf3': 'Develop, castle, d4' });
    const ends = lineEnds(graph, plans);
    // 1.e4 c5 ends on their move: a gap, not a line end.
    expect(ends.map((e) => e.path.map((m) => m.san).join(' ')).sort()).toEqual(['e4 e5 Nf3 Nc6 Bc4', 'e4 e5 Nf3 d6 d4']);
    for (const e of ends) expect([e.status, e.back, e.plan?.text]).toEqual(['near', 2, 'Develop, castle, d4']);
  });
  it('a plan more than 5 moves back no longer covers the end — unless you say it still applies', () => {
    const long = 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O O-O Re1 a6 Bb3';
    const { graph, at, plans } = setup([long], { 'e4 e5 Nf3': 'Italian plans' });
    expect(graph.pathTo(at(long).toKey)!.length - 3).toBeGreaterThan(PLAN_REACH);
    const [end] = lineEnds(graph, plans);
    expect([end.status, end.back]).toEqual(['far', 12]);
    const confirmed = setup([long], { 'e4 e5 Nf3': 'Italian plans' }, [long]);
    expect(lineEnds(confirmed.graph, confirmed.plans)[0].status).toBe('confirmed');
    // Its own plan.
    const own = setup([long], { [long]: 'Nbd2-f1-g3' });
    expect(lineEnds(own.graph, own.plans)[0].status).toBe('own');
    expect(planCover([], plans).status).toBe('none');
  });
  it('training a line that stops early shows the plan further on', () => {
    const { graph, at, plans } = setup(['e4 e5 Nf3 Nc6 Bc4 Bc5 c3'], { 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3': 'd4 next' });
    const path = graph.pathTo(at('e4 e5 Nf3').toKey)!;
    expect(planAhead(graph, path, plans)?.text).toBe('d4 next');
  });
});

describe('plans in PGN', () => {
  it('exports a plan as a "[Plan] …" comment and reads it back as the plan, not the note', async () => {
    const { graphToPgn, pgnToEdges } = await import('../lib/pgn');
    const { graph, at } = setup(['e4 e5 Nf3 Nc6 Bc4'], { 'e4 e5 Nf3 Nc6 Bc4': 'c3 and d4; Ng5 ideas' });
    at('e4 e5 Nf3 Nc6 Bc4').comment = 'The Italian';
    const pgn = graphToPgn(graph);
    expect(pgn).toContain('{ The Italian }');
    expect(pgn).toContain('[Plan] c3 and d4; Ng5 ideas');
    const bc4 = pgnToEdges(pgn).edges.find((e) => e.san === 'Bc4')!;
    expect([bc4.comment, bc4.plan]).toEqual(['The Italian', 'c3 and d4; Ng5 ideas']);
  });
});
