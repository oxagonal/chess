/**
 * A move tree for working through a puzzle: the game up to it, the solution you write (with the
 * opponent's other replies as branches), Lichess's solution and whatever you explore afterwards —
 * one tree, each move tagged by where it came from. Pure (mutable, cheap to copy by reference).
 */
import type { Chess } from 'chessops/chess';
import { makeSquare, squareRank } from 'chessops/util';
import { keyOf, playSan, playUci, startPos } from './chess';
import { judgeMove } from './puzzle';

export type NodeTag = 'game' | 'mine' | 'solution' | 'explore';

export interface TreeNode {
  id: string;
  parent?: string;
  uci: string;
  san: string;
  key: string;
  pos: Chess;
  /** Moves from the tree's start (for move numbers). */
  ply: number;
  children: string[];
  tags: NodeTag[];
}

export class MoveTree {
  readonly nodes = new Map<string, TreeNode>();
  readonly root = 'root';

  constructor(start: Chess = startPos()) {
    this.nodes.set(this.root, { id: this.root, uci: '', san: '', key: keyOf(start), pos: start, ply: 0, children: [], tags: [] });
  }

  get(id: string): TreeNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`No node ${id}`);
    return n;
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  children(id: string): TreeNode[] {
    return this.get(id).children.map((c) => this.get(c));
  }

  /** Play a move (UCI) after a node; an existing move is reused (and gets the tag). Undefined if illegal. */
  add(parentId: string, uci: string, tag: NodeTag): string | undefined {
    const parent = this.get(parentId);
    const played = playUci(parent.pos, uci);
    if (!played) return undefined;
    const id = `${parentId} ${played.uci}`;
    const existing = this.nodes.get(id);
    if (existing) {
      if (!existing.tags.includes(tag)) existing.tags.push(tag);
      return id;
    }
    this.nodes.set(id, { id, parent: parentId, uci: played.uci, san: played.san, key: played.key, pos: played.pos, ply: parent.ply + 1, children: [], tags: [tag] });
    parent.children.push(id);
    return id;
  }

  addSan(parentId: string, san: string, tag: NodeTag): string | undefined {
    const played = playSan(this.get(parentId).pos, san);
    return played ? this.add(parentId, played.uci, tag) : undefined;
  }

  /** The nodes from the start to `id` (not the start itself). */
  path(id: string): TreeNode[] {
    const out: TreeNode[] = [];
    for (let n: TreeNode | undefined = this.get(id); n && n.id !== this.root; n = n.parent ? this.get(n.parent) : undefined) out.unshift(n);
    return out;
  }

  /** Is `id` at or after `ancestor`? */
  isUnder(id: string, ancestor: string): boolean {
    for (let n: string | undefined = id; n; n = this.nodes.get(n)?.parent) if (n === ancestor) return true;
    return false;
  }

  /** The first-choice line from a node: its first child, that one's first child, and so on. */
  mainline(fromId: string): TreeNode[] {
    const out: TreeNode[] = [];
    for (let kids = this.children(fromId); kids.length; kids = this.children(kids[0].id)) out.push(kids[0]);
    return out;
  }

  /** Remove a node and everything after it. */
  remove(id: string) {
    const n = this.nodes.get(id);
    if (!n || !n.parent) return;
    const parent = this.get(n.parent);
    parent.children = parent.children.filter((c) => c !== id);
    const stack = [id];
    while (stack.length) {
      const x = this.nodes.get(stack.pop()!);
      if (!x) continue;
      this.nodes.delete(x.id);
      stack.push(...x.children);
    }
  }
}

/**
 * Your written solution's main line from the puzzle's start (your moves and the replies you expect —
 * the first choice at each step), and the opponent's turns on it where you've written their reply but
 * not considered any other: each needs another reply or "only one sensible reply" (`only`) — unless
 * their reply is the only legal move.
 */
export function unconsidered(tree: MoveTree, startId: string, only: ReadonlySet<string>): string[] {
  const you = tree.get(startId).pos.turn;
  const out: string[] = [];
  let id = startId;
  for (;;) {
    const kids = tree.children(id).filter((k) => k.tags.includes('mine'));
    if (!kids.length) break;
    const node = tree.get(id);
    if (node.pos.turn !== you && kids.length < 2 && !only.has(id) && legalMoveCount(node.pos) > kids.length) out.push(id);
    id = kids[0].id;
  }
  return out;
}

/** How many legal moves a position has (a forced reply has one: nothing else to consider). */
export function legalMoveCount(pos: Chess): number {
  let n = 0;
  for (const dests of pos.allDests().values()) n += dests.size();
  return n;
}

/**
 * "Same answer to…": your answer to one of their moves, written against their other moves too — every
 * other move of the piece they moved (`piece`, e.g. any king move), or every other legal reply (`all`).
 * Each reply your answer is still legal after gets it as a branch (the reply's node id is returned);
 * the replies it isn't legal after are returned by name: those need a thought of their own.
 */
export function sameAnswer(tree: MoveTree, answerId: string, scope: 'piece' | 'all'): { added: string[]; skipped: string[] } {
  const answer = tree.get(answerId);
  const theirs = answer.parent ? tree.get(answer.parent) : undefined;
  const at = theirs?.parent ? tree.get(theirs.parent) : undefined;
  const added: string[] = [];
  const skipped: string[] = [];
  if (!theirs || !at) return { added, skipped };
  const done = new Set(at.children);
  for (const [from, dests] of at.pos.allDests()) {
    if (scope === 'piece' && makeSquare(from) !== theirs.uci.slice(0, 2)) continue;
    const pawn = at.pos.board.get(from)?.role === 'pawn';
    for (const to of dests) {
      const promo = pawn && (squareRank(to) === 0 || squareRank(to) === 7) ? 'q' : '';
      const reply = playUci(at.pos, makeSquare(from) + makeSquare(to) + promo);
      if (!reply) continue;
      const replyId = `${at.id} ${reply.uci}`;
      if (done.has(replyId)) continue; // already written (castling shows up twice)
      done.add(replyId);
      if (!playUci(reply.pos, answer.uci)) {
        skipped.push(reply.san);
        continue;
      }
      const id = tree.add(at.id, reply.uci, 'mine')!;
      tree.add(id, answer.uci, 'mine');
      added.push(id);
    }
  }
  return { added, skipped };
}

export interface WrittenGrade {
  /** Your written lines contain the solution: every move of yours right, their best defence considered. */
  win: boolean;
  /** Where it went wrong: the position, and the solution's move there. */
  wrongAt?: { nodeId: string; expected: string; yours: boolean };
}

/**
 * Check your written solution against the puzzle's: along the solution, at each of your turns one of
 * your written moves must be right (the solution's, or any move that mates, as on Lichess), and at each
 * of theirs you must have written their move.
 */
export function gradeWritten(tree: MoveTree, startId: string, solution: readonly string[]): WrittenGrade {
  let id = startId;
  for (let step = 0; step < solution.length; step++) {
    const node = tree.get(id);
    const written = tree.children(id).filter((k) => k.tags.includes('mine'));
    if (step % 2 === 0) {
      const right = written.find((k) => judgeMove(node.pos, solution, step, k.uci) !== 'wrong');
      if (!right) return { win: false, wrongAt: { nodeId: id, expected: solution[step], yours: true } };
      if (judgeMove(node.pos, solution, step, right.uci) === 'solved') return { win: true };
      id = right.id;
    } else {
      const reply = written.find((k) => k.uci === solution[step]);
      if (!reply) return { win: false, wrongAt: { nodeId: id, expected: solution[step], yours: false } };
      id = reply.id;
    }
  }
  return { win: true };
}
