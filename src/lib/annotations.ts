/**
 * Move annotations like a Lichess study: one move symbol (!!, ?, □ …), one position assessment
 * (±, ∞ …), any number of observations (N for a novelty …), and a comment. Stored per ply on a game.
 * Pure: no DOM, no database.
 */

export interface Glyph {
  symbol: string;
  name: string;
  /** PGN numeric annotation glyph ($n). */
  nag: number;
}

export const MOVE_GLYPHS: Glyph[] = [
  { symbol: '!!', name: 'Brilliant move', nag: 3 },
  { symbol: '!', name: 'Good move', nag: 1 },
  { symbol: '!?', name: 'Interesting move', nag: 5 },
  { symbol: '?!', name: 'Dubious move', nag: 6 },
  { symbol: '?', name: 'Mistake', nag: 2 },
  { symbol: '??', name: 'Blunder', nag: 4 },
  { symbol: '□', name: 'Only move', nag: 7 },
  { symbol: '⨀', name: 'Zugzwang', nag: 22 },
];

export const POSITION_GLYPHS: Glyph[] = [
  { symbol: '=', name: 'Equal position', nag: 10 },
  { symbol: '∞', name: 'Unclear position', nag: 13 },
  { symbol: '⩲', name: 'White is slightly better', nag: 14 },
  { symbol: '⩱', name: 'Black is slightly better', nag: 15 },
  { symbol: '±', name: 'White is better', nag: 16 },
  { symbol: '∓', name: 'Black is better', nag: 17 },
  { symbol: '+−', name: 'White is winning', nag: 18 },
  { symbol: '−+', name: 'Black is winning', nag: 19 },
];

export const OBSERVATION_GLYPHS: Glyph[] = [
  { symbol: 'N', name: 'Novelty', nag: 146 },
  { symbol: '↑↑', name: 'Development', nag: 32 },
  { symbol: '↑', name: 'Initiative', nag: 36 },
  { symbol: '→', name: 'Attack', nag: 40 },
  { symbol: '⇆', name: 'Counterplay', nag: 132 },
  { symbol: '⊕', name: 'Time trouble', nag: 138 },
  { symbol: '∆', name: 'With the idea', nag: 140 },
];

const BY_SYMBOL = new Map([...MOVE_GLYPHS, ...POSITION_GLYPHS, ...OBSERVATION_GLYPHS].map((g) => [g.symbol, g]));

export function glyphName(symbol: string): string {
  return BY_SYMBOL.get(symbol)?.name ?? symbol;
}

/** The annotation of one move. */
export interface MoveAnnotation {
  /** Move symbol, then position symbol, then observations — at most one of each of the first two. */
  glyphs?: string[];
  comment?: string;
}

const isMove = (s: string) => MOVE_GLYPHS.some((g) => g.symbol === s);
const isPosition = (s: string) => POSITION_GLYPHS.some((g) => g.symbol === s);

/**
 * Toggle a symbol like Lichess: choosing a move (or position) symbol replaces the one already there,
 * choosing the same one again removes it; observations switch on and off independently.
 */
export function toggleGlyph(glyphs: readonly string[] | undefined, symbol: string): string[] {
  const list = [...(glyphs ?? [])];
  if (list.includes(symbol)) return list.filter((g) => g !== symbol);
  const kind = isMove(symbol) ? isMove : isPosition(symbol) ? isPosition : undefined;
  const kept = kind ? list.filter((g) => !kind(g)) : list;
  return sortGlyphs([...kept, symbol]);
}

/** Move symbol first, then position, then observations (in the menu's order). */
export function sortGlyphs(glyphs: readonly string[]): string[] {
  const rank = (s: string) => {
    const m = MOVE_GLYPHS.findIndex((g) => g.symbol === s);
    if (m >= 0) return m;
    const p = POSITION_GLYPHS.findIndex((g) => g.symbol === s);
    if (p >= 0) return 100 + p;
    const o = OBSERVATION_GLYPHS.findIndex((g) => g.symbol === s);
    return o >= 0 ? 200 + o : 300;
  };
  return [...glyphs].sort((a, b) => rank(a) - rank(b));
}

/** The move symbol, if any (it's written right after the move: Nf3!?). */
export function moveGlyph(a: MoveAnnotation | undefined): string | undefined {
  return a?.glyphs?.find(isMove);
}

/** Position and observation symbols (written after a space: Nf3!? ± N). */
export function otherGlyphs(a: MoveAnnotation | undefined): string[] {
  return (a?.glyphs ?? []).filter((g) => !isMove(g));
}

/** CSS class for a move symbol's color. */
export function glyphClass(symbol: string | undefined): string {
  switch (symbol) {
    case '!!':
      return 'g-brilliant';
    case '!':
      return 'g-good';
    case '!?':
      return 'g-interesting';
    case '?!':
      return 'g-dubious';
    case '?':
      return 'g-mistake';
    case '??':
      return 'g-blunder';
    case '□':
    case '⨀':
      return 'g-only';
    default:
      return '';
  }
}

/** Tidied for storage (symbols in order, comment trimmed), or undefined if nothing is left. */
export function cleanAnnotation(a: MoveAnnotation | undefined): MoveAnnotation | undefined {
  if (isEmpty(a)) return undefined;
  return {
    ...(a!.glyphs?.length ? { glyphs: sortGlyphs(a!.glyphs) } : {}),
    ...(a!.comment?.trim() ? { comment: a!.comment.trim() } : {}),
  };
}

/** A line you tried in a game review, saved with the game: moves from the position after `from` moves. */
export interface SavedLine {
  id: string;
  from: number;
  sans: string[];
  /** Annotations of its moves, by index in `sans`. */
  notes?: Record<string, MoveAnnotation>;
}

/** The line with move `index` annotated (or its annotation removed). */
export function withLineNote(line: SavedLine, index: number, a: MoveAnnotation | undefined): SavedLine {
  const notes = { ...(line.notes ?? {}) };
  const clean = cleanAnnotation(a);
  if (clean) notes[String(index)] = clean;
  else delete notes[String(index)];
  const { notes: _old, ...rest } = line;
  return Object.keys(notes).length ? { ...rest, notes } : rest;
}

/** An annotation with nothing in it is removed rather than stored. */
export function isEmpty(a: MoveAnnotation | undefined): boolean {
  return !a || (!a.glyphs?.length && !a.comment?.trim());
}
