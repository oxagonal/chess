import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { db } from '../db/db';
import { saveAnnotation } from '../db/annotations';
import { glyphsFromNags, moveGlyph, nagsOf, otherGlyphs, sanWithGlyphs, sortGlyphs, toggleGlyph, withLineNote } from '../lib/annotations';
import { biggestSwingsFor, formatEvalShort, type GameReview } from '../lib/review';
import { clocksAt, formatClock, formatMoveTime, inferIncrement, moveTimes, timeSpent } from '../lib/clocks';
import { materialBalance } from '../lib/material';
import { playSan, startPos } from '../lib/chess';
import { emptySnapshot, mergeSync } from '../lib/syncMerge';
import type { StoredGame } from '../lib/types';

describe('annotations', () => {
  it('keeps one move symbol and one position symbol, observations independent', () => {
    let g = toggleGlyph(undefined, '!?');
    g = toggleGlyph(g, '±');
    g = toggleGlyph(g, 'N');
    expect(g).toEqual(['!?', '±', 'N']);
    g = toggleGlyph(g, '??'); // replaces !?
    g = toggleGlyph(g, '∞'); // replaces ±
    g = toggleGlyph(g, '→');
    expect(g).toEqual(['??', '∞', 'N', '→']);
    expect(toggleGlyph(g, 'N')).toEqual(['??', '∞', '→']); // same again removes it
    expect(toggleGlyph(['□'], '□')).toEqual([]);
    expect(sortGlyphs(['N', '±', '!'])).toEqual(['!', '±', 'N']);
    expect(moveGlyph({ glyphs: ['□', '+−'] })).toBe('□');
    expect(otherGlyphs({ glyphs: ['□', '+−', 'N'] })).toEqual(['+−', 'N']);
  });

  it('saves per move on the game, and an empty annotation removes it', async () => {
    await db.games.clear();
    const game: StoredGame = { id: 'g1', source: 'lichess', account: 'me', url: '', white: 'a', black: 'b', userColor: 'white', result: '1-0', timeClass: 'blitz', rated: true, playedAt: 1, sans: ['e4', 'e5', 'Nf3'] };
    await db.games.add(game);
    await saveAnnotation('g1', 0, { glyphs: ['N', '!!'], comment: '  The big idea  ' });
    await saveAnnotation('g1', 2, { glyphs: ['?!'] });
    expect((await db.games.get('g1'))!.annotations).toEqual({ '0': { glyphs: ['!!', 'N'], comment: 'The big idea' }, '2': { glyphs: ['?!'] } });
    await saveAnnotation('g1', 2, { glyphs: [], comment: ' ' });
    await saveAnnotation('g1', 0, undefined);
    // Kept as an empty {} (not removed), so sync can't bring the old annotations back.
    expect((await db.games.get('g1'))!.annotations).toEqual({});
  });

  it('annotates side-line moves', () => {
    let line = { id: 'l1', from: 6, sans: ['Nxd4', 'exd4', 'O-O'] };
    line = withLineNote(line, 1, { glyphs: ['!', 'N'], comment: ' only move ' });
    expect(line).toEqual({ id: 'l1', from: 6, sans: ['Nxd4', 'exd4', 'O-O'], notes: { '1': { glyphs: ['!', 'N'], comment: 'only move' } } });
    expect(withLineNote(line, 1, { glyphs: [] })).toEqual({ id: 'l1', from: 6, sans: ['Nxd4', 'exd4', 'O-O'] });
  });

  it('survives sync when the newer copy of the game has none', () => {
    const base = { id: 'g', source: 'lichess', playedAt: 1, sans: ['e4'] };
    const local = emptySnapshot();
    local.games.set('g', { ...base, annotations: { '0': { glyphs: ['!'] } }, modifiedAt: 5 });
    const remote = mergeSync({ local: emptySnapshot(), remote: null, base: null, now: 0 }).doc;
    remote.tables.games.rows = [{ ...base, prepApplied: true, modifiedAt: 9 }];
    const [g] = mergeSync({ local, remote, base: null, now: 10 }).doc.tables.games.rows;
    expect(g.annotations).toEqual({ '0': { glyphs: ['!'] } });
    expect(g.prepApplied).toBe(true);
  });

  it('doesn’t bring back annotations or side lines you cleared', () => {
    const base = { id: 'g', source: 'lichess', playedAt: 1, sans: ['e4'] };
    const local = emptySnapshot();
    local.games.set('g', { ...base, annotations: {}, lines: [], modifiedAt: 9 });
    const remote = mergeSync({ local: emptySnapshot(), remote: null, base: null, now: 0 }).doc;
    remote.tables.games.rows = [{ ...base, annotations: { '0': { glyphs: ['!'] } }, lines: [{ id: 'l', from: 0, sans: ['d4'] }], modifiedAt: 5 }];
    const [g] = mergeSync({ local, remote, base: null, now: 10 }).doc.tables.games.rows;
    expect(g.annotations).toEqual({});
    expect(g.lines).toEqual([]);
  });
});

describe('computer review', () => {
  it('finds each side’s biggest swings separately', () => {
    // White blunders at ply 2 and 4 (small), Black at ply 3 and 5.
    const cp = [0, 0, 0, -400, 300, 250, 900];
    const review: GameReview = { depth: 10, analyzedAt: 0, evals: cp.map((c) => ({ cp: c })), best: cp.map(() => null) };
    expect(biggestSwingsFor(review, 'white').map((s) => s.ply)).toEqual([2, 4]);
    expect(biggestSwingsFor(review, 'black').map((s) => s.ply)).toEqual([3, 5]);
    expect(biggestSwingsFor(review, 'white', 1)).toHaveLength(1);
  });
});

describe('symbols in PGN', () => {
  it('turns symbols into $n codes and back, and writes them after the move', () => {
    expect(nagsOf(['!?', '±', 'N'])).toEqual([5, 16, 146]);
    expect(glyphsFromNags([16, 5, 999, 146])).toEqual(['!?', '±', 'N']);
    expect(glyphsFromNags([1, 2])).toEqual(['?']); // one move symbol: the last wins
    expect(sanWithGlyphs('Nf3', ['!?', '±', 'N'])).toBe('Nf3!? ± N');
    expect(sanWithGlyphs('e4', undefined)).toBe('e4');
  });
});

describe('eval beside a move', () => {
  it('prints scores like Lichess', () => {
    expect(formatEvalShort({ cp: 118 })).toBe('+1.2');
    expect(formatEvalShort({ cp: -42 })).toBe('−0.4');
    expect(formatEvalShort({ cp: 4 })).toBe('0.0');
    expect(formatEvalShort({ mate: 3 })).toBe('#3');
    expect(formatEvalShort({ mate: -2 })).toBe('#−2');
  });
});

describe('clocks', () => {
  const clocks = [180, 179, 175, 170.5, 160, 9.4];
  it('shows each side’s clock at a position', () => {
    expect(clocksAt(clocks, 0)).toEqual({ white: 180, black: 179 });
    expect(clocksAt(clocks, 1)).toEqual({ white: 180, black: 179 });
    expect(clocksAt(clocks, 3)).toEqual({ white: 175, black: 179 }); // after White's 2nd move
    expect(clocksAt(clocks, 4)).toEqual({ white: 175, black: 170.5 });
    expect(clocksAt(clocks, 6)).toEqual({ white: 160, black: 9.4 });
    expect(clocksAt(undefined, 3)).toEqual({});
  });
  it('works out time spent and formats clocks', () => {
    expect(timeSpent(clocks, 2)).toBe(5);
    expect(timeSpent(clocks, 1)).toBeUndefined();
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(247)).toBe('4:07');
    expect(formatClock(9.44)).toBe('0:09.4');
  });
  it('lists move times with the increment worked out from the clocks', () => {
    // 3+2: White's 2nd move was a 0.1s premove (+1.9), Black's took 4s (+2 = −2).
    const inc = [180, 180, 181.9, 178, 172, 178.5];
    expect(inferIncrement(inc)).toBe(2);
    expect(moveTimes(inc)).toEqual([undefined, undefined, expect.closeTo(0.1), 4, expect.closeTo(11.9), expect.closeTo(1.5)]);
    expect(inferIncrement(clocks)).toBe(0);
    expect(moveTimes(clocks)[2]).toBe(5);
    expect(formatMoveTime(0.84)).toBe('0.8s');
    expect(formatMoveTime(10.5)).toBe('10.5s');
    expect(formatMoveTime(65)).toBe('1:05');
  });
});

describe('material balance', () => {
  const after = (sans: string[]) => sans.reduce((pos, san) => playSan(pos, san)!.pos, startPos());
  it('shows the pieces each side is up and the points ahead', () => {
    expect(materialBalance(startPos())).toEqual({ white: { up: [], plus: 0 }, black: { up: [], plus: 0 } });
    // 1. e4 d5 2. exd5 Qxd5 3. Nc3 Qxg2: White took a pawn, Black took two.
    const m = materialBalance(after(['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qxg2']));
    expect(m).toEqual({ white: { up: [], plus: 0 }, black: { up: ['pawn'], plus: 1 } });
    // Trading a knight for a pawn and a bishop: pieces both ways, net points to one side.
    const t = materialBalance(after(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'Nd4', 'Nxd4', 'exd4', 'Bxd7+', 'Bxd7']));
    expect(t.white.up).toEqual(['pawn']);
    expect(t.black.up).toEqual(['bishop']);
    expect([t.white.plus, t.black.plus]).toEqual([0, 2]);
  });
});

