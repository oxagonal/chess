import { COLORS, colorName, repertoireScopeId } from '../db/scopes';
import { byName } from '../lib/chapters';
import type { Chapter, Collection } from '../lib/types';

/** The first scope worth showing: all of the first color that has chapters. */
export function defaultScope(chapters: readonly Chapter[]): string | undefined {
  return COLORS.find((c) => chapters.some((ch) => ch.color === c));
}

/** Pick what a page looks at: all of a color's chapters, a repertoire, or one chapter. */
export function ScopeSelect({
  value,
  onChange,
  chapters,
  collections,
}: {
  value: string;
  onChange: (scopeId: string) => void;
  chapters: readonly Chapter[];
  collections: readonly Collection[];
}) {
  const colors = COLORS.filter((c) => chapters.some((ch) => ch.color === c));
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="What to look at">
      <optgroup label="Everything">
        {colors.map((c) => (
          <option key={c} value={c}>
            All {colorName(c)} chapters
          </option>
        ))}
      </optgroup>
      {collections.length > 0 && (
        <optgroup label="Repertoires">
          {[...collections].sort(byName).map((r) => (
            <option key={r.id} value={repertoireScopeId(r.id)}>
              {r.name} ({r.color})
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="Chapters">
        {[...chapters].sort(byName).map((r) => (
          <option key={r.id} value={r.id}>
            {r.name} ({r.color})
          </option>
        ))}
      </optgroup>
    </select>
  );
}
