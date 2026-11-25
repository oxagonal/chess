/**
 * Position analysis for the builder's Engine box (and game review).
 *
 *  1. Lichess cloud eval — instant, deep analysis of common positions (several best lines).
 *  2. Stockfish 19 (lite NNUE, single-threaded WASM) running in a Web Worker — offline too, deepening
 *     until the depth set in Settings.
 *
 * Scores are reported from White's point of view, like every chess site.
 */
import { playUci, posFromFen } from '../lib/chess';

export interface MoveEval {
  /** Centipawns, White's point of view. */
  cp?: number;
  /** Mate in N (positive = White mates). */
  mate?: number;
  depth: number;
  source: 'cloud' | 'local';
}

/** One of the engine's best lines: its evaluation and the moves (standard UCI) from the position. */
export interface EngineLine {
  eval: MoveEval;
  moves: string[];
}

/** "+0.35", "−1.20", "#4", "#-2" */
export function formatEval(e: MoveEval): string {
  if (e.mate !== undefined) return `#${e.mate}`;
  const v = (e.cp ?? 0) / 100;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`;
}

/** Better for White = higher (mates beyond any centipawn score). */
export function evalScore(e: MoveEval): number {
  if (e.mate !== undefined) return e.mate > 0 ? 100000 - e.mate : -100000 - e.mate;
  return e.cp ?? 0;
}

/* ------------------------------------------------------------- cloud eval */

const cloudCache = new Map<string, EngineLine[] | null>();
/** After Lichess says "too many requests", ask again only after a minute. */
let cloudPausedUntil = 0;

/** Lichess's cloud analysis of a position (its best lines), if it has one. */
/** Lichess's cloud said it doesn't have this position (asked this session). */
export function cloudHasNot(key: string): boolean {
  return cloudCache.has(key) && cloudCache.get(key) === null;
}

export async function cloudLines(key: string, signal?: AbortSignal): Promise<EngineLine[] | undefined> {
  if (cloudCache.has(key)) return cloudCache.get(key) ?? undefined;
  if (Date.now() < cloudPausedUntil) return undefined;
  const fen = `${key} 0 1`;
  try {
    const res = await fetch(`https://lichess.org/api/cloud-eval?${new URLSearchParams({ fen, multiPv: '5' })}`, { signal });
    if (res.status === 404) {
      cloudCache.set(key, null);
      return undefined;
    }
    if (res.status === 429) cloudPausedUntil = Date.now() + 60_000;
    if (!res.ok) return undefined; // rate limited etc. — the local engine covers it
    const data = (await res.json()) as { depth: number; pvs: { moves: string; cp?: number; mate?: number }[] };
    const lines = data.pvs.map((pv) => ({ eval: { cp: pv.cp, mate: pv.mate, depth: data.depth, source: 'cloud' as const }, moves: normalise(key, pv.moves.split(' ')) }));
    cloudCache.set(key, lines);
    return lines;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    return undefined;
  }
}

/** Standard UCI for each move of a line (e.g. e1h1-style castling → e1g1); stops at an illegal move. */
function normalise(key: string, ucis: string[]): string[] {
  let pos = posFromFen(key);
  const out: string[] = [];
  for (const u of ucis) {
    const r = pos && playUci(pos, u);
    if (!r) break;
    out.push(r.uci);
    pos = r.pos;
  }
  return out;
}

/* ------------------------------------------------------------ local engine */

interface Job {
  fen: string;
  multiPv: number;
  depth: number;
  onUpdate: (lines: EngineLine[], depth: number) => void;
  resolve: (lines: EngineLine[]) => void;
  /**
   * A one-off search whose answer something waits on (is this move good?): it runs to its depth —
   * the Stockfish box asking about a position doesn't cut it short; the box's search waits instead.
   */
  keep?: boolean;
}

class Stockfish {
  private worker?: Worker;
  private ready?: Promise<void>;
  private current?: Job & { lines: Map<number, EngineLine>; whiteToMove: boolean };
  /** Waiting to run: one-off searches (kept, in order), then at most one of the box's. */
  private waiting: Job[] = [];

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.worker = new Worker(`${import.meta.env.BASE_URL}engine/stockfish-19-lite-single.js`);
    this.ready = new Promise((resolve, reject) => {
      const w = this.worker!;
      w.onerror = (e) => reject(new Error(`Stockfish failed to load: ${e.message}`));
      w.onmessage = (ev: MessageEvent<string>) => {
        const line = String(ev.data);
        if (line === 'uciok') w.postMessage('isready');
        else if (line === 'readyok') {
          w.onmessage = (m: MessageEvent<string>) => this.onLine(String(m.data));
          resolve();
        }
      };
      w.postMessage('uci');
    });
    return this.ready;
  }

  private sorted(job: NonNullable<typeof this.current>): EngineLine[] {
    return [...job.lines.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l);
  }

  private onLine(line: string) {
    const job = this.current;
    if (!job) return;
    if (line.startsWith('info ') && line.includes(' pv ') && !/ (lower|upper)bound/.test(line)) {
      const depth = Number(/ depth (\d+)/.exec(line)?.[1] ?? 0);
      const score = / score (cp|mate) (-?\d+)/.exec(line);
      const slot = Number(/ multipv (\d+)/.exec(line)?.[1] ?? 1);
      const pv = / pv (.+)$/.exec(line)?.[1]?.trim().split(/\s+/);
      if (!score || !pv?.length || depth < 1) return;
      const v = Number(score[2]) * (job.whiteToMove ? 1 : -1); // engine reports side-to-move POV
      const ev: MoveEval = score[1] === 'cp' ? { cp: v, depth, source: 'local' } : { mate: v, depth, source: 'local' };
      job.lines.set(slot, { eval: ev, moves: pv });
      job.onUpdate(this.sorted(job), depth);
    } else if (line.startsWith('bestmove')) {
      this.current = undefined;
      job.resolve(this.sorted(job));
      const next = this.waiting.shift();
      if (next) this.run(next);
    }
  }

  private run(job: Job) {
    const w = this.worker!;
    this.current = { ...job, lines: new Map(), whiteToMove: job.fen.split(' ')[1] !== 'b' };
    w.postMessage('ucinewgame');
    w.postMessage(`setoption name MultiPV value ${Math.max(1, job.multiPv)}`);
    w.postMessage(`position fen ${job.fen}`);
    // depth 0 = unlimited: search until stopped (the position changes or the box closes).
    w.postMessage(job.depth > 0 ? `go depth ${job.depth}` : 'go infinite');
  }

  async analyse(job: Job) {
    await this.start();
    if (!this.current) return this.run(job);
    // The box's search: replaces the box's search that was waiting (a newer position wins).
    if (!job.keep) {
      for (const w of this.waiting.filter((x) => !x.keep)) w.resolve([]);
      this.waiting = this.waiting.filter((x) => x.keep);
    }
    // One-off searches go before the box's.
    if (job.keep) this.waiting.splice(this.waiting.filter((x) => x.keep).length, 0, job);
    else this.waiting.push(job);
    // Stop the running search unless it's a one-off something waits on; its bestmove starts the next.
    if (!this.current.keep) this.worker!.postMessage('stop');
  }

  /** Stop the box's search (one-off searches finish). */
  stop() {
    for (const w of this.waiting.filter((x) => !x.keep)) w.resolve([]);
    this.waiting = this.waiting.filter((x) => x.keep);
    if (this.current && !this.current.keep) this.worker?.postMessage('stop');
  }
}

const engine = new Stockfish();
const localCache = new Map<string, EngineLine[]>();

export interface AnalysisStatus {
  depth: number;
  done: boolean;
  source: 'cloud' | 'local';
}

/**
 * The best `multiPv` lines in position `key`. Calls `onUpdate` as results arrive: Lichess's cloud
 * analysis first (if it has the position), then Stockfish's, deepening until `depth` (0 = unlimited,
 * until cancelled) — a deeper cloud result is kept until the engine catches up. Returns a function
 * that cancels the search.
 */
export function analysePosition(key: string, depth: number, multiPv: number, report: (lines: EngineLine[], status: AnalysisStatus) => void): () => void {
  let cancelled = false;
  // Everything found is shared with the explorer's Stockfish column.
  const onUpdate = (lines: EngineLine[], status: AnalysisStatus) => {
    publishLines(key, lines);
    report(lines, status);
  };
  const ctrl = new AbortController();
  const cacheKey = `${key}|${depth}|${multiPv}`;

  (async () => {
    const cached = depth > 0 ? localCache.get(cacheKey) : undefined;
    if (cached) {
      onUpdate(cached, { depth, done: true, source: 'local' });
      return;
    }
    let cloud: EngineLine[] | undefined;
    try {
      cloud = (await cloudLines(key, ctrl.signal))?.slice(0, multiPv);
      if (cancelled) return;
      if (cloud?.length) onUpdate(cloud, { depth: cloud[0].eval.depth, done: false, source: 'cloud' });
    } catch {
      return; // aborted
    }
    const cloudDepth = cloud?.[0]?.eval.depth ?? 0;
    try {
      const final = await new Promise<EngineLine[]>((resolve) =>
        engine.analyse({
          fen: `${key} 0 1`,
          multiPv,
          depth,
          resolve,
          onUpdate: (lines, d) => {
            if (cancelled || (cloud?.length && d < cloudDepth)) return;
            onUpdate(lines, { depth: d, done: false, source: 'local' });
          },
        }),
      );
      if (cancelled) return;
      if (final.length) {
        const best = cloud?.length && cloudDepth > final[0].eval.depth ? cloud : final;
        if (depth > 0) localCache.set(cacheKey, best);
        onUpdate(best, { depth: best[0].eval.depth, done: true, source: best[0].eval.source });
      }
    } catch (e) {
      console.warn(e);
    }
  })();

  return () => {
    cancelled = true;
    ctrl.abort();
    engine.stop();
  };
}

/**
 * Stockfish's best `multiPv` lines at `depth`, once (no cloud): for background work like the coverage
 * run's sharpness checks. Resolves with [] if another search takes the engine over first.
 */
export async function analyseOnce(key: string, depth: number, multiPv: number): Promise<EngineLine[]> {
  const cacheKey = `${key}|${depth}|${multiPv}`;
  const cached = localCache.get(cacheKey);
  if (cached) return cached;
  const lines = await new Promise<EngineLine[]>((resolve) => void engine.analyse({ fen: `${key} 0 1`, multiPv, depth, resolve, onUpdate: () => {}, keep: true }));
  if (lines.length) localCache.set(cacheKey, lines);
  return lines;
}

/* ------------------------------------------- the explorer's Stockfish column */

const latestLines = new Map<string, EngineLine[]>();
const lineListeners = new Set<(key: string, lines: EngineLine[]) => void>();

function publishLines(key: string, lines: EngineLine[]) {
  latestLines.delete(key);
  latestLines.set(key, lines);
  if (latestLines.size > 64) latestLines.delete(latestLines.keys().next().value!);
  for (const l of lineListeners) l(key, lines);
}

/** The latest best lines the Stockfish box found in a position (each gives its first move an eval). */
export function engineLinesFor(key: string): EngineLine[] | undefined {
  return latestLines.get(key);
}

/** Called whenever the Stockfish box finds better lines somewhere. Returns an unsubscribe function. */
export function onEngineLines(cb: (key: string, lines: EngineLine[]) => void): () => void {
  lineListeners.add(cb);
  return () => {
    lineListeners.delete(cb);
  };
}

/**
 * The evaluation after each of `ucis` in position `key` (White's point of view), from Lichess's cloud
 * analysis: the position's own best lines first, then the position after each remaining move, one
 * request at a time (cached, and shared with the Stockfish box). It never takes the local engine
 * from the Stockfish box. Calls `onUpdate` as results arrive; returns a function that cancels.
 */
export function cloudMoveEvals(key: string, ucis: string[], onUpdate: (evals: Map<string, MoveEval>) => void): () => void {
  const ctrl = new AbortController();
  const out = new Map<string, MoveEval>();
  (async () => {
    try {
      for (const l of (await cloudLines(key, ctrl.signal)) ?? []) {
        const u = l.moves[0];
        if (u && ucis.includes(u) && !out.has(u)) out.set(u, l.eval);
      }
      if (out.size) onUpdate(new Map(out));
      const pos = posFromFen(key);
      for (const u of ucis) {
        if (out.has(u) || !pos) continue;
        const after = playUci(pos, u);
        const best = after && (await cloudLines(after.key, ctrl.signal))?.[0];
        if (!best) continue;
        out.set(u, best.eval);
        onUpdate(new Map(out));
      }
    } catch {
      /* cancelled */
    }
  })();
  return () => ctrl.abort();
}

/* ------------------------------------------------------- game review */

export interface PositionEval {
  /** White's point of view. */
  eval: MoveEval;
  /** Engine's best move (standard UCI), if any. */
  best?: string;
  /** With two lines: the second-best move's evaluation (an only move stands out from it). */
  second?: MoveEval;
}

/**
 * Evaluate one position. Resolves `undefined` if the position is over (mate/stalemate) or the search
 * was replaced.
 */
export function evaluatePosition(fen: string, depth: number, multiPv = 1): Promise<PositionEval | undefined> {
  if (!(depth > 0)) depth = 18; // a review needs a finite search
  return new Promise((resolve) => {
    let best: EngineLine | undefined;
    engine
      .analyse({
        fen,
        multiPv,
        depth,
        onUpdate: (lines) => {
          if (lines[0]) best = lines[0];
        },
        resolve: (lines) => {
          const top = lines[0] ?? best;
          resolve(top ? { eval: top.eval, best: top.moves[0], ...(lines[1] ? { second: lines[1].eval } : {}) } : undefined);
        },
      })
      .catch(() => resolve(undefined));
  });
}

/** Lichess's win-chance curve: 0–100 for White. Mates count as 0 or 100. */
export function winChance(e: MoveEval): number {
  if (e.mate !== undefined) return e.mate > 0 ? 100 : 0;
  const cp = Math.max(-1000, Math.min(1000, e.cp ?? 0));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}
