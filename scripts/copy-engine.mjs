// Copies the Stockfish (lite, single-threaded WASM) engine from node_modules into public/engine
// so Vite serves it as a static file. Runs before `npm run dev` and `npm run build`.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'stockfish', 'bin');
const dest = join(root, 'public', 'engine');
mkdirSync(dest, { recursive: true });
for (const f of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm']) {
  copyFileSync(join(src, f), join(dest, f));
}
console.log('Stockfish engine copied to public/engine');
