import { describe, expect, it } from 'vitest';
import openings from '../data/openings.json';
import { RepGraph } from '../lib/graph';
import { movesFromLines } from '../lib/lines';
import { buildOpeningIndex, nameParts } from '../lib/openingNames';
import { nameOfLine, suggestChapters } from '../lib/suggest';

const names = buildOpeningIndex(openings as [string, string][]);

describe('suggesting chapters', () => {
  it('names positions, so a transposed move order gets the name of where it lands', () => {
    expect(names.size).toBeGreaterThan(3000);
    const g = new RepGraph('black', movesFromLines('r', 'black', ['e4 c5 d4 cxd4 Nf3 e6 Nxd4 Nc6 Nc3 Nf6']));
    const path = g.pathTo([...g.byId.values()].find((m) => m.san === 'Nf6')!.toKey)!;
    expect(nameOfLine(path, names)).toMatch(/^Sicilian Defense: Four Knights Variation/);
    expect(nameParts('Sicilian Defense: Four Knights Variation, Exchange Variation')).toEqual({ family: 'Sicilian Defense', variation: 'Four Knights Variation' });
  });

  it('groups a Sicilian chapter by variation — Four Knights lines together whatever the move order', () => {
    const g = new RepGraph(
      'black',
      movesFromLines('r', 'black', [
        'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6 Nc3 Nf6 Ndb5 Bb4',
        'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6 Nc3 Nf6 Nxc6 bxc6',
        'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6 Nc3 Nf6 Be2 Bb4',
        'e4 c5 d4 cxd4 Nf3 e6 Nxd4 Nc6 Nc3 Nf6',
        'e4 c5 c3 d5 exd5 Qxd5 d4 Nf6',
        'e4 c5 c3 d5 exd5 Qxd5 d4 e6',
        'e4 c5 c3 d5 e5 Bf5',
        'e4 c5 d4 cxd4 c3 dxc3 Nxc3 Nc6',
      ]),
    );
    const out = suggestChapters(g, names);
    const byName = Object.fromEntries(out.map((c) => [c.name, c.lines.map((l) => l.map((m) => m.san).join(' '))]));
    const fourKnights = Object.entries(byName).find(([n]) => n.includes('Four Knights'));
    expect(fourKnights).toBeDefined();
    // The 2.d4 move order sits with the other Four Knights lines, not under a gambit.
    // (That line ends at 3...e6, where it transposes into the 2.Nf3 order.)
    expect(fourKnights![1]).toContain('e4 c5 d4 cxd4 Nf3 e6');
    expect(fourKnights![1]).toHaveLength(4);
    const alapin = Object.entries(byName).find(([n]) => n.includes('Alapin'));
    expect(alapin![1]).toHaveLength(3);
    // Every line lands in exactly one chapter.
    expect(out.reduce((n, c) => n + c.lines.length, 0)).toBe(8);
  });

  it('keeps an Alapin line reaching a "Delayed Alapin" position with the Alapin, and names lone openings plainly', () => {
    const g = new RepGraph(
      'black',
      movesFromLines('r', 'black', [
        'e4 c5 c3 d5 exd5 Qxd5 d4 Nf6 Nf3 e6',
        'e4 c5 c3 d5 exd5 Qxd5 d4 e6',
        'e4 c5 c3 d5 e5 Bf5',
        'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O',
        'd4 Nf6 c4 e6 Nc3 Bb4 Qc2 O-O',
      ]),
    );
    const names2 = suggestChapters(g, names).map((c) => `${c.name}:${c.lines.length}`);
    expect(names2).toContain('Sicilian Defense: Alapin Variation:3');
    expect(names2).toContain('Nimzo-Indian Defense:2');
  });

  it('keeps a true delayed line (one that never goes through the plain variation) apart', () => {
    // 2.Nf3 e6 3.c3: a Delayed Alapin that never passes the 2.c3 position.
    const g = new RepGraph('black', movesFromLines('r', 'black', ['e4 c5 Nf3 e6 c3 d5 exd5 exd5', 'e4 c5 Nf3 e6 c3 Nf6 e5 Nd5', 'e4 c5 Nf3 e6 c3 d5 e5 d4']));
    const groups = suggestChapters(g, names, 1).map((c) => c.name);
    expect(groups.some((n) => n.includes('Delayed Alapin'))).toBe(true);
    expect(groups.some((n) => n === 'Sicilian Defense: Alapin Variation')).toBe(false);
  });
});
