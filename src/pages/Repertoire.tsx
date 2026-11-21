import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { PageProps } from '../App';
import { db } from '../db/db';
import { addEdges, chapterForNewLine, deleteMove, deleteRepertoire, deleteUnionMove, renameRepertoire, setMoveAnnotation, setNoTrain, splitOff } from '../db/repertoire';
import { loadOpeningIndex, nameParts } from '../lib/openingNames';
import { catchAllName, catchAllOf, chapterGap, chapterOfMoveId, chapterPosition, chapterTerritory, entersOtherChapter, sourcesOf, trainable } from '../lib/chapters';
import { useOpeningIndex } from '../components/ChapterTree';
import { ChaptersPanel, ChapterSwitcher } from '../components/ChaptersPanel';
import { repTarget, useSettings, updateSettings } from '../db/settings';
import { PHONE_QUERY, useCards, useChapterGraphs, useCoverage, useMediaQuery, useRepGraph } from '../hooks';
import { byName, cardIdOf, cardsOf } from '../lib/chapters';
import { colorName, useChaptersAndSets, useScopeGraph } from '../db/scopes';
import type { StudioPanelDef } from '../components/Studio';
// The studio (dockview) loads only when the desktop builder opens it — phones never download it.
const Studio = lazy(() => import('../components/Studio').then((m) => ({ default: m.Studio })));
import type { DockviewApi, DockviewPanelApi } from 'dockview-react';
import { Board } from '../components/Board';
import { PhoneStudio } from '../components/PhoneStudio';
import { EvalBar } from '../components/EvalBar';
import { PositionMenuItems, PositionTools } from '../components/PositionTools';
import { RepertoireHub } from './MapPage';
import { ExplorerPanel } from '../components/ExplorerPanel';
import { InlineMoves } from '../components/InlineMoves';
import { annotateProps } from '../components/NotePopover';
import { AnnotationMenu, type AnnotationTarget } from '../components/AnnotationMenu';
import { glyphClass, glyphName, moveGlyph, sanWithGlyphs } from '../lib/annotations';
import { MoveList, revealInBox, type SideLine } from '../components/MoveList';
import { EnginePanel } from '../components/EnginePanel';
import { ColorPill, Empty, LineView, MoreMenu } from '../components/ui';
import { href, navigate, openScope, scopeHref } from '../router';
import { nextMemoryTarget, type MemoryStep } from '../lib/fromMemory';
import { compactLine, formatLine, moveNumberPrefix, playSan, playUci, posFromFen, START_KEY, turnOfKey, type Color } from '../lib/chess';
import { oneIn, oneInShort } from '../lib/coverage';
import { isCoverageFresh, reachAlongLine, runCoverageForGraph, sourceLabel, statsProvider } from '../services/coverage';
import type { AppSettings } from '../db/settings';
import { type CoverageResult, type PositionStats, type RepMove, type Repertoire } from '../lib/types';
import { isDue, isNew } from '../lib/srs';
import { RepGraph } from '../lib/graph';

export function RepertoirePage({ route }: PageProps) {
  const id = route.path[1];
  // Keyed by chapter: switching chapters starts the builder afresh at the line it was opened with.
  if (id) return <Builder key={id} repId={id} initialLine={route.query.get('line') ?? ''} />;
  return <RepertoireHub route={route} />;
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

/** Another chapter's own part of the tree (chapterTerritory), with the chapter and its graph. */
type Territory = { chapter: Repertoire; graph: RepGraph; key: string; moves: RepMove[]; keys: Set<string> };

/**
 * The repertoire builder. `onDone`: opened from a training session (Edit line) — shows "Continue
 * training" instead of the links that would leave the session.
 */
export function Builder({ repId, initialLine, onDone }: { repId: string; initialLine: string; onDone?: () => void }) {
  // `repId` is a chapter — or 'white' / 'black': all of that color's chapters as one tree, like a
  // repertoire from before chapters. Then new moves are filed in the chapter the line continues (or
  // a new chapter named after its opening), and deletes and notes apply to every chapter with the move.
  const colorMode = repId === 'white' || repId === 'black';
  const chapterData = useRepGraph(colorMode ? undefined : repId);
  // (Every move, those marked not to train too: they're shown, struck through.)
  const colorData = useScopeGraph(colorMode ? repId : undefined, { all: true });
  const rep: Repertoire | undefined = colorMode
    ? colorData.scope && { id: repId, name: `All ${colorName(repId as Color)} chapters`, color: repId as Color, createdAt: 0, updatedAt: colorData.scope.updatedAt }
    : chapterData.rep;
  const graph = colorMode ? colorData.graph : chapterData.graph;
  const loading = colorMode ? colorData.loading : chapterData.loading;
  /** Browsing a color: when two chapters fit a new line equally well, you pick (undefined: cancelled). */
  const [asking, setAsking] = useState<{ ids: string[]; resolve: (id?: string) => void } | null>(null);
  const askChapter = (ids: string[]) => new Promise<string | undefined>((resolve) => setAsking({ ids, resolve }));
  /** A line about to go into another chapter's own part (see territories): where it goes instead. */
  const [entering, setEntering] = useState<{ san: string; key: string; other: Territory; resolve: (choice: 'there' | 'here' | 'cancel') => void } | null>(null);
  /** Chapters you said to add into this one anyway (this visit): not asked about again. */
  const addHereAnyway = useRef(new Set<string>());
  const territoriesRef = useRef<Territory[]>([]);
  /**
   * Save a line (from the start): into this chapter, or — browsing a color — the chapter it belongs in.
   * In a chapter, a line going into another chapter's own part of the tree (a transposition, or the
   * wrong chapter) asks first: carry on there, add it here too, or not at all.
   */
  const saveLine = async (path: LineMove[], opts?: { known?: boolean }) => {
    if (!colorMode && graph) {
      const others = territoriesRef.current.filter((t) => !addHereAnyway.current.has(t.chapter.id));
      const hit = entersOtherChapter(path, (fromKey, san) => !!graph.edge(fromKey, san), others);
      if (hit) {
        const at = path[hit.index];
        const choice = await new Promise<'there' | 'here' | 'cancel'>((resolve) => setEntering({ san: at.san, key: at.key, other: hit.other, resolve }));
        setEntering(null);
        if (choice === 'cancel') return { added: 0, mineAdded: 0 };
        if (choice === 'there') {
          // The rest of the line goes on in that chapter, from the same position.
          const rest = path.slice(hit.index + 1);
          if (rest.length) await addEdges(hit.other.chapter.id, toEdges(rest), opts);
          const theirs = (hit.other.graph.pathTo(at.key) ?? []).map((m) => m.san);
          navigate(`repertoire/${hit.other.chapter.id}`, { line: [...theirs, ...rest.map((m) => m.san)].join(' ') });
          return { added: 0, mineAdded: 0 };
        }
        addHereAnyway.current.add(hit.other.chapter.id);
      }
    }
    const target = colorMode ? await chapterForNewLine(repId as Color, path.map((m) => m.san), askChapter) : repId;
    if (!target) return { added: 0, mineAdded: 0 };
    return addEdges(target, toEdges(path), opts);
  };
  const allCards = useCards();
  // The cards you train here: moves marked not to train (and what only they lead to) don't count.
  const cards = useMemo(() => (graph && allCards ? cardsOf(new RepGraph(graph.color, trainable(graph.color, [...graph.byId.values()])), allCards) : undefined), [graph, allCards]);
  // Moves left out of training: those marked not to train and the lines after them (what only they lead to).
  const untrained = useMemo(() => {
    const all = graph ? [...graph.byId.values()] : [];
    if (!graph || !all.some((m) => m.noTrain)) return new Set<string>();
    const kept = new Set(trainable(graph.color, all).map((m) => m.id));
    return new Set(all.filter((m) => !kept.has(m.id)).map((m) => m.id));
  }, [graph]);
  // Coverage is of all this color's chapters together: an Italian chapter isn't "missing" 1...c5 if
  // your Sicilian chapter answers it. The run is kept live as you edit.
  const { scope: colorScope, graph: colorGraph } = useScopeGraph(rep?.color);
  const coverage = useCoverage(rep?.color);
  const settings = useSettings();
  const live = useLiveCoverage(rep?.color ?? '', colorScope, colorGraph, settings, coverage);
  const [line, setLine] = useState<LineMove[]>(() => lineFromSans(initialLine.split(/\s+/).filter(Boolean)));
  const [cursor, setCursor] = useState(line.length);
  // Only trust a coverage run that matches the current repertoire and settings.
  const goalN = repTarget(colorScope, settings);
  const freshCoverage = colorScope && settings.loaded && isCoverageFresh(coverage, colorScope, settings) ? coverage : undefined;
  const reach = useLineReach(line.slice(0, cursor), rep?.color, colorGraph, settings, freshCoverage);
  // How often this position comes up if the chapter's opening came up every game: the figure above
  // divided by how often the opening's position (e.g. 1.e4 d6 for a Pirc chapter) comes up.
  const openingNames = useOpeningIndex();
  // Your other chapters of this color, each with its own part of the tree (chapterTerritory): a line
  // added here that goes into one of them is caught (saveLine), and being there says so.
  const chapterGraphs = useChapterGraphs();
  const { chapters: allChapters } = useChaptersAndSets();
  const territories = useMemo<Territory[]>(() => {
    if (colorMode || !rep || !chapterGraphs || !allChapters || !openingNames) return [];
    return allChapters
      .filter((c) => c.color === rep.color && c.id !== rep.id)
      .flatMap((c) => {
        const g = chapterGraphs.get(c.id);
        const t = g && chapterTerritory(g, openingNames, c.name);
        return g && t ? [{ chapter: c, graph: g, ...t }] : [];
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorMode, rep?.id, rep?.color, chapterGraphs, allChapters, openingNames]);
  territoriesRef.current = territories;
  const chapterOpening = useMemo(() => (graph && rep && !colorMode ? chapterPosition(graph, openingNames, rep.name) : undefined), [graph, openingNames, rep, colorMode]);
  const openingPath = (chapterOpening?.moves ?? []).map((m) => ({ fromKey: m.fromKey, san: m.san, key: m.toKey }));
  const openingReach = useLineReach(openingPath, rep?.color, colorGraph, settings, freshCoverage);
  const here = line.slice(0, cursor);
  const pastOpening =
    !!chapterOpening && chapterOpening.moves.length > 0 && here.length > chapterOpening.moves.length && here.some((m) => m.key === chapterOpening.key);
  const within =
    pastOpening && reach.prob !== undefined && openingReach.prob ? { prob: Math.min(1, reach.prob / openingReach.prob), loading: reach.loading || openingReach.loading } : undefined;
  const [flipped, setFlipped] = useState(false);
  // The move whose annotation menu (symbols and note) is open, from a right-click.
  const [noteTarget, setNoteTarget] = useState<RepAnnotationTarget | null>(null);
  // Desktop: a dockable "studio" (tabs, rows and columns you arrange; remembered per device).
  // Narrow windows (tablets): everything stacked, the page scrolls.
  const stacked = useMediaQuery('(max-width: 900px)');
  // Phones: the board, its buttons and the moves fit on the first screen (see .builder-phone).
  const phone = useMediaQuery(PHONE_QUERY);
  const [layoutVersion, setLayoutVersion] = useState(0);
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
      await saveLine(path);
    }
  };

  /**
   * Several moves at once (a move further along a Stockfish line): the board goes to the position after
   * them. Not added to the chapter even with auto-add on — it's a look ahead, and Add line keeps it.
   */
  const playMoves = (sans: string[]) => {
    let p = pos;
    let from = key;
    const items: LineMove[] = [];
    for (const san of sans) {
      const r = playSan(p, san);
      if (!r) break;
      items.push({ san: r.san, uci: r.uci, fromKey: from, key: r.key });
      p = r.pos;
      from = r.key;
    }
    if (!items.length) return;
    // The line already carries on this way: just step along it (keeping what comes after).
    if (!items.every((m, i) => line[cursor + i]?.san === m.san)) setLine([...line.slice(0, cursor), ...items]);
    setCursor(cursor + items.length);
  };

  /* ---- Play from memory: it plays popular opponent moves, you answer, your moves save as known ---- */
  const [memory, setMemory] = useState<{ startKey: string; startPath: MemoryStep[]; startProb: number } | null>(null);
  // Replies most common first once coverage knows how often they're played.
  const navProbs = coverage?.probs;
  const orderKids = useCallback(
    (kids: RepMove[]) => (navProbs ? [...kids].sort((a, b) => (navProbs[b.toKey] ?? 0) - (navProbs[a.toKey] ?? 0)) : kids),
    [navProbs],
  );
  // The scoresheet shows your line and then carries on down the repertoire's main continuation to the
  // end of the line, like a game score. Not in Play from memory: that would give the answers away.
  const display = useMemo(() => {
    const out: LineMove[] = [...line];
    if (memory || !graph) return out;
    const last = out[out.length - 1];
    if (last && !graph.edge(last.fromKey, last.san)) return out; // you've left the repertoire
    const seen = new Set([START_KEY, ...out.map((m) => m.key)]);
    let k = last ? last.key : START_KEY;
    for (let guard = 0; guard < 120; guard++) {
      const m = orderKids(graph.childrenOf(k))[0];
      if (!m || seen.has(m.toKey)) break;
      out.push({ san: m.san, uci: m.uci, fromKey: m.fromKey, key: m.toKey });
      seen.add(m.toKey);
      k = m.toKey;
    }
    return out;
  }, [line, graph, memory, orderKids]);
  const goTo = (plies: number) => {
    if (plies > line.length) setLine(display.slice(0, plies));
    setCursor(plies);
  };
  const forward = () => (cursor < display.length ? goTo(cursor + 1) : !memory && children[0] && play(children[0].san));
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
      const { mineAdded } = await saveLine(path, { known: true });
      setMemAdded((n) => n + mineAdded);
      return;
    }
    play(r.san);
  };

  // The most common hole: an opponent reply you don't answer, or your move with nothing prepared.
  // Only this chapter's: a gap in another chapter is fixed there.
  // (Rarer than the target too: the real biggest hole, not "none".)
  const biggestGap = useMemo(() => {
    if (!freshCoverage || !graph) return undefined;
    // (All of a color's chapters: the whole repertoire's biggest hole, not one opening's.)
    const pick = chapterGap(graph, freshCoverage, openingNames, rep?.name, colorMode);
    if (!pick) return undefined;
    return { ...pick, label: formatLine(pick.sans) || 'the starting position' };
  }, [freshCoverage, graph, openingNames, rep?.name, colorMode]);

  const jumpToBiggestGap = () => {
    if (!biggestGap) return;
    const l = lineFromSans(biggestGap.sans);
    setLine(l);
    setCursor(l.length);
  };

  const addLineToRep = async () => {
    const { added } = await saveLine(line.slice(0, cursor));
    setMessage(`Added ${added} move${added === 1 ? '' : 's'}.`);
    setTimeout(() => setMessage(null), 2500);
  };

  const removeMove = async (moveId: string, san: string) => {
    const n = graph ? countBelow(graph, moveId) : 1;
    if (n > 1 && !confirm(`Delete ${san} and the ${n - 1} move(s) that follow it?`)) return;
    const m = graph?.byId.get(moveId);
    if (colorMode) {
      if (m) await deleteUnionMove(m);
    } else await deleteMove(repId, moveId);
  };

  // Play from memory on a phone shows the line as text in a small box: keep the current move in it.
  const lineBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    revealInBox(lineBox.current?.querySelector('.mv.current'));
  }, [cursor, line.length, memory, phone]);

  // keyboard navigation (not with Ctrl / ⌘ / Alt: those are the browser's — Ctrl+F finds, Alt+← goes back)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement)?.closest('input, textarea, select')) return;
      if (e.key === 'ArrowLeft') setCursor((c) => Math.max(0, c - 1));
      else if (e.key === 'ArrowRight') forward();
      else if (e.key === 'Home') setCursor(0);
      else if (e.key === 'End') goTo(display.length);
      else if (e.key === 'x' || e.key === 'X') setFlipped((f) => !f);
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
  // Play from memory is "zen mode": just the board and the line — no explorer, arrows, notes,
  // engine or stats. If you can't find the move without the explorer, you don't really know it.
  const zen = !!memory;
  const dueCount = (cards ?? []).filter((c) => isDue(c)).length;
  const newCount = (cards ?? []).filter(isNew).length;
  const nav = settings.builderNav === 'inline' ? 'inline' : 'scoresheet';
  // Right-click (long-press on touch) a saved move to annotate it: symbols and a note, like a Lichess
  // study. Not in Play from memory. `ply` is the move's place from the start (for its move number).
  const annotate = (m: RepMove | undefined, ply: number) =>
    m && !zen ? annotateProps((x, y) => setNoteTarget({ id: sourcesOf(m)[0], sources: sourcesOf(m), moveId: m.id, san: m.san, ply, x, y })) : {};
  // A saved move as written in the notation: its symbols after it, colored like Lichess.
  // (A move left out of training — and the line after it — is greyed out, symbols' colors and all.)
  const shown = (m: RepMove) => ({
    san: sanWithGlyphs(m.san, m.glyphs),
    className: `${glyphClass(moveGlyph(m))} ${untrained.has(m.id) ? 'no-train' : ''}`,
    title:
      [
        m.noTrain ? 'Not trained, nor the line after it' : untrained.has(m.id) ? 'Not trained: it comes after a move you don’t train' : '',
        ...(m.glyphs ?? []).map(glyphName),
        m.comment ?? '',
      ]
        .filter(Boolean)
        .join(' · ') || undefined,
  });
  // Back to the default studio layout (the Studio forgets the saved one).
  const resetLayout = () => setLayoutVersion((v) => v + 1);

  // Side lines: the repertoire's other moves where the displayed line could have gone differently,
  // each run ahead to its next choice.
  const sideLines = (i: number): SideLine[] => {
    const m = display[i];
    if (!graph.has(m.fromKey)) return [];
    return orderKids(graph.childrenOf(m.fromKey))
      .filter((c) => c.san !== m.san)
      .map((alt) => {
        const run = [alt];
        const seen = new Set([m.fromKey, alt.toKey]);
        let k = alt.toKey;
        for (let kids = graph.childrenOf(k); kids.length === 1 && run.length < 8 && !seen.has(kids[0].toKey); kids = graph.childrenOf(k)) {
          run.push(kids[0]);
          k = kids[0].toKey;
          seen.add(k);
        }
        const more = graph.childrenOf(k).length;
        return {
          key: alt.id,
          moves: run.map((x, j) => ({ ...shown(x), note: !!x.comment, menu: annotate(x, i + j) })),
          onSelect: (j: number) => {
            const l = [...display.slice(0, i), ...run.slice(0, j + 1).map((x) => ({ san: x.san, uci: x.uci, fromKey: x.fromKey, key: x.toKey }))];
            setLine(l);
            setCursor(l.length);
          },
          tail: more > 0 ? <span className="ml-more" title={`${more} choice${more === 1 ? '' : 's'} follow — click the line to see them`}>…</span> : undefined,
        };
      });
  };

  const counts = `${plural(graph.myMoves().length, 'move')} · ${plural(graph.leaves().length, 'line')}`;
  // The chapter itself (not when browsing all of a color's chapters).
  const chapterActions = !colorMode && (
    <>
      <button
        onClick={() => {
          const n = prompt('Rename chapter', rep.name);
          if (n?.trim()) void renameRepertoire(rep.id, n.trim());
        }}
      >
        Rename chapter…
      </button>
      <button
        className="danger"
        onClick={async () => {
          if (!confirm(`Delete “${rep.name}”? Its lines go with it, and the training progress on moves no other chapter has.`)) return;
          await deleteRepertoire(rep.id);
          navigate('repertoire');
        }}
      >
        Delete chapter…
      </button>
    </>
  );
  const header = (
    <div className="builder-head">
      <ChapterSwitcher chapter={rep} line={line.slice(0, cursor).map((m) => m.san)} />
      <ColorPill color={rep.color} />
      {!phone && <span className="muted small">{counts}</span>}
      {phone && <span className="spacer" />}
      <button
        className="primary small"
        onClick={startMemory}
        disabled={reach.loading && cursor > 0}
        title="It plays your opponents' most popular moves and you answer. Your moves are saved as already known (no need to learn them), until everything from here is filled in down to your 1-in-N goal."
        aria-label={phone && onDone ? 'Play from memory' : undefined}
      >
        {/* Opened from training, a phone's row also has Continue: just ▶, so the chapter's name still shows. */}
        ▶{phone && onDone ? '' : phone ? ' From memory' : ` Play from memory${cursor > 0 ? ' from here' : ''}`}
      </button>
      {!phone && <span className="spacer" />}
      {!stacked && (
        <button className="small ghost" onClick={resetLayout} title="Put the panes back to their original sizes">
          Reset layout
        </button>
      )}
      {onDone && (
        <button className="primary small" onClick={onDone}>
          {phone ? 'Continue →' : 'Continue training →'}
        </button>
      )}
      {phone ? (
        // One row on a phone: the links and the notation choice wait in a menu.
        <MoreMenu label="More">
          {!onDone && (
            <>
              <button onClick={() => navigate('train', { rep: rep.id, mode: 'learn' })}>
                Learn <span className="badge new">{newCount}</span>
              </button>
              <button onClick={() => navigate('train', { rep: rep.id, mode: 'review' })}>
                Review <span className="badge due">{dueCount}</span>
              </button>
              <button onClick={() => openScope(rep.id)}>Map — gaps, weak moves</button>
            </>
          )}
          <button onClick={() => updateSettings({ builderNav: nav === 'inline' ? 'scoresheet' : 'inline' })}>
            {nav === 'inline' ? 'Show moves as a scoresheet' : 'Show moves inline'}
          </button>
          <PositionMenuItems pos={pos} ply={cursor} orientation={orientation} />
          {!onDone && <button onClick={() => navigate('repertoire')}>All repertoires</button>}
          {!onDone && chapterActions}
          <div className="menu-note muted small">{counts}</div>
        </MoreMenu>
      ) : onDone ? null : (
        <>
          <a className="btn small" href={href('train', { rep: rep.id, mode: 'learn' })}>
            Learn <span className="badge new">{newCount}</span>
          </a>
          <a className="btn small" href={href('train', { rep: rep.id, mode: 'review' })}>
            Review <span className="badge due">{dueCount}</span>
          </a>
          <a className="btn small" href={scopeHref(rep.id)} title="How well you know this, its gaps and your weakest moves (Repertoire tab)">
            Map
          </a>
          <a className="btn small" href={href('repertoire')}>
            All
          </a>
          {chapterActions && <MoreMenu label="Chapter">{chapterActions}</MoreMenu>}
        </>
      )}
    </div>
  );

  const memoryPanel = memory && (
    <div className="panel memory-panel">
      <div className="row">
        <h3 style={{ margin: 0 }}>{phone ? 'Play from memory' : `Play from memory · ${rep.name}`}</h3>
        <span className="spacer" />
        {memAdded > 0 && !phone && <span className="badge good">{plural(memAdded, 'move')} added</span>}
        {memState.status === 'waiting' && (
          <button className="small" onClick={skipMemory} title="Skip this position for now">
            I don't know this
          </button>
        )}
        <button className="small" onClick={stopMemory}>
          Stop
        </button>
      </div>
      <div className="memory-status">
        {memAdded > 0 && phone && <span className="badge good">{plural(memAdded, 'move')} added</span>}{' '}
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
  );

  const movesPanel = (
    <div className="panel moves-panel">
      <div className="row moves-head">
        <h3 style={{ margin: 0 }}>Moves</h3>
        {opening && !zen && <span className="muted small moves-opening">{opening}</span>}
        <span className="spacer" />
        {!zen && (
          <>
            {missingUpToCursor && (
              <button className="primary small" onClick={addLineToRep}>
                + Add line
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
                    : 'No gaps found in this chapter'
              }
            >
              Biggest gap{biggestGap ? ` · ${oneIn(biggestGap.prob)}` : ''}
            </button>
            {!phone && (
              <span className="seg" title="How to show the moves · right-click a move to annotate it (symbols and a note)">
                <button className={`small ${nav === 'scoresheet' ? 'active' : ''}`} onClick={() => updateSettings({ builderNav: 'scoresheet' })}>
                  Scoresheet
                </button>
                <button className={`small ${nav === 'inline' ? 'active' : ''}`} onClick={() => updateSettings({ builderNav: 'inline' })}>
                  Inline
                </button>
              </span>
            )}
          </>
        )}
      </div>
      <div className="moves-body" ref={lineBox}>
        {zen && phone ? (
          // Play from memory on a phone: the line as a few lines of text, not a tall scoresheet.
          <LineView
            items={display.map((m) => ({ san: m.san, className: graph.edge(m.fromKey, m.san) ? undefined : 'out' }))}
            current={cursor}
            onSelect={goTo}
          />
        ) : nav === 'scoresheet' || zen ? (
          <MoveList
            moves={display.map((m, i) => {
              const e = graph.edge(m.fromKey, m.san);
              // The line you're on shows its symbols and notes (not in Play from memory: they'd give it away).
              const s = e && !zen ? shown(e) : undefined;
              return {
                san: s?.san ?? m.san,
                // Only moves you've played that aren't saved stand out (grey, italic).
                className: e ? s?.className : 'out',
                title: e ? s?.title : 'Not in your repertoire yet',
                comment: zen ? undefined : e?.comment || undefined,
                menu: annotate(e, i),
              };
            })}
            current={cursor}
            onSelect={goTo}
            sideLines={zen ? undefined : sideLines}
          />
        ) : (
          <InlineMoves
            graph={graph}
            line={display}
            current={cursor}
            order={orderKids}
            onSelect={(path) => {
              setLine(path);
              setCursor(path.length);
            }}
            menuFor={annotate}
            untrained={untrained}
          />
        )}
      </div>
      {noteTarget && (
        <RepAnnotationMenu
          target={noteTarget}
          onClose={() => setNoteTarget(null)}
          onDelete={noteTarget.moveId ? () => void removeMove(noteTarget.moveId!, noteTarget.san) : undefined}
        />
      )}
      {entering && rep && (
        <EntersChapter
          san={entering.san}
          other={entering.other}
          theirs={(entering.other.graph.pathTo(entering.key) ?? []).map((m) => m.san)}
          here={rep.name}
          onChoose={(c) => entering.resolve(c)}
        />
      )}
      {asking && (
        <ChooseChapter
          ids={asking.ids}
          onPick={(id) => {
            asking.resolve(id);
            setAsking(null);
          }}
        />
      )}
    </div>
  );

  const engine = <EnginePanel fenKey={key} ply={cursor} onPlay={(san) => play(san)} onJump={playMoves} />;
  const coverageBox = (
    <CoverageBox
      reach={reach}
      within={within}
      openingLabel={formatLine((chapterOpening?.moves ?? []).map((m) => m.san))}
      colorLabel={rep ? `${rep.color === 'white' ? 'White' : 'Black'} chapters` : ''}
      inRep={inRep}
      score={coverage?.coverage?.[key]}
      prob={prob}
      oneInN={goalN}
      source={sourceLabel(settings)}
      running={live.running || live.stale}
      error={live.error}
    />
  );
  const reachMark = !reach.error && (reach.prob !== undefined || reach.loading) && (
    <span className="ps-reach" style={{ opacity: reach.loading ? 0.5 : 1 }} title="How often games reach this position">
      {reach.prob === undefined ? '…' : reach.prob === 0 ? 'never' : `1 in ${oneInShort(reach.prob)}`}
    </span>
  );
  // Lichess analysis and the FEN to copy (e.g. into Chessable) — not while playing from memory.
  const positionTools = <PositionTools pos={pos} ply={cursor} orientation={orientation} />;
  const board = (
    <Board
      pos={pos}
      orientation={orientation}
      interactive
      lastMove={lastMove}
      onMove={onBoardMove}
      arrows={zen ? [] : children.map((c) => ({ uci: c.uci, brush: c.mine ? 'green' : 'paleBlue' }))}
    />
  );
  const navButtons = (
    <>
      <button onClick={() => setCursor(0)} title="Start (Home)" aria-label="Start">
        ⏮
      </button>
      <button className="ps-step" onClick={() => setCursor(Math.max(0, cursor - 1))} title="Back (←)" aria-label="Back">
        ◀
      </button>
      <button className="ps-step" onClick={forward} title="Forward (→)" aria-label="Forward">
        ▶
      </button>
      <button onClick={() => goTo(display.length)} title="End of the line (End)" aria-label="End of the line">
        ⏭
      </button>
      <button onClick={() => setFlipped(!flipped)} title="Flip board (x)" aria-label="Flip board">
        ⇅
      </button>
    </>
  );
  const boardPane = (
    <>
      <div className="board-fit">{board}</div>
      <div className="row">
        {navButtons}
        {!stacked && (
          <button onClick={(e) => fitBoard(e.currentTarget)} title="Snap this pane to the board: no spare space around it">
            Fit
          </button>
        )}
        <span className="spacer" />
        {!zen && (
          <label className="check small" title="Every move you play on the board is saved into the repertoire immediately">
            <input type="checkbox" checked={autoAdd} onChange={(e) => updateSettings({ builderAutoAdd: e.target.checked })} />
            {phone ? 'Auto-add' : 'Auto-add moves'}
          </label>
        )}
      </div>
      {!zen && !phone && positionTools}
      {!zen && stacked && !phone && coverageBox}
    </>
  );
  const explorer = !zen && (
    <ExplorerPanel
      fenKey={key}
      color={rep.color}
      title={myTurn ? 'Your move' : "Opponent's replies"}
      saved={children.map((c) => {
        const card = cardById.get(cardIdOf(c));
        const childProb = coverage?.probs[c.toKey];
        const prepared = coverage?.coverage?.[c.toKey];
        return {
          id: c.id,
          san: c.san,
          uci: c.uci,
          mine: c.mine,
          prepared:
            prepared !== undefined && childProb !== undefined && childProb >= 1 / goalN ? (
              <span className="small" style={{ color: coverColor(prepared) }} title="Prepared from the position after this move">
                {Math.round(prepared * 100)}%
              </span>
            ) : undefined,
          // Due or when it's next due — not "new" for a move you haven't learned yet (most of a fresh line).
          extras: card && card.state !== 0 && <CardBadge state={card.state} due={card.due} />,
        };
      })}
      notes={
        <>
          {!inRep && (
            <div className="note" style={{ marginBottom: 6 }}>
              Not in your repertoire yet. Use <b>Add line</b> to save the line up to here{autoAdd ? '' : ' (or turn on Auto-add)'}.
            </div>
          )}
          {inRep && children.length === 0 && (
            <div className="note" style={{ marginBottom: 6 }}>
              {myTurn ? 'No move prepared here yet — play one on the board or press + on a move below.' : 'End of line — press + on the replies you expect.'}
            </div>
          )}
          {territories
            .filter((t) => t.keys.has(key))
            .map((t) => (
              <div key={t.chapter.id} className="note" style={{ marginBottom: 6 }}>
                ↪ This position is part of your “{t.chapter.name}” chapter — its lines from here are there.{' '}
                <button
                  className="linklike"
                  onClick={() => navigate(`repertoire/${t.chapter.id}`, { line: (t.graph.pathTo(key) ?? []).map((m) => m.san).join(' ') })}
                >
                  Open it there
                </button>
              </div>
            ))}
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
  );

  // Phones: the board stays on screen; the moves, explorer, Stockfish and coverage are tabs under it
  // (Play from memory: just the status and the line), and the move buttons sit at the bottom.
  if (phone)
    return (
      <PhoneStudio
        page="builder"
        className={`builder-phone ${zen ? 'zen' : ''}`}
        head={!zen && header}
        board={board}
        evalBar={!zen && <EvalBar fenKey={key} orientation={orientation} />}
        // Stockfish at the top, like Chess.com (not while playing from memory)
        engine={!zen && <EnginePanel top fenKey={key} ply={cursor} onPlay={(san) => play(san)} onJump={playMoves} />}
        tabs={
          zen
            ? [{ id: 'memory', label: 'Play from memory', content: <>{memoryPanel}{movesPanel}</> }]
            : [
                { id: 'moves', label: 'Moves', content: movesPanel },
                { id: 'explorer', label: 'Explorer', content: explorer },
                // (Chapters: the switcher on the chapter's name, at the top.)
                // How often games reach this position, on the tab itself: no need to open it to see.
                { id: 'coverage', label: 'Coverage', mark: reachMark, content: coverageBox },
              ]
        }
        controls={
          <>
            {navButtons}
            {!zen && (
              <label className="check small" title="Every move you play on the board is saved into the repertoire immediately">
                <input type="checkbox" checked={autoAdd} onChange={(e) => updateSettings({ builderAutoAdd: e.target.checked })} />
                Auto-add
              </label>
            )}
          </>
        }
      />
    );

  if (stacked)
    return (
      <div className="builder">
        {!zen && header}
        <div className="board-layout builder-grid">
          <div className="board-col col">{boardPane}</div>
          <div className="col builder-right">
            {memoryPanel}
            {!zen && engine}
            {movesPanel}
            {explorer}
          </div>
        </div>
      </div>
    );

  const hidden = <div className="muted small studio-hidden">Hidden while you play from memory.</div>;
  const studioPanels: StudioPanelDef[] = [
    { type: 'board', title: 'Board', render: () => <div className="board-pane">{boardPane}</div> },
    { type: 'stockfish', title: 'Stockfish', fitHeight: true, render: () => (zen ? hidden : engine) },
    {
      type: 'moves',
      title: 'Moves',
      render: () => (
        <>
          {memoryPanel}
          {movesPanel}
        </>
      ),
    },
    { type: 'explorer', title: 'Explorer', multiple: true, render: () => (zen ? hidden : explorer) },
    {
      type: 'chapters',
      title: 'Chapters',
      render: () => (zen ? hidden : <ChaptersPanel color={rep.color} line={line.slice(0, cursor).map((m) => m.san)} current={colorMode ? undefined : rep.id} />),
    },
    {
      type: 'coverage',
      title: 'Coverage',
      fitHeight: true,
      render: () => (zen ? hidden : coverageBox),
    },
  ];

  return (
    <div className="builder studio">
      {!zen && header}
      {zen && <div className="builder-head" />}
      <div className="studio-wrap">
        <Suspense fallback={<div className="muted small">Loading the studio…</div>}>
          <Studio storageKey="builder-studio-v1" panels={studioPanels} defaultLayout={defaultBuilderLayout} resetSignal={layoutVersion} />
        </Suspense>
      </div>
    </div>
  );
}

/** Board on the left (coverage under it); Stockfish, moves and the explorer stacked on the right. */
function defaultBuilderLayout(api: DockviewApi) {
  const add = (type: string, title: string, position?: Parameters<DockviewApi['addPanel']>[0]['position'], size?: { initialWidth?: number; initialHeight?: number }) =>
    api.addPanel({ id: type, component: 'panel', title, params: { type }, ...(position ? { position } : {}), ...size });
  add('board', 'Board');
  add('stockfish', 'Stockfish', { referencePanel: 'board', direction: 'right' }, { initialWidth: Math.round(api.width * 0.56) });
  add('moves', 'Moves', { referencePanel: 'stockfish', direction: 'below' });
  add('explorer', 'Explorer', { referencePanel: 'moves', direction: 'below' });
  add('chapters', 'Chapters', { referencePanel: 'explorer', direction: 'within' });
  api.getPanel('explorer')?.api.setActive();
  add('coverage', 'Coverage', { referencePanel: 'board', direction: 'below' }, { initialHeight: 96 });
  // Stockfish starts at the height of a header and three lines (it snaps to its content anyway).
  api.getPanel('stockfish')?.group.api.setSize({ height: 160 });
  api.getPanel('moves')?.group.api.setSize({ height: Math.round((api.height - 160) * 0.5) });
}

/**
 * Snap the board's pane to the board: make its width match the board's height, so the board is as
 * big as the pane's height allows with no spare space beside it (or the pane narrows if too wide).
 */
function fitBoard(from: HTMLElement) {
  const fit = from.closest('.studio-body')?.querySelector('.board-fit') as HTMLElement | null;
  const api = (from.closest('.studio-body') as (HTMLElement & { __dvPanelApi?: DockviewPanelApi }) | null)?.__dvPanelApi;
  if (!fit || !api) return;
  const { clientWidth: w, clientHeight: h } = fit;
  if (Math.abs(w - h) > 2) api.group.api.setSize({ width: api.group.api.width + (h - w) });
}

/** A learned move's training state in the explorer: due, or how long until it is. */
function CardBadge({ state, due }: { state: number; due: number }) {
  if (state === 0) return null;
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
  rep: Pick<Repertoire, 'updatedAt' | 'oneInN'> | undefined,
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

/**
 * How often you reach this position, and how much of what follows is prepared — two numbers; the
 * explanations live in the tooltips.
 */
function CoverageBox({
  reach,
  within,
  openingLabel,
  colorLabel,
  inRep,
  score,
  prob,
  oneInN,
  source,
  running,
  error,
}: {
  reach: LineReach;
  /** If the chapter's opening came up every game (only past the opening's position). */
  within?: { prob: number; loading: boolean };
  openingLabel: string;
  colorLabel: string;
  inRep: boolean;
  score?: number;
  prob?: number;
  oneInN: number;
  source: string;
  running: boolean;
  error?: string;
}) {
  const p = reach.prob;
  const rare = prob === undefined || prob < 1 / oneInN;
  const err = reach.error ?? error;
  return (
    <div className="panel coverage-box">
      <div
        className="cov-stat"
        title={`How often this position appears in your games, if you play your moves and opponents answer like ${source}. Every move order in all your ${colorLabel} counts.`}
      >
        <b style={{ opacity: reach.loading ? 0.5 : 1 }}>{reach.error ? '—' : p === undefined ? '…' : p === 0 ? 'never' : oneIn(p)}</b>
        <span>{p !== undefined && p >= 1 / 1.05 ? 'you reach this position' : `games reach here (all ${colorLabel})`}</span>
      </div>
      {within && (
        <div className="cov-stat" title={`How often this position comes up if this chapter's opening (${openingLabel}) came up in every game.`}>
          <b style={{ opacity: within.loading ? 0.5 : 1 }}>{within.prob === 0 ? 'never' : oneIn(within.prob)}</b>
          <span>within this opening</span>
        </div>
      )}
      {inRep && (
        <div
          className="cov-stat"
          title={`Of the games that reach this position, the share that stays in your prep until positions get rarer than 1 in ${oneInN} games.`}
        >
          <b style={{ color: score !== undefined && !rare ? coverColor(score) : undefined, opacity: running ? 0.5 : 1 }}>
            {score === undefined ? (running ? '…' : '—') : rare ? '—' : `${Math.round(score * 100)}%`}
          </b>
          <span>{score !== undefined && rare ? `rarer than 1 in ${oneInN}` : 'prepared from here'}</span>
        </div>
      )}
      <span className="spacer" />
      {running && <span className="muted small">updating…</span>}
      {err && (
        <span className="cov-error small" title={err}>
          ⚠ {err.length > 60 ? `${err.slice(0, 57)}…` : err}
        </span>
      )}
    </div>
  );
}

/**
 * A move you're adding goes into another chapter's own part of the tree: carry on there (the rest of
 * the line goes with it), add it to this chapter as well, or not at all.
 */
function EntersChapter({
  san,
  other,
  theirs,
  here,
  onChoose,
}: {
  san: string;
  other: Territory;
  /** That chapter's own way to the position. */
  theirs: string[];
  here: string;
  onChoose: (choice: 'there' | 'here' | 'cancel') => void;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onChoose('cancel');
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onChoose]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onChoose('cancel')}>
      <div className="panel col choose-chapter" role="dialog" aria-label={`${san} goes into ${other.chapter.name}`} style={{ gap: 10 }}>
        {/* Not an h3: those are capitalized, and d3 mustn't read as D3. */}
        <div className="enters-title">
          {san} goes into “{other.chapter.name}”
        </div>
        <div className="muted small">
          The position after it belongs to your “{other.chapter.name}” chapter, which has its lines from there (it gets there by{' '}
          <span className="mono">{formatLine(theirs)}</span>). Keep it in one place?
        </div>
        <button className="primary" onClick={() => onChoose('there')}>
          Continue in “{other.chapter.name}”
        </button>
        <button onClick={() => onChoose('here')} title="Fine for a transposition you want in both — a move in two chapters is still trained once">
          Add it to “{here}” too
        </button>
        <div className="row">
          <span className="muted small">Adding it here too won't ask again about “{other.chapter.name}” until you leave this chapter.</span>
          <span className="spacer" />
          <button className="small ghost" onClick={() => onChoose('cancel')}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** `id`: the chapter move to read; `sources`: every chapter move it stands for (all get the change). */
/** Two chapters fit a new line equally well: which one it goes in. */
function ChooseChapter({ ids, onPick }: { ids: string[]; onPick: (id?: string) => void }) {
  const chapters = useLiveQuery(async () => (await db.repertoires.bulkGet(ids)).filter((c): c is Repertoire => !!c), [ids.join()]);
  const names = useOpeningIndex();
  const graphs = useLiveQuery(async () => {
    const moves = await db.moves.where('repId').anyOf(ids).toArray();
    return new Map(ids.map((id) => [id, moves.filter((m) => m.repId === id)]));
  }, [ids.join()]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onPick(undefined);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onPick]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onPick(undefined)}>
      <div className="panel col choose-chapter" role="dialog" aria-label="Which chapter does this line go in?" style={{ gap: 8 }}>
        <h3 style={{ margin: 0 }}>Which chapter does this line go in?</h3>
        <div className="muted small">It fits these equally well.</div>
        {(chapters ?? []).map((c) => {
          const g = graphs?.get(c.id);
          const opening = g ? compactLine(chapterPosition(new RepGraph(c.color, g), names, c.name).moves.map((m) => m.san)) : '';
          return (
            <button key={c.id} className="cp-item" onClick={() => onPick(c.id)}>
              <span className="cp-name">{c.name}</span>
              {opening && <span className="cp-line">{opening}</span>}
            </button>
          );
        })}
        <div className="row">
          <span className="spacer" />
          <button className="small ghost" onClick={() => onPick(undefined)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

type RepAnnotationTarget = AnnotationTarget & { id: string; sources?: string[]; /** The move in the builder's graph (to delete it). */ moveId?: string };

/** The annotation menu for a saved repertoire move: reads the move's latest symbols and note, saves as you go. */
function RepAnnotationMenu({ target, onClose, onDelete }: { target: RepAnnotationTarget; onClose: () => void; onDelete?: () => void }) {
  const move = useLiveQuery(() => db.moves.get(target.id), [target.id]);
  if (!move) return null;
  return (
    <AnnotationMenu
      target={target}
      annotation={{ glyphs: move.glyphs, comment: move.comment }}
      onChange={(a) => void Promise.all((target.sources ?? [target.id]).map((id) => setMoveAnnotation(id, a)))}
      onClose={onClose}
      extra={
        <>
          {move.mine && (
            <button
              className="small ghost no-train-toggle"
              title={
                move.noTrain
                  ? 'Train this move and the line after it again (your progress is kept)'
                  : 'Keep it in the chapter, for reference, but leave it and the line after it (what only it leads to) out of training'
              }
              onClick={() => {
                void setNoTrain(move, !move.noTrain);
                onClose();
              }}
            >
              {move.noTrain ? '↺ Train this move again' : '⊘ Don\'t train this move or the line after it'}
            </button>
          )}
          <SplitOffForm move={move} onDone={onClose} />
          {onDelete && (
            <button
              className="small ghost danger"
              title="Delete this move — and the moves only it leads to — from the repertoire"
              onClick={() => {
                onClose();
                onDelete();
              }}
            >
              🗑 Delete this move
            </button>
          )}
        </>
      }
    />
  );
}

/**
 * Split a chapter by hand: this move — and, ticked, other moves from the same position (a few rare
 * replies, say, to keep together) — and everything after them go to a new chapter (named after the
 * opening) or an existing one; the moves leading there come along so it starts from move 1.
 */
function SplitOffForm({ move, onDone }: { move: RepMove; onDone: () => void }) {
  const chapterId = chapterOfMoveId(move.id);
  const [open, setOpen] = useState(false);
  const chapter = useLiveQuery(() => db.repertoires.get(chapterId), [chapterId]);
  const others = useLiveQuery(async () => (chapter ? (await db.repertoires.where('color').equals(chapter.color).toArray()).filter((c) => c.id !== chapterId) : []), [chapter]);
  // null until you type one: the suggested name, which follows the moves ticked.
  const [name, setName] = useState<string | null>(null);
  const [into, setInto] = useState('new');
  const [keepCopy, setKeepCopy] = useState(false);
  const [info, setInfo] = useState<{ path: string[]; ply: number; siblings: RepMove[]; oneName: string; branchName: string }>();
  const [also, setAlso] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !chapter) return;
    let off = false;
    void (async () => {
      const moves = await db.moves.where('repId').equals(chapterId).toArray();
      const g = new RepGraph(chapter.color, moves);
      const before = g.pathTo(move.fromKey) ?? [];
      const line = [...before, move];
      const names = await loadOpeningIndex();
      const deepestName = (keys: string[]) => {
        for (let i = keys.length - 1; i >= 0; i--) {
          const n = names.get(keys[i]);
          if (n) {
            const p = nameParts(n);
            return p.variation ? `${p.family}: ${p.variation}` : p.family;
          }
        }
      };
      // One line: named after the deepest named position on the way, or just after (its first branch).
      const keys = [...line.map((m) => m.toKey)];
      for (let k = move.toKey, i = 0; i < 6; i++) {
        const next = g.childrenOf(k)[0];
        if (!next) break;
        keys.push(next.toKey);
        k = next.toKey;
      }
      if (!off)
        setInfo({
          path: line.map((m) => m.san),
          ply: before.length,
          siblings: g.childrenOf(move.fromKey).filter((m) => m.id !== move.id),
          oneName: deepestName(keys) ?? `${chapter.name}${chapter.name.includes(':') ? ', ' : ': '}${move.san}`,
          // Several moves: after the position they're played from.
          branchName: deepestName(before.map((m) => m.toKey)) ?? chapter.name,
        });
    })();
    return () => {
      off = true;
    };
  }, [open, chapter, chapterId, move]);

  if (!open)
    return (
      <button className="small ghost split-off-toggle" onClick={() => setOpen(true)} title="Move this move and everything after it to another chapter (or a new one)">
        ✂ Move to another chapter…
      </button>
    );
  const label = (m: RepMove) => `${moveNumberPrefix(info?.ply ?? 0, true)}${m.san}`;
  const chosen = [move, ...(info?.siblings ?? []).filter((m) => also.includes(m.id))];
  // Several replies: a catch-all for the opening's other lines ("Italian Game: Other lines").
  const suggested = !info ? '' : chosen.length > 1 ? catchAllName(info.branchName) : info.oneName;
  const newName = name ?? suggested;
  const go = async () => {
    setError(null);
    try {
      const id = await splitOff(
        chapterId,
        chosen.map((m) => m.id),
        into === 'new' ? { name: newName } : { chapterId: into },
        { keepCopy },
      );
      onDone();
      navigate(`repertoire/${id}`, { line: (info?.path ?? []).join(' ') });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="split-off col" style={{ gap: 6 }}>
      {/* Not the uppercase label: "3...h6" mustn't read "3...H6". */}
      <div className="split-off-title">
        Move {chosen.map(label).join(', ')} and everything after {chosen.length > 1 ? 'them' : 'it'}
      </div>
      {!!info?.siblings.length && (
        <div className="split-off-also">
          <span className="muted small">Together with (other moves from this position):</span>
          {info.siblings.map((m) => (
            <label key={m.id} className="check small">
              <input
                type="checkbox"
                checked={also.includes(m.id)}
                onChange={(e) => setAlso((a) => (e.target.checked ? [...a, m.id] : a.filter((x) => x !== m.id)))}
              />
              {label(m)}
            </label>
          ))}
        </div>
      )}
      <select value={into} onChange={(e) => setInto(e.target.value)} aria-label="To">
        <option value="new">to a new chapter</option>
        {[...(others ?? [])].sort(byName).map((c) => (
          <option key={c.id} value={c.id}>
            to “{c.name}”
          </option>
        ))}
      </select>
      {into === 'new' && <input value={newName} onChange={(e) => setName(e.target.value)} placeholder="New chapter's name" onKeyDown={(e) => e.stopPropagation()} />}
      {into === 'new' && catchAllOf(newName) !== undefined && (
        <div className="muted small">
          Catch-all: when you add from All {chapter ? colorName(chapter.color) : ''} chapters, {catchAllOf(newName) ? `${catchAllOf(newName)} lines` : 'lines'} that no other
          chapter has go here.
        </div>
      )}
      <label className="check small">
        <input type="checkbox" checked={keepCopy} onChange={(e) => setKeepCopy(e.target.checked)} /> Keep a copy in “{chapter?.name}”
      </label>
      {error && <div className="error small">{error}</div>}
      <div className="row">
        <button className="small ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <span className="spacer" />
        <button className="small primary" onClick={go} disabled={into === 'new' && !newName.trim()}>
          {keepCopy ? 'Copy' : 'Move'}
        </button>
      </div>
    </div>
  );
}
