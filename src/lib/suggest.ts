/**
 * Suggesting chapters: split a chapter into openings by naming each of its lines after the deepest
 * named position it passes through (positions, not move orders — a Four Knights Sicilian reached by
 * 2.d4 cxd4 3.Nf3 is still the Four Knights), then grouping lines by opening and variation.
 * Pure: no DOM, no database.
 */
import type { RepGraph } from './graph';
import type { RepMove } from './types';
import { linePaths } from './map';
import { nameParts, type OpeningIndex } from './openingNames';

export interface SuggestedChapter {
  name: string;
  lines: RepMove[][];
}

/** A group smaller than this folds into its opening's "other lines" (when the opening has bigger groups). */
export const MIN_LINES = 3;

/** The deepest named position on a path (its full name), if any. */
export function nameOfLine(path: readonly RepMove[], names: OpeningIndex): string | undefined {
  for (let i = path.length - 1; i >= 0; i--) {
    const n = names.get(path[i].toKey);
    if (n) return n;
  }
  return undefined;
}

/**
 * The chapter a line belongs to: its deepest name's opening and variation. A "Delayed" variation
 * counts as the plain one only when the line goes through that variation's own named position (an
 * Alapin that reaches a "Delayed Alapin" position); a delayed line that never does keeps its own name.
 */
export function groupOfLine(path: readonly RepMove[], names: OpeningIndex): { key: string; family: string } | undefined {
  const full = nameOfLine(path, names);
  if (!full) return undefined;
  const { family, variation } = nameParts(full);
  if (!variation) return { key: family, family };
  const plain = variation.replace(/^Delayed\s+/, '');
  if (plain !== variation) {
    const through = path.some((m) => {
      const n = names.get(m.toKey);
      if (!n) return false;
      const p = nameParts(n);
      return p.family === family && p.variation === plain;
    });
    if (through) return { key: `${family}: ${plain}`, family };
  }
  return { key: `${family}: ${variation}`, family };
}

export function suggestChapters(graph: RepGraph, names: OpeningIndex, minLines = MIN_LINES): SuggestedChapter[] {
  const groups = new Map<string, { family: string; lines: RepMove[][] }>();
  const add = (key: string, family: string, lines: RepMove[][]) => {
    const g = groups.get(key);
    if (g) g.lines.push(...lines);
    else groups.set(key, { family, lines: [...lines] });
  };
  const paths = linePaths(graph);
  // A line that ends by transposing (its last position goes on elsewhere) belongs with the lines that
  // carry on from there — e.g. 2.d4 cxd4 3.Nf3 e6 4.Nxd4 into the Four Knights — so it's placed after.
  const transposes = (p: RepMove[]) => graph.childrenOf(p[p.length - 1].toKey).length > 0;
  for (const path of paths.filter((p) => !transposes(p))) {
    const g = groupOfLine(path, names);
    add(g?.key ?? 'Other lines', g?.family ?? 'Other lines', [path]);
  }
  for (const path of paths.filter(transposes)) {
    const key = path[path.length - 1].toKey;
    let best: string | undefined;
    let most = 0;
    for (const [name, g] of groups) {
      const n = g.lines.filter((l) => l.some((m) => m.toKey === key)).length;
      if (n > most) [best, most] = [name, n];
    }
    if (best) {
      groups.get(best)!.lines.push(path);
      continue;
    }
    const g = groupOfLine(path, names);
    add(g?.key ?? 'Other lines', g?.family ?? 'Other lines', [path]);
  }
  // Small groups fold into "<opening> — other lines" when the opening has a bigger group to sit beside.
  const families = new Map<string, number>();
  for (const g of groups.values()) families.set(g.family, (families.get(g.family) ?? 0) + 1);
  const out = new Map<string, { family: string; lines: RepMove[][] }>();
  for (const [key, g] of groups) {
    const fold = g.lines.length < minLines && key !== g.family && (families.get(g.family) ?? 0) > 1;
    const target = fold ? `${g.family} — other lines` : key;
    const existing = out.get(target);
    if (existing) existing.lines.push(...g.lines);
    else out.set(target, { family: g.family, lines: [...g.lines] });
  }
  // A family-level group (lines that stop at the opening's own name) and its "other lines" are the same thing.
  for (const [key, g] of [...out]) {
    const other = `${g.family} — other lines`;
    if (key === g.family && out.has(other) && key !== other) {
      out.get(other)!.lines.unshift(...g.lines);
      out.delete(key);
    }
  }
  // An opening whose lines all folded into "other lines" is just that opening.
  return [...out].map(([name, g]) => {
    const alone = name.endsWith(' — other lines') && ![...out].some(([k, o]) => k !== name && o.family === g.family);
    return { name: alone ? g.family : name, lines: g.lines };
  });
}

/** Every move on a suggested chapter's lines. */
export function movesOf(ch: SuggestedChapter): RepMove[] {
  const seen = new Map<string, RepMove>();
  for (const l of ch.lines) for (const m of l) seen.set(m.id, m);
  return [...seen.values()];
}
