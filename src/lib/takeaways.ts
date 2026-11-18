/**
 * What a reviewed game says to work on: tags chosen in the game review, shown beside the game on the
 * Games tab. Pure: no DOM, no database.
 */

/** Offered on every game; tags you add yourself follow them. */
export const WORK_ON_TAGS = [
  'Tactics',
  'Calculation',
  'Opening prep',
  'Opening trap',
  'Endgames',
  'Time management',
  'King safety',
  'Positional misunderstanding',
  'Converting',
  'Defending',
];

/** The built-in tags, then yours, then any on this game that are neither — each once. */
export function tagOptions(custom: readonly string[], onGame: readonly string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...WORK_ON_TAGS, ...custom, ...onGame]) {
    const k = t.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t.trim());
  }
  return out;
}

/** The tags with `tag` added or removed (case doesn't matter), in the order of `order`. */
export function toggleTag(tags: readonly string[], tag: string, order: readonly string[]): string[] {
  const k = tag.trim().toLowerCase();
  const on = tags.some((t) => t.toLowerCase() === k);
  const next = on ? tags.filter((t) => t.toLowerCase() !== k) : [...tags, tag.trim()];
  const rank = (t: string) => {
    const i = order.findIndex((o) => o.toLowerCase() === t.toLowerCase());
    return i < 0 ? order.length : i;
  };
  return [...next].sort((a, b) => rank(a) - rank(b));
}
