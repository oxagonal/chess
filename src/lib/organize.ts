/**
 * Organizing chapters: by first move (1.e4, 1.d4 … or, for Black, what you meet), then by opening
 * family (Sicilian, Semi-Slav, Catalan …) in ECO order — read off each chapter's lines.
 * Pure: no DOM, no database.
 */
import type { Color } from './chess';
import type { RepGraph } from './graph';
import type { Chapter } from './types';
import { linePaths } from './map';
import { nameParts, type OpeningIndex } from './openingNames';

export const SEVERAL_OPENINGS = 'Several openings';
export const SEVERAL_FIRST = 'Several first moves';
const MAJORITY = 0.6;

export interface ChapterInfo {
  /** "1.e4" (White) / "vs 1.e4" (Black), or SEVERAL_FIRST / "Empty". */
  firstMove: string;
  family: string;
  /** For ordering: the family's ECO code in this chapter ("B45"), "~" when unknown. */
  eco: string;
  /** The name without its family prefix, for showing inside the family's group. */
  short: string;
}

function majority<T>(items: T[]): { value: T; share: number } | undefined {
  const counts = new Map<T, number>();
  for (const x of items) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: T | undefined;
  let n = 0;
  for (const [k, c] of counts) if (c > n) [best, n] = [k, c];
  return best === undefined ? undefined : { value: best, share: n / items.length };
}

export function chapterInfo(chapter: Chapter, graph: RepGraph, names: OpeningIndex | undefined): ChapterInfo {
  const lines = linePaths(graph);
  const short = (family: string) => (chapter.name.startsWith(`${family}: `) ? chapter.name.slice(family.length + 2) : chapter.name);
  if (!lines.length) return { firstMove: 'Empty', family: 'Empty', eco: '~', short: chapter.name };
  const first = majority(lines.map((l) => l[0].san))!;
  const firstMove = first.share >= MAJORITY ? `${chapter.color === 'white' ? '' : 'vs '}1.${first.value}` : SEVERAL_FIRST;
  if (!names) return { firstMove, family: SEVERAL_OPENINGS, eco: '~', short: chapter.name };
  const named = lines.map((l) => {
    for (let i = l.length - 1; i >= 0; i--) {
      const n = names.get(l[i].toKey);
      if (n) return { family: nameParts(n).family, eco: names.eco.get(l[i].toKey) ?? '~' };
    }
    return { family: 'Other', eco: '~' };
  });
  const fam = majority(named.map((n) => n.family))!;
  if (fam.share < MAJORITY) return { firstMove, family: SEVERAL_OPENINGS, eco: '~', short: chapter.name };
  const eco = named.filter((n) => n.family === fam.value).reduce((a, n) => (n.eco < a ? n.eco : a), '~');
  return { firstMove, family: fam.value, eco, short: short(fam.value) };
}

export interface FamilyGroup {
  family: string;
  eco: string;
  chapters: { chapter: Chapter; info: ChapterInfo }[];
}

export interface FirstMoveGroup {
  firstMove: string;
  families: FamilyGroup[];
}

const FIRST_ORDER = ['e4', 'd4', 'c4', 'Nf3'];
function firstRank(label: string): number {
  if (label === SEVERAL_FIRST) return 90;
  if (label === 'Empty') return 99;
  const san = label.replace(/^(vs )?1\./, '');
  const i = FIRST_ORDER.indexOf(san);
  return i < 0 ? 50 : i;
}

/** One color's chapters as first-move groups of family groups, each in a sensible order. */
export function organize(chapters: readonly Chapter[], graphs: ReadonlyMap<string, RepGraph>, names: OpeningIndex | undefined, color: Color): FirstMoveGroup[] {
  const by = new Map<string, Map<string, FamilyGroup>>();
  for (const chapter of chapters) {
    if (chapter.color !== color) continue;
    const g = graphs.get(chapter.id);
    const info = g ? chapterInfo(chapter, g, names) : { firstMove: 'Empty', family: 'Empty', eco: '~', short: chapter.name };
    const fams = by.get(info.firstMove) ?? new Map<string, FamilyGroup>();
    by.set(info.firstMove, fams);
    const fam = fams.get(info.family) ?? { family: info.family, eco: info.eco, chapters: [] };
    fams.set(info.family, fam);
    if (info.eco < fam.eco) fam.eco = info.eco;
    fam.chapters.push({ chapter, info });
  }
  return [...by]
    .map(([firstMove, fams]) => ({
      firstMove,
      families: [...fams.values()]
        .map((f) => ({ ...f, chapters: f.chapters.sort((a, b) => (a.info.eco < b.info.eco ? -1 : a.info.eco > b.info.eco ? 1 : a.chapter.name.localeCompare(b.chapter.name))) }))
        .sort((a, b) => (a.eco < b.eco ? -1 : a.eco > b.eco ? 1 : a.family.localeCompare(b.family))),
    }))
    .sort((a, b) => firstRank(a.firstMove) - firstRank(b.firstMove) || a.firstMove.localeCompare(b.firstMove));
}
