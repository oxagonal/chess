import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { db } from '../db/db';
import { saveAnnotation } from '../db/annotations';
import { moveGlyph, otherGlyphs, sortGlyphs, toggleGlyph, withLineNote } from '../lib/annotations';
import { biggestSwingsFor, type GameReview } from '../lib/review';
import { clocksAt, formatClock, timeSpent } from '../lib/clocks';
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

