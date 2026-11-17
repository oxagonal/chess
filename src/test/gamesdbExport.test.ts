import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { BUCKETS, dateNumber, encodeSans, movetextSans, playerId, runExport } from '../../gamesdb/export';
import { bucketGames, decodeMoves, encodeMoves, matchNames, type GameBucket, type NameEntry } from '../lib/gamesdb';

describe('exporter pieces', () => {
  it('reads the main line out of real-world movetext', () => {
    const text = `1. e4 {[%clk 1:30:00]} c5 2. Nf3 (2. c3 d5 {Alapin} 3. exd5) d6!? $1 3.d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6
6. Be3 ; a line comment runs to the end of the line, so this e5 is ignored
6... e5 7. Nb3 1-0`;
    expect(movetextSans(text)).toEqual(['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6', 'Be3', 'e5', 'Nb3']);
    expect(movetextSans('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. 0-0 Nf6 *')).toContain('O-O');
  });

  it('matches the spec’s test vectors exactly', () => {
    for (const [moves, encoded] of [
      ['e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6', 'DBwyIgYVMysLGyIbFRs-LQESMCg'],
      ['e4 e5 Nf3 Nc6 Bc4 Nf6 O-O Be7 d4 exd4 e5 Ne4', 'DBw0JAYVOSoFGj4tBAY9NAsbJBscJC0c'],
      ['a4 h5 a5 h4 a6 h3 axb7 hxg2 bxa8=N gxh1=Q', 'CBg3JxggJx8gKB8XKDEXDjF4Dgc'],
    ]) {
      expect(encodeSans(moves.split(' ')).mv).toBe(encoded);
      expect(encodeMoves(moves.split(' '))).toBe(encoded);
    }
    expect(playerId('Iinuma, Paul Y')).toBe(5290257001642107);
    expect(playerId('Paul Iinuma')).toBe(8114831744130966);
    expect(playerId('Carlsen, Magnus') % BUCKETS).toBe(3555);
    expect(playerId('Müller, Jörg')).toBe(6483172313183628);
  });

  it('stops at an illegal move and caps at 30 moves', () => {
    expect(encodeSans(['e4', 'e5', 'Ke3', 'Nc6']).plies).toBe(2);
    const long = Array.from({ length: 40 }, () => ['Nf3', 'Nf6', 'Ng1', 'Ng8']).flat();
    expect(decodeMoves(encodeSans(long).mv)).toHaveLength(60);
  });

  it('turns PGN dates into numbers', () => {
    expect(dateNumber('2024.05.03')).toBe(20240503);
    expect(dateNumber('2024.05.??')).toBe(20240500);
    expect(dateNumber('????.??.??')).toBe(0);
    expect(dateNumber(undefined)).toBe(0);
  });
});

describe('exporting a PGN', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gamesdb-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const game = (h: Record<string, string>, moves: string) =>
    Object.entries(h)
      .map(([k, v]) => `[${k} "${v}"]`)
      .join('\n') + `\n\n${moves}\n`;

  it('writes the manifest, name index and buckets per the spec', async () => {
    const pgn = [
      game({ Event: 'Marshall CC IM Norm', Date: '2024.05.03', White: 'Iinuma, Paul Y', Black: 'Smith, Anna', Result: '1-0', WhiteElo: '2290', BlackElo: '2210', WhiteFideId: '2088123', TimeControl: '5400+30' }, '1. e4 c5 2. Nf3 d6 1-0'),
      game({ Event: 'US Open', Date: '2025.08.??', White: 'Lee, Ann', Black: 'Iinuma, Paul Y', Result: '1/2-1/2' }, '1. d4 {a comment} Nf6 (1... d5) 2. c4 e6 1/2-1/2'),
      game({ Event: '?', Date: '????.??.??', White: 'Paul Iinuma', Black: 'Kim, Bo', Result: '0-1' }, '1. c4 e5 0-1'),
      game({ Event: 'Odds', White: 'A', Black: 'B', Result: '*', SetUp: '1', FEN: '8/8/8/8/8/8/8/K6k w - - 0 1' }, '1. Kb1 *'),
      game({ Event: 'Empty', White: 'C', Black: 'D', Result: '*' }, '*'),
    ].join('\n');
    writeFileSync(join(dir, 'in.pgn'), pgn);
    const out = join(dir, 'dist');
    const logs: string[] = [];
    const m = await runExport({ inputs: [join(dir, 'in.pgn')], out, release: '2026-11-02', log: (s) => logs.push(s) });

    expect(m).toMatchObject({ format: 1, release: '2026-11-02', games: 3, players: 5, buckets: 8192, maxPlies: 60 });
    expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).games).toBe(3);
    expect(logs.join('\n')).toMatch(/2 skipped/);

    const read = <T,>(p: string) => JSON.parse(gunzipSync(readFileSync(join(out, p))).toString('utf8')) as T;
    // Name index: in the shard of every word; totals, years and FIDE id.
    const ii = read<NameEntry[]>('names/ii.bin');
    expect(ii.find((e) => e[0] === 'Iinuma, Paul Y')).toEqual(['Iinuma, Paul Y', 5290257001642107, 2, 2024, 2025, 2088123]);
    expect(ii.find((e) => e[0] === 'Paul Iinuma')).toEqual(['Paul Iinuma', 8114831744130966, 1, 0, 0, 0]);
    expect(read<NameEntry[]>('names/pa.bin').map((e) => e[0]).sort()).toEqual(['Iinuma, Paul Y', 'Paul Iinuma']);
    expect(matchNames(ii, 'paul iinuma').map((e) => e[0])).toEqual(['Iinuma, Paul Y', 'Paul Iinuma']);

    // His bucket: both games, newest first, from his side.
    const bucket = read<GameBucket>(`games/${5290257001642107 % 8192}.bin`);
    const games = bucketGames(bucket, ['Iinuma, Paul Y', 5290257001642107], '2026-11-02');
    expect(games.map((g) => [g.white, g.black, g.userColor, g.result, g.event, g.sans.join(' ')])).toEqual([
      ['Lee, Ann', 'Iinuma, Paul Y', 'black', '1/2-1/2', 'US Open', 'd4 Nf6 c4 e6'],
      ['Iinuma, Paul Y', 'Smith, Anna', 'white', '1-0', 'Marshall CC IM Norm', 'e4 c5 Nf3 d6'],
    ]);
    expect(games[1]).toMatchObject({ whiteElo: 2290, blackElo: 2210, timeClass: 'classical' });
    // Unknown event / date stay unknown; skipped games aren't anywhere.
    const paul = bucketGames(read<GameBucket>(`games/${8114831744130966 % 8192}.bin`), ['Paul Iinuma', 8114831744130966], 'x');
    expect(paul[0]).toMatchObject({ event: undefined, playedAt: 0, result: '0-1' });
    const all = readdirSync(join(out, 'games')).flatMap((f) => Object.keys(read<GameBucket>(`games/${f}`).players));
    expect(all).toHaveLength(5);
    expect(readdirSync(out).sort()).toEqual(['games', 'manifest.json', 'names']);
  });
});
