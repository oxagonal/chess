import { useEffect, useMemo, useRef, useState } from 'react';
import { addEdges, createRepertoire, fetchLichessStudy } from '../db/repertoire';
import { db } from '../db/db';
import { getSettings, repTarget } from '../db/settings';
import { colorName, loadScope } from '../db/scopes';
import { statsProvider, type StatsProvider } from '../services/coverage';
import { reachProbabilities } from '../lib/coverage';
import { alternativesIn, importGraph, keptEdges, reachable, studyChapters, trimByReach, type StudyChapter } from '../lib/importPlan';
import { formatLine, posFromFen, type Color } from '../lib/chess';
import type { RepGraph } from '../lib/graph';
import { moveGames, type Chapter, type PositionStats, type RepMove } from '../lib/types';
import type { ImportedEdge } from '../lib/pgn';
import { Board, type Arrow } from './Board';
import { OneInNSlider } from './OneInNSlider';
import { WdlBar } from './ui';
import { href } from '../router';

type Step = 'source' | 'chapters' | 'trim' | 'choose' | 'import';
const STEPS: { id: Step; label: string }[] = [
  { id: 'source', label: 'Source' },
  { id: 'chapters', label: 'Chapters' },
  { id: 'trim', label: 'Trim' },
  { id: 'choose', label: 'Your choices' },
  { id: 'import', label: 'Import' },
];

interface Row {
  include: boolean;
  name: string;
  color: Color;
  /** 'new' or an existing chapter's id to add to. */
  target: string;
}

/** One chapter-to-be: what it imports, the graph to review (with the target chapter's moves, locked), and what's kept. */
interface Plan {
  name: string;
  color: Color;
  target: string;
  graph: RepGraph;
  /** Moves already in the target chapter: always kept. */
  locked: Set<string>;
  /** After trimming (all moves until trimmed). */
  trimmed: Set<string>;
  /** Your moves you chose not to keep. */
  removed: Set<string>;
}

const keptOf = (p: Plan) => reachable(p.graph, (m) => (p.trimmed.has(m.id) || p.locked.has(m.id)) && !p.removed.has(m.id));

/**
 * Positions where the import gives you more than one move, with every option (unticked ones too, so
 * you can tick them back) — as long as the moves you've kept still reach the position.
 */
function choicesOf(p: Plan) {
  const base = reachable(p.graph, (m) => p.trimmed.has(m.id) || p.locked.has(m.id));
  const kept = keptOf(p);
  const reached = new Set([p.graph.root, ...[...kept].map((id) => p.graph.byId.get(id)!.toKey)]);
  return alternativesIn(p.graph, base).filter((a) => reached.has(a.key));
}

/**
 * Import a Lichess study or PGN as chapters: pick and name its chapters, trim opponent replies too
 * rare to prepare, then look at every position where it gives you more than one move and keep
 * the ones you'll play.
 */
export function ImportWizard({ chapters, onClose }: { chapters: Chapter[]; onClose: () => void }) {
  const [step, setStep] = useState<Step>('source');
  const [error, setError] = useState<string | null>(null);
  const [study, setStudy] = useState<string | undefined>();
  const [parsed, setParsed] = useState<StudyChapter[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [combine, setCombine] = useState(false);
  const [combined, setCombined] = useState<Row>({ include: true, name: '', color: 'white', target: 'new' });
  const [plans, setPlans] = useState<Plan[]>([]);
  const box = useRef<HTMLDivElement>(null);
  // (In braces: scrollIntoView returns a promise in newer browsers, and an effect may only return a cleanup.)
  useEffect(() => {
    box.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [step]);

  const loaded = (pgn: string, defaultColor: Color) => {
    const r = studyChapters(pgn);
    if (!r.chapters.length) throw new Error('No moves found in that PGN or study.');
    setStudy(r.study);
    setParsed(r.chapters);
    setRows(r.chapters.map((c) => ({ include: true, name: c.name, color: c.orientation ?? defaultColor, target: 'new' })));
    setCombined({ include: true, name: r.study ?? r.chapters[0].name, color: r.chapters[0].orientation ?? defaultColor, target: 'new' });
    setCombine(false);
    setStep('chapters');
  };

  const buildPlans = async () => {
    const groups: { name: string; color: Color; target: string; edges: ImportedEdge[] }[] = combine
      ? [{ ...combined, edges: parsed.filter((_, i) => rows[i].include).flatMap((c) => c.edges) }]
      : parsed.flatMap((c, i) => (rows[i].include ? [{ ...rows[i], edges: c.edges }] : []));
    const out: Plan[] = [];
    for (const g of groups) {
      const existing = g.target === 'new' ? [] : await db.moves.where('repId').equals(g.target).toArray();
      const graph = importGraph(g.color, g.edges, existing);
      const locked = new Set(existing.map((m) => `import|${m.fromKey}|${m.san}`));
      out.push({ name: g.name, color: g.color, target: g.target, graph, locked, trimmed: new Set(graph.byId.keys()), removed: new Set() });
    }
    setPlans(out);
    setStep('trim');
  };

  return (
    <div className="panel col wizard" ref={box} style={{ gap: 12, scrollMarginTop: 12 }}>
      <div className="row">
        <h2 style={{ margin: 0 }}>Import a study or PGN{study ? ` — ${study}` : ''}</h2>
        <span className="spacer" />
        <button className="ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <ol className="wizard-steps">
        {STEPS.map((s, i) => (
          <li key={s.id} className={s.id === step ? 'on' : STEPS.findIndex((x) => x.id === step) > i ? 'done' : ''}>
            {s.label}
          </li>
        ))}
      </ol>
      {error && <div className="error">{error}</div>}
      {step === 'source' && <SourceStep onLoaded={loaded} onError={setError} />}
      {step === 'chapters' && (
        <ChaptersStep
          parsed={parsed}
          rows={rows}
          setRows={setRows}
          combine={combine}
          setCombine={setCombine}
          combined={combined}
          setCombined={setCombined}
          chapters={chapters}
          onBack={() => setStep('source')}
          onNext={() => void buildPlans().catch((e) => setError((e as Error).message))}
        />
      )}
      {step === 'trim' && <TrimStep plans={plans} setPlans={setPlans} onBack={() => setStep('chapters')} onNext={() => setStep('choose')} />}
      {step === 'choose' && <ChooseStep plans={plans} setPlans={setPlans} onBack={() => setStep('trim')} onNext={() => setStep('import')} />}
      {step === 'import' && <ImportStep plans={plans} chapters={chapters} onBack={() => setStep('choose')} onClose={onClose} />}
    </div>
  );
}

/* ---------------------------------------------------------------- 1 source */

function SourceStep({ onLoaded, onError }: { onLoaded: (pgn: string, color: Color) => void; onError: (e: string | null) => void }) {
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [color, setColor] = useState<Color>('white');
  const [busy, setBusy] = useState(false);
  const go = async (get: () => Promise<string>) => {
    setBusy(true);
    onError(null);
    try {
      onLoaded(await get(), color);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row">
        <input placeholder="https://lichess.org/study/…" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: '1 1 300px' }} />
        <button className="primary" disabled={busy || !url.trim()} onClick={() => go(() => fetchLichessStudy(url))}>
          {busy ? 'Loading…' : 'Load study'}
        </button>
      </div>
      <div className="muted small">or paste PGN (each game becomes a chapter; variations and comments are kept)</div>
      <textarea rows={5} placeholder="1. e4 c5 2. Nf3 (2. c3 d5) d6 3. d4 ..." value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row">
        <button disabled={busy || !text.trim()} onClick={() => go(async () => text)}>
          Use this PGN
        </button>
        <label className="btn">
          Upload .pgn
          <input
            type="file"
            accept=".pgn,text/plain"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void go(() => f.text());
            }}
          />
        </label>
        <span className="spacer" />
        <label className="small muted">
          Chapters without a board orientation are for{' '}
          <select value={color} onChange={(e) => setColor(e.target.value as Color)}>
            <option value="white">White</option>
            <option value="black">Black</option>
          </select>
        </label>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- 2 chapters */

function TargetSelect({ value, color, chapters, onChange }: { value: string; color: Color; chapters: Chapter[]; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Import into">
      <option value="new">New chapter</option>
      {chapters
        .filter((c) => c.color === color)
        .map((c) => (
          <option key={c.id} value={c.id}>
            Add to “{c.name}”
          </option>
        ))}
    </select>
  );
}

function ChaptersStep(props: {
  parsed: StudyChapter[];
  rows: Row[];
  setRows: (r: Row[]) => void;
  combine: boolean;
  setCombine: (b: boolean) => void;
  combined: Row;
  setCombined: (r: Row) => void;
  chapters: Chapter[];
  onBack: () => void;
  onNext: () => void;
}) {
  const { parsed, rows, setRows, combine, setCombine, combined, setCombined, chapters } = props;
  const set = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch, ...(patch.color ? { target: 'new' } : {}) } : r)));
  const any = rows.some((r) => r.include);
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row">
        <label className="check">
          <input type="radio" checked={!combine} onChange={() => setCombine(false)} /> Each study chapter becomes a chapter
        </label>
        <label className="check">
          <input type="radio" checked={combine} onChange={() => setCombine(true)} /> All into one chapter
        </label>
      </div>
      {combine && (
        <div className="row wizard-row">
          <input value={combined.name} onChange={(e) => setCombined({ ...combined, name: e.target.value })} placeholder="Chapter name" style={{ flex: '1 1 220px' }} />
          <select value={combined.color} onChange={(e) => setCombined({ ...combined, color: e.target.value as Color, target: 'new' })}>
            <option value="white">I play White</option>
            <option value="black">I play Black</option>
          </select>
          <TargetSelect value={combined.target} color={combined.color} chapters={chapters} onChange={(v) => setCombined({ ...combined, target: v })} />
        </div>
      )}
      <div className="col" style={{ gap: 6 }}>
        {parsed.map((c, i) => (
          <div key={i} className={`row wizard-row ${rows[i].include ? '' : 'faded'}`}>
            <input type="checkbox" checked={rows[i].include} onChange={(e) => set(i, { include: e.target.checked })} aria-label={`Import ${c.name}`} />
            {combine ? (
              <span style={{ flex: '1 1 220px' }}>{c.name}</span>
            ) : (
              <input value={rows[i].name} onChange={(e) => set(i, { name: e.target.value })} style={{ flex: '1 1 220px' }} disabled={!rows[i].include} />
            )}
            <span className="muted small">{c.edges.length} moves</span>
            {!combine && (
              <>
                <select value={rows[i].color} onChange={(e) => set(i, { color: e.target.value as Color })} disabled={!rows[i].include}>
                  <option value="white">White</option>
                  <option value="black">Black</option>
                </select>
                <TargetSelect value={rows[i].target} color={rows[i].color} chapters={chapters} onChange={(v) => set(i, { target: v })} />
              </>
            )}
            {c.errors.length > 0 && (
              <span className="warn small" title={c.errors.join('\n')}>
                ⚠ {c.errors.length}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="row">
        <button className="ghost" onClick={props.onBack}>
          Back
        </button>
        <span className="spacer" />
        <button className="primary" disabled={!any} onClick={props.onNext}>
          Next: trim
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 3 trim */

function TrimStep({ plans, setPlans, onBack, onNext }: { plans: Plan[]; setPlans: (p: Plan[]) => void; onBack: () => void; onNext: () => void }) {
  const [n, setN] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [queried, setQueried] = useState(0);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const color = plans[0]?.color ?? 'white';
  useEffect(() => {
    void (async () => setN(repTarget(await loadScope(color), await getSettings())))();
  }, [color]);
  useEffect(() => () => ctrl.current?.abort(), []);

  const run = async () => {
    if (!n) return;
    setRunning(true);
    setError(null);
    setQueried(0);
    ctrl.current = new AbortController();
    try {
      const s = await getSettings();
      const providers = new Map<Color, StatsProvider>();
      let count = 0;
      const next: Plan[] = [];
      for (const p of plans) {
        if (!providers.has(p.color)) providers.set(p.color, await statsProvider(s, p.color, ctrl.current.signal, 'high'));
        const fwd = await reachProbabilities(p.graph, providers.get(p.color)!, {
          threshold: 1 / n,
          pickAll: true,
          signal: ctrl.current.signal,
          onProgress: () => setQueried(++count),
        });
        next.push({ ...p, trimmed: trimByReach(p.graph, fwd, 1 / n), removed: new Set() });
      }
      setPlans(next);
      setDone(true);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(`Couldn't look positions up: ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  };
  const keepAll = () => {
    setPlans(plans.map((p) => ({ ...p, trimmed: new Set(p.graph.byId.keys()), removed: new Set() })));
    onNext();
  };

  return (
    <div className="col" style={{ gap: 10 }}>
      <p className="muted small" style={{ margin: 0 }}>
        Studies often go deep into replies you'll almost never meet. Trimming drops opponent moves that come up less often than your target
        (in the opening explorer chosen in Settings), with everything after them. Lines the explorer knows nothing about are kept, and none
        of your own moves are trimmed — you choose between those next.
      </p>
      {n !== null && <OneInNSlider value={n} onChange={(v) => (setN(v), setDone(false))} label="Keep replies seen in at least" color={color} />}
      {error && <div className="error">{error}</div>}
      {running && <div className="muted">Looked up {queried} positions…</div>}
      {done && (
        <div className="col" style={{ gap: 4 }}>
          {plans.map((p, i) => {
            const total = [...p.graph.byId.keys()].filter((id) => !p.locked.has(id)).length;
            const kept = [...keptOf(p)].filter((id) => !p.locked.has(id)).length;
            return (
              <div key={i} className="small">
                <b>{p.name}</b>: keeps {kept} of {total} moves{total > kept ? ` — ${total - kept} too rare to prepare` : ''}
              </div>
            );
          })}
        </div>
      )}
      <div className="row">
        <button className="ghost" onClick={onBack} disabled={running}>
          Back
        </button>
        <span className="spacer" />
        {running ? (
          <button onClick={() => ctrl.current?.abort()}>Cancel</button>
        ) : (
          <>
            <button onClick={keepAll}>Keep everything</button>
            {done ? (
              <button className="primary" onClick={onNext}>
                Next: your choices
              </button>
            ) : (
              <button className="primary" onClick={run} disabled={!n}>
                Trim to 1 in {n ?? '…'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 4 choose */

function ChooseStep({ plans, setPlans, onBack, onNext }: { plans: Plan[]; setPlans: (p: Plan[]) => void; onBack: () => void; onNext: () => void }) {
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState<Map<string, PositionStats | null>>(new Map());
  const all = useMemo(() => plans.flatMap((p, pi) => choicesOf(p).map((a) => ({ pi, a, id: `${pi}|${a.key}` }))), [plans]);
  const todo = all.filter((x) => !reviewed.has(x.id));
  const cur = todo[0];
  const providers = useRef(new Map<Color, StatsProvider>());

  useEffect(() => {
    if (!cur || stats.has(cur.a.key)) return;
    const color = plans[cur.pi].color;
    let off = false;
    void (async () => {
      try {
        if (!providers.current.has(color)) providers.current.set(color, await statsProvider(await getSettings(), color));
        const s = await providers.current.get(color)!(cur.a.key);
        if (!off) setStats((m) => new Map(m).set(cur.a.key, s ?? null));
      } catch {
        if (!off) setStats((m) => new Map(m).set(cur.a.key, null));
      }
    })();
    return () => {
      off = true;
    };
  }, [cur, plans, stats]);

  if (!all.length)
    return (
      <div className="col" style={{ gap: 10 }}>
        <div className="note">No position gives you more than one move — nothing to choose.</div>
        <div className="row">
          <button className="ghost" onClick={onBack}>
            Back
          </button>
          <span className="spacer" />
          <button className="primary" onClick={onNext}>
            Next: import
          </button>
        </div>
      </div>
    );

  const toggle = (pi: number, m: RepMove) => {
    setPlans(
      plans.map((p, j) => {
        if (j !== pi) return p;
        const removed = new Set(p.removed);
        if (removed.has(m.id)) removed.delete(m.id);
        else removed.add(m.id);
        return { ...p, removed };
      }),
    );
  };
  const keepAllHere = () => {
    if (!cur) return;
    setPlans(plans.map((p, j) => (j === cur.pi ? { ...p, removed: new Set([...p.removed].filter((id) => !cur.a.options.some((o) => o.id === id))) } : p)));
  };

  if (!cur)
    return (
      <div className="col" style={{ gap: 10 }}>
        <div className="note">
          All {all.length} position{all.length === 1 ? '' : 's'} with more than one move of yours reviewed.
        </div>
        <div className="row">
          <button className="ghost" onClick={() => setReviewed(new Set())}>
            Review again
          </button>
          <span className="spacer" />
          <button className="primary" onClick={onNext}>
            Next: import
          </button>
        </div>
      </div>
    );

  const plan = plans[cur.pi];
  const pos = posFromFen(cur.a.key);
  const s = stats.get(cur.a.key);
  const options = cur.a.options;
  const arrows: Arrow[] = options.map((m) => ({ uci: m.uci, brush: plan.removed.has(m.id) ? 'paleGrey' : 'green' }));
  const keptCount = options.filter((m) => !plan.removed.has(m.id)).length;
  const done = all.length - todo.length;

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row">
        <b>
          {plan.name} · position {done + 1} of {all.length}
        </b>
        <span className="spacer" />
        <span className="muted small">{formatLine(cur.a.path) || 'Starting position'}</span>
      </div>
      <div className="choose">
        <div className="choose-board">{pos && <Board pos={pos} orientation={plan.color} arrows={arrows} />}</div>
        <div className="col choose-options" style={{ gap: 8 }}>
          <div className="muted small">The study gives you {options.length} moves here. Keep the ones you'll play:</div>
          {options.map((m) => {
            const ms = s?.moves.find((x) => x.san === m.san);
            const games = ms ? moveGames(ms) : 0;
            const locked = plan.locked.has(m.id);
            return (
              <label key={m.id} className={`choose-option ${plan.removed.has(m.id) ? 'off' : ''}`}>
                <input type="checkbox" checked={!plan.removed.has(m.id)} disabled={locked} onChange={() => toggle(cur.pi, m)} />
                <b className="choose-san">{m.san}</b>
                {locked && <span className="chip">in your chapter</span>}
                <span className="spacer" />
                {s === undefined ? (
                  <span className="muted small">…</span>
                ) : ms && s ? (
                  <>
                    <span className="muted small">{Math.round((games / Math.max(1, s.total)) * 100)}%</span>
                    <span className="choose-wdl">
                      <WdlBar white={ms.white} draws={ms.draws} black={ms.black} />
                    </span>
                  </>
                ) : (
                  <span className="muted small">{s === null ? 'no explorer data' : 'not played in the explorer'}</span>
                )}
                {m.comment && <span className="choose-note">{m.comment}</span>}
              </label>
            );
          })}
          <div className="row">
            <button className="small" onClick={keepAllHere}>
              Keep all
            </button>
            <span className="spacer" />
            <button className="primary small" disabled={keptCount === 0} onClick={() => setReviewed(new Set(reviewed).add(cur.id))}>
              {keptCount === options.length ? 'Keep all, next' : `Keep ${keptCount}, next`}
            </button>
          </div>
          <div className="muted small">Unticking a move drops everything that only it leads to (other positions to choose in update to match).</div>
        </div>
      </div>
      <div className="row">
        <button className="ghost" onClick={onBack}>
          Back
        </button>
        <span className="spacer" />
        <button className="ghost" onClick={onNext}>
          Skip the rest — keep what's ticked
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 5 import */

function ImportStep({ plans, chapters, onBack, onClose }: { plans: Plan[]; chapters: Chapter[]; onBack: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ name: string; id: string; added: number; mine: number }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const summary = plans.map((p) => {
    const kept = keptOf(p);
    const fresh = [...kept].filter((id) => !p.locked.has(id));
    return { p, kept, fresh: fresh.length, mine: fresh.filter((id) => p.graph.byId.get(id)?.mine).length };
  });
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const out: { name: string; id: string; added: number; mine: number }[] = [];
      for (const { p, kept } of summary) {
        const id = p.target === 'new' ? (await createRepertoire(p.name, p.color)).id : p.target;
        const r = await addEdges(id, keptEdges(p.graph, kept));
        out.push({ name: p.target === 'new' ? p.name : (chapters.find((c) => c.id === p.target)?.name ?? p.name), id, added: r.added, mine: r.mineAdded });
      }
      setResult(out);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (result)
    return (
      <div className="col" style={{ gap: 8 }}>
        {result.map((r) => (
          <div key={r.id} className="note">
            <a href={href(`repertoire/${r.id}`)}>{r.name}</a>: {r.added} move{r.added === 1 ? '' : 's'} added, {r.mine} new to learn.
          </div>
        ))}
        <div className="row">
          <span className="spacer" />
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    );
  return (
    <div className="col" style={{ gap: 8 }}>
      {summary.map(({ p, fresh, mine }, i) => (
        <div key={i} className="small">
          <b>{p.name}</b> ({colorName(p.color)}) → {p.target === 'new' ? 'new chapter' : `“${chapters.find((c) => c.id === p.target)?.name}”`}: {fresh} move
          {fresh === 1 ? '' : 's'}, {mine} of yours to learn
        </div>
      ))}
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="ghost" onClick={onBack} disabled={busy}>
          Back
        </button>
        <span className="spacer" />
        <button className="primary" onClick={run} disabled={busy}>
          {busy ? 'Importing…' : 'Import'}
        </button>
      </div>
    </div>
  );
}
