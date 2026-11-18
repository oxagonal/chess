import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { useSettings } from '../db/settings';
import { colorName } from '../db/scopes';
import { startOfToday, useCards, useChapterGraphs } from '../hooks';
import { chapterLines, STRENGTH_HINT, STRENGTH_LABEL, STRENGTHS, strengthCounts, strengthHistory, type MapLine, type Strength } from '../lib/map';
import { formatLine, type Color } from '../lib/chess';
import { formatInterval } from '../lib/srs';
import type { Chapter, Collection } from '../lib/types';
import { MiniBoard } from '../components/MiniBoard';
import { StrengthChart } from '../components/StrengthChart';
import { Empty } from '../components/ui';
import { href, navigate } from '../router';

const DAY = 86_400_000;
const rank = (s: Strength) => STRENGTHS.indexOf(s);

interface ChapterMap {
  chapter: Chapter;
  lines: MapLine[];
  /** 0 (nothing learned) … 1 (every line solid). */
  score: number;
}

/**
 * The repertoire as a map: one card per chapter, one square per line, colored by how well you know
 * it (its weakest move). Hover or tap a square for the line, its position and what's due.
 */
export function RepertoireMap({
  color,
  setId,
  chapters,
  collections,
}: {
  color: Color;
  setId?: string;
  chapters: Chapter[];
  collections: Collection[];
}) {
  const graphs = useChapterGraphs();
  const cards = useCards();
  const settings = useSettings();
  const logs = useLiveQuery(() => db.reviewLog.where('color').equals(color).toArray(), [color]);
  const [order, setOrder] = useState<'weakest' | 'strongest'>('weakest');
  const set = collections.find((c) => c.id === setId && c.color === color);
  const shown = chapters.filter((c) => c.color === color && (!set || set.chapterIds.includes(c.id)));

  const now = Date.now();
  const today = startOfToday();
  const maps = useMemo<ChapterMap[] | undefined>(() => {
    if (!graphs || !cards) return undefined;
    const byId = new Map(cards.map((c) => [c.id, c]));
    return shown.map((chapter) => {
      const g = graphs.get(chapter.id);
      const lines = g ? chapterLines(g, byId, now, today) : [];
      const score = lines.length ? lines.reduce((a, l) => a + rank(l.strength), 0) / (lines.length * (STRENGTHS.length - 1)) : 0;
      return { chapter, lines, score };
    });
    // `now` changes every render; the cards and graphs are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphs, cards, shown.map((c) => c.id).join(), today]);
  const allLines = useMemo(() => maps?.flatMap((m) => m.lines) ?? [], [maps]);
  const history = useMemo(
    () =>
      logs && allLines.length
        ? strengthHistory(allLines, logs, { requestRetention: settings.requestRetention, maximumIntervalDays: settings.maxIntervalDays }, 30, Date.now(), today)
        : [],
    [allLines, logs, settings.requestRetention, settings.maxIntervalDays, today],
  );

  if (!maps) return null;
  const go = (q: Record<string, string | undefined>) => navigate('repertoire', { view: 'map', color, set: setId, ...q });
  const sorted = [...maps].sort((a, b) => (a.lines.length ? 0 : 1) - (b.lines.length ? 0 : 1) || (order === 'weakest' ? a.score - b.score : b.score - a.score));
  const counts = strengthCounts(allLines);
  const total = allLines.length;
  const due = allLines.filter((l) => l.due).length;

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row">
        <div className="segmented" role="group" aria-label="Color">
          {(['white', 'black'] as Color[]).map((c) => (
            <button key={c} className={`small ${c === color ? 'active' : ''}`} onClick={() => go({ color: c, set: undefined })}>
              {colorName(c)}
            </button>
          ))}
        </div>
        {collections.some((c) => c.color === color) && (
          <select value={set?.id ?? ''} onChange={(e) => go({ set: e.target.value || undefined })} aria-label="Repertoire">
            <option value="">All {colorName(color)} chapters</option>
            {collections
              .filter((c) => c.color === color)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        )}
      </div>

      {total === 0 ? (
        <Empty>No {colorName(color)} lines yet.</Empty>
      ) : (
        <>
          <div className="panel map-summary">
            <div className="map-eyebrow">
              Map · {set ? set.name : `${colorName(color)} chapters`}
            </div>
            <div className="map-hero">
              <span className="map-hero-num">{Math.round((counts.solid / total) * 100)}%</span>
              <span className="muted">
                solid — {counts.solid} of {total} line{total === 1 ? '' : 's'}
              </span>
            </div>
            <div className="map-tiles">
              <Tile value={due} label="due now" />
              <Tile value={counts.lapsed} label="lapsed" />
              <Tile value={counts.new} label="not learned" />
            </div>
            <StrengthBar counts={counts} />
          </div>

          {history.length > 1 && (
            <div className="panel">
              <h3 style={{ marginTop: 0 }}>Lines in rotation, by strength</h3>
              <StrengthChart data={history} />
              <Legend chart />
            </div>
          )}

          <div className="row">
            <h2 style={{ margin: 0 }}>Chapters, {order} first</h2>
            <span className="spacer" />
            <div className="seg" role="group" aria-label="Order">
              <button className={`small ${order === 'weakest' ? 'active' : ''}`} onClick={() => setOrder('weakest')}>
                Weakest first
              </button>
              <button className={`small ${order === 'strongest' ? 'active' : ''}`} onClick={() => setOrder('strongest')}>
                Strongest first
              </button>
            </div>
          </div>
          <Legend />
          <ChapterCards maps={sorted} color={color} />
        </>
      )}
    </div>
  );
}

function Tile({ value, label }: { value: number; label: string }) {
  return (
    <div className="map-tile">
      <b>{value}</b>
      <span className="muted small">{label}</span>
    </div>
  );
}

function StrengthBar({ counts, slim = false }: { counts: Record<Strength, number>; slim?: boolean }) {
  const total = STRENGTHS.reduce((a, s) => a + counts[s], 0) || 1;
  const order: Strength[] = ['solid', 'growing', 'learning', 'lapsed', 'new'];
  return (
    <div className={`str-bar ${slim ? 'slim' : ''}`} aria-hidden="true">
      {order
        .filter((s) => counts[s] > 0)
        .map((s) => (
          <span key={s} className={`str-seg str-${s}`} style={{ flexGrow: counts[s] / total }} title={`${STRENGTH_LABEL[s]}: ${counts[s]}`} />
        ))}
    </div>
  );
}

function Legend({ chart = false }: { chart?: boolean }) {
  const items: Strength[] = chart ? ['solid', 'growing', 'learning', 'lapsed'] : ['new', 'lapsed', 'learning', 'growing', 'solid'];
  return (
    <div className="map-legend">
      {items.map((s) => (
        <span key={s} title={STRENGTH_HINT[s]}>
          <span className={`str-swatch str-${s}`} /> {STRENGTH_LABEL[s]}
          {!chart && s === 'learning' && <span className="muted"> &lt;1 wk</span>}
          {!chart && s === 'growing' && <span className="muted"> 1–4 wk</span>}
          {!chart && s === 'solid' && <span className="muted"> 1 mo+</span>}
        </span>
      ))}
      {!chart && (
        <>
          <span>
            <span className="str-swatch str-growing due" /> Hollow = due
          </span>
          <span>
            <span className="str-swatch str-solid today" /> Practiced today
          </span>
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- squares */

type Open = { chapter: Chapter; line: MapLine; index: number; rect: DOMRect; pinned: boolean };

function ChapterCards({ maps, color }: { maps: ChapterMap[]; color: Color }) {
  const [open, setOpen] = useState<Open | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keep = () => clearTimeout(closeTimer.current);
  const leave = useCallback(() => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen((o) => (o?.pinned ? o : null)), 160);
  }, []);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open]);

  return (
    <>
      {maps.map(({ chapter, lines }) => {
        const counts = strengthCounts(lines);
        const dueCount = lines.filter((l) => l.due).length;
        const practice = () =>
          dueCount
            ? navigate('train', { rep: chapter.id, mode: 'review', t: String(Date.now()) })
            : counts.new
              ? navigate('train', { rep: chapter.id, mode: 'learn', t: String(Date.now()) })
              : navigate('train', { rep: chapter.id, mode: 'drill', t: String(Date.now()) });
        return (
          <div key={chapter.id} className="panel map-chapter">
            <div className="row map-chapter-head">
              <a className="map-chapter-name" href={href(`repertoire/${chapter.id}`)}>
                {chapter.name}
              </a>
              <span className="muted small">
                {lines.length} line{lines.length === 1 ? '' : 's'}
              </span>
              <span className="spacer" />
              {lines.length > 0 && <StrengthBar counts={counts} slim />}
              {lines.length > 0 && (
                <button className="small ghost" onClick={practice}>
                  {dueCount ? `Review ${dueCount} due ▸` : counts.new ? 'Learn new ▸' : 'Drill weakest ▸'}
                </button>
              )}
            </div>
            {lines.length === 0 ? (
              <div className="muted small">No lines yet — add moves in the builder.</div>
            ) : (
              <div className="map-squares">
                {lines.map((line, i) => (
                  <button
                    key={line.id}
                    className={`sq str-${line.strength} ${line.due ? 'due' : ''} ${line.today ? 'today' : ''} ${open?.line.id === line.id ? 'open' : ''}`}
                    aria-label={`Line ${i + 1}: ${formatLine(line.path.map((m) => m.san))} — ${STRENGTH_LABEL[line.strength]}${line.due ? ', due' : ''}`}
                    onMouseEnter={(e) => {
                      keep();
                      const rect = e.currentTarget.getBoundingClientRect();
                      setOpen((o) => (o?.pinned ? o : { chapter, line, index: i, rect, pinned: false }));
                    }}
                    onMouseLeave={leave}
                    onFocus={(e) => setOpen({ chapter, line, index: i, rect: e.currentTarget.getBoundingClientRect(), pinned: false })}
                    onBlur={leave}
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      setOpen((o) => (o?.pinned && o.line.id === line.id ? null : { chapter, line, index: i, rect, pinned: true }));
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {open && <LinePopover open={open} color={color} onEnter={keep} onLeave={leave} onClose={() => setOpen(null)} />}
    </>
  );
}

function LinePopover({ open, color, onEnter, onLeave, onClose }: { open: Open; color: Color; onEnter: () => void; onLeave: () => void; onClose: () => void }) {
  const { chapter, line } = open;
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: open.rect.right + 8, top: open.rect.top });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const right = open.rect.right + 8;
    const left = right + width > window.innerWidth - 8 ? Math.max(8, open.rect.left - width - 8) : right;
    setPos({ left, top: Math.max(8, Math.min(open.rect.top - 20, window.innerHeight - height - 8)) });
  }, [open.rect]);
  useEffect(() => {
    if (!open.pinned) return;
    const away = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!box.current?.contains(t) && !t.closest('.sq')) onClose();
    };
    const id = setTimeout(() => window.addEventListener('pointerdown', away), 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener('pointerdown', away);
    };
  }, [open.pinned, onClose]);

  const sans = line.path.map((m) => m.san);
  const end = line.path[line.path.length - 1];
  const nextDue = line.cards.filter((c) => c.state !== 0).reduce((a, c) => Math.min(a, c.due), Infinity);
  const status =
    line.strength === 'new' && !line.due
      ? 'Not learned'
      : line.due
        ? line.overdueDays > 0
          ? `Overdue ${line.overdueDays}d`
          : 'Due today'
        : Number.isFinite(nextDue)
          ? `Due in ${formatInterval(nextDue - Date.now())}`
          : '—';
  return (
    <div className="map-pop" ref={box} style={pos} onMouseEnter={onEnter} onMouseLeave={onLeave} role="dialog" aria-label={`Line ${open.index + 1} of ${chapter.name}`}>
      <div className="map-eyebrow">{chapter.name}</div>
      <div className="map-pop-title">Line {open.index + 1}</div>
      <div className="map-pop-moves mono">{formatLine(sans)}</div>
      <div className="map-pop-body">
        <MiniBoard fen={end.toKey} orientation={color} size={148} />
        <dl className="map-pop-stats">
          <dt>Strength</dt>
          <dd>
            <span className={`str-swatch str-${line.strength}`} /> {STRENGTH_LABEL[line.strength]}
          </dd>
          <dt>Interval</dt>
          <dd>{line.interval !== undefined ? formatInterval(Math.max(DAY / 24, line.interval)) : '—'}</dd>
          <dt>Status</dt>
          <dd className={line.due ? 'warn' : ''}>{status}</dd>
          <dt>Reviews</dt>
          <dd>{line.reviews}</dd>
          <dt>Length</dt>
          <dd>{Math.ceil(line.path.length / 2)} moves</dd>
        </dl>
      </div>
      <div className="row map-pop-actions">
        <button className="primary small" onClick={() => navigate('train', { rep: chapter.id, mode: 'drill', at: end.toKey, t: String(Date.now()) })}>
          Practice ▸
        </button>
        <button className="small" onClick={() => navigate(`repertoire/${chapter.id}`, { line: sans.join(' ') })}>
          Open in builder
        </button>
      </div>
    </div>
  );
}
