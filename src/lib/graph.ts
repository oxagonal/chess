import { START_KEY, turnOfKey, type Color } from './chess';
import type { RepMove } from './types';

/**
 * In-memory view of a repertoire: a directed graph of positions (keys) connected by moves.
 * Positions are merged by key, so transpositions share their continuation.
 */
export class RepGraph {
  readonly children = new Map<string, RepMove[]>();
  readonly parents = new Map<string, RepMove[]>();
  readonly byId = new Map<string, RepMove>();
  private _tree?: Map<string, RepMove>;

  constructor(
    readonly color: Color,
    moves: readonly RepMove[],
    readonly root: string = START_KEY,
  ) {
    for (const m of moves) {
      this.byId.set(m.id, m);
      push(this.children, m.fromKey, m);
      push(this.parents, m.toKey, m);
    }
  }

  get size(): number {
    return this.byId.size;
  }

  childrenOf(key: string): RepMove[] {
    return this.children.get(key) ?? [];
  }

  parentsOf(key: string): RepMove[] {
    return this.parents.get(key) ?? [];
  }

  isMyTurn(key: string): boolean {
    return turnOfKey(key) === this.color;
  }

  /** True if the position is part of the repertoire (reachable from the root). */
  has(key: string): boolean {
    return key === this.root || this.tree().has(key);
  }

  edge(fromKey: string, san: string): RepMove | undefined {
    return this.childrenOf(fromKey).find((m) => m.san === san);
  }

  /** BFS tree: for every reachable position, the move that first reaches it. */
  tree(): Map<string, RepMove> {
    if (this._tree) return this._tree;
    const tree = new Map<string, RepMove>();
    const seen = new Set<string>([this.root]);
    let frontier = [this.root];
    while (frontier.length) {
      const next: string[] = [];
      for (const key of frontier) {
        for (const m of this.childrenOf(key)) {
          if (seen.has(m.toKey)) continue;
          seen.add(m.toKey);
          tree.set(m.toKey, m);
          next.push(m.toKey);
        }
      }
      frontier = next;
    }
    this._tree = tree;
    return tree;
  }

  /** Shortest sequence of moves from the root to `key`, or undefined if unreachable. */
  pathTo(key: string): RepMove[] | undefined {
    if (key === this.root) return [];
    const tree = this.tree();
    if (!tree.has(key)) return undefined;
    const path: RepMove[] = [];
    let cur = key;
    while (cur !== this.root) {
      const m = tree.get(cur);
      if (!m) return undefined;
      path.push(m);
      cur = m.fromKey;
    }
    return path.reverse();
  }

  /** Depth (in plies) of each reachable position along its shortest path. */
  depths(): Map<string, number> {
    const d = new Map<string, number>([[this.root, 0]]);
    const tree = this.tree();
    const depthOf = (key: string): number => {
      const cached = d.get(key);
      if (cached !== undefined) return cached;
      const m = tree.get(key);
      const v = m ? depthOf(m.fromKey) + 1 : 0;
      d.set(key, v);
      return v;
    };
    for (const key of tree.keys()) depthOf(key);
    return d;
  }

  reachableKeys(): Set<string> {
    return new Set([this.root, ...this.tree().keys()]);
  }

  /** Moves whose origin is no longer reachable from the root (to be garbage-collected). */
  orphanMoves(): RepMove[] {
    const reach = this.reachableKeys();
    return [...this.byId.values()].filter((m) => !reach.has(m.fromKey));
  }

  /**
   * Positions in topological order from the root (DFS post-order reversed). Back edges
   * (repetitions) are ignored so the order is always well-defined.
   */
  topoOrder(): string[] {
    const order: string[] = [];
    const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
    const stack: { key: string; i: number }[] = [{ key: this.root, i: 0 }];
    state.set(this.root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const kids = this.childrenOf(top.key);
      if (top.i < kids.length) {
        const child = kids[top.i++].toKey;
        if (!state.has(child)) {
          state.set(child, 1);
          stack.push({ key: child, i: 0 });
        }
      } else {
        state.set(top.key, 2);
        order.push(top.key);
        stack.pop();
      }
    }
    return order.reverse();
  }

  /** Set of moves that are back edges in the DFS from the root (they create cycles). */
  backEdges(): Set<string> {
    const index = new Map(this.topoOrder().map((k, i) => [k, i]));
    const out = new Set<string>();
    for (const m of this.byId.values()) {
      const a = index.get(m.fromKey);
      const b = index.get(m.toKey);
      if (a !== undefined && b !== undefined && b <= a) out.add(m.id);
    }
    return out;
  }

  /** Your moves, in the order a learner should meet them (shallowest first). */
  myMoves(): RepMove[] {
    return [...this.byId.values()].filter((m) => m.mine);
  }

  /** Leaves: reachable positions with no continuation. */
  leaves(): string[] {
    return [...this.reachableKeys()].filter((k) => this.childrenOf(k).length === 0);
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

export function moveId(repId: string, fromKey: string, san: string): string {
  return `${repId}|${fromKey}|${san}`;
}
