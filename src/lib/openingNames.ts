/**
 * Opening names by position (from the Lichess opening names, public domain): each named line is
 * replayed once, so a position gets its name however it's reached.
 */
import { playSan, START_KEY, startPos } from './chess';

/** Position key → opening name, e.g. "Sicilian Defense: Four Knights Variation"; `eco` → its ECO code (B45). */
export class OpeningIndex extends Map<string, string> {
  readonly eco = new Map<string, string>();
}

export function buildOpeningIndex(entries: readonly (readonly [string, string, string?])[]): OpeningIndex {
  const index = new OpeningIndex();
  for (const [name, sans, eco] of entries) {
    let pos = startPos();
    let key = START_KEY;
    let ok = true;
    for (const san of sans.split(' ')) {
      const r = playSan(pos, san);
      if (!r) {
        ok = false;
        break;
      }
      pos = r.pos;
      key = r.key;
    }
    if (ok && !index.has(key)) {
      index.set(key, name);
      if (eco) index.eco.set(key, eco);
    }
  }
  return index;
}

let cached: Promise<OpeningIndex> | undefined;

/** The index, loaded (as its own chunk) the first time it's needed. */
export function loadOpeningIndex(): Promise<OpeningIndex> {
  cached ??= import('../data/openings.json').then((m) => buildOpeningIndex((m.default ?? m) as unknown as [string, string, string][]));
  return cached;
}

/**
 * "Sicilian Defense: Four Knights Variation, Exchange Variation" → its family and first variation.
 */
export function nameParts(name: string): { family: string; variation?: string } {
  const [family, rest] = name.split(/:\s*/, 2);
  const variation = rest?.split(/,\s*/)[0];
  return { family: family.trim(), variation: variation?.trim() || undefined };
}
