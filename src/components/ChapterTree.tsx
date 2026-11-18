import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Color } from '../lib/chess';
import type { RepGraph } from '../lib/graph';
import { loadOpeningIndex, type OpeningIndex } from '../lib/openingNames';
import { organize } from '../lib/organize';
import type { Chapter } from '../lib/types';

/** Opening names, loaded once (a separate chunk); undefined until they arrive. */
export function useOpeningIndex(): OpeningIndex | undefined {
  const [names, setNames] = useState<OpeningIndex>();
  useEffect(() => {
    let off = false;
    void loadOpeningIndex().then((n) => !off && setNames(n));
    return () => {
      off = true;
    };
  }, []);
  return names;
}

/** Which groups are open, remembered on this device (a convenience: it can always start fresh). */
function useOpenState(storageKey: string) {
  const read = (): Record<string, boolean> => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, boolean>;
    } catch {
      return {};
    }
  };
  const [open, setOpen] = useState<Record<string, boolean>>(read);
  const set = (key: string, value: boolean) => {
    const next = { ...open, [key]: value };
    setOpen(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* private mode etc.: just don't remember */
    }
  };
  return [open, set] as const;
}

/**
 * One color's chapters as dropdowns: first move (1.e4, 1.d4 … / vs 1.e4 …), then opening family
 * (Sicilian, Catalan …) in ECO order. A first move or family with one chapter shows the chapter itself
 * (first moves like that together, after the dropdowns); inside a family, chapters drop its name.
 */
export function ChapterTree({
  color,
  chapters,
  graphs,
  storageKey,
  row,
  summary,
}: {
  color: Color;
  chapters: Chapter[];
  graphs: ReadonlyMap<string, RepGraph>;
  storageKey: string;
  /** A chapter's row; `label` is the name to show. */
  row: (chapter: Chapter, label: string) => ReactNode;
  /** Extra text in a group's header (e.g. due counts), for its chapters. */
  summary?: (chapterIds: string[]) => ReactNode;
}) {
  const names = useOpeningIndex();
  const groups = useMemo(() => organize(chapters, graphs, names, color), [chapters, graphs, names, color]);
  const [open, setOpen] = useOpenState(`chapter-tree:${storageKey}:${color}`);
  if (!groups.length) return null;
  // A first move with a single chapter needs no folder: those chapters sit together after the folders.
  const count = (g: (typeof groups)[number]) => g.families.reduce((n, f) => n + f.chapters.length, 0);
  const loose = groups.filter((g) => count(g) === 1).map((g) => g.families[0].chapters[0].chapter);
  return (
    <div className="ctree">
      {groups.filter((g) => count(g) > 1).map((g) => {
        const ids = g.families.flatMap((f) => f.chapters.map((c) => c.chapter.id));
        const key = g.firstMove;
        return (
          <details key={key} className="panel ctree-first" open={open[key] ?? true} onToggle={(e) => setOpen(key, e.currentTarget.open)}>
            <summary className="ctree-summary">
              <span className="ctree-title">{g.firstMove}</span>
              <span className="muted small">
                {ids.length} chapter{ids.length === 1 ? '' : 's'}
              </span>
              <span className="spacer" />
              {summary?.(ids)}
            </summary>
            <div className="list">
              {g.families.map((f) => {
                if (f.chapters.length === 1) return <div key={f.family}>{row(f.chapters[0].chapter, f.chapters[0].chapter.name)}</div>;
                const fkey = `${g.firstMove}|${f.family}`;
                const fids = f.chapters.map((c) => c.chapter.id);
                return (
                  <details key={f.family} className="ctree-family" open={open[fkey] ?? false} onToggle={(e) => setOpen(fkey, e.currentTarget.open)}>
                    <summary className="ctree-summary">
                      <span className="ctree-family-name">{f.family}</span>
                      {f.eco !== '~' && <span className="ctree-eco">{f.eco}</span>}
                      <span className="muted small">{f.chapters.length} chapters</span>
                      <span className="spacer" />
                      {summary?.(fids)}
                    </summary>
                    <div className="list ctree-children">
                      {f.chapters.map((c) => (
                        <div key={c.chapter.id}>{row(c.chapter, c.info.short)}</div>
                      ))}
                    </div>
                  </details>
                );
              })}
            </div>
          </details>
        );
      })}
      {loose.length > 0 && (
        <div className="panel list ctree-loose">
          {loose.map((c) => (
            <div key={c.id}>{row(c, c.name)}</div>
          ))}
        </div>
      )}
    </div>
  );
}
