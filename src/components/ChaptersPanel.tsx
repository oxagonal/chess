import { useEffect, useMemo, useRef, useState } from 'react';
import { useChaptersAndSets } from '../db/scopes';
import { useChapterGraphs } from '../hooks';
import { chapterPosition } from '../lib/chapters';
import { compactLine, playSan, START_KEY, startPos, type Color } from '../lib/chess';
import { organize } from '../lib/organize';
import type { Chapter } from '../lib/types';
import { navigate } from '../router';
import { useOpeningIndex } from './ChapterTree';

/** The position after `sans` (undefined if a move doesn't play). */
function keyAfter(sans: readonly string[]): string | undefined {
  let pos = startPos();
  let key = START_KEY;
  for (const s of sans) {
    const r = playSan(pos, s);
    if (!r) return undefined;
    pos = r.pos;
    key = r.key;
  }
  return key;
}

/**
 * Every chapter of a color, to jump between without leaving the board: the chapters that also have
 * the position you're on come first, then all of them by first move and opening. A chapter opens at
 * the same position when it has it, otherwise at its own opening.
 */
export function ChaptersPanel({ color, line, current, onPicked }: { color: Color; line: readonly string[]; current?: string; onPicked?: () => void }) {
  const { chapters } = useChaptersAndSets();
  const graphs = useChapterGraphs();
  const names = useOpeningIndex();
  const [filter, setFilter] = useState('');
  const key = useMemo(() => keyAfter(line), [line]);
  const groups = useMemo(() => (chapters && graphs ? organize(chapters, graphs, names, color) : []), [chapters, graphs, names, color]);
  if (!chapters || !graphs) return null;

  const open = (ch: Chapter) => {
    const g = graphs.get(ch.id);
    const here = !!key && !!g && line.length > 0 && g.has(key);
    const sans = here ? [...line] : g ? chapterPosition(g, names, ch.name).moves.map((m) => m.san) : [];
    onPicked?.();
    navigate(`repertoire/${ch.id}`, sans.length ? { line: sans.join(' ') } : undefined);
  };
  const alsoHere = line.length && key ? chapters.filter((c) => c.color === color && c.id !== current && graphs.get(c.id)?.has(key)) : [];
  const q = filter.trim().toLowerCase();
  const item = (ch: Chapter, label: string) => {
    const g = graphs.get(ch.id);
    const opening = g ? compactLine(chapterPosition(g, names, ch.name).moves.map((m) => m.san)) : '';
    return (
      <button key={ch.id} className={`cp-item ${ch.id === current ? 'current' : ''}`} onClick={() => open(ch)} title={ch.name}>
        <span className="cp-name">{label}</span>
        {opening && <span className="cp-line">{opening}</span>}
      </button>
    );
  };

  return (
    <div className="chapters-panel">
      {alsoHere.length > 0 && (
        <div className="cp-here">
          <div className="cp-label">{current ? 'This position is also in' : 'This position is in'}</div>
          <div className="cp-here-list">
            {alsoHere.map((c) => (
              <button key={c.id} className="chip cp-chip" onClick={() => open(c)}>
                {c.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <button
        className={`cp-item cp-all ${current === undefined ? 'current' : ''}`}
        onClick={() => {
          onPicked?.();
          navigate(`repertoire/${color}`, line.length ? { line: line.join(' ') } : undefined);
        }}
        title="Every chapter of this color as one tree"
      >
        <span className="cp-name">All {color === 'white' ? 'White' : 'Black'} chapters</span>
        <span className="cp-line">one tree · new moves go into the chapter they belong to</span>
      </button>
      <input className="cp-filter" placeholder="Find a chapter" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <div className="cp-groups">
        {groups.map((g) => {
          const items = g.families.flatMap((f) =>
            f.chapters
              .filter((c) => !q || c.chapter.name.toLowerCase().includes(q))
              .map((c) => ({ c, label: f.chapters.length > 1 || g.families.length === 1 ? c.info.short : c.chapter.name, family: f })),
          );
          if (!items.length) return null;
          return (
            <div key={g.firstMove} className="cp-group">
              <div className="cp-label">
                {g.firstMove}
                {g.families.length === 1 && ` · ${g.families[0].family}`}
              </div>
              {g.families.length === 1
                ? items.map(({ c, label }) => item(c.chapter, label))
                : g.families.map((f) => {
                    const fi = items.filter((x) => x.family === f);
                    if (!fi.length) return null;
                    return (
                      <div key={f.family} className="cp-family">
                        {f.chapters.length > 1 && <div className="cp-family-name">{f.family}</div>}
                        {fi.map(({ c, label }) => item(c.chapter, label))}
                      </div>
                    );
                  })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The chapter's name as a switcher: click it for every chapter of the color (see ChaptersPanel). */
export function ChapterSwitcher({ chapter, line }: { chapter: Chapter; line: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="chapter-switcher" ref={box}>
      <button className="chapter-switch-btn" onClick={() => setOpen(!open)} aria-expanded={open} title="Switch chapter">
        <h1>{chapter.name}</h1>
        <span className="chapter-switch-caret">▾</span>
      </button>
      {open && (
        <div className="chapter-switch-pop">
          <ChaptersPanel color={chapter.color} line={line} current={chapter.id} onPicked={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
