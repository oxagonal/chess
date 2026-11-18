import { useEffect, useMemo, useState } from 'react';
import { splitChapter } from '../db/repertoire';
import { formatLine } from '../lib/chess';
import type { RepGraph } from '../lib/graph';
import { loadOpeningIndex } from '../lib/openingNames';
import { movesOf, suggestChapters, type SuggestedChapter } from '../lib/suggest';
import type { Chapter } from '../lib/types';

interface Choice {
  name: string;
  keep: boolean;
  /** Index of the suggestion this one is merged into, or -1. */
  into: number;
}

/**
 * Split a chapter into openings, suggested from the opening names of its lines. You rename, merge
 * or leave out suggestions before anything changes; left-out lines stay together in one chapter.
 */
export function SuggestChapters({ chapter, graph, onClose }: { chapter: Chapter; graph: RepGraph; onClose: () => void }) {
  const [suggested, setSuggested] = useState<SuggestedChapter[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [keepOriginal, setKeepOriginal] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let off = false;
    loadOpeningIndex()
      .then((names) => {
        if (off) return;
        const s = suggestChapters(graph, names);
        setSuggested(s);
        setChoices(s.map((c) => ({ name: c.name, keep: true, into: -1 })));
      })
      .catch((e) => setError((e as Error).message));
    return () => {
      off = true;
    };
  }, [graph]);

  /** Final chapters: merges followed, left-out lines gathered into one. */
  const parts = useMemo(() => {
    if (!suggested) return [];
    const root = (i: number, seen = new Set<number>()): number => {
      const j = choices[i]?.into ?? -1;
      return j < 0 || seen.has(j) ? i : root(j, seen.add(i));
    };
    const out = new Map<number | 'rest', SuggestedChapter>();
    suggested.forEach((s, i) => {
      const r = root(i);
      const target: number | 'rest' = choices[r]?.keep ? r : 'rest';
      const name = target === 'rest' ? `${chapter.name} — rest` : choices[r].name;
      const e = out.get(target);
      if (e) e.lines.push(...s.lines);
      else out.set(target, { name, lines: [...s.lines] });
    });
    return [...out.values()];
  }, [suggested, choices, chapter.name]);

  const set = (i: number, patch: Partial<Choice>) => setChoices((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const apply = async () => {
    setBusy(true);
    try {
      await splitChapter(
        chapter.id,
        parts.map((p) => ({ name: p.name, moveIds: movesOf(p).map((m) => m.id) })),
        { keepOriginal },
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="panel col suggest" style={{ gap: 10 }}>
      <div className="row">
        <h2 style={{ margin: 0 }}>Split “{chapter.name}” into chapters</h2>
        <span className="spacer" />
        <button className="ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Each line is named after the deepest named opening position it reaches — by position, so a different move order into the same
        opening lands in the same chapter. Rename, merge or leave out suggestions; lines you leave out stay together in one chapter. Your
        progress is kept: it belongs to positions, not chapters.
      </p>
      {error && <div className="error">{error}</div>}
      {!suggested && !error && <div className="muted">Reading opening names…</div>}
      {suggested && suggested.length <= 1 && <div className="note">This chapter is already one opening — nothing to split.</div>}
      {suggested && suggested.length > 1 && (
        <>
          <div className="col suggest-list">
            {suggested.map((s, i) => {
              const c = choices[i];
              if (!c) return null;
              return (
                <div key={i} className={`suggest-item ${c.keep && c.into < 0 ? '' : 'faded'}`}>
                  <div className="row">
                    <input type="checkbox" checked={c.keep} onChange={(e) => set(i, { keep: e.target.checked })} aria-label={`Make “${c.name}” a chapter`} />
                    <input className="suggest-name" value={c.name} onChange={(e) => set(i, { name: e.target.value })} disabled={!c.keep || c.into >= 0} />
                    <button className="ghost small" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                      {s.lines.length} line{s.lines.length === 1 ? '' : 's'} {open === i ? '▴' : '▾'}
                    </button>
                    <span className="spacer" />
                    <label className="small muted">
                      Merge into{' '}
                      <select value={c.into} onChange={(e) => set(i, { into: Number(e.target.value) })}>
                        <option value={-1}>—</option>
                        {choices.map((o, j) =>
                          j === i ? null : (
                            <option key={j} value={j}>
                              {o.name}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                  </div>
                  {open === i && (
                    <ul className="suggest-lines mono">
                      {s.lines.slice(0, 40).map((l, k) => (
                        <li key={k}>{formatLine(l.map((m) => m.san))}</li>
                      ))}
                      {s.lines.length > 40 && <li className="muted">…and {s.lines.length - 40} more</li>}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
          <div className="row">
            <span className="muted small">
              Makes {parts.length} chapter{parts.length === 1 ? '' : 's'}: {parts.map((p) => p.name).join(' · ')}
            </span>
          </div>
          <div className="row">
            <label className="check small">
              <input type="checkbox" checked={keepOriginal} onChange={(e) => setKeepOriginal(e.target.checked)} />
              Keep “{chapter.name}” as it is too
            </label>
            <span className="spacer" />
            <button className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={busy || parts.length < 1} onClick={apply}>
              {busy ? 'Splitting…' : `Split into ${parts.length}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
