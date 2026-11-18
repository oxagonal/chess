// Builds src/data/openings.json from the Lichess opening names (github.com/lichess-org/chess-openings,
// public domain / CC0): node scripts/openings-from-lichess.mjs <folder with a.tsv … e.tsv>
// Each entry is [name, "e4 c5 Nf3 …", eco]; the app replays them to name positions (by position, so a
// transposition gets the name of where it lands).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node scripts/openings-from-lichess.mjs <dir>');
const out = [];
for (const f of ['a', 'b', 'c', 'd', 'e']) {
  const lines = readFileSync(join(dir, `${f}.tsv`), 'utf8').split('\n').slice(1);
  for (const line of lines) {
    const [eco, name, pgn] = line.split('\t');
    if (!name || !pgn) continue;
    const sans = pgn
      .trim()
      .split(/\s+/)
      .filter((t) => !/^\d+\.+$/.test(t))
      .join(' ');
    out.push([name, sans, eco]);
  }
}
writeFileSync(new URL('../src/data/openings.json', import.meta.url), JSON.stringify(out));
console.log(`${out.length} openings`);
