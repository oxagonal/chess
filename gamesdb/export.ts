/**
 * Exports Lumbra's Gigabase into the static games database described in SPEC.md — run on your
 * computer, from the PGN download or the Scid 5 download (.si5, read by gamesdb/scid5.py — needs
 * Python 3 with python-chess):
 *
 *   npm run export:gamesdb -- --release 2026-11-02 path/to/LumbrasGigaBase_OTB.pgn [more.pgn …]
 *   npm run export:gamesdb -- --release 2026-11-11 path/to/LumbrasGigaBase_OTB.si5
 *
 * One streaming pass over the PGN writes every game (twice, once per player) into 256 temporary
 * files by bucket; a second pass turns each into the final bucket files; then the name index.
 * Memory stays small apart from the per-name totals (~860,000 names).
 */
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { Chess } from 'chessops/chess';
import { parseSan } from 'chessops/san';
import { stdUci } from '../src/lib/chess';
import { GAMESDB_FORMAT, MAX_PLIES, nameTokens, shardKey, type GameBucket, type GamesDbManifest, type NameEntry } from '../src/lib/gamesdb';

export const BUCKETS = 8192;
const SUPER = 256;
const FLUSH_BYTES = 96 * 1024 * 1024;

/** 53-bit id from the exact name (stable across releases). */
export function playerId(name: string): number {
  return Number(createHash('sha1').update(name, 'utf8').digest().readBigUInt64BE(0) >> 11n);
}

const PROMOS = ['q', 'n', 'b', 'r'];
const sq = (name: string) => name.charCodeAt(0) - 97 + (name.charCodeAt(1) - 49) * 8;

/** The first MAX_PLIES moves of a game's SAN tokens, encoded per SPEC.md; stops at an illegal move. */
export function encodeSans(sans: readonly string[]): { mv: string; plies: number } {
  const pos = Chess.default();
  const bytes = Buffer.alloc(Math.min(sans.length, MAX_PLIES) * 2);
  let n = 0;
  for (const raw of sans) {
    if (n >= MAX_PLIES) break;
    const move = parseSan(pos, raw);
    if (!move || !('from' in move)) break;
    const uci = stdUci(pos, move);
    bytes[n * 2] = sq(uci);
    bytes[n * 2 + 1] = sq(uci.slice(2)) | ((uci.length > 4 ? PROMOS.indexOf(uci[4]) : 0) << 6);
    pos.play(move);
    n++;
  }
  return { mv: bytes.subarray(0, n * 2).toString('base64url'), plies: n };
}

/** The same encoding from UCI moves (e2e4, e1g1, e7e8q) — what the Scid 5 reader gives. */
export function encodeUcis(ucis: readonly string[]): { mv: string; plies: number } {
  const n = Math.min(ucis.length, MAX_PLIES);
  const bytes = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const u = ucis[i];
    bytes[i * 2] = sq(u);
    bytes[i * 2 + 1] = sq(u.slice(2)) | ((u.length > 4 ? PROMOS.indexOf(u[4]) : 0) << 6);
  }
  return { mv: bytes.toString('base64url'), plies: n };
}

const RESULT_TOKENS = new Set(['1-0', '0-1', '1/2-1/2', '½-½', '*']);

/** SAN tokens of a PGN game's main line (comments, variations, NAGs, numbers and the result removed). */
export function movetextSans(text: string, max = MAX_PLIES): string[] {
  const out: string[] = [];
  let depth = 0;
  let token = '';
  const flush = () => {
    if (token) {
      const t = token
        .replace(/^\d+\.+/, '')
        .replace(/[!?]+$/, '')
        .replace(/^0-0-0/, 'O-O-O')
        .replace(/^0-0/, 'O-O');
      if (t && !RESULT_TOKENS.has(t) && !/^\d+\.*$/.test(t) && !t.startsWith('$')) out.push(t);
    }
    token = '';
  };
  for (let i = 0; i < text.length && out.length < max; i++) {
    const ch = text[i];
    if (ch === '{') {
      flush();
      const end = text.indexOf('}', i);
      i = end < 0 ? text.length : end;
    } else if (ch === ';') {
      flush();
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
    } else if (ch === '(') {
      flush();
      depth++;
    } else if (ch === ')') {
      flush();
      depth = Math.max(0, depth - 1);
    } else if (depth > 0) {
      continue;
    } else if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
      flush();
    } else token += ch;
  }
  flush();
  return out.slice(0, max);
}

/** "2024.05.??" → 20240500; unknown year → 0. */
export function dateNumber(raw: string | undefined): number {
  const m = raw?.match(/^(\d{4}|\?{4})[.\-/](\d{2}|\?\?)[.\-/](\d{2}|\?\?)/);
  if (!m || m[1].startsWith('?')) return 0;
  return Number(m[1]) * 10000 + (Number(m[2]) || 0) * 100 + (Number(m[3]) || 0);
}

const RESULT_CODE: Record<string, 0 | 1 | 2 | 3> = { '*': 0, '1-0': 1, '0-1': 2, '1/2-1/2': 3 };

interface Totals {
  games: number;
  first: number;
  last: number;
  fide?: Map<number, number>;
}

interface Pgn {
  headers: Record<string, string>;
  movetext: string;
  /** Main-line moves already in UCI (the Scid 5 reader) — used instead of movetext. */
  ucis?: string[];
}

/**
 * Streams the games of a Scid 5 database (base.si5 / .sn5 / .sg5) through gamesdb/scid5.py, which
 * prints one JSON line per game: [white, black, date, result, event, tc, whiteElo, blackElo,
 * whiteFideId, blackFideId, "uci uci …"].
 */
export async function* readScid5(si5: string, log: (msg: string) => void, onGame?: () => void, sinceYear?: number): AsyncGenerator<Pgn> {
  const base = si5.replace(/\.si5$/i, '');
  const script = join(dirname(fileURLToPath(import.meta.url)), 'scid5.py');
  const args = ['-I', script, base];
  if (process.env.GAMESDB_WORKERS) args.push('--workers', process.env.GAMESDB_WORKERS);
  if (process.env.GAMESDB_LIMIT) args.push('--limit', process.env.GAMESDB_LIMIT); // trial runs: the first N games
  // Older games are dropped by the reader before it decodes them (the exporter checks again anyway).
  if (sinceYear) args.push('--since', String(sinceYear));
  const child = spawn(process.env.PYTHON ?? 'python', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  createInterface({ input: child.stderr }).on('line', (line) => log(`  ${line}`));
  const exited = new Promise<number>((res, rej) => {
    child.on('error', rej);
    child.on('close', (code) => res(code ?? 1));
  });
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    if (!line) continue;
    const [white, black, date, result, event, tc, we, be, wf, bf, moves] = JSON.parse(line) as [string, string, string, string, string, string, number, number, string, string, string];
    onGame?.();
    yield {
      headers: { White: white, Black: black, Date: date, Result: result, Event: event, TimeControl: tc, WhiteElo: String(we), BlackElo: String(be), WhiteFideId: wf, BlackFideId: bf },
      movetext: '',
      ucis: moves ? moves.split(' ') : [],
    };
  }
  const code = await exited;
  if (code !== 0) throw new Error(`gamesdb/scid5.py exited with code ${code}`);
}

/** Streams the games of a PGN file. */
export async function* readPgnFile(path: string, onBytes?: (n: number) => void): AsyncGenerator<Pgn> {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 });
  if (onBytes) stream.on('data', (chunk) => onBytes(Buffer.byteLength(chunk as string)));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let headers: Record<string, string> = {};
  let moves: string[] = [];
  let inMoves = false;
  for await (const line of lines) {
    if (line.startsWith('[')) {
      if (inMoves) {
        yield { headers, movetext: moves.join('\n') };
        headers = {};
        moves = [];
        inMoves = false;
      }
      const m = line.match(/^\[(\w+)\s+"((?:[^"\\]|\\.)*)"\s*\]/);
      if (m) headers[m[1]] = m[2].replace(/\\(["\\])/g, '$1');
    } else if (line.trim()) {
      inMoves = true;
      moves.push(line);
    }
  }
  if (Object.keys(headers).length || moves.length) yield { headers, movetext: moves.join('\n') };
}

export interface ExportOptions {
  inputs: string[];
  out: string;
  release: string;
  headersFile?: string;
  /** Leave out games from before this year (games with an unknown year are kept). */
  sinceYear?: number;
  log?: (msg: string) => void;
}

export async function runExport({ inputs, out, release, headersFile, sinceYear, log = console.log }: ExportOptions) {
  const tmp = join(out, '.tmp');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  mkdirSync(join(out, 'games'));
  mkdirSync(join(out, 'names'));

  const ids = new Map<string, number>();
  const owners = new Map<number, string>();
  const idOf = (name: string) => {
    let id = ids.get(name);
    if (id === undefined) {
      id = playerId(name);
      const other = owners.get(id);
      if (other !== undefined && other !== name) throw new Error(`Player id collision: "${name}" and "${other}"`);
      owners.set(id, name);
      ids.set(name, id);
    }
    return id;
  };
  const totals = new Map<string, Totals>();
  const tally = (name: string, year: number, fide: number) => {
    let t = totals.get(name);
    if (!t) totals.set(name, (t = { games: 0, first: 0, last: 0 }));
    t.games++;
    if (year) {
      t.first = t.first ? Math.min(t.first, year) : year;
      t.last = Math.max(t.last, year);
    }
    if (fide) {
      t.fide ??= new Map();
      t.fide.set(fide, (t.fide.get(fide) ?? 0) + 1);
    }
  };

  // ---------------------------------------------------------------- pass 1
  const buffers: string[][] = Array.from({ length: SUPER }, () => []);
  let buffered = 0;
  const flush = () => {
    buffers.forEach((lines, i) => {
      if (lines.length) appendFileSync(join(tmp, `${i}.ndjson`), lines.join('\n') + '\n');
      buffers[i] = [];
    });
    buffered = 0;
  };
  // Progress: PGN by bytes read; a Scid 5 database by games (56-byte index records).
  const totalBytes = inputs.reduce((s, f) => s + statSync(f).size, 0);
  let readBytes = 0;
  let games = 0;
  let skipped = 0;
  const started = Date.now();
  let lastLog = started;
  for (const file of inputs) {
    const source = /\.si5$/i.test(file) ? readScid5(file, log, () => (readBytes += 56), sinceYear) : readPgnFile(file, (n) => (readBytes += n));
    for await (const { headers: h, movetext, ucis } of source) {
      const white = h.White?.trim();
      const black = h.Black?.trim();
      if (!white || !black || white === '?' || black === '?' || h.FEN || (h.SetUp && h.SetUp !== '0')) {
        skipped++;
        continue;
      }
      const { mv, plies } = ucis ? encodeUcis(ucis) : encodeSans(movetextSans(movetext));
      if (!plies) {
        skipped++;
        continue;
      }
      const date = dateNumber(h.Date);
      const year = Math.floor(date / 10000);
      if (sinceYear && year && year < sinceYear) {
        skipped++;
        continue;
      }
      const r = RESULT_CODE[h.Result ?? '*'] ?? 0;
      const event = h.Event && h.Event !== '?' ? h.Event : '';
      const tc = h.TimeControl && h.TimeControl !== '?' && h.TimeControl !== '-' ? h.TimeControl : '';
      const we = Number(h.WhiteElo) || 0;
      const be = Number(h.BlackElo) || 0;
      for (const [me, opp, c, myElo, oppElo, fide] of [
        [white, black, 0, we, be, Number(h.WhiteFideId) || 0],
        [black, white, 1, be, we, Number(h.BlackFideId) || 0],
      ] as const) {
        const id = idOf(me);
        const bucket = id % BUCKETS;
        const line = JSON.stringify([bucket, id, c, opp, oppElo, myElo, date, r, event, tc, mv]);
        buffers[bucket % SUPER].push(line);
        buffered += line.length;
        tally(me, year, fide);
      }
      games++;
      if (buffered > FLUSH_BYTES) flush();
      if (Date.now() - lastLog > 10_000) {
        lastLog = Date.now();
        const rate = games / ((lastLog - started) / 1000);
        const eta = readBytes ? ((totalBytes - readBytes) / readBytes) * ((lastLog - started) / 1000) : 0;
        log(`  ${games.toLocaleString()} games (${Math.round(rate).toLocaleString()}/s), ${((100 * readBytes) / totalBytes).toFixed(1)}% read, ~${Math.ceil(eta / 60)} min left`);
      }
    }
  }
  flush();
  log(`Read ${games.toLocaleString()} games (${skipped.toLocaleString()} skipped: set-up positions, no moves, no names or older than --since); ${totals.size.toLocaleString()} players.`);

  // ---------------------------------------------------------------- pass 2: buckets
  let biggest = 0;
  let files = 0;
  for (let s = 0; s < SUPER; s++) {
    const path = join(tmp, `${s}.ndjson`);
    if (!existsSync(path)) continue;
    const byBucket = new Map<number, Map<number, unknown[][]>>();
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      const [bucket, id, ...entry] = JSON.parse(line) as [number, number, ...unknown[]];
      let players = byBucket.get(bucket);
      if (!players) byBucket.set(bucket, (players = new Map()));
      let list = players.get(id);
      if (!list) players.set(id, (list = []));
      list.push(entry);
    }
    unlinkSync(path);
    for (const [bucket, players] of byBucket) {
      const events: string[] = [];
      const tcs: string[] = [];
      const evIdx = new Map<string, number>();
      const tcIdx = new Map<string, number>();
      const index = (s: string, list: string[], map: Map<string, number>) => {
        if (!s) return -1;
        let i = map.get(s);
        if (i === undefined) map.set(s, (i = list.push(s) - 1));
        return i;
      };
      const content: GameBucket = { events, tcs, players: {} };
      for (const [id, list] of [...players].sort((a, b) => a[0] - b[0])) {
        // newest first, unknown dates last
        list.sort((a, b) => ((b[4] as number) || -1) - ((a[4] as number) || -1));
        content.players[String(id)] = list.map(([c, opp, oppElo, myElo, date, r, event, tc, mv]) => [
          c as 0 | 1,
          opp as string,
          oppElo as number,
          myElo as number,
          date as number,
          r as 0 | 1 | 2 | 3,
          index(event as string, events, evIdx),
          index(tc as string, tcs, tcIdx),
          mv as string,
        ]);
      }
      const data = gzipSync(JSON.stringify(content), { level: 9 });
      if (data.length > 20 * 1024 * 1024) throw new Error(`games/${bucket}.bin is ${(data.length / 1e6).toFixed(1)} MB — over the 20 MB safety limit`);
      biggest = Math.max(biggest, data.length);
      writeFileSync(join(out, 'games', `${bucket}.bin`), data);
      files++;
    }
    if (s % 32 === 31) log(`  buckets: ${Math.round(((s + 1) / SUPER) * 100)}%`);
  }
  rmSync(tmp, { recursive: true, force: true });

  // ---------------------------------------------------------------- names
  const shards = new Map<string, NameEntry[]>();
  for (const [name, t] of totals) {
    let fide = 0;
    let best = 0;
    for (const [id, n] of t.fide ?? []) if (n > best) [fide, best] = [id, n];
    const entry: NameEntry = [name, ids.get(name)!, t.games, t.first, t.last, fide];
    for (const key of new Set(nameTokens(name).map(shardKey))) {
      let list = shards.get(key);
      if (!list) shards.set(key, (list = []));
      list.push(entry);
    }
  }
  for (const [key, list] of shards) {
    list.sort((a, b) => b[2] - a[2] || (a[0] < b[0] ? -1 : 1));
    const data = gzipSync(JSON.stringify(list), { level: 9 });
    if (data.length > 20 * 1024 * 1024) throw new Error(`names/${key}.bin is over 20 MB`);
    biggest = Math.max(biggest, data.length);
    writeFileSync(join(out, 'names', `${key}.bin`), data);
    files++;
  }

  const manifest: GamesDbManifest = {
    format: GAMESDB_FORMAT,
    source: "Lumbra's Gigabase (OTB)",
    sourceUrl: 'https://lumbrasgigabase.com',
    license: 'CC BY-NC 4.0',
    release,
    games,
    players: totals.size,
    buckets: BUCKETS,
    maxPlies: MAX_PLIES,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (headersFile) copyFileSync(headersFile, join(out, '_headers'));
  log(`Wrote ${files + 2} files to ${out} (largest ${(biggest / 1e6).toFixed(1)} MB) in ${Math.round((Date.now() - started) / 1000)} s.`);
  return manifest;
}

// ---------------------------------------------------------------- command line
const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const release = opt('--release');
  const out = opt('--out') ?? join(here, 'dist');
  const since = opt('--since');
  if (!release || !args.length) {
    console.error(
      'Usage: npm run export:gamesdb -- --release <Gigabase version, e.g. 2026-11-02> [--since <year>] [--out gamesdb/dist] <file.pgn> [more.pgn …]',
    );
    process.exit(1);
  }
  runExport({ inputs: args, out, release, sinceYear: since ? Number(since) : undefined, headersFile: join(here, '_headers') }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
