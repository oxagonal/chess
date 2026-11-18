import { describe, expect, it } from 'vitest';
import { RepGraph } from '../lib/graph';
import { movesFromLines } from '../lib/lines';
import { analyzeGame } from '../lib/prep';
import type { StoredGame } from '../lib/types';

const game = (sans: string, color: 'white' | 'black' = 'black'): StoredGame =>
  ({ id: 'g', source: 'lichess', account: 'me', url: '', white: 'W', black: 'B', userColor: color, result: '*', timeClass: 'blitz', rated: true, playedAt: 1, sans: sans.split(' ') }) as StoredGame;

describe('back in prep', () => {
  // Four Knights Sicilian, by 2.Nf3.
  const graph = new RepGraph('black', movesFromLines('r', 'black', ['e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6 Nc3 Nf6']));
  const reps = [{ rep: { id: 'black', name: 'Black', color: 'black' as const }, graph }];

  it('notices when the game transposes back into your prep after leaving it', () => {
    // 2.Nc3 is off your book, but 5.Nxd4 brings the Four Knights back; your prep ends after 5...Nf6.
    const r = analyzeGame(game('e4 c5 Nc3 e6 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Ndb5'), reps);
    expect(r.kind).toBe('opponent-deviated');
    expect(r.ply).toBe(2);
    expect(r.rejoins).toHaveLength(1);
    expect(r.rejoins![0]).toMatchObject({ ply: 8, inBook: 1, left: { kind: 'end-of-prep', ply: 10, played: 'Ndb5' } });
  });

  it('says so when you leave it again once back, and stays quiet when the game never returns', () => {
    const r = analyzeGame(game('e4 c5 Nc3 e6 Nf3 Nc6 d4 cxd4 Nxd4 d6'), reps);
    expect(r.rejoins![0].left).toMatchObject({ kind: 'you-deviated', ply: 9, played: 'd6', expected: ['Nf6'] });
    expect(analyzeGame(game('e4 c5 c3 d5 exd5 Qxd5'), reps).rejoins).toBeUndefined();
    expect(analyzeGame(game('e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6 Nc3 Nf6'), reps).kind).toBe('still-in-book');
  });
});
