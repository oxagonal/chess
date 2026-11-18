import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { db } from '../db/db';
import {
  MAX_PLIES,
  bucketGames,
  dateOf,
  decodeMoves,
  encodeMoves,
  matchNames,
  nameTokens,
  shardKey,
  timeClassOf,
  type GameBucket,
  type GamesDbManifest,
  type NameEntry,
} from '../lib/gamesdb';
import { GAMES_DB_URL, searchPlayers } from '../services/gamesdb';
import { refreshPlayerGames, savePlayer } from '../services/players';
import { inWindow, onlineWindow } from '../lib/players';

/** The vectors in gamesdb/SPEC.md — the exporter must produce exactly these. */
const VECTORS = [
  { moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6', encoded: 'DBwyIgYVMysLGyIbFRs-LQESMCg' },
  { moves: 'e4 e5 Nf3 Nc6 Bc4 Nf6 O-O Be7 d4 exd4 e5 Ne4', encoded: 'DBw0JAYVOSoFGj4tBAY9NAsbJBscJC0c' },
  { moves: 'a4 h5 a5 h4 a6 h3 axb7 hxg2 bxa8=N gxh1=Q', encoded: 'CBg3JxggJx8gKB8XKDEXDjF4Dgc' },
];

describe('games database format', () => {
  it('encodes moves as from/to bytes (castling, promotions) and back', () => {
    for (const v of VECTORS) {
      expect(encodeMoves(v.moves.split(' '))).toBe(v.encoded);
      expect(decodeMoves(v.encoded).join(' ')).toBe(v.moves);
    }
  });

  it('keeps only the first 30 moves', () => {
    const long = Array.from({ length: 40 }, () => ['Nf3', 'Nf6', 'Ng1', 'Ng8']).flat();
    expect(decodeMoves(encodeMoves(long))).toHaveLength(MAX_PLIES);
  });

  it('indexes names by the first two letters of each word', () => {
    expect(nameTokens('Iinuma, Paul Y')).toEqual(['iinuma', 'paul']);
    expect(nameTokens('Müller, Jörg').map(shardKey)).toEqual(['jo', 'mu']);
    expect(shardKey('ølund')).toBe('_l');
  });

  it('finds names by every word, the last one possibly unfinished', () => {
    const entries: NameEntry[] = [
      ['Iinuma, Paul Y', 1, 120, 2003, 2026, 0],
      ['Paul Iinuma', 2, 11, 2022, 2025, 0],
      ['Iinuma, Ken', 3, 4, 2010, 2012, 0],
      ['Paulsen, Iinu', 4, 1, 1990, 1990, 0],
    ];
    expect(matchNames(entries, 'paul iinuma').map((e) => e[1])).toEqual([1, 2]);
    expect(matchNames(entries, 'iinu').map((e) => e[1])).toEqual([1, 2, 3, 4]);
    expect(matchNames(entries, 'iinuma k').map((e) => e[1])).toEqual([3]);
    expect(matchNames(entries, 'paul iin').map((e) => e[1])).toEqual([1, 2]); // typed order: "iin" is the unfinished word
  });

  it('turns a bucket into games from the player’s side', () => {
    const bucket: GameBucket = {
      events: ['Marshall CC IM Norm'],
      tcs: ['5400+30'],
      players: { '7': [[1, 'Smith, Anna', 2210, 2290, 20240500, 2, 0, 0, VECTORS[0].encoded]] },
    };
    const [g] = bucketGames(bucket, ['Iinuma, Paul Y', 7], '2026-11');
    expect(g).toMatchObject({ white: 'Smith, Anna', black: 'Iinuma, Paul Y', userColor: 'black', result: '0-1', userScore: 1, whiteElo: 2210, blackElo: 2290, event: 'Marshall CC IM Norm', timeClass: 'classical', source: 'otb', account: 'lgb:2026-11' });
    expect(g.sans.slice(0, 2)).toEqual(['e4', 'c5']);
    expect(new Date(g.playedAt).getMonth()).toBe(4);
    expect(dateOf(0)).toBe(0);
    expect(timeClassOf('180+2')).toBe('blitz');
    expect(timeClassOf('900+10')).toBe('rapid');
    expect(timeClassOf('40/7200:3600')).toBe('classical');
  });
});

describe('searching and linking (fake database)', () => {
  const files: Record<string, unknown> = {
    'manifest.json': { format: 1, source: "Lumbra's Gigabase", license: 'CC BY-NC 4.0', release: '2026-11', games: 2, players: 3, buckets: 4, maxPlies: 60 } satisfies GamesDbManifest,
    'names/ii.bin': [
      ['Iinuma, Paul Y', 5, 1, 2024, 2024, 0],
      ['Paul Iinuma', 6, 1, 2025, 2025, 0],
    ],
    'games/1.bin': { events: ['US Open'], tcs: [], players: { '5': [[0, 'Lee, Ann', 2000, 2300, 20240804, 1, 0, -1, VECTORS[1].encoded]] } },
    'games/2.bin': { events: [], tcs: [], players: { '6': [[1, 'Kim, Bo', 0, 0, 20250000, 3, -1, -1, VECTORS[0].encoded]] } },
  };
  const requests: string[] = [];
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
    requests.length = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      requests.push(url);
      const path = url.replace(`${GAMES_DB_URL}/`, '').replace(/\?.*$/, '');
      const body = files[path];
      if (body === undefined) return new Response('not found', { status: 404 });
      if (path.endsWith('.json')) return new Response(JSON.stringify(body));
      return new Response(gzipSync(JSON.stringify(body)));
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('searches the shard of the longest word and adds the release to file URLs', async () => {
    const found = await searchPlayers('Paul Iinuma');
    expect(found.map((e) => e[0])).toEqual(['Iinuma, Paul Y', 'Paul Iinuma']);
    expect(requests.some((u) => u.includes('names/ii.bin?r=2026-11'))).toBe(true);
    expect(await searchPlayers('nobody here')).toEqual([]);
  });

  it('downloads the games of every linked name into the player', async () => {
    const p = await savePlayer({ name: 'Paul Iinuma', dbLinks: [{ id: 5, name: 'Iinuma, Paul Y', games: 1 }, { id: 6, name: 'Paul Iinuma', games: 1 }] });
    const r = await refreshPlayerGames(p);
    expect(r.errors).toEqual([]);
    const games = await db.playerGames.where('playerId').equals(p.id).toArray();
    expect(games.map((g) => [g.white, g.black, g.userColor]).sort()).toEqual([
      ['Iinuma, Paul Y', 'Lee, Ann', 'white'],
      ['Kim, Bo', 'Paul Iinuma', 'black'],
    ]);
    // Nothing new to download the second time.
    const before = requests.length;
    await refreshPlayerGames(p);
    expect(requests.filter((u) => u.includes('games/')).length).toBe(requests.slice(0, before).filter((u) => u.includes('games/')).length);
    // Unlinking a name drops its games.
    await savePlayer({ ...p, dbLinks: [{ id: 6, name: 'Paul Iinuma', games: 1 }] });
    await refreshPlayerGames((await db.players.get(p.id))!);
    expect((await db.playerGames.where('playerId').equals(p.id).toArray()).map((g) => g.black)).toEqual(['Paul Iinuma']);
  });
});

describe("a scouted player's online games", () => {
  const sinceAsked: number[] = [];
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
    sinceAsked.length = 0;
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    // Lichess's export: note the period asked for, send no games.
    vi.stubGlobal('fetch', async (url: string) => {
      const u = new URL(url);
      expect(u.searchParams.has('max')).toBe(false);
      sinceAsked.push(Number(u.searchParams.get('since')));
      return new Response('');
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const cache = (playerId: string, playedAt: number) =>
    db.playerGames.put({
      ...({ source: 'lichess', account: 'x', url: '', white: 'x', black: 'y', userColor: 'white', result: '1-0', timeClass: 'blitz', rated: true, sans: [] } as const),
      id: `${playerId}|lichess:${playedAt}`,
      gameId: `lichess:${playedAt}`,
      playerId,
      playedAt,
    });

  it('downloads the period chosen (all of it if asked), then only newer games — older ones when the date moves back', async () => {
    const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
    let p = await savePlayer({ name: 'X', lichess: 'x', since: '2025-01-01', timeClasses: ['blitz'] });
    await refreshPlayerGames(p);
    expect(sinceAsked).toEqual([day('2025-01-01')]);
    await cache(p.id, day('2026-06-01'));
    await refreshPlayerGames(p);
    expect(sinceAsked[1]).toBe(day('2026-06-01') + 1); // just what's newer
    p = await savePlayer({ ...p, since: '' }); // all their games
    await refreshPlayerGames(p);
    expect(sinceAsked[2]).toBe(0);
    p = await savePlayer({ ...p, since: '2026-01-01' }); // narrower: nothing to fetch but newer games
    await refreshPlayerGames(p);
    expect(sinceAsked[3]).toBe(day('2026-06-01') + 1);
    p = await savePlayer({ ...p, timeClasses: ['blitz', 'bullet'] }); // another time control: its whole period
    await refreshPlayerGames(p);
    expect(sinceAsked[4]).toBe(day('2026-01-01'));
  });

  it('shows only the games in the chosen period and time controls', () => {
    const w = onlineWindow({ since: '2026-01-01', timeClasses: ['blitz'] }, ['rapid']);
    expect(inWindow({ playedAt: Date.parse('2026-03-01'), timeClass: 'blitz' }, w)).toBe(true);
    expect(inWindow({ playedAt: Date.parse('2025-12-01'), timeClass: 'blitz' }, w)).toBe(false);
    expect(inWindow({ playedAt: Date.parse('2026-03-01'), timeClass: 'bullet' }, w)).toBe(false);
    expect(onlineWindow({ since: '' }, ['rapid'])).toEqual({ since: 0, timeClasses: ['rapid'] });
    const now = Date.parse('2026-11-18T12:00:00Z');
    expect(onlineWindow({}, ['blitz'], now).since).toBe(now - 365 * 86_400_000);
  });
});

/**
 * Checks a database built on your computer before you deploy it:
 *   GAMESDB_DIR=gamesdb/dist npm run check:gamesdb
 * (optionally GAMESDB_PROBE="Paul Iinuma" to check one name is findable).
 */
const DIR = process.env.GAMESDB_DIR;
describe.runIf(!!DIR)('a built games database', () => {
  const dir = DIR!;
  const read = (p: string) => JSON.parse(gunzipSync(readFileSync(join(dir, p))).toString('utf8'));

  it('is within Cloudflare’s static-asset limits and decodes cleanly', () => {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as GamesDbManifest;
    expect(manifest.format).toBe(1);
    expect(manifest.maxPlies).toBe(MAX_PLIES);
    expect(existsSync(join(dir, '_headers'))).toBe(true);

    const all: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else all.push(p);
      }
    };
    walk(dir);
    let bytes = 0;
    for (const f of all) {
      const size = statSync(f).size;
      bytes += size;
      expect(size, f).toBeLessThanOrEqual(25 * 1024 * 1024);
    }
    expect(all.length).toBeLessThanOrEqual(20000);
    const buckets = readdirSync(join(dir, 'games'));
    expect(buckets.length).toBeLessThanOrEqual(manifest.buckets);

    // Sample name shards: every entry has a word with that shard's key.
    const shards = readdirSync(join(dir, 'names'));
    let names = 0;
    for (const f of shards.filter((_, i) => i % Math.ceil(shards.length / 25) === 0)) {
      const key = f.replace('.bin', '');
      const entries = read(`names/${f}`) as NameEntry[];
      names += entries.length;
      for (const e of entries.slice(0, 500)) {
        expect(e.length, f).toBe(6);
        expect(nameTokens(e[0]).map(shardKey), `${e[0]} in ${f}`).toContain(key);
      }
    }

    // Sample buckets: every game decodes to as many moves as were stored.
    let games = 0;
    let badGames = 0;
    for (const f of buckets.filter((_, i) => i % Math.ceil(buckets.length / 25) === 0)) {
      const b = read(`games/${f}`) as GameBucket;
      for (const [pid, list] of Object.entries(b.players)) {
        expect(Number(pid) % manifest.buckets, `player ${pid} in ${f}`).toBe(Number(f.replace('.bin', '')));
        for (const g of list) {
          games++;
          const stored = Math.floor((g[8].length * 6) / 8 / 2);
          if (decodeMoves(g[8]).length !== stored || stored > MAX_PLIES) badGames++;
        }
      }
    }
    expect(badGames, `${badGames} of ${games} sampled games don't decode`).toBe(0);

    const probe = process.env.GAMESDB_PROBE;
    if (probe) {
      const words = nameTokens(probe);
      const key = shardKey([...words].sort((a, b) => b.length - a.length)[0]);
      const found = matchNames(read(`names/${key}.bin`) as NameEntry[], probe);
      expect(found.length, `"${probe}" not found`).toBeGreaterThan(0);
      console.log(`"${probe}":`, found.slice(0, 10).map((e) => `${e[0]} (${e[2]})`).join(', '));
    }
    console.log(`OK — ${all.length} files, ${(bytes / 1e9).toFixed(2)} GB; sampled ${names} names and ${games} games.`);
  }, 15 * 60_000); // a full database is ~2 GB: allow well beyond the default 5 s
});
