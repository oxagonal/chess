import { describe, expect, it } from 'vitest';
import { keyOf, playSan, playUci, posFromFen, START_KEY, startPos, formatLine, keyFromFen } from '../lib/chess';
import { RepGraph } from '../lib/graph';
import { movesFromLines } from '../lib/lines';
import { graphToPgn, pgnToEdges, tokenizeMoveText } from '../lib/pgn';
import { planLine, orderCards } from '../lib/trainer';
import { newCard, grade, isDue, Rating, State } from '../lib/srs';

describe('chess helpers', () => {
  it('normalises en passant: no ep square unless a capture is legal', () => {
    const r = playSan(startPos(), 'e4')!;
    expect(r.key).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -');
    // 1.e4 d5 2.e5 f5 → ep on f6 is legal
    let pos = startPos() as ReturnType<typeof startPos>;
    for (const s of ['e4', 'd5', 'e5', 'f5']) pos = playSan(pos, s)!.pos;
    expect(keyOf(pos).endsWith(' f6')).toBe(true);
  });

  it('uses standard UCI for castling and accepts both encodings', () => {
    let pos = startPos();
    for (const s of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']) pos = playSan(pos, s)!.pos;
    const castle = playSan(pos, 'O-O')!;
    expect(castle.uci).toBe('e1g1');
    expect(playUci(pos, 'e1g1')!.san).toBe('O-O');
    expect(playUci(pos, 'e1h1')!.san).toBe('O-O');
  });

  it('tolerates annotations and check marks in SAN', () => {
    let pos = startPos();
    for (const s of ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6']) pos = playSan(pos, s)!.pos;
    expect(playSan(pos, 'Qxf7#!!')!.san).toBe('Qxf7#');
    expect(playSan(pos, 'Qxf7')!.san).toBe('Qxf7#');
  });

  it('round-trips keys and FENs', () => {
    expect(keyOf(posFromFen(START_KEY)!)).toBe(START_KEY);
    expect(keyFromFen('8/8/8/8/8/8/8/K6k w - - 12 40')).toBe('8/8/8/8/8/8/8/K6k w - -');
    expect(formatLine(['e4', 'c5', 'Nf3'])).toBe('1. e4 c5 2. Nf3');
    expect(formatLine(['c5', 'Nf3'], 1)).toBe('1... c5 2. Nf3');
  });
});

describe('RepGraph', () => {
  const moves = movesFromLines('r', 'white', [
    'd4 d5 c4 e6 Nc3 Nf6',
    'd4 Nf6 c4 e6 Nc3 d5', // transposes to the QGD line
    'd4 d5 c4 c6 Nf3',
  ]);
  const g = new RepGraph('white', moves);

  it('merges transpositions into one position', () => {
    const a = movesFromLines('x', 'white', ['d4 d5 c4 e6 Nc3 Nf6']).at(-1)!.toKey;
    const b = movesFromLines('x', 'white', ['d4 Nf6 c4 e6 Nc3 d5']).at(-1)!.toKey;
    expect(a).toBe(b);
    expect(g.parentsOf(a)).toHaveLength(2);
  });

  it('finds shortest paths and depths', () => {
    const qgd = movesFromLines('x', 'white', ['d4 d5 c4 e6']).at(-1)!.toKey;
    expect(g.pathTo(qgd)!.map((m) => m.san)).toEqual(['d4', 'd5', 'c4', 'e6']);
    expect(g.depths().get(qgd)).toBe(4);
    expect(g.isMyTurn(qgd)).toBe(true);
  });

  it('topological order puts parents first', () => {
    const order = g.topoOrder();
    const idx = new Map(order.map((k, i) => [k, i]));
    for (const m of g.byId.values()) expect(idx.get(m.fromKey)!).toBeLessThan(idx.get(m.toKey)!);
  });

  it('detects orphans after an edge is removed', () => {
    const without = moves.filter((m) => !(m.san === 'c6'));
    const g2 = new RepGraph('white', without);
    expect(g2.orphanMoves().map((m) => m.san)).toEqual(['Nf3']);
  });
});

describe('PGN', () => {
  const pgn = `[Event "Test"]

1. e4 c5 {Sicilian} (1... e5 2. Nf3 Nc6 (2... d6 3. d4) 3. Bb5) 2. Nf3 d6 3. d4 *

[Event "Second"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 { Italian [%clk 0:03:00] } *`;

  it('imports variations and merges duplicate moves', () => {
    const r = pgnToEdges(pgn);
    expect(r.errors).toEqual([]);
    expect(r.games).toBe(2);
    const sans = r.edges.map((e) => e.san);
    expect(sans.filter((s) => s === 'e4')).toHaveLength(1);
    expect(sans).toContain('Bc4');
    expect(sans).toContain('Bb5');
    expect(r.edges.find((e) => e.san === 'c5')!.comment).toBe('Sicilian');
    expect(r.edges.find((e) => e.san === 'Bc4')!.comment).toBe('Italian');
  });

  it('reports illegal moves', () => {
    const r = pgnToEdges('1. e4 e5 2. Ke3 *');
    expect(r.errors[0]).toMatch(/illegal move/);
    expect(r.edges).toHaveLength(2);
  });

  it('exports a graph and re-imports it identically', () => {
    const moves = movesFromLines('r', 'white', ['e4 c5 Nf3 d6 d4', 'e4 e5 Nf3 Nc6 Bb5', 'e4 e5 Nf3 d6 d4']);
    const out = graphToPgn(new RepGraph('white', moves));
    const back = pgnToEdges(out);
    expect(new Set(back.edges.map((e) => `${e.fromKey}|${e.san}`))).toEqual(new Set(moves.map((m) => `${m.fromKey}|${m.san}`)));
  });

  it('tokenizes typed move text', () => {
    expect(tokenizeMoveText('1. e4 c5 2.Nf3 {x} (2. c3) d6 3...Nf6 *')).toEqual(['e4', 'c5', 'Nf3', 'd6', 'Nf6']);
  });
});

describe('builder navigator', () => {
  it('runs each move ahead to the next choice, following transpositions', async () => {
    const { continuations } = await import('../components/NextMoves');
    const { keysAlong } = await import('../lib/pgn');
    const ms = movesFromLines('n', 'white', [
      'd4 Nf6 c4 e6 Nc3 Bb4 Qc2',
      'd4 Nf6 c4 e6 Nc3 d5 cxd5',
      'd4 Nf6 c4 g6 Nc3 Bg7 e4',
      'd4 d5 c4 e6 Nc3',
      'd4 d5 c4 c6 Nf3',
      'd4 e6 c4 Nf6',
    ]);
    const g = new RepGraph('white', ms);
    const show = (rows: { run: { san: string }[]; next: { san: string }[]; lines: number }[]) =>
      rows.map((r) => `${r.run.map((m) => m.san).join(' ')} → ${r.next.map((m) => m.san).join('/') || 'end'} (${r.lines})`);

    expect(show(continuations(g, g.root))).toEqual(['d4 → Nf6/d5/e6 (5)']);
    const afterD4 = keysAlong(['d4']).keys.at(-1)!;
    expect(show(continuations(g, afterD4))).toEqual([
      'Nf6 c4 → e6/g6 (3)',
      'd5 c4 → e6/c6 (2)',
      // 1...e6 2.c4 Nf6 is the Nimzo/QGD position again: the row carries on to its next choice.
      'e6 c4 Nf6 Nc3 → Bb4/d5 (2)',
    ]);

    // With reach probabilities, the more common reply comes first.
    const k = (l: string) => keysAlong(l.split(' ')).keys.at(-1)!;
    const probs = { [afterD4]: 1, [k('d4 Nf6')]: 0.3, [k('d4 d5')]: 0.6, [k('d4 e6')]: 0.1 };
    expect(continuations(g, afterD4, probs).map((r) => r.run[0].san)).toEqual(['d5', 'Nf6', 'e6']);
  });
});

describe('drilling ahead of time', () => {
  it('restarts the interval from today instead of growing it, however often you drill', async () => {
    const { gradeAhead } = await import('../lib/srs');
    const DAY = 86_400_000;
    const t0 = Date.UTC(2026, 0, 1);
    // A learned move reviewed on Jan 1 with a 46-day interval.
    let c = grade(newCard({ id: 'x', repId: 'r', fromKey: 'k', san: 'e4' }, t0 - 3 * DAY), Rating.Good, undefined, t0 - 3 * DAY);
    c = { ...c, state: State.Review, stability: 46, lastReview: t0, due: t0 + 46 * DAY };
    // Drilled 23 days early, then nine more times that day and once a day for a week.
    let now = t0 + 23 * DAY;
    c = gradeAhead(c, Rating.Good, undefined, now);
    expect(c.due).toBe(now + 46 * DAY);
    expect(c.stability).toBe(46);
    for (let i = 0; i < 9; i++) c = gradeAhead(c, Rating.Good, undefined, (now += 30 * 60_000));
    for (let d = 0; d < 7; d++) c = gradeAhead(c, Rating.Good, undefined, (now += DAY));
    expect(c.due).toBe(now + 46 * DAY);
    expect(c.stability).toBe(46);

    // A miss counts in full; a move that's due gets a normal review (which can grow the interval).
    const missed = gradeAhead(c, Rating.Again, undefined, now);
    expect(missed.lapses).toBe(c.lapses + 1);
    expect(missed.due - now).toBeLessThan(46 * DAY);
    const due = gradeAhead(c, Rating.Good, undefined, c.due + DAY);
    expect(due.due - (c.due + DAY)).toBeGreaterThan(46 * DAY);
  });
});

describe('trainer planning', () => {
  const moves = movesFromLines('r', 'white', ['e4 c5 Nf3 d6 d4', 'e4 c5 Nf3 Nc6 d4', 'e4 e5 Nf3 Nc6 Bb5']);
  const g = new RepGraph('white', moves);
  const byLine = (sans: string[]) => moves.find((m) => m.san === sans.at(-1) && g.pathTo(m.fromKey)!.map((x) => x.san).join(' ') === sans.slice(0, -1).join(' '))!;

  it('walks from the start and quizzes only pending moves', () => {
    const d4 = byLine(['e4', 'c5', 'Nf3', 'd6', 'd4']);
    const pending = new Set([d4.id]);
    const steps = planLine(g, d4, pending, 'review');
    expect(steps.map((s) => s.move.san)).toEqual(['e4', 'c5', 'Nf3', 'd6', 'd4']);
    expect(steps.map((s) => s.kind)).toEqual(['auto', 'auto', 'auto', 'auto', 'quiz']);
  });

  it('extends the line through opponent replies that lead to more pending moves', () => {
    const nf3 = byLine(['e4', 'c5', 'Nf3']);
    const d4b = byLine(['e4', 'c5', 'Nf3', 'Nc6', 'd4']);
    const steps = planLine(g, nf3, new Set([nf3.id, d4b.id]), 'learn');
    expect(steps.map((s) => s.move.san)).toEqual(['e4', 'c5', 'Nf3', 'Nc6', 'd4']);
    expect(steps.filter((s) => s.kind === 'show').map((s) => s.move.san)).toEqual(['Nf3', 'd4']);
  });

  it('continues down the branch to its end after the trained move, asking your later moves ungraded', () => {
    const nf3 = byLine(['e4', 'e5', 'Nf3']);
    const steps = planLine(g, nf3, new Set([nf3.id]), 'review');
    expect(steps.map((s) => s.move.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
    expect(steps.map((s) => s.kind)).toEqual(['auto', 'auto', 'quiz', 'auto', 'practice']);
  });

  it('learn asks only the new moves: known moves are played for you and the line stops after the last new one', () => {
    // Bb5 is new; e4 and Nf3 are already learned, and the line would otherwise go on past Bb5.
    const lm = movesFromLines('r', 'white', ['e4 e5 Nf3 Nc6 Bb5 a6 Ba4']);
    const lg = new RepGraph('white', lm);
    const bb5 = lm.find((m) => m.san === 'Bb5')!;
    const steps = planLine(lg, bb5, new Set([bb5.id]), 'learn', { leadIn: true });
    expect(steps.map((s) => s.move.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
    expect(steps.map((s) => s.kind)).toEqual(['auto', 'auto', 'auto', 'auto', 'show']);
    // Known moves between new ones are played for you too.
    const ba4 = lm.find((m) => m.san === 'Ba4')!;
    const both = planLine(lg, bb5, new Set([bb5.id, ba4.id]), 'learn');
    expect(both.map((s) => s.kind)).toEqual(['auto', 'auto', 'auto', 'auto', 'show', 'auto', 'show']);
    // The same line in review: from move 1 to the end of the branch.
    expect(planLine(lg, bb5, new Set([bb5.id]), 'review', { leadIn: true }).map((s) => s.kind)).toEqual([
      'practice', 'auto', 'practice', 'auto', 'quiz', 'auto', 'practice',
    ]);
  });

  it('with lead-in, asks your earlier moves from the starting position too', () => {
    const d4 = byLine(['e4', 'c5', 'Nf3', 'd6', 'd4']);
    const steps = planLine(g, d4, new Set([d4.id]), 'review', { leadIn: true });
    expect(steps.map((s) => s.kind)).toEqual(['practice', 'auto', 'practice', 'auto', 'quiz']);
    expect(steps.filter((s) => s.leadIn).map((s) => s.move.san)).toEqual(['e4', 'Nf3']);
  });

  it('finds every move order into a transposed position, most common first', async () => {
    const { moveOrders } = await import('../lib/trainer');
    const { keysAlong } = await import('../lib/pgn');
    // 1.d4 Nf6 2.c4 e6 and 1.d4 e6 2.c4 Nf6 meet; then 3.Nc3.
    const tm = movesFromLines('t', 'white', ['d4 Nf6 c4 e6 Nc3', 'd4 e6 c4 Nf6']);
    const tg = new RepGraph('white', tm);
    const meet = keysAlong(['d4', 'Nf6', 'c4', 'e6']).keys.at(-1)!;
    const orders = moveOrders(tg, meet);
    expect(orders.map((o) => o.map((m) => m.san).join(' ')).sort()).toEqual(['d4 Nf6 c4 e6', 'd4 e6 c4 Nf6']);

    // With reach probabilities, the more common move order comes first.
    const k = (l: string) => keysAlong(l.split(' ')).keys.at(-1)!;
    const probs = { [k('d4')]: 1, [k('d4 Nf6')]: 0.8, [k('d4 Nf6 c4')]: 0.8, [k('d4 e6')]: 0.2, [k('d4 e6 c4')]: 0.2, [meet]: 0.5 };
    expect(moveOrders(tg, meet, probs)[0].map((m) => m.san)).toEqual(['d4', 'Nf6', 'c4', 'e6']);

    // planLine follows the chosen move order, then carries on to the end.
    const nc3 = tm.find((m) => m.san === 'Nc3')!;
    const other = orders.find((o) => o[1].san === 'e6')!;
    const steps = planLine(tg, nc3, new Set([nc3.id]), 'review', { leadIn: true, via: other });
    expect(steps.map((s) => s.move.san)).toEqual(['d4', 'e6', 'c4', 'Nf6', 'Nc3']);
    expect(steps.map((s) => s.kind)).toEqual(['practice', 'auto', 'practice', 'auto', 'quiz']);

    // A position with one move order has just that one.
    expect(moveOrders(tg, k('d4 Nf6'))).toHaveLength(1);
  });

  it('Skip repeats: plays moves already played this session for you and heads for new ones', () => {
    // Two branches after 1.e4 c5 2.Nf3: 2...d6 3.d4 and 2...Nc6 3.Bb5. Reviewing 2.Nf3 when 2...d6 3.d4
    // was already played this session: e4 is played for you, and the line goes on into 2...Nc6 3.Bb5.
    const sm = movesFromLines('s', 'white', ['e4 c5 Nf3 d6 d4', 'e4 c5 Nf3 Nc6 Bb5']);
    const sg = new RepGraph('white', sm);
    const id = (san: string) => sm.find((m) => m.san === san)!.id;
    const nf3 = sm.find((m) => m.san === 'Nf3')!;
    const seen = new Set([id('e4'), id('d4')]);
    const steps = planLine(sg, nf3, new Set([nf3.id]), 'review', { leadIn: true, seen });
    expect(steps.map((s) => s.move.san)).toEqual(['e4', 'c5', 'Nf3', 'Nc6', 'Bb5']);
    expect(steps.map((s) => s.kind)).toEqual(['auto', 'auto', 'quiz', 'auto', 'practice']);

    // Without it, the first branch and every move from move 1.
    const full = planLine(sg, nf3, new Set([nf3.id]), 'review', { leadIn: true });
    expect(full.map((s) => s.move.san)).toEqual(['e4', 'c5', 'Nf3', 'd6', 'd4']);
    expect(full.map((s) => s.kind)).toEqual(['practice', 'auto', 'quiz', 'auto', 'practice']);

    // A due move is always asked, even if you've played it this session.
    expect(planLine(sg, nf3, new Set([nf3.id]), 'review', { leadIn: true, seen: new Set([nf3.id]) })[2].kind).toBe('quiz');
  });

  it('orders cards shallow-first, or by probability when known', () => {
    const cards = g.myMoves().map((m) => newCard({ id: m.id, repId: 'r', fromKey: m.fromKey, san: m.san }));
    const ordered = orderCards(cards, g);
    expect(ordered[0].san).toBe('e4');
    const bb5 = byLine(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
    const byProb = orderCards(cards, g, { [bb5.fromKey]: 1 });
    expect(byProb[0].san).toBe('Bb5');
  });
});

describe('SRS', () => {
  it('schedules: Good pushes the card out, Again brings it back soon', () => {
    const now = Date.UTC(2026, 0, 1);
    const c0 = newCard({ id: 'a', repId: 'r', fromKey: START_KEY, san: 'e4' }, now);
    expect(c0.state).toBe(State.New);
    expect(isDue(c0, now)).toBe(false);
    let c = grade(c0, Rating.Good, undefined, now);
    expect(c.state).not.toBe(State.New);
    // run a few successful reviews, each when due
    for (let i = 0; i < 4; i++) c = grade(c, Rating.Good, undefined, c.due);
    expect(c.state).toBe(State.Review);
    expect(c.due - c.lastReview!).toBeGreaterThan(24 * 3600 * 1000);
    const failed = grade(c, Rating.Again, undefined, c.due);
    expect(failed.lapses).toBe(1);
    expect(failed.due - failed.lastReview!).toBeLessThan(24 * 3600 * 1000);
  });
});
