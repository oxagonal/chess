import { describe, expect, it } from 'vitest';
import { keyOf, playSan, playUci, posFromFen, START_KEY, startPos, formatLine, keyFromFen } from '../lib/chess';
import { RepGraph } from '../lib/graph';
import { movesFromLines } from '../lib/lines';
import { graphToPgn, pgnToEdges, tokenizeMoveText } from '../lib/pgn';
import { newMovesQuiz, planLine, orderCards } from '../lib/trainer';
import { isSharp, movesThatHold } from '../lib/sharp';
import { puzzleTilt, tiltCheck } from '../lib/tilt';
import { behind, behindTargets, gameDurationMs, periodBounds, planTotals, tooMuchOpenings, weekStart } from '../lib/plan';
import type { StoredGame } from '../lib/types';
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

describe('drilling ahead of time', () => {
  it('restarts the interval from today instead of growing it, however often you drill', async () => {
    const { gradeAhead } = await import('../lib/srs');
    const DAY = 86_400_000;
    const t0 = Date.UTC(2026, 0, 1);
    // A learned move reviewed on Jan 1 with a 46-day interval.
    let c = grade(newCard({ id: 'x', color: 'white', fromKey: 'k', san: 'e4' }, t0 - 3 * DAY), Rating.Good, undefined, t0 - 3 * DAY);
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

describe('the answer timer', () => {
  it('grades a right answer by how long it took: Easy, Good or Hard; a miss is Again', async () => {
    const { gradeForAnswer } = await import('../lib/srs');
    const limit = 10_000;
    expect(gradeForAnswer(false, 1_500, limit)).toBe(Rating.Easy);
    expect(gradeForAnswer(false, 2_000, limit)).toBe(Rating.Easy);
    // Quick means at once: never more than 2 s, whatever the timer (a quarter of 10 s would be 2.5 s).
    expect(gradeForAnswer(false, 2_500, limit)).toBe(Rating.Good);
    expect(gradeForAnswer(false, 2_500, 60_000)).toBe(Rating.Good);
    expect(gradeForAnswer(false, 900, 3_000)).toBe(Rating.Good); // a quarter of 3 s is 0.75 s
    // Not allowed on this move: a quick answer is just Good.
    expect(gradeForAnswer(false, 1_000, limit, false)).toBe(Rating.Good);
    expect(gradeForAnswer(false, 6_000, limit)).toBe(Rating.Good);
    expect(gradeForAnswer(false, 10_000, limit)).toBe(Rating.Good);
    expect(gradeForAnswer(false, 14_000, limit)).toBe(Rating.Hard);
    expect(gradeForAnswer(true, 1_000, limit)).toBe(Rating.Again);
    // Off, or not timed: Good.
    expect(gradeForAnswer(false, 30_000, 0)).toBe(Rating.Good);
    expect(gradeForAnswer(false, undefined, limit)).toBe(Rating.Good);
  });

  it('allows Easy only on a move in regular reviews that you did not miss last time', async () => {
    const { easyAllowed } = await import('../lib/srs');
    expect(easyAllowed({ state: State.Review }, Rating.Good)).toBe(true);
    expect(easyAllowed({ state: State.Review }, undefined)).toBe(true);
    expect(easyAllowed({ state: State.Review }, Rating.Again)).toBe(false); // last answer a miss (or forgotten in a game)
    expect(easyAllowed({ state: State.Relearning }, Rating.Good)).toBe(false); // relearning after a miss
    expect(easyAllowed({ state: State.Learning }, Rating.Good)).toBe(false); // still in its learning steps
    expect(easyAllowed({ state: State.New })).toBe(false);
  });

  it('lengthens a due move more when quick and less when slow — but a quick drill ahead of time only restarts it', async () => {
    const { gradeAhead } = await import('../lib/srs');
    const DAY = 86_400_000;
    const t0 = Date.UTC(2026, 0, 1);
    let c = grade(newCard({ id: 'x', color: 'white', fromKey: 'k', san: 'e4' }, t0 - 3 * DAY), Rating.Good, undefined, t0 - 3 * DAY);
    c = { ...c, state: State.Review, stability: 20, lastReview: t0 - 20 * DAY, due: t0 };
    const after = (r: Parameters<typeof grade>[1]) => grade(c, r, { requestRetention: 0.9, maximumIntervalDays: 365 }, t0).stability;
    expect(after(Rating.Easy)).toBeGreaterThan(after(Rating.Good));
    expect(after(Rating.Good)).toBeGreaterThan(after(Rating.Hard));
    // 10 days early: Easy is treated like Good (interval restarted, not grown).
    const early = { ...c, due: t0 + 10 * DAY };
    const drilled = gradeAhead(early, Rating.Easy, undefined, t0);
    expect(drilled.due).toBe(t0 + 30 * DAY);
    expect(drilled.stability).toBe(20);
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

  it('in a review, teaches a move you never learned where the line meets it, then replays just the new moves', () => {
    const lm = movesFromLines('r', 'white', ['e4 e5 Nf3 Nc6 Bb5 a6 Ba4']);
    const lg = new RepGraph('white', lm);
    const nf3 = lm.find((m) => m.san === 'Nf3')!;
    const bb5 = lm.find((m) => m.san === 'Bb5')!;
    // Nf3 is due; Bb5 was never learned; e4 and Ba4 you know.
    const steps = planLine(lg, nf3, new Set([nf3.id]), 'review', { leadIn: true, teach: new Set([bb5.id]) });
    expect(steps.map((s) => s.kind)).toEqual(['practice', 'auto', 'quiz', 'auto', 'show', 'auto', 'practice']);
    expect(newMovesQuiz(steps).map((s) => s.kind)).toEqual(['auto', 'auto', 'auto', 'auto', 'quiz', 'auto', 'auto']);
    // A drill of a move you never learned teaches it too; Learn is unchanged.
    expect(planLine(lg, bb5, new Set([bb5.id]), 'review', { teach: new Set([bb5.id]) })[4].kind).toBe('show');
    expect(planLine(lg, bb5, new Set([bb5.id]), 'learn', { teach: new Set([bb5.id]) }).map((s) => s.kind)).toEqual(['auto', 'auto', 'auto', 'auto', 'show']);
  });

  it('with lead-in, asks your earlier moves from the starting position too', () => {
    const d4 = byLine(['e4', 'c5', 'Nf3', 'd6', 'd4']);
    const steps = planLine(g, d4, new Set([d4.id]), 'review', { leadIn: true });
    expect(steps.map((s) => s.kind)).toEqual(['practice', 'auto', 'practice', 'auto', 'quiz']);
    expect(steps.filter((s) => s.leadIn).map((s) => s.move.san)).toEqual(['e4', 'Nf3']);
  });

  it("reviews a move only through its own chapter's move orders", async () => {
    const { moveOrders, ordersFor } = await import('../lib/trainer');
    const { unionGraph } = await import('../lib/chapters');
    const { keysAlong } = await import('../lib/pgn');
    // King's Indian chapter: 1.d4 Nf6 2.c4 d6 3.Nf3. Another chapter: 1.d4 d6 2.c4 Nf6 3.Nc3 — the same position.
    const kid = movesFromLines('kid', 'white', ['d4 Nf6 c4 d6 Nf3']);
    const old = movesFromLines('old', 'white', ['d4 d6 c4 Nf6 Nc3']);
    const ug = unionGraph('white', [...kid, ...old]);
    const meet = keysAlong(['d4', 'Nf6', 'c4', 'd6']).keys.at(-1)!;
    const all = moveOrders(ug, meet);
    expect(all.length).toBe(2);
    const mine = (san: string) => [...ug.byId.values()].find((m) => m.fromKey === meet && m.san === san)!;
    const line = (o: { san: string }[]) => o.map((m) => m.san).join(' ');
    expect(ordersFor(all, mine('Nc3')).map(line)).toEqual(['d4 d6 c4 Nf6']);
    expect(ordersFor(all, mine('Nf3')).map(line)).toEqual(['d4 Nf6 c4 d6']);
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
    const cards = g.myMoves().map((m) => newCard({ id: m.id, color: 'white', fromKey: m.fromKey, san: m.san }));
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
    const c0 = newCard({ id: 'a', color: 'white', fromKey: START_KEY, san: 'e4' }, now);
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

describe('sharp positions', () => {
  const at = (...cps: number[]) => cps.map((cp) => ({ eval: { cp } }));
  it('a quiet position has about three moves roughly as good as the best', () => {
    expect(movesThatHold(at(20, 10, -5, -200), 'white', 30)).toBe(3);
    expect(isSharp(at(20, 10, -5, -200), 'white', 30)).toBe(false);
    // Only two hold: sharp.
    expect(movesThatHold(at(50, 25, -40), 'white', 30)).toBe(2);
    expect(isSharp(at(50, 25, -40), 'white', 30)).toBe(true);
  });
  it("reads the evaluation from the side to move's point of view", () => {
    // Black to move: −0.5 is Black's best; −0.1 and +0.6 are much worse for Black.
    expect(movesThatHold(at(-50, -10, 60), 'black', 30)).toBe(1);
  });
  it("can't tell from too few lines unless there are that few moves", () => {
    expect(movesThatHold(at(10, 0), 'white', 25)).toBeUndefined();
    expect(movesThatHold(at(10, 0), 'white', 2)).toBe(2);
  });
  it('is more lenient once the position is decided, and counts mates as best', () => {
    expect(movesThatHold(at(520, 480, 470), 'white', 30)).toBe(3);
    expect(movesThatHold([{ eval: { mate: 2 } }, { eval: { cp: 300 } }, { eval: { cp: 290 } }], 'white', 30)).toBe(1);
  });
});

describe('tilt', () => {
  const now = Date.UTC(2026, 10, 21, 20, 0);
  const game = (minAgo: number, score: number, termination = 'resign', source = 'lichess') =>
    ({ id: `g${minAgo}`, source, playedAt: now - minAgo * 60_000, userScore: score, termination }) as unknown as StoredGame;
  it('flags a losing streak and a loss on time in the session you are playing', () => {
    const t = tiltCheck([game(5, 0, 'outoftime'), game(15, 0), game(25, 0), game(35, 1)], now)!;
    expect(t.reasons).toEqual(['3 losses in a row', 'you just lost on time']);
    expect(t.session.map((g) => g.id)).toEqual(['g5', 'g15', 'g25', 'g35']);
  });
  it('only looks at this session, and only while you are still playing', () => {
    // Two losses now; earlier losses were an hour before (another session).
    expect(tiltCheck([game(5, 0), game(15, 0), game(80, 0), game(90, 0)], now)).toBeUndefined();
    // Last game two hours ago: you've stopped already.
    expect(tiltCheck([game(120, 0), game(130, 0), game(140, 0)], now)).toBeUndefined();
    // Chess.com's word for a loss on time, and over-the-board games don't count.
    expect(tiltCheck([game(5, 0, 'timeout', 'chesscom')], now)!.reasons).toEqual(['you just lost on time']);
    expect(tiltCheck([game(5, 0, 'timeout', 'otb')], now)).toBeUndefined();
  });
  it('a long session is a reason too', () => {
    const games = Array.from({ length: 10 }, (_, i) => game(5 + i * 10, i % 2));
    expect(tiltCheck(games, now)!.reasons).toEqual(['10 games in this session']);
  });
  it('puzzles: three misses in a row, or a quick miss right after a miss', () => {
    const a = (win: boolean, s = 60) => ({ win, ms: s * 1000 });
    expect(puzzleTilt([a(true), a(false), a(false)])).toBeUndefined();
    expect(puzzleTilt([a(false), a(false), a(false)])).toBe('3 misses in a row');
    expect(puzzleTilt([a(true), a(false), a(false, 8)])).toMatch(/^a quick miss \(8 s\) right after a miss/);
    // A quick miss after a solve is just a miss; a solve ends a streak.
    expect(puzzleTilt([a(true), a(false, 8)])).toBeUndefined();
    expect(puzzleTilt([a(false), a(false), a(true)])).toBeUndefined();
  });
});

describe('the 1/3 plan', () => {
  const MIN = 60_000;
  const act = (third: 'tactics' | 'games' | 'study', mins: number, start: number, extra: object = {}) => ({ id: `${third}${start}`, third, what: 'x', start, ms: mins * MIN, ...extra });
  it('weeks start on Monday', () => {
    const wed = new Date(2026, 10, 18, 15, 0).getTime(); // a Wednesday
    expect(new Date(weekStart(wed)).getDay()).toBe(1);
    expect(weekStart(wed)).toBe(new Date(2026, 10, 16).getTime());
  });
  it('counts a game from its clocks: the time each side used', () => {
    // 3+0: each side spends 10 s a move for 4 moves.
    const clocks = [180, 180, 170, 170, 160, 160, 150, 150];
    expect(gameDurationMs({ clocks, sans: clocks.map(() => 'x'), timeClass: 'blitz' })).toBe((60 + 8) * 1000);
    expect(gameDurationMs({ sans: [], timeClass: 'rapid' })).toBe(20 * MIN);
  });
  it('adds up the thirds, playing and reviewing, and study by topic — only games of the chosen speeds', () => {
    const t = 1_000_000;
    const totals = planTotals(
      [act('tactics', 30, t), act('study', 60, t, { topic: 'openings' }), act('games', 10, t, { what: 'review' }), act('study', 20, t - 1e9, { topic: 'endgames' })],
      [
        { id: 'r1', source: 'lichess', playedAt: t, timeClass: 'rapid', sans: [] } as unknown as StoredGame,
        { id: 'b1', source: 'lichess', playedAt: t, timeClass: 'bullet', sans: [] } as unknown as StoredGame,
      ],
      t - 1,
      t + 1,
      ['blitz', 'rapid'],
    );
    expect(totals.by).toEqual({ tactics: 30 * MIN, games: 30 * MIN, study: 60 * MIN });
    expect([totals.playing, totals.reviewing, totals.gamesPlayed]).toEqual([20 * MIN, 10 * MIN, 1]);
    // The rapid game counts and isn't reviewed yet; the bullet one isn't training.
    expect([totals.gamesReviewed, totals.toReview]).toEqual([0, ['r1']]);
    expect(totals.topics.openings).toBe(60 * MIN);
    // Openings: half of 2 hours — more than Studer's third.
    expect(tooMuchOpenings(totals)).toBe(true);
    // 7 hours a week: tactics (30 of 140 min) and games (30) are furthest behind — tactics first.
    expect(behind(totals, 420 * MIN)).toBe('tactics');
  });
  it('today: from midnight to midnight; with planned slots, the third furthest behind its own target', () => {
    const t = new Date(2026, 10, 22, 15, 30).getTime();
    const b = periodBounds('today', t);
    expect([b.from, b.to, b.days]).toEqual([new Date(2026, 10, 22).getTime(), new Date(2026, 10, 23).getTime(), 1]);
    const totals = planTotals([act('tactics', 40, t), act('study', 10, t, { topic: 'openings' })], [], b.from, b.to, []);
    // Planned today: 45 min tactics, 30 min study — study is further behind.
    expect(behindTargets(totals, { tactics: 45 * MIN, games: 0, study: 30 * MIN })).toBe('study');
  });
  it('counts the games you reviewed, and lists the rest newest first', () => {
    const g = (id: string, playedAt: number, reviewedAt?: number) => ({ id, source: 'lichess', playedAt, timeClass: 'blitz', sans: [], reviewedAt }) as unknown as StoredGame;
    const totals = planTotals([], [g('a', 10, 50), g('b', 20), g('c', 30), g('otb', 25)].map((x, i) => (i === 3 ? { ...x, source: 'otb' } : x)), 0, 100, ['blitz']);
    expect([totals.gamesPlayed, totals.gamesReviewed, totals.toReview]).toEqual([3, 1, ['c', 'b']]);
  });
});
