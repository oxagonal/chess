import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/db';
import { canReadStudies, fetchLichessStudy, listMyStudies } from '../db/repertoire';
import { updateSettings } from '../db/settings';
import { exportBackup } from '../services/backup';

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});
afterEach(() => vi.unstubAllGlobals());

describe('your Lichess studies', () => {
  it('reads studies with your login, and says to reconnect when the login predates study access', async () => {
    const fetchMock = vi.fn(async () => new Response('[Event "x"]\n\n1. e4 *', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await updateSettings({ lichessToken: 'lio_tok', lichessAccount: 'me', lichessScopes: 'study:read' });
    expect(await fetchLichessStudy('https://lichess.org/study/AbCdEfGh')).toContain('1. e4');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/study/AbCdEfGh.pgn');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer lio_tok');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    await updateSettings({ lichessScopes: '' });
    await expect(fetchLichessStudy('AbCdEfGh')).rejects.toThrow(/reconnect Lichess/);
    expect(canReadStudies({ lichessToken: 'x', lichessScopes: '' })).toBe(false);
    expect(canReadStudies({ lichessToken: 'x', lichessScopes: 'study:read' })).toBe(true);
  });

  it('lists your studies, newest first, and keeps the permission out of backups', async () => {
    const body = ['{"id":"aaaaaaaa","name":"Old","updatedAt":1}', '{"id":"bbbbbbbb","name":"Caro-Kann (unlisted)","updatedAt":5}', ''].join('\n');
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await updateSettings({ lichessToken: 'lio_tok', lichessAccount: 'me', lichessScopes: 'study:read' });
    expect((await listMyStudies()).map((s) => s.name)).toEqual(['Caro-Kann (unlisted)', 'Old']);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain('/api/study/by/me');
    expect(await exportBackup()).not.toContain('study:read');
  });
});
