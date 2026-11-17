import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { PageProps } from '../App';
import { db } from '../db/db';
import {
  addEdges,
  createRepertoire,
  deleteMove,
  deleteRepertoire,
  exportPgn,
  fetchLichessStudy,
  importPgn,
  renameRepertoire,
} from '../db/repertoire';
import { repTarget, useSettings, updateSettings } from '../db/settings';
import { useCards, useCoverage, useRepertoires, useRepGraph } from '../hooks';
import { Board } from '../components/Board';
import { ExplorerPanel } from '../components/ExplorerPanel';
import { MoveNote } from '../components/MoveNote';
import { ColorPill, Empty, LineView, MoreMenu } from '../components/ui';
import { href, navigate } from '../router';
import { nextMemoryTarget, type MemoryStep } from '../lib/fromMemory';
import { formatLine, playSan, playUci, posFromFen, START_KEY, turnOfKey, type Color } from '../lib/chess';
import { oneIn } from '../lib/coverage';
import { isCoverageFresh, reachAlongLine, runCoverageForGraph, sourceLabel, statsProvider } from '../services/coverage';
import type { AppSettings } from '../db/settings';
import { type CoverageResult, type PositionStats, type Repertoire } from '../lib/types';
import { isDue, isNew } from '../lib/srs';
import { download } from '../services/backup';
import type { RepGraph } from '../lib/graph';

export function RepertoirePage({ route }: PageProps) {
  const id = route.path[1];
  if (id) return <Builder repId={id} initialLine={route.query.get('line') ?? ''} />;
  return <RepertoireList />;
}

/* ------------------------------------------------------------------ list */

function RepertoireList() {
  const reps = useRepertoires();
  const cards = useCards();
  const [name, setName] = useState('');
  const [color, setColor] = useState<Color>('white');
  const [importing, setImporting] = useState<string | null>(null);

  const create = async () => {
    const rep = await createRepertoire(name, color);
    setName('');
    navigate(`repertoire/${rep.id}`);
  };

  const now = Date.now();
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row">
        <h1>Repertoires</h1>
      </div>
      <div className="panel">
        <h2>New repertoire</h2>
        <div className="row">
          <input placeholder="Name, e.g. “Black vs 1.e4”" value={name} onChange={(e) => setName(e.target.value)} style={{ minWidth: 260 }} />
          <select value={color} onChange={(e) => setColor(e.target.value as Color)}>
            <option value="white">I play White</option>
            <option value="black">I play Black</option>
          </select>
          <button className="primary" onClick={create}>
            Create
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          Tip: keep one repertoire per color, or split them (e.g. Black vs 1.e4 and Black vs 1.d4) — game analysis checks all repertoires
          of the color you played.
        </p>
      </div>

      {reps && reps.length === 0 && <Empty>No repertoires yet — create one above.</Empty>}
      {reps && reps.length > 0 && (
        <div className="panel list">
          {reps.map((r) => {
            const rc = cards?.filter((c) => c.repId === r.id) ?? [];
            const due = rc.filter((c) => isDue(c, now)).length;
            const fresh = rc.filter(isNew).length;
            return (
              <div key={r.id} className="list-item">
                <div className="list-main">
                  <div className="list-head">
                    <ColorPill color={r.color} />
                    <a className="list-title" href={href(`repertoire/${r.id}`)}>
                      {r.name}
                    </a>
                  </div>
                  <div className="list-meta">
                    <span>
                      {rc.length} move{rc.length === 1 ? '' : 's'} to know
                    </span>
                    {due > 0 && <span className="badge due">{due} due</span>}
                    {fresh > 0 && <span className="badge new">{fresh} new</span>}
                  </div>
                </div>
                <div className="list-buttons">
                  <a className="btn small" href={href(`repertoire/${r.id}`)}>
                    Edit
                  </a>
                  <a className="btn small" href={href('train', { rep: r.id, mode: 'review' })}>
                    Train
                  </a>
                  <a className="btn small" href={href(`coverage/${r.id}`)}>
                    Coverage
                  </a>
                  <MoreMenu>
                    <button onClick={() => setImporting(importing === r.id ? null : r.id)}>Import PGN or study…</button>
                    <button onClick={async () => download(`${r.name.replace(/[^\w-]+/g, '_')}.pgn`, await exportPgn(r.id), 'application/x-chess-pgn')}>
                      Export PGN
                    </button>
                    <button
                      onClick={() => {
                        const n = prompt('Rename repertoire', r.name);
                        if (n) renameRepertoire(r.id, n);
                      }}
                    >
                      Rename…
                    </button>
                    <button
                      className="danger"
                      onClick={() => {
                        if (confirm(`Delete “${r.name}” and all its training progress?`)) deleteRepertoire(r.id);
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
      {importing && <ImportPanel repId={importing} onClose={() => setImporting(null)} />}
    </div>
  );
}

function ImportPanel({ repId, onClose }: { repId: string; onClose: () => void }) {
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
        Paste PGN (variations and comments are kept), upload a .pgn file, or pull a public Lichess study. Moves merge into the existing
        repertoire; transpositions are joined automatically.
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

/* --------------------------------------------------------------- builder */

interface LineMove {
  san: string;
  uci: string;
  fromKey: string;
  key: string;
}

function lineFromSans(sans: string[]): LineMove[] {
  let pos = posFromFen(START_KEY)!;
  let key = START_KEY;
  const out: LineMove[] = [];
  for (const s of sans) {
    const r = playSan(pos, s);
    if (!r) break;
    out.push({ san: r.san, uci: r.uci, fromKey: key, key: r.key });
    pos = r.pos;
    key = r.key;
  }
  return out;
}

const toEdges = (l: LineMove[]) => l.map((m) => ({ fromKey: m.fromKey, toKey: m.key, san: m.san, uci: m.uci }));

function Builder({ repId, initialLine }: { repId: string; initialLine: string }) {
  const { rep, graph, loading } = useRepGraph(repId);
  const cards = useCards(repId);
  const coverage = useCoverage(repId);
  const settings = useSettings();
  const live = useLiveCoverage(repId, rep, graph, settings, coverage);
  const [line, setLine] = useState<LineMove[]>(() => lineFromSans(initialLine.split(/\s+/).filter(Boolean)));
  const [cursor, setCursor] = useState(line.length);
  // Only trust a coverage run that matches the current repertoire and settings.
  const goalN = repTarget(rep, settings);
  const freshCoverage = rep && settings.loaded && isCoverageFresh(coverage, rep, settings) ? coverage : undefined;
  const reach = useLineReach(line.slice(0, cursor), rep?.color, graph, settings, freshCoverage);
  const [flipped, setFlipped] = useState(false);
  const [opening, setOpening] = useState<string | undefined>();
  const [message, setMessage] = useState<string | null>(null);
  const autoAdd = settings.builderAutoAdd;

  // Re-sync when navigated with a different ?line=
  const lastInitial = useRef(initialLine);
  useEffect(() => {
    if (initialLine !== lastInitial.current) {
      lastInitial.current = initialLine;
      const l = lineFromSans(initialLine.split(/\s+/).filter(Boolean));
      setLine(l);
      setCursor(l.length);
    }
  }, [initialLine]);

  const key = cursor === 0 ? START_KEY : line[cursor - 1].key;
  const pos = useMemo(() => posFromFen(key)!, [key]);
  const lastMove = cursor > 0 ? line[cursor - 1].uci : undefined;

  const children = graph?.childrenOf(key) ?? [];
  const inRep = graph?.has(key) ?? false;
  const myTurn = rep ? pos.turn === rep.color : false;
  const cardById = useMemo(() => new Map((cards ?? []).map((c) => [c.id, c])), [cards]);
  const lineInRep = line.map((m) => !!graph?.edge(m.fromKey, m.san));
  const missingUpToCursor = line.slice(0, cursor).some((_, i) => !lineInRep[i]);
  const currentEdge = cursor > 0 && graph ? graph.edge(line[cursor - 1].fromKey, line[cursor - 1].san) : undefined;

  const play = async (san: string, add = false) => {
    const r = playSan(pos, san);
    if (!r) return;
    const item: LineMove = { san: r.san, uci: r.uci, fromKey: key, key: r.key };
    if (line[cursor]?.san === r.san) setCursor(cursor + 1);
    else {
      setLine([...line.slice(0, cursor), item]);
      setCursor(cursor + 1);
    }
    if ((add || autoAdd) && graph) {
      // Adding requires the whole path to be in the repertoire, so add any missing earlier moves too.
      const path = [...line.slice(0, cursor), item];
      await addEdges(repId, toEdges(path));
    }
  };

  /* ---- Play from memory: it plays popular opponent moves, you answer, your moves save as known ---- */
  const [memory, setMemory] = useState<{ startKey: string; startPath: MemoryStep[]; startProb: number } | null>(null);
  const [memSkip, setMemSkip] = useState<Set<string>>(new Set());
  const [memState, setMemState] = useState<{ status: 'searching' | 'waiting' | 'done' | 'error'; targetKey?: string; prob?: number; error?: string }>({
    status: 'searching',
  });
  const [memAdded, setMemAdded] = useState(0);
  const memStats = useRef(new Map<string, PositionStats | undefined>());
  const graphRef = useRef(graph);
  graphRef.current = graph;

  useEffect(() => {
    if (!memory || !rep || !settings.loaded) return;
    const ctrl = new AbortController();
    setMemState({ status: 'searching' });
    let animate: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      try {
        const base = await statsProvider(settings, rep.color, ctrl.signal);
        const provider = async (k: string) => {
          if (memStats.current.has(k)) return memStats.current.get(k);
          const s = await base(k);
          memStats.current.set(k, s);
          return s;
        };
        const g = graphRef.current;
        if (!g) return;
        const target = await nextMemoryTarget({
          graph: g,
          color: rep.color,
          startKey: memory.startKey,
          startPath: memory.startPath,
          startProb: memory.startProb,
          threshold: 1 / goalN,
          provider,
          skip: memSkip,
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted) return;
        if (!target) {
          setMemState({ status: 'done' });
          return;
        }
        const l = target.path as LineMove[];
        setLine(l);
        // Show the opponent's move being played, then wait for yours.
        if (l.length > memory.startPath.length) {
          setCursor(l.length - 1);
          animate = setTimeout(() => setCursor(l.length), 350);
        } else setCursor(l.length);
        setMemState({ status: 'waiting', targetKey: l.length ? l[l.length - 1].key : START_KEY, prob: target.prob });
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setMemState({ status: 'error', error: (e as Error).message });
      }
    })();
    return () => {
      ctrl.abort();
      clearTimeout(animate);
    };
    // Re-run when the repertoire changes (your answer was saved), when you skip, or settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memory, rep?.updatedAt, memSkip, settings.loaded, goalN, sourceLabel(settings)]);

  const startMemory = () => {
    memStats.current = new Map();
    setMemSkip(new Set());
    setMemAdded(0);
    setMemory({ startKey: key, startPath: line.slice(0, cursor), startProb: cursor === 0 ? 1 : (reach.prob ?? 1) });
  };
  const stopMemory = () => setMemory(null);
  const skipMemory = () => memState.targetKey && setMemSkip((s) => new Set([...s, memState.targetKey!]));

  const onBoardMove = async (uci: string) => {
    const r = playUci(pos, uci);
    if (!r) return;
    if (memory && memState.status === 'waiting' && key === memState.targetKey && cursor === line.length) {
      const item: LineMove = { san: r.san, uci: r.uci, fromKey: key, key: r.key };
      const path = [...line.slice(0, cursor), item];
      setLine(path);
      setCursor(path.length);
      setMemState({ status: 'searching' });
      const { mineAdded } = await addEdges(repId, toEdges(path), { known: true });
      setMemAdded((n) => n + mineAdded);
      return;
    }
    play(r.san);
  };

  // The most common hole: an opponent reply you don't answer, or your move with nothing prepared.
  const biggestGap = useMemo(() => {
    if (!freshCoverage) return undefined;
    const g = freshCoverage.gaps[0];
    const u = freshCoverage.unfinished[0];
    const pick =
      g && (!u || g.prob >= u.prob)
        ? { sans: [...g.path, g.san], prob: g.prob }
        : u
          ? { sans: u.path, prob: u.prob }
          : undefined;
    if (!pick) return undefined;
    return { ...pick, label: formatLine(pick.sans) || 'the starting position' };
  }, [freshCoverage]);

  const jumpToBiggestGap = () => {
    if (!biggestGap) return;
    const l = lineFromSans(biggestGap.sans);
    setLine(l);
    setCursor(l.length);
  };

  const addLineToRep = async () => {
    const { added } = await addEdges(repId, toEdges(line.slice(0, cursor)));
    setMessage(`Added ${added} move${added === 1 ? '' : 's'}.`);
    setTimeout(() => setMessage(null), 2500);
  };

  const removeMove = async (moveId: string, san: string) => {
    const n = graph ? countBelow(graph, moveId) : 1;
    if (n > 1 && !confirm(`Delete ${san} and the ${n - 1} move(s) that follow it?`)) return;
    await deleteMove(repId, moveId);
  };

  // keyboard navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      if (e.key === 'ArrowLeft') setCursor((c) => Math.max(0, c - 1));
      else if (e.key === 'ArrowRight') {
        if (cursor < line.length) setCursor(cursor + 1);
        else if (children.length && !memory) play(children[0].san);
      } else if (e.key === 'Home') setCursor(0);
      else if (e.key === 'End') setCursor(line.length);
      else if (e.key === 'f') setFlipped((f) => !f);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (loading) return <div className="muted">Loading…</div>;
  if (!rep || !graph) return <Empty>Repertoire not found. <a href={href('repertoire')}>Back to list</a></Empty>;

  const orientation: Color = flipped ? (rep.color === 'white' ? 'black' : 'white') : rep.color;
  const myMovesHere = children.filter((c) => c.mine);
  const prob = coverage?.probs[key];
  // Play from memory is "zen mode": just the board and the line — no explorer, arrows, notes or
  // stats. If you can't find the move without the explorer, you don't really know it.
  const zen = !!memory;
  const dueCount = (cards ?? []).filter((c) => isDue(c)).length;
  const newCount = (cards ?? []).filter(isNew).length;

  return (
    <div className="board-layout">
      <div className="board-col col">
        <Board
          pos={pos}
          orientation={orientation}
          interactive
          lastMove={lastMove}
          onMove={onBoardMove}
          arrows={zen ? [] : children.map((c) => ({ uci: c.uci, brush: c.mine ? 'green' : 'paleBlue' }))}
        />
        <div className="row">
          <button onClick={() => setCursor(0)} title="Start (Home)">
            ⏮
          </button>
          <button onClick={() => setCursor(Math.max(0, cursor - 1))} title="Back (←)">
            ◀
          </button>
          <button onClick={() => (cursor < line.length ? setCursor(cursor + 1) : !zen && children[0] && play(children[0].san))} title="Forward (→)">
            ▶
          </button>
          <button onClick={() => setCursor(line.length)} title="End">
            ⏭
          </button>
          <button onClick={() => setFlipped(!flipped)} title="Flip board (f)">
            ⇅
          </button>
          {!zen && (
            <a
              className="btn small"
              href={`https://lichess.org/analysis/standard/${`${key} 0 1`.replace(/ /g, '_')}?color=${orientation}`}
              target="_blank"
              rel="noreferrer"
              title="Open this position on the Lichess analysis board (new tab)"
            >
              Analyze on Lichess ↗
            </a>
          )}
          <span className="spacer" />
          {!zen && (
            <label className="check small" title="Every move you play on the board is saved into the repertoire immediately">
              <input type="checkbox" checked={autoAdd} onChange={(e) => updateSettings({ builderAutoAdd: e.target.checked })} />
              Auto-add moves
            </label>
          )}
        </div>
        {currentEdge && !zen && <MoveNote key={currentEdge.id} id={currentEdge.id} san={currentEdge.san} />}
      </div>

      <div className="col">
        {!zen && (
          <div className="panel">
            <div className="row">
              <h1 style={{ margin: 0 }}>{rep.name}</h1>
              <ColorPill color={rep.color} />
              <span className="spacer" />
              <a className="btn small" href={href('train', { rep: rep.id, mode: 'learn' })}>
                Learn <span className="badge new">{newCount}</span>
              </a>
              <a className="btn small" href={href('train', { rep: rep.id, mode: 'review' })}>
                Review <span className="badge due">{dueCount}</span>
              </a>
              <a className="btn small" href={href(`coverage/${rep.id}`)}>
                Coverage
              </a>
              <a className="btn small" href={href(`insights/${rep.id}`)}>
                Insights
              </a>
              <a className="btn small" href={href('repertoire')}>
                All
              </a>
            </div>
            <div className="muted small" style={{ marginTop: 4 }}>
              {plural(graph.myMoves().length, 'move')} · {plural(graph.leaves().length, 'line')}
            </div>
          </div>
        )}

        {memory ? (
          <div className="panel memory-panel">
            <div className="row">
              <h3 style={{ margin: 0 }}>Play from memory · {rep.name}</h3>
              <span className="spacer" />
              {memAdded > 0 && <span className="badge good">{plural(memAdded, 'move')} added</span>}
              {memState.status === 'waiting' && (
                <button className="small" onClick={skipMemory} title="Skip this position for now">
                  I don't know this
                </button>
              )}
              <button className="small" onClick={stopMemory}>
                Stop
              </button>
            </div>
            <div style={{ marginTop: 8 }}>
              {memState.status === 'searching' && <span className="muted">Finding the next position…</span>}
              {memState.status === 'waiting' && (
                <>
                  <b>Your move.</b>{' '}
                  <span className="muted">
                    {myTurn ? '' : 'Go to the end of the line to answer. '}
                    {memState.prob === undefined || memState.prob >= 1 / 1.05
                      ? 'This position comes up in every game.'
                      : `This position comes up in ${oneIn(memState.prob)} games.`}{' '}
                    It saves as known — no need to learn it.
                  </span>
                </>
              )}
              {memState.status === 'done' && (
                <span>
                  <b>All done.</b> <span className="muted">Everything from here is filled in down to 1 in {goalN} games{memSkip.size ? ` (except ${plural(memSkip.size, 'position')} you skipped)` : ''}.</span>
                </span>
              )}
              {memState.status === 'error' && <div className="error">{memState.error}</div>}
            </div>
          </div>
        ) : (
          <div className="row">
            <button
              className="primary"
              onClick={startMemory}
              disabled={reach.loading && cursor > 0}
              title="It plays your opponents' most popular moves and you answer. Your moves are saved as already known (no need to learn them), until everything from here is filled in down to your 1-in-N goal."
            >
              ▶ Play from memory{cursor > 0 ? ' from here' : ''}
            </button>
            <span className="muted small">Quickly enter lines you already know.</span>
          </div>
        )}

        <div className="panel">
          <div className="row" style={{ marginBottom: 6 }}>
            <h3 style={{ margin: 0 }}>Line</h3>
            <span className="spacer" />
            {!zen && (
              <>
                {missingUpToCursor && !memory && (
                  <button className="primary small" onClick={addLineToRep}>
                    + Add line to repertoire
                  </button>
                )}
                {message && <span className="badge good">{message}</span>}
                <button
                  className="small blue"
                  disabled={!inRep || (cursor === 0 && graph.size === 0)}
                  onClick={() => navigate('train', { rep: rep.id, mode: 'drill', at: key, t: String(Date.now()) })}
                  title={
                    inRep
                      ? cursor === 0
                        ? 'Train your whole repertoire now (learned and new moves, ignoring due dates)'
                        : 'Train this line and everything after it now (learned and new moves, ignoring due dates)'
                      : 'Add this line to your repertoire first'
                  }
                >
                  Train this line
                </button>
                <button
                  className="small"
                  disabled={!biggestGap}
                  onClick={jumpToBiggestGap}
                  title={
                    biggestGap
                      ? `Most common position you have no answer for: ${biggestGap.label} (${oneIn(biggestGap.prob)} games)`
                      : live.running || live.stale
                        ? 'Calculating coverage…'
                        : `No gaps at 1 in ${goalN} games`
                  }
                >
                  Biggest gap{biggestGap ? ` · ${oneIn(biggestGap.prob)}` : ''}
                </button>
              </>
            )}
          </div>
          <LineView
            items={line.map((m, i) => ({ san: m.san, className: lineInRep[i] ? 'book' : 'out', title: lineInRep[i] ? 'In repertoire' : 'Not in repertoire' }))}
            current={cursor}
            onSelect={setCursor}
          />
          {opening && !zen && <div className="muted small" style={{ marginTop: 6 }}>{opening}</div>}
        </div>

        {!zen && (
          <>
            <div className={inRep ? 'metric-pair' : undefined}>
              <ReachPanel reach={reach} source={sourceLabel(settings)} atStart={cursor === 0} />
              {inRep && (
                <CoverageStrip
                  atStart={cursor === 0}
                  score={coverage?.coverage?.[key]}
                  prob={prob}
                  oneInN={goalN}
                  source={coverage?.paramsLabel}
                  running={live.running || live.stale}
                  queried={live.queried}
                  error={live.error}
                />
              )}
            </div>

            <ExplorerPanel
              fenKey={key}
              color={rep.color}
              title={myTurn ? 'Your move' : "Opponent's replies"}
              saved={children.map((c) => {
                const card = cardById.get(c.id);
                const childProb = coverage?.probs[c.toKey];
                const prepared = coverage?.coverage?.[c.toKey];
                return {
                  id: c.id,
                  san: c.san,
                  uci: c.uci,
                  mine: c.mine,
                  comment: c.comment,
                  extras: (
                    <>
                      {prepared !== undefined && childProb !== undefined && childProb >= 1 / goalN && (
                        <span className="small" style={{ color: coverColor(prepared) }} title="Prepared from the position after this move">
                          {Math.round(prepared * 100)}%
                        </span>
                      )}
                      {card && <CardBadge state={card.state} due={card.due} />}
                    </>
                  ),
                };
              })}
              notes={
                <>
                  {!inRep && !memory && (
                    <div className="note" style={{ marginBottom: 6 }}>
                      Not in your repertoire yet. Use <b>Add line</b> to save the line up to here{autoAdd ? '' : ' (or turn on Auto-add)'}.
                    </div>
                  )}
                  {inRep && children.length === 0 && (
                    <div className="note" style={{ marginBottom: 6 }}>
                      {myTurn ? 'No move prepared here yet — play one on the board or press + on a move below.' : 'End of line — press + on the replies you expect.'}
                    </div>
                  )}
                  {myTurn && myMovesHere.length > 1 && (
                    <div className="note" style={{ marginBottom: 6 }}>
                      You have {myMovesHere.length} prepared moves here. That's fine (all are trained), but most players keep one.
                    </div>
                  )}
                </>
              }
              onPlay={(san) => play(san)}
              onAdd={(san) => play(san, true)}
              onDelete={(id, san) => removeMove(id, san)}
              onOpening={setOpening}
              reachHere={reach.loading ? undefined : reach.prob}
            />
          </>
        )}
      </div>
    </div>
  );
}

function CardBadge({ state, due }: { state: number; due: number }) {
  if (state === 0) return <span className="badge new">new</span>;
  if (due <= Date.now()) return <span className="badge due">due</span>;
  const days = Math.round((due - Date.now()) / 86_400_000);
  return <span className="badge" title={`Next review ${new Date(due).toLocaleString()}`}>{days < 1 ? '<1d' : `${days}d`}</span>;
}

function countBelow(graph: RepGraph, moveId: string): number {
  const m = graph.byId.get(moveId);
  if (!m) return 1;
  const without = new Set([moveId]);
  // moves that become unreachable if this one is removed
  const remaining = [...graph.byId.values()].filter((x) => x.id !== moveId);
  const reach = new Set([graph.root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const x of remaining) {
      if (reach.has(x.fromKey) && !reach.has(x.toKey)) {
        reach.add(x.toKey);
        changed = true;
      }
    }
  }
  return without.size + remaining.filter((x) => !reach.has(x.fromKey)).length;
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/* ---------------------------------------------------- live coverage score */

function useLiveCoverage(
  repId: string,
  rep: Repertoire | undefined,
  graph: RepGraph | undefined,
  settings: AppSettings & { loaded: boolean },
  stored: CoverageResult | undefined,
) {
  const [state, setState] = useState<{ running: boolean; queried: number; error?: string }>({ running: false, queried: 0 });
  const fresh = !!rep && isCoverageFresh(stored, rep, settings);
  const sig = `${rep?.updatedAt}|${graph?.size}|${repTarget(rep, settings)}|${settings.probabilitySource}|${settings.speeds.join()}|${settings.rating}|${settings.ratingPool}|${settings.bandsMode}|${settings.manualBands.join()}`;
  useEffect(() => {
    if (!rep || !graph || !graph.size || !settings.loaded || fresh) return;
    const ctrl = new AbortController();
    // Debounce so a burst of edits triggers one recalculation; explorer lookups are cached.
    const t = setTimeout(async () => {
      setState({ running: true, queried: 0 });
      try {
        await runCoverageForGraph(repId, graph, { signal: ctrl.signal, onProgress: (q) => setState({ running: true, queried: q }) });
        setState({ running: false, queried: 0 });
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setState({ running: false, queried: 0, error: (e as Error).message });
      }
    }, 600);
    return () => {
      clearTimeout(t);
      ctrl.abort();
      setState((s) => (s.running ? { running: false, queried: 0 } : s));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, fresh, settings.loaded]);
  return { ...state, stale: !fresh && !!graph?.size && !state.error };
}

function coverColor(c: number): string {
  if (c >= 0.9) return 'var(--good)';
  if (c >= 0.7) return 'var(--warn)';
  return 'var(--bad)';
}

function CoverageStrip({
  atStart,
  score,
  prob,
  oneInN,
  source,
  running,
  queried,
  error,
}: {
  atStart: boolean;
  score?: number;
  prob?: number;
  oneInN: number;
  source?: string;
  running: boolean;
  queried: number;
  error?: string;
}) {
  const rare = prob === undefined || prob < 1 / oneInN;
  const explain = `Of the games that reach this position, the share that stays inside your repertoire until positions get rarer than 1 in ${oneInN} games${source ? ` (opponent moves: ${source})` : ''}.`;
  return (
    <div className="panel">
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h3 style={{ margin: 0 }} title={explain}>
          Prepared {atStart ? 'overall' : 'from here'}
        </h3>
        <span className="spacer" />
        {running && <span className="muted small">updating… {queried ? `${queried} positions looked up` : ''}</span>}
      </div>
      {error && <div className="error" style={{ marginTop: 6 }}>{error}</div>}
      {!error && score === undefined && (
        <div className="muted small" style={{ marginTop: 6 }}>
          {running ? 'Calculating…' : 'Not calculated yet.'}
        </div>
      )}
      {score !== undefined && !rare && (
        <div className="row" style={{ marginTop: 8, flexWrap: 'nowrap', opacity: running ? 0.5 : 1 }} title={explain}>
          <div className="progress" style={{ flex: 1, height: 10 }}>
            <div style={{ width: `${score * 100}%`, background: coverColor(score) }} />
          </div>
          <b style={{ fontSize: 20, color: coverColor(score), minWidth: 52, textAlign: 'right' }}>{Math.round(score * 100)}%</b>
        </div>
      )}
      {score !== undefined && !rare && (
        <div className="muted small" style={{ marginTop: 4 }}>
          {score >= 0.999
            ? `Fully prepared down to 1-in-${oneInN} positions.`
            : `${Math.round((1 - score) * 100)}% of games from here leave your prep while still common — see the gaps on the Coverage tab.`}
        </div>
      )}
      {rare && score !== undefined && (
        <div className="muted small" style={{ marginTop: 6 }}>
          This position is rarer than 1 in {oneInN} games, so nothing below it counts as required. Raise this repertoire's target on the Coverage page to dig deeper.
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------- how often you reach it */

interface LineReach {
  prob?: number;
  /** Explorer stats for the current position (to split the probability over replies). */
  here?: PositionStats;
  /** True when the figure includes other move orders from your repertoire. */
  viaRepertoire?: boolean;
  loading: boolean;
  error?: string;
}

function useLineReach(
  path: { fromKey: string; san: string; key: string }[],
  color: Color | undefined,
  graph: RepGraph | undefined,
  settings: AppSettings & { loaded: boolean },
  /** Repertoire-wide reach per position from an up-to-date coverage run (all move orders summed). */
  known?: CoverageResult,
): LineReach {
  const [state, setState] = useState<LineReach>({ loading: true });
  const lineSig = path.map((m) => m.san).join(' ');
  const key = path.length ? path[path.length - 1].key : START_KEY;
  const sig = `${lineSig}|${color}|${graph?.size}|${sourceLabel(settings)}|${known?.computedAt ?? 0}`;
  useEffect(() => {
    if (!color || !settings.loaded) return;
    const ctrl = new AbortController();
    // Drop the previous position's figure at once — showing it while the new one loads is misleading.
    setState({ loading: true });
    const t = setTimeout(async () => {
      try {
        const provider = await statsProvider(settings, color, ctrl.signal);
        // Split only between your saved choices; an unsaved move you're trying out counts as always played.
        const myOptions = (fromKey: string, san: string) => {
          const mine = graph?.childrenOf(fromKey).filter((m) => m.mine) ?? [];
          return mine.some((m) => m.san === san) ? mine.length : 1;
        };
        // Start from the deepest position on this line whose total reach the coverage run knows — that
        // counts every move order in your repertoire, so transpositions add up and the figure matches
        // the gap list — then follow the rest of the line move by move.
        let start = 0;
        let base = 1;
        if (known) {
          for (let i = path.length; i > 0; i--) {
            const p = known.probs[path[i - 1].key];
            if (p !== undefined && p > 0) {
              start = i;
              base = p;
              break;
            }
          }
        }
        const prob = base * (await reachAlongLine(path.slice(start), color, provider, myOptions));
        const here = turnOfKey(key) !== color ? await provider(key) : undefined;
        if (!ctrl.signal.aborted) setState({ prob, here, loading: false, viaRepertoire: start > 0 });
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setState({ loading: false, error: (e as Error).message });
      }
    }, 120);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, settings.loaded]);
  return state;
}


function ReachPanel({ reach, source, atStart }: { reach: LineReach; source: string; atStart: boolean }) {
  const p = reach.prob;
  return (
    <div className="panel">
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h3 style={{ margin: 0 }} title="If you play your moves and opponents answer like the selected database, the share of your games in which this position appears on the board.">
          Coverage
        </h3>
        <span className="spacer" />
        <span className="muted small">{source}</span>
      </div>
      {reach.error && <div className="error" style={{ marginTop: 6 }}>{reach.error}</div>}
      {!reach.error && (
        <div className="row" style={{ marginTop: 6, alignItems: 'baseline', opacity: reach.loading ? 0.5 : 1 }}>
          <b style={{ fontSize: 26 }}>{p === undefined ? '…' : p === 0 ? 'never' : oneIn(p)}</b>
          <span className="muted">
            {p === undefined
              ? 'calculating…'
              : p === 0
                ? '— this line doesn\'t occur in the database'
                : atStart || p >= 1 / 1.05
                  ? '— you reach this position'
                  : 'games reach this position'}
          </span>
        </div>
      )}
      {!reach.loading && reach.viaRepertoire && !atStart && (
        <div className="muted small" style={{ marginTop: 4 }}>
          Counts every move order in your repertoire that reaches this position.
        </div>
      )}
    </div>
  );
}
