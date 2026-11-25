import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/db';
import { engineLines } from '../services/sharpness';

const KEY = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -';

describe('sharp lines: what the cloud doesn’t know', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('is remembered, so later runs don’t ask Lichess again — a rate limit isn’t', async () => {
    await db.engineCache.clear();
    let asked = 0;
    vi.stubGlobal('fetch', async () => {
      asked++;
      return new Response('{}', { status: 404 });
    });
    expect(await engineLines(KEY)).toBeUndefined();
    expect((await db.engineCache.get(KEY))?.lines).toEqual([]);
    expect(await engineLines(KEY)).toBeUndefined();
    expect(asked).toBe(1);
    // Another position, rate limited: nothing kept (it's asked again next time).
    const other = KEY.replace(' b ', ' w ');
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 429 }));
    expect(await engineLines(other)).toBeUndefined();
    expect(await db.engineCache.get(other)).toBeUndefined();
  });
});
