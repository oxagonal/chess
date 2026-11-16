/**
 * Move evaluations for the builder.
 *
 *  1. Lichess cloud eval — instant, deep evals for common positions (top few moves).
 *  2. Stockfish 19 (lite NNUE, single-threaded WASM) running in a Web Worker — evaluates exactly the
 *     moves you're looking at (`go searchmoves …` with one MultiPV line per move), offline too.
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

export type EvalMap = Map<string, MoveEval>; // keyed by standard UCI

/** "+0.35", "−1.20", "#4", "#-2" */
export function formatEval(e: MoveEval): string {
  if (e.mate !== undefined) return `#${e.mate}`;
  const v = (e.cp ?? 0) / 100;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`;
}

/** Better for the side that just moved = higher. Used to rank/color evals. */
export function evalScore(e: MoveEval): number {
  if (e.mate !== undefined) return e.mate > 0 ? 100000 - e.mate : -100000 - e.mate;
  return e.cp ?? 0;
}

/* ------------------------------------------------------------- cloud eval */

const cloudCache = new Map<string, EvalMap | null>();

export async function cloudEval(key: string, signal?: AbortSignal): Promise<EvalMap | undefined> {
  if (cloudCache.has(key)) return cloudCache.get(key) ?? undefined;
  const fen = `${key} 0 1`;
  try {
    const res = await fetch(`https://lichess.org/api/cloud-eval?${new URLSearchParams({ fen, multiPv: '5' })}`, { signal });
    if (res.status === 404) {
      cloudCache.set(key, null);
      return undefined;
    }
    if (!res.ok) return undefined; // rate limited etc. — the local engine covers it
    const data = (await res.json()) as { depth: number; pvs: { moves: string; cp?: number; mate?: number }[] };
    const pos = posFromFen(key);
    const out: EvalMap = new Map();
    for (const pv of data.pvs) {
      const first = pv.moves.split(' ')[0];
      const uci = (pos && playUci(pos, first)?.uci) || first; // normalises e1h1-style castling
      out.set(uci, { cp: pv.cp, mate: pv.mate, depth: data.depth, source: 'cloud' });
    }
    cloudCache.set(key, out);
    return out;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    return undefined;
  }
}

/* ------------------------------------------------------------ local engine */

interface Job {
  fen: string;
  moves: string[];
  depth: number;
  onUpdate: (evals: EvalMap, depth: number) => void;
  resolve: (evals: EvalMap) => void;
}

class Stockfish {
  private worker?: Worker;
  private ready?: Promise<void>;
  private current?: Job & { evals: EvalMap; whiteToMove: boolean };
  private queued?: Job;

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

  private onLine(line: string) {
    const job = this.current;
    if (!job) return;
    if (line.startsWith('info ') && line.includes(' pv ') && !/ (lower|upper)bound/.test(line)) {
      const depth = Number(/ depth (\d+)/.exec(line)?.[1] ?? 0);
      const score = / score (cp|mate) (-?\d+)/.exec(line);
      const first = / pv (\S+)/.exec(line)?.[1];
      if (!score || !first || depth < 1) return;
      const v = Number(score[2]) * (job.whiteToMove ? 1 : -1); // engine reports side-to-move POV
      job.evals.set(first, score[1] === 'cp' ? { cp: v, depth, source: 'local' } : { mate: v, depth, source: 'local' });
      job.onUpdate(new Map(job.evals), depth);
    } else if (line.startsWith('bestmove')) {
      this.current = undefined;
      job.resolve(job.evals);
      if (this.queued) {
        const next = this.queued;
        this.queued = undefined;
        this.run(next);
      }
    }
  }

  private run(job: Job) {
    const w = this.worker!;
    this.current = { ...job, evals: new Map(), whiteToMove: job.fen.split(' ')[1] !== 'b' };
    w.postMessage('ucinewgame');
    w.postMessage(`setoption name MultiPV value ${Math.max(1, job.moves.length)}`);
    w.postMessage(`position fen ${job.fen}`);
    w.postMessage(job.moves.length ? `go depth ${job.depth} searchmoves ${job.moves.join(' ')}` : `go depth ${job.depth}`);
  }

  async analyse(job: Job) {
    await this.start();
    if (this.current) {
      // Replace whatever was waiting and stop the running search; its bestmove starts this one.
      this.queued?.resolve(new Map());
      this.queued = job;
      this.worker!.postMessage('stop');
    } else {
      this.run(job);
    }
  }

  stop() {
    this.queued?.resolve(new Map());
    this.queued = undefined;
    if (this.current) this.worker?.postMessage('stop');
  }
}

const engine = new Stockfish();
const localCache = new Map<string, EvalMap>();

/**
 * Evaluate each of `moves` (standard UCI) in the position `key`. Calls `onUpdate` as results arrive:
 * cloud evals first (if any), then Stockfish's, deepening until `depth`.
 */
export function evaluateMoves(
  key: string,
  moves: string[],
  depth: number,
  onUpdate: (evals: EvalMap, status: { depth: number; done: boolean; source: 'cloud' | 'local' }) => void,
): () => void {
  let cancelled = false;
  const ctrl = new AbortController();
  const cacheKey = `${key}|${depth}|${[...moves].sort().join(',')}`;
  const merged: EvalMap = new Map();

  (async () => {
    const cached = localCache.get(cacheKey);
    if (cached) {
      onUpdate(new Map(cached), { depth, done: true, source: 'local' });
      return;
    }
    try {
      const cloud = await cloudEval(key, ctrl.signal);
      if (cancelled) return;
      if (cloud) {
        for (const m of moves) {
          const e = cloud.get(m);
          if (e) merged.set(m, e);
        }
        onUpdate(new Map(merged), { depth: 0, done: false, source: 'cloud' });
      }
    } catch {
      return; // aborted
    }
    if (!moves.length || cancelled) return;
    try {
      const final = await new Promise<EvalMap>((resolve) =>
        engine.analyse({
          fen: `${key} 0 1`,
          moves,
          depth,
          resolve,
          onUpdate: (local, d) => {
            if (cancelled) return;
            // Keep a deeper cloud eval until the engine catches up.
            for (const [m, e] of local) {
              const c = merged.get(m);
              if (!c || c.source === 'local' || e.depth >= c.depth) merged.set(m, e);
            }
            onUpdate(new Map(merged), { depth: d, done: false, source: 'local' });
          },
        }),
      );
      if (cancelled) return;
      if (final.size) {
        localCache.set(cacheKey, new Map(merged));
        onUpdate(new Map(merged), { depth, done: true, source: 'local' });
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

/* ------------------------------------------------------- game review */

export interface PositionEval {
  /** White's point of view. */
  eval: MoveEval;
  /** Engine's best move (standard UCI), if any. */
  best?: string;
}

/**
 * Evaluate one position (no move restriction). The engine reports a best line per depth; we keep the
 * deepest one. Resolves `undefined` if the position is over (mate/stalemate) or the search was replaced.
 */
export function evaluatePosition(fen: string, depth: number): Promise<PositionEval | undefined> {
  return new Promise((resolve) => {
    let best: { uci: string; e: MoveEval } | undefined;
    engine
      .analyse({
        fen,
        moves: [],
        depth,
        onUpdate: (evals) => {
          for (const [uci, e] of evals) if (!best || e.depth >= best.e.depth) best = { uci, e };
        },
        resolve: () => resolve(best ? { eval: best.e, best: best.uci } : undefined),
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