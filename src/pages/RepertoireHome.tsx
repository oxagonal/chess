import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import {
  createCollection,
  createRepertoire,
  deleteCollection,
  deleteRepertoire,
  mergeChapter,
  exportPgn,
  fetchLichessStudy,
  importPgn,
  renameRepertoire,
  updateCollection,
} from '../db/repertoire';
import { colorName, repertoireScopeId, useChaptersAndSets } from '../db/scopes';
import { useCards, useChapterGraphs } from '../hooks';
import { byName, cardIdOf, chapterConflicts, type ChapterConflict } from '../lib/chapters';
import { formatLine, type Color } from '../lib/chess';
import { isDue, isNew } from '../lib/srs';
import type { Chapter, Collection, ReviewCard } from '../lib/types';
import type { RepGraph } from '../lib/graph';
import { ColorPill, MoreMenu } from '../components/ui';
import { download } from '../services/backup';
import { href, navigate, openScope } from '../router';
import { SuggestChapters } from '../components/SuggestChapters';

/**
 * Pieces of the Repertoire tab (pages/MapPage) for managing chapters and repertoires — the tab's own
 * buttons, a chapter's ⋯ menu and the panels it opens, and your repertoires (saved sets of chapters,
 * e.g. what you'll play at a tournament).
 */

/** The tab's buttons: what chapters are, every chapter of a color in the builder, a new chapter, importing. */
export function RepertoireActions({ color, onImport }: { color: Color; onImport: () => void }) {
  return (
    <>
      <HelpButton />
      <span className="spacer" />
      <a className="btn primary" href={href(`repertoire/${color}`)} title={`Every ${colorName(color)} chapter as one tree, in the studio — new moves go into the chapter they belong to`}>
        Open all {colorName(color)}
      </a>
      <NewChapterButton color={color} />
      <button onClick={onImport} title="Import a Lichess study (yours too, private or unlisted) or a PGN">
        Import
      </button>
    </>
  );
}

/** A panel a chapter's ⋯ menu opens: splitting it, merging it, importing into it. */
export type ChapterPanel = { kind: 'split' | 'merge' | 'import'; id: string } | null;

/** A chapter's ⋯ menu. */
export function ChapterMenu({ chapter: r, onPanel }: { chapter: Chapter; onPanel: (p: ChapterPanel) => void }) {
  return (
    <MoreMenu label="Chapter">
      <button onClick={() => onPanel({ kind: 'split', id: r.id })}>Split into chapters…</button>
      <button onClick={() => onPanel({ kind: 'merge', id: r.id })}>Merge into…</button>
      <button onClick={() => onPanel({ kind: 'import', id: r.id })}>Import PGN or study…</button>
      <button onClick={async () => download(`${r.name.replace(/[^\w-]+/g, '_')}.pgn`, await exportPgn(r.id), 'application/x-chess-pgn')}>Export PGN</button>
      <button
        onClick={() => {
          const n = prompt('Rename chapter', r.name);
          if (n?.trim()) void renameRepertoire(r.id, n.trim());
        }}
      >
        Rename…
      </button>
      <button
        className="danger"
        onClick={() => {
          if (confirm(`Delete “${r.name}”? Its lines go with it, and the training progress on moves no other chapter has.`)) void deleteRepertoire(r.id);
        }}
      >
        Delete…
      </button>
    </MoreMenu>
  );
}

/** The panel a chapter's menu opened, if its chapter is still there. */
export function ChapterPanelView({ panel, onClose }: { panel: ChapterPanel; onClose: () => void }) {
  const { chapters } = useChaptersAndSets();
  const graphs = useChapterGraphs();
  const chapter = panel && chapters?.find((c) => c.id === panel.id);
  if (!panel || !chapter || !chapters) return null;
  if (panel.kind === 'import') return <ImportPanel repId={chapter.id} onClose={onClose} />;
  if (panel.kind === 'merge') return <MergePanel chapter={chapter} chapters={chapters} onClose={onClose} />;
  const graph = graphs?.get(chapter.id);
  return graph ? <SuggestChapters chapter={chapter} graph={graph} onClose={onClose} /> : null;
}

/** A color's repertoires (saved sets of its chapters), with their counts. */
export function RepertoireSets({ color }: { color: Color }) {
  const { chapters, collections } = useChaptersAndSets();
  const graphs = useChapterGraphs();
  const cards = useCards();
  if (!chapters || !collections || !graphs || !cards) return null;
  if (!chapters.some((c) => c.color === color)) return null;
  const byId = new Map(cards.map((c) => [c.id, c]));
  /** Your moves in these chapters (shared moves once): how many, due, new. */
  const countsOf = (chapterIds: readonly string[]) => {
    const ids = new Set<string>();
    for (const id of chapterIds) for (const m of graphs.get(id)?.byId.values() ?? []) if (m.mine) ids.add(cardIdOf(m));
    const rc = [...ids].map((id) => byId.get(id)).filter((c): c is ReviewCard => !!c);
    return { total: rc.length, due: rc.filter((c) => isDue(c)).length, fresh: rc.filter(isNew).length };
  };
  return <Repertoires color={color} chapters={chapters} collections={collections.filter((c) => c.color === color)} graphs={graphs} countsOf={countsOf} />;
}

/** A small popover anchored to its button; closes on a click outside or Escape. */
function usePopover() {
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
  return { open, setOpen, box };
}

function NewChapterButton({ color: initial }: { color: Color }) {
  const { open, setOpen, box } = usePopover();
  const [name, setName] = useState('');
  const [color, setColor] = useState<Color>(initial);
  useEffect(() => setColor(initial), [initial]);
  const create = async () => {
    const rep = await createRepertoire(name || (color === 'white' ? 'New White chapter' : 'New Black chapter'), color);
    setName('');
    setOpen(false);
    navigate(`repertoire/${rep.id}`);
  };
  return (
    <div className="pop-anchor" ref={box}>
      <button onClick={() => setOpen(!open)} aria-expanded={open}>
        + New chapter
      </button>
      {open && (
        <div className="pop-box col" style={{ gap: 8 }}>
          <input
            autoFocus
            placeholder="Name, e.g. “Italian”"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
          />
          <div className="row">
            <select value={color} onChange={(e) => setColor(e.target.value as Color)}>
              <option value="white">I play White</option>
              <option value="black">I play Black</option>
            </select>
            <span className="spacer" />
            <button className="primary small" onClick={create}>
              Create
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** What chapters and repertoires are — on demand, not taking up the page. */
function HelpButton() {
  const { open, setOpen, box } = usePopover();
  return (
    <div className="pop-anchor" ref={box}>
      <button className="help-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="What are chapters and repertoires?">
        ?
      </button>
      {open && (
        <div className="pop-box help-pop">
          <p>
            A <b>chapter</b> is one opening, from the first move — “Italian”, “Caro-Kann, Exchange”. A move that's in several chapters is
            learned once: your progress belongs to positions, not chapters.
          </p>
          <p>
            <b>Open all</b> shows every chapter of a color as one tree in the studio; moves you add there go into the chapter they belong to
            (or a new one named after the opening).
          </p>
          <p style={{ marginBottom: 0 }}>
            A <b>repertoire</b> is a set of chapters you play together — to cram before a tournament. Training “All White” covers every White
            chapter.
          </p>
        </div>
      )}
    </div>
  );
}

function Counts({ total, due, fresh }: { total: number; due: number; fresh: number }) {
  return (
    <div className="list-meta">
      <span title="Your moves to know">
        {total} move{total === 1 ? '' : 's'}
      </span>
      {due > 0 && <span className="badge due">{due} due</span>}
      {fresh > 0 && <span className="badge new">{fresh} new</span>}
    </div>
  );
}

/** Merge a chapter into another of its color. */
function MergePanel({ chapter, chapters, onClose }: { chapter: Chapter; chapters: Chapter[]; onClose: () => void }) {
  const options = chapters.filter((c) => c.color === chapter.color && c.id !== chapter.id).sort(byName);
  const [into, setInto] = useState(options[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);
  return (
    <div className="panel col merge-panel" ref={box} style={{ gap: 10 }}>
      <div className="row">
        <h2 style={{ margin: 0 }}>Merge “{chapter.name}”</h2>
        <span className="spacer" />
        <button className="ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {options.length === 0 ? (
        <div className="note">No other {colorName(chapter.color)} chapter to merge it into.</div>
      ) : (
        <>
          <div className="row">
            <span>into</span>
            <select value={into} onChange={(e) => setInto(e.target.value)} style={{ flex: '1 1 240px' }}>
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            Its moves and notes join that chapter and “{chapter.name}” goes away; repertoires that had it get the other chapter instead.
            Your progress is kept.
          </p>
          {error && <div className="error">{error}</div>}
          <div className="row">
            <span className="spacer" />
            <button className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={!into}
              onClick={async () => {
                try {
                  await mergeChapter(chapter.id, into);
                  onClose();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Merge
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ repertoires */

function Repertoires({
  color,
  chapters,
  collections,
  graphs,
  countsOf,
}: {
  color: Color;
  chapters: Chapter[];
  collections: Collection[];
  graphs: Map<string, RepGraph>;
  countsOf: (ids: readonly string[]) => { total: number; due: number; fresh: number };
}) {
  // null: closed; 'new': creating one; otherwise the id of the one being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const name = (id: string) => chapters.find((c) => c.id === id)?.name ?? '?';
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row">
        <h2 style={{ margin: 0 }}>{colorName(color)} repertoires</h2>
        <span className="spacer" />
        {editing !== 'new' && (
          <button className="small" onClick={() => setEditing('new')}>
            New repertoire
          </button>
        )}
      </div>
      {editing === 'new' && <CollectionEditor chapters={chapters} defaultColor={color} onDone={() => setEditing(null)} />}
      {collections.length === 0 && editing !== 'new' && (
        <p className="muted small" style={{ margin: 0 }}>
          None yet. Make one when you want to train just some chapters together — say an Exchange Caro-Kann and an Italian for one
          tournament, the Fantasy and the Italian for the next.
        </p>
      )}
      {collections.length > 0 && (
        <div className="panel list">
          {collections.map((set) => {
            const ids = set.chapterIds.filter((id) => graphs.has(id));
            const conflicts = chapterConflicts(
              set.color,
              ids.flatMap((id) => [...(graphs.get(id)?.byId.values() ?? [])]),
            );
            if (editing === set.id) return <CollectionEditor key={set.id} chapters={chapters} set={set} onDone={() => setEditing(null)} />;
            return (
              <div key={set.id} className="list-item">
                <div className="list-main">
                  <div className="list-head">
                    <ColorPill color={set.color} />
                    <span className="list-title">{set.name}</span>
                  </div>
                  <div className="list-meta">
                    {ids.length ? ids.map((id) => <span key={id} className="chip">{name(id)}</span>) : <span>No chapters</span>}
                  </div>
                  <Counts {...countsOf(ids)} />
                  {conflicts.length > 0 && <Conflicts conflicts={conflicts} name={name} />}
                </div>
                <div className="list-buttons">
                  <a className="btn small" href={href('train', { rep: repertoireScopeId(set.id), mode: 'review' })}>
                    Train
                  </a>
                  <button className="small" onClick={() => setEditing(set.id)}>
                    Edit
                  </button>
                  <MoreMenu>
                    <button onClick={() => openScope(repertoireScopeId(set.id))}>Map</button>
                    <button
                      className="danger"
                      onClick={() => {
                        if (confirm(`Delete the repertoire “${set.name}”? Its chapters and your progress stay.`)) deleteCollection(set.id);
                      }}
                    >
                      Delete…
                    </button>
                  </MoreMenu>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Positions where the repertoire's chapters give you different moves. */
function Conflicts({ conflicts, name }: { conflicts: ChapterConflict[]; name: (id: string) => string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="conflicts">
      <button className="ghost small conflicts-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        ⚠ Chapters disagree in {conflicts.length} position{conflicts.length === 1 ? '' : 's'} {open ? '▴' : '▾'}
      </button>
      {open && (
        <ul className="conflicts-list">
          {conflicts.slice(0, 12).map((c) => (
            <li key={c.key}>
              <span className="muted">after {formatLine(c.path) || 'the start'}:</span>{' '}
              {c.options.map((o, i) => (
                <span key={o.san}>
                  {i > 0 && ' · '}
                  <b>{o.san}</b> <span className="muted">({o.chapters.map(name).join(', ')})</span>
                </span>
              ))}
            </li>
          ))}
          {conflicts.length > 12 && <li className="muted">…and {conflicts.length - 12} more</li>}
        </ul>
      )}
    </div>
  );
}

function CollectionEditor({ chapters, set, defaultColor = 'white', onDone }: { chapters: Chapter[]; set?: Collection; defaultColor?: Color; onDone: () => void }) {
  const [name, setName] = useState(set?.name ?? '');
  const [color, setColor] = useState<Color>(set?.color ?? defaultColor);
  const [picked, setPicked] = useState<Set<string>>(new Set(set?.chapterIds ?? []));
  const options = chapters.filter((c) => c.color === color);
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const save = async () => {
    const ids = options.filter((c) => picked.has(c.id)).map((c) => c.id);
    if (set) await updateCollection(set.id, { name: name.trim() || set.name, chapterIds: ids });
    else await createCollection(name, color, ids);
    onDone();
  };
  return (
    <div className="panel col collection-editor" style={{ gap: 10 }}>
      <div className="row">
        <input placeholder="Name, e.g. “November open”" value={name} onChange={(e) => setName(e.target.value)} style={{ minWidth: 240 }} autoFocus />
        {!set && (
          <select value={color} onChange={(e) => setColor(e.target.value as Color)}>
            <option value="white">White</option>
            <option value="black">Black</option>
          </select>
        )}
      </div>
      {options.length === 0 ? (
        <p className="muted small">No {colorName(color)} chapters yet.</p>
      ) : (
        <div className="collection-picks">
          {options.map((c) => (
            <label key={c.id} className="check">
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
              {c.name}
            </label>
          ))}
        </div>
      )}
      <div className="row">
        <button className="primary small" onClick={save} disabled={!options.some((c) => picked.has(c.id))}>
          {set ? 'Save' : 'Create'}
        </button>
        <button className="small ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- import */

export function ImportPanel({ repId, onClose }: { repId: string; onClose: () => void }) {
  const rep = useLiveQuery(() => db.repertoires.get(repId), [repId]);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [repId]);
  const [text, setText] = useState('');
  const [study, setStudy] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const run = async (pgn: string) => {
    setBusy(true);
    setResult(null);
    setErrors([]);
    try {
      const r = await importPgn(repId, pgn);
      setResult(`Imported ${r.games} game(s)/chapter(s): ${r.mineAdded} new move${r.mineAdded === 1 ? '' : 's'} to learn.`);
      setErrors(r.errors);
    } catch (e) {
      setErrors([(e as Error).message]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" ref={panelRef} style={{ scrollMarginTop: 12 }}>
      <div className="row">
        <h2>Import into “{rep?.name}”</h2>
        <span className="spacer" />
        <button className="ghost" onClick={onClose}>
          ✕
        </button>
      </div>
      <p className="muted">
        Paste PGN (variations and comments are kept), upload a .pgn file, or pull a public Lichess study. Moves merge into the chapter;
        transpositions are joined automatically.
      </p>
      <div className="col">
        <textarea rows={6} placeholder="1. e4 c5 2. Nf3 (2. c3 d5) d6 3. d4 ..." value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row">
          <button className="primary" disabled={busy || !text.trim()} onClick={() => run(text)}>
            Import PGN
          </button>
          <label className="btn">
            Upload .pgn
            <input
              type="file"
              accept=".pgn,text/plain"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) run(await f.text());
              }}
            />
          </label>
          <span className="spacer" />
          <input placeholder="https://lichess.org/study/…" value={study} onChange={(e) => setStudy(e.target.value)} style={{ minWidth: 260 }} />
          <button
            disabled={busy || !study.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await run(await fetchLichessStudy(study));
              } catch (e) {
                setErrors([(e as Error).message]);
                setBusy(false);
              }
            }}
          >
            Import study
          </button>
        </div>
        {result && <div className="note">{result}</div>}
        {errors.length > 0 && (
          <div className="error">
            {errors.slice(0, 8).map((e, i) => (
              <div key={i}>{e}</div>
            ))}
            {errors.length > 8 && <div>…and {errors.length - 8} more</div>}
          </div>
        )}
      </div>
    </div>
  );
}
