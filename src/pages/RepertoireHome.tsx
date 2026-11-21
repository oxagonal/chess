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
import { COLORS, colorName, repertoireScopeId, scopeOf, useChaptersAndSets } from '../db/scopes';
import { useSettings } from '../db/settings';
import { isCoverageFresh } from '../services/coverage';
import { oneIn } from '../lib/coverage';
import { linePaths } from '../lib/map';
import { useCards, useChapterGraphs, useCoverage } from '../hooks';
import { byName, cardIdOf, chapterConflicts, chapterGap, chapterPosition, type ChapterConflict } from '../lib/chapters';
import { compactLine, formatLine, type Color } from '../lib/chess';
import { isDue, isNew } from '../lib/srs';
import type { Chapter, Collection, CoverageResult, ReviewCard } from '../lib/types';
import type { RepGraph } from '../lib/graph';
import { ColorPill, Empty, MoreMenu } from '../components/ui';
import { download } from '../services/backup';
import { href, navigate } from '../router';
import { SuggestChapters } from '../components/SuggestChapters';
import { ImportWizard } from '../components/ImportWizard';
import { ChapterTree, useOpeningIndex } from '../components/ChapterTree';
import type { OpeningIndex } from '../lib/openingNames';

/**
 * The Repertoire page: your chapters (one opening each, by color) and your repertoires (saved sets of
 * chapters, e.g. what you'll play at a tournament).
 */
export function RepertoireHome({ query }: { query: URLSearchParams }) {
  const { chapters, collections } = useChaptersAndSets();
  const graphs = useChapterGraphs();
  const cards = useCards();
  const [importing, setImporting] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState<string | null>(null);
  const [merging, setMerging] = useState<string | null>(null);
  const [wizard, setWizard] = useState(false);
  const settings = useSettings();
  const covWhite = useCoverage('white');
  const covBlack = useCoverage('black');
  const names = useOpeningIndex();
  if (!chapters || !collections || !graphs || !cards) return null;

  // Each color's coverage run, if it's up to date: it gives every chapter's biggest gap.
  const freshCov = (color: Color): CoverageResult | undefined => {
    const run = color === 'white' ? covWhite : covBlack;
    const scope = settings.loaded ? scopeOf(color, chapters, collections, settings) : undefined;
    return scope && run && isCoverageFresh(run, scope, settings) ? run : undefined;
  };
  const color: Color = query.get('color') === 'black' || (query.get('color') !== 'white' && !chapters.some((c) => c.color === 'white')) ? 'black' : 'white';
  const tabs = (
    <div className="row rep-head">
      <h1 style={{ margin: 0 }}>Repertoire</h1>
      <HelpButton />
      <span className="spacer" />
      <a className="btn primary" href={href(`repertoire/${color}`)} title={`Every ${colorName(color)} chapter as one tree, in the studio — new moves go into the chapter they belong to`}>
        Open all {colorName(color)}
      </a>
      <NewChapterButton color={color} />
      <button onClick={() => setWizard(true)} title="Import a Lichess study (yours too, private or unlisted) or a PGN">
        Import
      </button>
      <a className="btn" href={href(`map/${color}`)} title={`How well you know your ${colorName(color)} chapters, the gaps in them and your weakest moves`}>
        Map
      </a>
    </div>
  );
  // Chapters are shown one color at a time.
  const colorSwitch = (
    <div className="segmented" role="group" aria-label="Color">
      {COLORS.map((c) => (
        <button key={c} className={`small ${c === color ? 'active' : ''}`} onClick={() => navigate('repertoire', { color: c })}>
          {colorName(c)}
        </button>
      ))}
    </div>
  );
  const shown = chapters.filter((c) => c.color === color);

  /** Card ids of your moves in these chapters (shared moves once). */
  const cardIdsOf = (chapterIds: readonly string[]) => {
    const ids = new Set<string>();
    for (const id of chapterIds) for (const m of graphs.get(id)?.byId.values() ?? []) if (m.mine) ids.add(cardIdOf(m));
    return ids;
  };
  const byId = new Map(cards.map((c) => [c.id, c]));
  const countsOf = (chapterIds: readonly string[]) => {
    const rc = [...cardIdsOf(chapterIds)].map((id) => byId.get(id)).filter((c): c is ReviewCard => !!c);
    return { total: rc.length, due: rc.filter((c) => isDue(c)).length, fresh: rc.filter(isNew).length };
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      {tabs}
      {wizard && <ImportWizard chapters={chapters} onClose={() => setWizard(false)} />}

      <div className="row">{colorSwitch}</div>
      {shown.length === 0 && <Empty>No {colorName(color)} chapters yet — add one with New chapter, import a Lichess study, or open all {colorName(color)} and start playing moves.</Empty>}
      {shown.length > 0 && (
        <div className="col" style={{ gap: 8 }}>
          <div className="row">
            <h2 style={{ margin: 0 }}>{colorName(color)} chapters</h2>
            <span className="spacer" />
            {!freshCov(color) && (
              <a className="small muted" href={href(`map/${color}`)}>
                Run Coverage for {colorName(color)} (on the Map) to see each chapter's biggest gap →
              </a>
            )}
          </div>
          <ChapterTree
            color={color}
            chapters={chapters}
            graphs={graphs}
            storageKey="repertoire"
            summary={(ids) => <Badges {...countsOf(ids)} />}
            row={(ch, label) => (
              <ChapterRow
                chapter={ch}
                label={label}
                graph={graphs.get(ch.id)}
                names={names}
                coverage={freshCov(color)}
                counts={countsOf([ch.id])}
                onImport={() => setImporting(importing === ch.id ? null : ch.id)}
                onSuggest={() => setSuggesting(suggesting === ch.id ? null : ch.id)}
                onMerge={() => setMerging(merging === ch.id ? null : ch.id)}
              />
            )}
          />
        </div>
      )}
      {importing && <ImportPanel repId={importing} onClose={() => setImporting(null)} />}
      {merging && chapters.some((c) => c.id === merging) && (
        <MergePanel chapter={chapters.find((c) => c.id === merging)!} chapters={chapters} onClose={() => setMerging(null)} />
      )}
      {suggesting && graphs.get(suggesting) && chapters.some((c) => c.id === suggesting) && (
        <SuggestChapters chapter={chapters.find((c) => c.id === suggesting)!} graph={graphs.get(suggesting)!} onClose={() => setSuggesting(null)} />
      )}

      {shown.length > 0 && (
        <Repertoires color={color} chapters={chapters} collections={collections.filter((c) => c.color === color)} graphs={graphs} countsOf={countsOf} />
      )}
    </div>
  );
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

/** Due / new badges for a group header. */
function Badges({ due, fresh }: { total: number; due: number; fresh: number }) {
  return (
    <>
      {due > 0 && <span className="badge due">{due} due</span>}
      {fresh > 0 && <span className="badge new">{fresh} new</span>}
    </>
  );
}

function ChapterRow({
  chapter: r,
  label,
  graph,
  names,
  coverage,
  counts,
  onImport,
  onSuggest,
  onMerge,
}: {
  chapter: Chapter;
  label: string;
  graph?: RepGraph;
  names?: OpeningIndex;
  /** Its color's coverage run, when up to date. */
  coverage?: CoverageResult;
  counts: { total: number; due: number; fresh: number };
  onImport: () => void;
  onSuggest: () => void;
  onMerge: () => void;
}) {
  const lines = graph ? linePaths(graph).filter((l) => l.some((m) => m.mine)).length : 0;
  const opening = graph ? chapterPosition(graph, names, r.name).moves.map((m) => m.san) : [];
  const gap = graph && coverage ? chapterGap(graph, coverage, names, r.name) : undefined;
  const target = coverage ? Math.round(1 / coverage.threshold) : 0;
  const gapTitle = gap
    ? `Biggest gap: ${compactLine(gap.sans)} — ${oneIn(gap.prob)} games${gap.inChapter !== undefined ? `, ${oneIn(gap.inChapter)} of games in this opening` : ''}. ` +
      (gap.beyondTarget ? `Rarer than your target (1 in ${target}): you're prepared as deep as you asked.` : `Within your target (1 in ${target}): worth preparing.`)
    : '';
  return (
    <div className="list-item chapter-row">
      <div className="list-main">
        <div className="list-head">
          <a className="list-title" href={href(`repertoire/${r.id}`)} title={r.name}>
            {label}
          </a>
          {opening.length > 0 && (
            <a className="chapter-pos" href={href(`repertoire/${r.id}`, { line: opening.join(' ') })} title="The position that defines this chapter's opening">
              {compactLine(opening)}
            </a>
          )}
        </div>
        <div className="list-meta">
          <span title={`${counts.total} of your moves to know, across ${lines} line${lines === 1 ? '' : 's'}`}>
            {counts.total} move{counts.total === 1 ? '' : 's'} · {lines} line{lines === 1 ? '' : 's'}
          </span>
          {counts.due > 0 && <span className="badge due">{counts.due} due</span>}
          {counts.fresh > 0 && <span className="badge new">{counts.fresh} new</span>}
          {gap && (
            <a className={`gap-chip ${gap.beyondTarget ? 'good' : 'warn'}`} href={href(`repertoire/${r.id}`, { line: gap.sans.join(' ') })} title={gapTitle}>
              gap <b>{oneIn(gap.prob)}</b>
              {gap.inChapter !== undefined && (
                <>
                  {' · '}
                  <b>{oneIn(gap.inChapter)}</b> in this opening
                </>
              )}
            </a>
          )}
          {coverage && !gap && <span className="gap-chip good">no gaps found</span>}
        </div>
      </div>
      <div className="list-buttons">
        <a className="btn small" href={href(`repertoire/${r.id}`)}>
          Edit
        </a>
        <a className="btn small" href={href('train', { rep: r.id, mode: 'review' })}>
          Train
        </a>
        <MoreMenu>
          <button onClick={onSuggest}>Split into chapters…</button>
          <button onClick={onMerge}>Merge into…</button>
          <button onClick={onImport}>Import PGN or study…</button>
          <button onClick={async () => download(`${r.name.replace(/[^\w-]+/g, '_')}.pgn`, await exportPgn(r.id), 'application/x-chess-pgn')}>Export PGN</button>
          <button
            onClick={() => {
              const n = prompt('Rename chapter', r.name);
              if (n) renameRepertoire(r.id, n);
            }}
          >
            Rename…
          </button>
          <button
            className="danger"
            onClick={() => {
              if (confirm(`Delete “${r.name}”? Training progress on moves no other chapter has goes with it.`)) deleteRepertoire(r.id);
            }}
          >
            Delete…
          </button>
        </MoreMenu>
      </div>
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
                    <button onClick={() => navigate(`map/${repertoireScopeId(set.id)}`)}>Map</button>
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
