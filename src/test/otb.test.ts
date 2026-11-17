import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/db';
import { draftFromPgn, draftOf, makeOtbGame, normalizeName, parsePgnDate, readPgnGames, sameName, sideOf, similarNames } from '../lib/otb';
import { otbGamesVs, pgnGamesOf } from '../lib/players';
import { GameStatsIndex } from '../lib/mygames';
import { START_KEY } from '../lib/chess';
import { deleteAllGames } from '../services/sync';
import { refreshPlayerGames, savePlayer } from '../services/players';
import type { Player, StoredGame } from '../lib/types';

const PGN = `[Event "Club Championship"]
[Date "2026.10.04"]
[White "Ching, Owen"]
[Black "Smith, Anna"]
[WhiteElo "1850"]
[BlackElo "1790"]
[Result "1-0"]

1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 1-0

[Event "Club Championship"]
[Date "2026.10.11"]
[White "Smith, Anna"]
[Black "Owen Ching"]
[Result "1/2-1/2"]

1. d4 Nf6 2. c4 e6 1/2-1/2

[Event "Rapid"]
[White "Someone Else"]
[Black "Smith, Anna"]
[Result "0-1"]

1. e4 e5 2. Nf3 Nc6 0-1
`;

let n = 0;
const newId = () => `t${++n}`;

describe('names', () => {
  it('ignores case, accents, punctuation and word order', () => {
    expect(normalizeName('Carlsen, Magnus')).toBe(normalizeName('magnus CARLSEN'));
    expect(sameName('Müller, Jörg', 'Jorg Muller')).toBe(true);
    expect(sameName('Anna Smith', 'Anna Smyth')).toBe(false);
    expect(sameName('', '')).toBe(false);
  });

  it('matches names with middle names and initials, but not a lone first or last name', () => {
    // The five ways Lumbra's Gigabase spells one player.
    for (const n of ['Iinuma, Paul Y', 'Paul Iinuma', 'Paul Yuu Iinuma', 'Paul Y Iinuma', 'Paul Yuu-RE Iinuma']) expect(sameName('Paul Iinuma', n)).toBe(true);
    expect(sameName('Iinuma, Paul Y', 'Paul Yuu Iinuma')).toBe(false); // Y vs Yuu: neither contains the other
    expect(sameName('Iinuma', 'Iinuma, Paul Y')).toBe(false);
    expect(sameName('Paul', 'Paul Iinuma')).toBe(false);
    expect(sameName('Paul Y', 'Iinuma, Paul Y')).toBe(false); // only one real word
    expect(sameName('Paul Iinuma', 'Paul Smith')).toBe(false);
  });

  it('suggests names that share a word, for typos and nicknames', () => {
    const names = ['Iinuma, Paul', 'Paul Smith', 'Anna Iinuma', 'Bob Jones'];
    expect(similarNames('Paul Inuma', names)).toEqual(['Iinuma, Paul', 'Paul Smith']);
    expect(similarNames('Mr Iinuma', names)).toEqual(['Anna Iinuma', 'Iinuma, Paul']);
    expect(similarNames('Paul Iinuma', names)).not.toContain('Iinuma, Paul'); // exact match isn't a suggestion
  });
});

describe('PGN of over-the-board games', () => {
  it('reads headers and moves, and finds your side by name', () => {
    const { games, errors } = readPgnGames(PGN);
    expect(errors).toEqual([]);
    expect(games).toHaveLength(3);
    expect(games[0]).toMatchObject({ white: 'Ching, Owen', black: 'Smith, Anna', whiteElo: 1850, result: '1-0', event: 'Club Championship' });
    expect(games[0].sans.slice(0, 4)).toEqual(['e4', 'c5', 'Nf3', 'd6']);
    expect(new Date(games[0].playedAt!).getDate()).toBe(4);
    expect(sideOf(games[0], 'Owen Ching')).toBe('white');
    expect(sideOf(games[1], 'Owen Ching')).toBe('black');
    expect(sideOf(games[2], 'Owen Ching')).toBeUndefined();
  });

  it('keeps the legal part of a game with an illegal move', () => {
    const { games, errors } = readPgnGames('1. e4 e5 2. Ke3 Nc6 *');
    expect(games[0].sans).toEqual(['e4', 'e5']);
    expect(errors[0]).toMatch(/illegal move "Ke3"/);
  });

  it('turns a draft into a stored game and back', () => {
    const [g] = readPgnGames(PGN).games;
    const stored = makeOtbGame(draftFromPgn(g, 'white'), newId);
    expect(stored).toMatchObject({ source: 'otb', white: 'Ching, Owen', black: 'Smith, Anna', userColor: 'white', userScore: 1, timeClass: 'classical' });
    expect(stored.id).toMatch(/^otb:/);
    const back = draftOf(stored);
    expect(back).toMatchObject({ opponent: 'Smith, Anna', opponentElo: 1790, myElo: 1850, result: '1-0', event: 'Club Championship' });
    expect(makeOtbGame(back, newId).id).toBe(stored.id); // editing keeps the id
  });

  it('parses dates', () => {
    expect(parsePgnDate('????.??.??')).toBeUndefined();
    expect(new Date(parsePgnDate('2025-02-03')!).getMonth()).toBe(1);
  });
});

describe('scouting a player', () => {
  const anna: Player = { id: 'p1', name: 'Anna Smith', pgn: PGN, createdAt: 1 };

  it('uses your OTB games against them, seen from their side', () => {
    const mine = readPgnGames(PGN).games.slice(0, 2).map((g) => makeOtbGame(draftFromPgn(g, sideOf(g, 'Owen Ching')!), newId));
    const theirs = otbGamesVs(anna, mine);
    expect(theirs.map((g) => g.userColor)).toEqual(['black', 'white']);
    expect(theirs[0].userScore).toBe(0); // you won game 1
    // As Black against 1.e4 she played 1...c5.
    const idx = new GameStatsIndex(theirs, { color: 'black' });
    expect(idx.get(START_KEY)?.moves.map((m) => m.san)).toEqual(['e4']);
  });

  it('takes pasted PGN games where they are named, in their color', () => {
    const { games, skipped } = pgnGamesOf(anna);
    expect(games.map((g) => g.userColor)).toEqual(['black', 'white', 'black']);
    expect(skipped).toBe(0);
    expect(pgnGamesOf({ ...anna, name: 'Nobody' }).games).toHaveLength(0);
    // Stable ids: reading again gives the same ones.
    expect(pgnGamesOf(anna).games.map((g) => g.id)).toEqual(games.map((g) => g.id));
  });
});

describe('player games and downloads', () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });
  afterEach(() => vi.unstubAllGlobals());

  const game = (id: string, source: StoredGame['source']): StoredGame => ({
    id, source, account: 'me', url: '', white: 'a', black: 'b', userColor: 'white', result: '1-0', timeClass: 'blitz', rated: true, playedAt: 1, sans: ['e4'],
  });

  it('"Delete downloaded games" keeps over-the-board games', async () => {
    await db.games.bulkAdd([game('lichess:1', 'lichess'), game('chesscom:1', 'chesscom'), game('otb:1', 'otb')]);
    await deleteAllGames();
    expect((await db.games.toArray()).map((g) => g.id)).toEqual(['otb:1']);
  });

  it('downloads only the newest Lichess games the first time, then just new ones', async () => {
    const urls: string[] = [];
    const line = (id: string, t: number) =>
      JSON.stringify({ id, rated: true, variant: 'standard', speed: 'blitz', createdAt: t, status: 'mate', winner: 'white', moves: 'e4 e5', players: { white: { user: { id: 'anna', name: 'Anna' } }, black: { user: { id: 'bob', name: 'Bob' } } } });
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      const body = urls.length === 1 ? `${line('g2', 2000)}\n${line('g1', 1000)}\n` : `${line('g3', 3000)}\n`;
      return new Response(body, { status: 200 });
    });
    const p = await savePlayer({ name: 'Anna', lichess: 'anna' });
    await refreshPlayerGames(p);
    expect(urls[0]).toContain('max=600');
    expect(urls[0]).not.toContain('sort=dateAsc');
    await refreshPlayerGames(p);
    expect(urls[1]).toContain('since=2001');
    const cached = await db.playerGames.where('playerId').equals(p.id).toArray();
    expect(cached.map((g) => g.gameId).sort()).toEqual(['lichess:g1', 'lichess:g2', 'lichess:g3']);
    expect(cached[0].userColor).toBe('white');

    // A different account: the old account's games go.
    await savePlayer({ ...p, lichess: 'someone-else' });
    expect(await db.playerGames.count()).toBe(0);
  });
});
