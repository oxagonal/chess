import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { useSettings } from '../db/settings';
import { colorName, repertoireScopeId, scopeOf } from '../db/scopes';
import { startOfToday, useCards, useChapterGraphs, useCoverage } from '../hooks';
import { chapterLines, STRENGTH_HINT, STRENGTH_LABEL, STRENGTHS, strengthHistory, type MapLine, type Strength } from '../lib/map';
import { chapterPosition } from '../lib/chapters';
import { compactLine, formatLine, START_KEY, type Color } from '../lib/chess';
import type { Chapter, Collection, CoverageResult } from '../lib/types';
import { isCoverageFresh } from '../services/coverage';
import { LineCard } from '../components/LineCard';
import { Empty } from '../components/ui';
import { ChapterTree, useOpeningIndex } from '../components/ChapterTree';
import type { RepGraph } from '../lib/graph';
import { href, navigate } from '../router';

/** Known well: the next review is a week or more away. */
const WELL: Strength[] = ['growing', 'solid'];
/** Strongest first, for bars and the legend. */
const ORDER: Strength[] = ['solid', 'growing', 'learning', 'lapsed', 'new'];

interface ChapterMap {
  chapter: Chapter;
  lines: MapLine[];
  /** Each line's weight: how often it comes up (its end position's reach), or 1 each without coverage. */
  weights: number[];
  /**
   * The games reaching the chapter's opening that leave its lines while still common (1 − the coverage
   * run's coverage of that position; 0 without a run), and that share as a weight beside the lines'.
   */
  uncovered: number;
  uncoveredWeight: number;
  /** Share of the chapter's games (by weight) that go down lines you know well. */
  ready: number;
}

/** Shares by strength and not covered, of some chapters together. */
function chapterShares(ms: readonly ChapterMap[]): { s: Record<Strength, number>; uncovered: number } {
  const lines = ms.flatMap((m) => m.lines);
  const weights = ms.flatMap((m) => m.weights);
  const off = ms.reduce((a, m) => a + m.uncoveredWeight, 0);
  const inLines = weights.reduce((a, w) => a + w, 0);
  const uncovered = inLines + off > 0 ? off / (inLines + off) : 0;
  return { s: scaled(shares(lines, weights), 1 - uncovered), uncovered };
}

/** Shares by strength, weighted. */
function shares(lines: readonly MapLine[], weights: readonly number[]): Record<Strength, number> {
  const out = Object.fromEntries(STRENGTHS.map((s) => [s, 0])) as Record<Strength, number>;
  const total = weights.reduce((a, w) => a + w, 0) || 1;
  lines.forEach((l, i) => (out[l.strength] += weights[i] / total));
  return out;
}
const readyOf = (s: Record<Strength, number>) => WELL.reduce((a, k) => a + s[k], 0);
const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Each chapter's lines with their weights (how often they come up, from the color's coverage run
 * when it's up to date; otherwise every line counts the same) and readiness — for the map and Home.
 */
export function useMapData(color: Color, chapters: Chapter[], collections: Collection[], setId?: string) {
  const graphs = useChapterGraphs();
  const cards = useCards();
  const settings = useSettings();
  const run = useCoverage(color);
  const set = collections.find((c) => c.id === setId && c.color === color);
  const setRun = useCoverage(set && repertoireScopeId(set.id));
  const shown = chapters.filter((c) => c.color === color && (!set || set.chapterIds.includes(c.id)));
  const scope = settings.loaded ? scopeOf(color, chapters, collections, settings) : undefined;
  const cov: CoverageResult | undefined = scope && run && isCoverageFresh(run, scope, settings) ? run : undefined;
  // The games your lines don't cover — from the run of what's shown (the color, or the repertoire):
  // one minus its coverage of the start position, as on the Coverage page.
  const setScope = set && settings.loaded ? scopeOf(repertoireScopeId(set.id), chapters, collections, settings) : undefined;
  const gapRun = set ? (setScope && setRun && isCoverageFresh(setRun, setScope, settings) ? setRun : undefined) : cov;
  const rootCoverage = gapRun?.coverage?.[START_KEY];
  const uncovered: Uncovered | undefined =
    gapRun && rootCoverage !== undefined
      ? { share: Math.min(1, Math.max(0, 1 - rootCoverage)), oneInN: Math.round(1 / gapRun.threshold), scopeId: gapRun.repId }
      : undefined;
  const today = startOfToday();
  const names = useOpeningIndex();
  const maps = useMemo<ChapterMap[] | undefined>(() => {
    if (!graphs || !cards) return undefined;
    const byId = new Map(cards.map((c) => [c.id, c]));
    const now = Date.now();
    return shown.map((chapter) => {
      const g = graphs.get(chapter.id);
      const lines = g ? chapterLines(g, byId, now, today) : [];
      // A line too rare for the run to price still shows, thinly.
      const weights = lines.map((l) => (cov ? Math.max(cov.probs[l.path[l.path.length - 1].toKey] ?? 0, 1e-5) : 1));
      // Not covered: from the chapter's opening (e.g. 1.e4 c5 for a Sicilian) — what the run says about
      // the games reaching it, with every chapter's moves counted (another chapter may answer a move).
      const at = g && lines.length && gapRun?.coverage ? gapRun.coverage[chapterPosition(g, names, chapter.name).key] : undefined;
      const uncovered = at === undefined ? 0 : Math.min(0.99, Math.max(0, 1 - at));
      const uncoveredWeight = (weights.reduce((a, w) => a + w, 0) * uncovered) / (1 - uncovered);
      return { chapter, lines, weights, uncovered, uncoveredWeight, ready: lines.length ? readyOf(shares(lines, weights)) * (1 - uncovered) : 0 };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphs, cards, shown.map((c) => c.id).join(), today, cov, gapRun, names]);
  const allLines = useMemo(() => maps?.flatMap((m) => m.lines) ?? [], [maps]);
  const allWeights = useMemo(() => maps?.flatMap((m) => m.weights) ?? [], [maps]);
  // With a run, shares of all your games (the lines' shares scaled to the games they cover).
  const inLines = shares(allLines, allWeights);
  const overall = uncovered ? scaled(inLines, 1 - uncovered.share) : inLines;
  return { graphs, maps, allLines, allWeights, cov, set, today, overall, uncovered };
}

/** The share of your games that leave your lines while still common (a coverage run's gaps). */
export interface Uncovered {
  share: number;
  /** The run's target: positions rarer than 1 in this many games don't count. */
  oneInN: number;
  /** The scope the run is for (its Coverage page lists the gaps). */
  scopeId: string;
}

function scaled(s: Record<Strength, number>, by: number): Record<Strength, number> {
  return Object.fromEntries(STRENGTHS.map((k) => [k, s[k] * by])) as Record<Strength, number>;
}

const uncoveredHint = (u: Pick<Uncovered, 'oneInN'>) =>
  `games that leave your lines while still common — at an opponent move you have no answer to, or a position with no move of yours, met at least 1 in ${u.oneInN} games`;

/** Share known well (growing or solid), weighted. */
export { readyOf, shares, WeightedBar };

/**
 * The repertoire as a map, weighted by how often things come up: how much of your games go down
 * lines you know well, and each chapter as a strip of its lines — each as wide as it is common in
 * your games, colored by how well you know its weakest move. Hover or tap a line for the details.
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
  const settings = useSettings();
  const logs = useLiveQuery(() => db.reviewLog.where('color').equals(color).toArray(), [color]);
  const [order, setOrder] = useState<'opening' | 'weakest' | 'strongest'>('opening');
  const { graphs, maps, allLines, cov, set, today, overall, uncovered } = useMapData(color, chapters, collections, setId);
  // A week ago vs now, in lines known well.
  const week = useMemo(() => {
    if (!logs || !allLines.length) return undefined;
    const h = strengthHistory(allLines, logs, { requestRetention: settings.requestRetention, maximumIntervalDays: settings.maxIntervalDays }, 8, Date.now(), today);
    const well = (d: (typeof h)[number]) => WELL.reduce((a, s) => a + d.counts[s], 0);
    return well(h[h.length - 1]) - well(h[0]);
  }, [allLines, logs, settings.requestRetention, settings.maxIntervalDays, today]);

  if (!maps) return null;
  const go = (q: Record<string, string | undefined>) => navigate('repertoire', { view: 'map', color, set: setId, ...q });
  const total = allLines.length;
  const due = allLines.filter((l) => l.due).length;
  const sorted = [...maps].sort((a, b) => (a.lines.length ? 0 : 1) - (b.lines.length ? 0 : 1) || (order === 'weakest' ? a.ready - b.ready : b.ready - a.ready));
  const scopeId = set ? `set:${set.id}` : color;

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
          <div className="panel readiness">
            <div className="readiness-head">
              <span className="readiness-num">{pct(readyOf(overall))}</span>
              <span className="readiness-text">
                {cov ? `of your ${colorName(color)} games go down lines you know well` : `of your ${colorName(color)} lines you know well`}
                {set ? ` · ${set.name}` : ''}
              </span>
              <span className="spacer" />
              {due > 0 && (
                <button className="primary small" onClick={() => navigate('train', { rep: scopeId, mode: 'review', t: String(Date.now()) })}>
                  Review {due} due line{due === 1 ? '' : 's'}
                </button>
              )}
            </div>
            <WeightedBar s={overall} uncovered={uncovered} />
            <div className="readiness-legend">
              {ORDER.map((s) => (
                <span key={s} title={STRENGTH_HINT[s]}>
                  <span className={`str-swatch str-${s}`} /> {STRENGTH_LABEL[s]} <b>{pct(overall[s])}</b>
                </span>
              ))}
              {uncovered && (
                <span title={uncoveredHint(uncovered)}>
                  <span className="str-swatch str-uncovered" /> Not covered <b>{pct(uncovered.share)}</b>
                </span>
              )}
            </div>
            <div className="muted small">
              {cov ? 'Weighted by how often each line comes up in your games.' : 'Every line counts the same — run Coverage to weight them by how often they come up.'}
              {uncovered && uncovered.share > 0 && (
                <>
                  {' '}
                  <b>Not covered</b>: games that leave your lines while still common (1 in {uncovered.oneInN} or more) —{' '}
                  <a href={href(`coverage/${uncovered.scopeId}`)}>see the gaps</a>.
                </>
              )}
              {week !== undefined && week !== 0 && (
                <>
                  {' '}
                  This week: <b className={week > 0 ? 'good-text' : 'warn-text'}>{week > 0 ? `+${week}` : week}</b> line{Math.abs(week) === 1 ? '' : 's'} known well.
                </>
              )}
            </div>
          </div>

          <div className="row">
            <h2 style={{ margin: 0 }}>Chapters</h2>
            <span className="muted small">{cov ? 'width = how often a line comes up · hollow = due' : 'hollow = due'}</span>
            <span className="spacer" />
            <div className="seg" role="group" aria-label="Order">
              <button className={`small ${order === 'opening' ? 'active' : ''}`} onClick={() => setOrder('opening')}>
                By opening
              </button>
              <button className={`small ${order === 'weakest' ? 'active' : ''}`} onClick={() => setOrder('weakest')}>
                Weakest first
              </button>
              <button className={`small ${order === 'strongest' ? 'active' : ''}`} onClick={() => setOrder('strongest')}>
                Strongest first
              </button>
            </div>
          </div>
          <ChapterStrips maps={sorted} color={color} graphs={order === 'opening' ? graphs : undefined} allGraphs={graphs} gaps={uncovered} />
        </>
      )}
    </div>
  );
}

function WeightedBar({ s, uncovered, slim = false }: { s: Record<Strength, number>; uncovered?: Pick<Uncovered, 'share' | 'oneInN'>; slim?: boolean }) {
  return (
    <div className={`str-bar ${slim ? 'slim' : ''}`} aria-hidden="true">
      {ORDER.filter((k) => s[k] > 0).map((k) => (
        <span key={k} className={`str-seg str-${k}`} style={{ flexGrow: s[k] }} title={`${STRENGTH_LABEL[k]}: ${pct(s[k])}`} />
      ))}
      {uncovered && uncovered.share > 0 && (
        <span className="str-seg str-uncovered" style={{ flexGrow: uncovered.share }} title={`Not covered: ${pct(uncovered.share)} — ${uncoveredHint(uncovered)}`} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ strips */

type Open = { chapter: Chapter; line: MapLine; index: number; rect: DOMRect; pinned: boolean };

/** Each chapter as a strip of its lines; given `graphs`, grouped by first move and opening. */
function ChapterStrips({
  maps,
  color,
  graphs,
  allGraphs,
  gaps,
}: {
  maps: ChapterMap[];
  color: Color;
  graphs?: ReadonlyMap<string, RepGraph>;
  allGraphs?: ReadonlyMap<string, RepGraph>;
  /** The coverage run behind the not-covered shares (its target, and whose gaps to link to). */
  gaps?: Uncovered;
}) {
  const names = useOpeningIndex();
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

  const strip = ({ chapter, lines, weights, ready, uncovered, uncoveredWeight }: ChapterMap, label: string) => {
    const dueCount = lines.filter((l) => l.due).length;
    const fresh = lines.some((l) => l.strength === 'new');
    const g = allGraphs?.get(chapter.id);
    const opening = g ? compactLine(chapterPosition(g, names, chapter.name).moves.map((m) => m.san)) : '';
    const practice = () =>
      navigate('train', { rep: chapter.id, mode: dueCount ? 'review' : fresh ? 'learn' : 'drill', t: String(Date.now()) });
    return (
      <div key={chapter.id} className="map-row">
        <div className="map-row-head">
          <a className="map-row-name" href={href(`repertoire/${chapter.id}`)} title={chapter.name}>
            {label}
          </a>
          {opening && <span className="map-row-line">{opening}</span>}
          <span className="spacer" />
          {lines.length > 0 && (
            <span
              className="map-row-ready"
              title={`Share of this chapter's games that go down lines you know well (weighted by how often they come up)${uncovered ? ` — ${pct(uncovered)} of them leave its lines while still common` : ''}`}
            >
              {pct(ready)}
            </span>
          )}
          {lines.length > 0 && (
            <button className="small ghost" onClick={practice}>
              {dueCount ? `Review ${dueCount}` : fresh ? 'Learn' : 'Drill'} ▸
            </button>
          )}
        </div>
        {lines.length === 0 ? (
          <div className="muted small">No lines yet — add moves in the builder.</div>
        ) : (
          <div className="strip" role="list">
            {lines.map((line, i) => (
              <button
                key={line.id}
                role="listitem"
                className={`strip-seg str-${line.strength} ${line.due ? 'due' : ''} ${open?.line.id === line.id ? 'open' : ''}`}
                style={{ flexGrow: weights[i] }}
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
            {uncovered > 0 && gaps && (
              <a
                role="listitem"
                className="strip-seg str-uncovered"
                style={{ flexGrow: uncoveredWeight }}
                href={href(`coverage/${gaps.scopeId}`)}
                title={`Not covered: ${pct(uncovered)} of this chapter's games — ${uncoveredHint(gaps)}. Open Coverage for the gaps.`}
                aria-label={`Not covered: ${pct(uncovered)} of this chapter's games`}
              />
            )}
          </div>
        )}
      </div>
    );
  };
  const byId = new Map(maps.map((m) => [m.chapter.id, m]));

  return (
    <>
      {graphs ? (
        <ChapterTree
          color={color}
          chapters={maps.map((m) => m.chapter)}
          graphs={graphs}
          storageKey="map"
          summary={(ids) => {
            const ms = ids.map((id) => byId.get(id)).filter((m): m is ChapterMap => !!m);
            const { s, uncovered } = chapterShares(ms);
            return (
              <>
                <WeightedBar s={s} slim uncovered={gaps && uncovered ? { ...gaps, share: uncovered } : undefined} />
                <span className="map-row-ready">{pct(readyOf(s))}</span>
              </>
            );
          }}
          row={(ch, label) => (byId.has(ch.id) ? strip(byId.get(ch.id)!, label) : null)}
        />
      ) : (
        <div className="panel list">{maps.map((m) => <div key={m.chapter.id}>{strip(m, m.chapter.name)}</div>)}</div>
      )}
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
      if (!box.current?.contains(t) && !t.closest('.strip-seg')) onClose();
    };
    const id = setTimeout(() => window.addEventListener('pointerdown', away), 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener('pointerdown', away);
    };
  }, [open.pinned, onClose]);

  const sans = line.path.map((m) => m.san);
  const end = line.path[line.path.length - 1];
  return (
    <div className="map-pop" ref={box} style={pos} onMouseEnter={onEnter} onMouseLeave={onLeave} role="dialog" aria-label={`Line ${open.index + 1} of ${chapter.name}`}>
      <LineCard eyebrow={chapter.name} title={`Line ${open.index + 1}`} line={line} color={color} />
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
