import { describe, expect, it } from 'vitest';
import openings from '../data/openings.json';
import { RepGraph } from '../lib/graph';
import { movesFromLines } from '../lib/lines';
import { buildOpeningIndex } from '../lib/openingNames';
import { organize, SEVERAL_OPENINGS } from '../lib/organize';
import type { Chapter } from '../lib/types';
import type { Color } from '../lib/chess';

const names = buildOpeningIndex(openings as [string, string, string][]);

const make = (list: { name: string; color: Color; lines: string[] }[]) => {
  const chapters: Chapter[] = list.map((c, i) => ({ id: `c${i}`, name: c.name, color: c.color, createdAt: 1, updatedAt: 1 }));
  const graphs = new Map(list.map((c, i) => [`c${i}`, new RepGraph(c.color, movesFromLines(`c${i}`, c.color, c.lines))]));
  return { chapters, graphs };
};

describe('organizing chapters', () => {
  it('groups White by first move, then by opening family in ECO order', () => {
    const { chapters, graphs } = make([
      { name: 'Catalan Opening: Open Defense', color: 'white', lines: ['d4 Nf6 c4 e6 g3 d5 Bg2 dxc4 Nf3'] },
      { name: 'Catalan Opening: Closed', color: 'white', lines: ['d4 Nf6 c4 e6 g3 d5 Bg2 Be7 Nf3'] },
      { name: 'Italian', color: 'white', lines: ['e4 e5 Nf3 Nc6 Bc4 Bc5 c3', 'e4 e5 Nf3 Nc6 Bc4 Nf6 d3'] },
      { name: 'Caro-Kann Exchange', color: 'white', lines: ['e4 c6 d4 d5 exd5 cxd5 Bd3'] },
    ]);
    const out = organize(chapters, graphs, names, 'white');
    expect(out.map((g) => g.firstMove)).toEqual(['1.e4', '1.d4']);
    // Caro-Kann (B1x) before Italian (C5x).
    expect(out[0].families.map((f) => f.family)).toEqual(['Caro-Kann Defense', 'Italian Game']);
    const catalan = out[1].families.find((f) => f.family === 'Catalan Opening')!;
    expect(catalan.chapters.map((c) => c.info.short).sort()).toEqual(['Closed', 'Open Defense']);
  });

  it('groups Black by what you meet, and a mixed chapter as several openings', () => {
    const { chapters, graphs } = make([
      { name: 'Four Knights', color: 'black', lines: ['e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6 Nc3 Nf6'] },
      { name: 'Alapin', color: 'black', lines: ['e4 c5 c3 d5 exd5 Qxd5 d4 Nf6'] },
      { name: 'Semi-Slav', color: 'black', lines: ['d4 d5 c4 c6 Nf3 Nf6 Nc3 e6'] },
      { name: 'Everything', color: 'black', lines: ['e4 c5 Nf3 e6', 'd4 Nf6 c4 e6 Nc3 Bb4', 'c4 e5'] },
    ]);
    const out = organize(chapters, graphs, names, 'black');
    const e4 = out.find((g) => g.firstMove === 'vs 1.e4')!;
    expect(e4.families.map((f) => [f.family, f.chapters.length])).toEqual([['Sicilian Defense', 2]]);
    expect(out.find((g) => g.firstMove === 'vs 1.d4')!.families[0].family).toBe('Semi-Slav Defense');
    const mixed = out.find((g) => g.families.some((f) => f.family === SEVERAL_OPENINGS));
    expect(mixed?.firstMove).toBe('Several first moves');
  });
});
