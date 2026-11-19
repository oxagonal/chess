# Chess Prep

A local-first opening trainer in the spirit of Chessbook / Chessable / ChessReps:

- **Chapters and repertoires** — your openings are *chapters* (one color's move tree from move 1, e.g.
  "Italian" or "Caro-Kann, Exchange"). Training progress belongs to positions, not chapters: a move that's in
  several chapters is one card, learned once. A *repertoire* is a saved set of chapters (say an Exchange
  Caro-Kann and an Italian for one tournament) that you can train, measure and check — it says where its
  chapters give you different moves in the same position. Train all of a color, a repertoire or one chapter.
- **Map** — its own tab, for all of a color, a repertoire or one chapter, organized by the questions it
  answers. *How ready am I?* One bar of all your games: your lines by how well you know their weakest move
  (not learned, missed last time, learning, growing, solid), the games your lines don't cover (they leave
  them while still more common than your coverage target), and the *rare sidelines* (opponent moves rarer
  than the target, which stay outside your prep even with every gap filled) — with the Coverage run's
  target and Run button under it. *What next?* To-dos with one action each: review what's due, prepare the
  gaps, drill your weakest moves. *Where?* Each chapter as a strip of its lines, as wide as they come up
  (hover a line for its position and status, and practice it). *Details*, on demand: how the coverage
  numbers come about, the positions worth knowing cold, and your lines as a tree with accuracy, recall and
  slips in games. How well you know something is always the same strength bands.
- **Split into chapters** — a chapter's ⋯ menu suggests chapters from the opening names of its lines (by
  position, so transposed move orders land together); rename, merge or leave out suggestions first.
- **Import wizard** — Repertoire → *Import a Lichess study or PGN*: study chapters become chapters (or go into
  existing ones), opponent replies rarer than 1 in N can be trimmed, and every position where the study gives
  you more than one move is shown on a board, with explorer stats, to keep one, some or all.
- **Repertoire builder** — build White and Black repertoires move by move on the board, with the Lichess
  opening explorer (at *your* rating), the masters database and your own games alongside. Positions are
  merged by FEN, so transpositions are handled automatically. A live **coverage score** shows, for the
  position you're on (the start position or any move you click), the share of games reaching it that stay
  inside your prep until positions get rarer than 1 in N games — with a score per reply, recalculated as
  you edit. Import PGN (with variations and comments),
  `.pgn` files or public Lichess studies; export back to PGN.
- **Game review** — each game opens in the same dockable studio as the builder: board with both clocks,
  Stockfish, the game's moves as a scoresheet (always the game itself, with each move's clock), and a
  computer review (eval graph, your three biggest mistakes and your opponent's). Right-click a move — or
  long-press it on a phone or iPad — to annotate it like a Lichess study (!!, !, !?, ?!, ?, ??, □, ±, N…, a
  comment). Annotations and the analysis are saved with the game (an interrupted analysis continues).
- **On a phone** the builder and the game review work like the Lichess and Chess.com apps: Stockfish sits
  at the top (switch it on or off there — phones keep their own engine settings, e.g. fewer lines), the
  board stays on screen, the moves, explorer, computer review and the rest are tabs under it (each
  scrolling in its own box), and the move buttons sit at the bottom. Drag the grip under the board to make it
  smaller (an evaluation bar appears beside it); in a review, where the game left your prep pops up at that move.
- **Players** — a tab next to the explorer in the builder for scouting opponents: save a player with their
  Lichess / Chess.com usernames (their games since a date you choose, or all of them, in the time controls you pick, are downloaded and cached on the device) or just a name
  (your over-the-board games against them, plus any PGN you paste), or find them by name in the
  **over-the-board games database** (13 million games from Lumbra's Gigabase, exported and deployed as a
  separate static site — see `gamesdb/SPEC.md`), and see what they play in the position you're on.
- **Explorer columns** — the explorer's ⚙ picks its columns (games, %, 1 in N, Stockfish eval, result, last
  played; saved with your settings, so they sync). In *My games* and *Players* each move shows when it was
  last played, and 🔍 lists the games behind a move or the position (any move order) on the Games tab.
- **Spaced repetition** — every one of your moves is a card scheduled with [FSRS](https://github.com/open-spaced-repetition/ts-fsrs).
  *Learn* shows new lines and then has you replay them from memory; *Review* plays each due position out
  from the starting position (opponent moves and moves that aren't due are played for you) and asks only
  for the due moves. A wrong move snaps back and you retry **right there** — the line never restarts. A
  second miss shows the answer as an arrow. An **answer timer** (⚙ in a session, or Settings → Training; 10 s by
  default, 0 turns it off) grades how quickly you find each move in reviews and drills: in time is Good, slower
  Hard — so ones you dig for come back sooner. Easy (which FSRS rewards with a much longer interval) is kept for
  moves you play at once — in the first quarter of the time, 2 s at most — that are already in regular reviews
  and that you didn't miss last time; never right after a miss or while a move is still being learned.
- **Coverage — "1 in N games"** (on the Map) — assuming you play your prep and opponents answer like players
  at your rating, how often does each position appear? Finds the opponent moves you'll face at least once
  every N games that your repertoire doesn't answer (*gaps*), positions where it's your move with nothing
  prepared, and the positions worth knowing cold. A color's run measures each of its chapters too (another
  chapter's answer to a move counts); a repertoire has its own. Optionally restrict training to positions
  above the threshold.
- **Games** — downloads your Lichess and Chess.com games (incrementally), and takes **over-the-board games** you
  enter (play the moves on a board, or paste PGN — a multi-game PGN is matched to your name) and checks each one against your
  repertoires: where *you* left your prep ("forgot prep"), where the *opponent* did (gaps), or where the
  line simply ended. Forgotten moves can be sent straight back into review; opponent surprises open the
  builder at that position so you can prepare an answer.
- **Weakest moves** (on the Map) — your learned moves ranked by strength band and, within one, by a blend
  of training accuracy, FSRS recall and difficulty, and slips in real games; *Drill* practices any line or
  your weakest moves on demand.

- **Sync between devices** — optional: keep your phone and computer in step through a secret gist in your
  own GitHub account (see below).

All data lives in your browser (IndexedDB). Nothing is uploaded anywhere unless you turn on sync, and then
only to your own GitHub gist; usernames are only sent to lichess.org / chess.com to download your games.
Use **Settings → Export backup** to keep a copy.

## Running it

Requires Node 20+.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (vitest)
npm run build      # static site in dist/ — host anywhere (GitHub Pages, Netlify, a USB stick…)
```

## Putting it online (and on your phone)

It's a static site, hosted on **Cloudflare** (Workers static assets, free plan) at
**https://chess.oxagon.workers.dev**. One-time setup in the Cloudflare dashboard:
**Workers & Pages → Create → Import a repository** → pick this repo, then

- **Project name:** `chess` (pre-filled from `wrangler.jsonc`; it becomes the first part of the address)
- **Production branch:** `main`
- **Build command:** `npm run build`
- **Deploy command:** `npx wrangler deploy` (the default)

`wrangler.jsonc` tells Cloudflare to serve `dist/`; `public/_headers` sets caching so a new deploy reaches
phones right away. Node 22 is pinned in `.node-version`. Every push to `main` deploys automatically; other
branches get their own preview URL. No rewrite rules are needed because the app uses `#/` URLs. The bottom
of Settings shows which version (commit) is live.

For a shorter address, change your account's `workers.dev` subdomain (Workers & Pages → *Account details*
→ *Subdomain*); it's free.

On the phone, open the site and install it:

- **iPhone (Safari):** Share → *Add to Home Screen*
- **Android (Chrome):** ⋮ → *Install app* / *Add to Home screen*

It then opens full-screen with its own icon and works offline for training (game sync, the explorer and
coverage need a connection). Its icon can show how many moves are due (Settings → Training → *Show due moves on
the app icon*): iPhone and iPad only show a web app's number once it may send notifications — Chess Prep
never sends any, and the number is updated whenever the app is open.

**Moving to a new address:** browsers keep the data per website, so the new
site starts empty. Turn on sync (below) on the old site, then connect the new site with the same token — or
use Settings → Export backup on the old site and Restore backup on the new one. Re-add the home-screen app
from the new URL.

### Syncing your phone and computer

Each device has its own copy of your data; **Settings → Connections → Sync between devices** keeps them in step. There's
no server to run — the data goes to a secret gist in your GitHub account:

1. Create a GitHub token with only the **gist** permission (the link in Settings pre-fills it; choose *No
   expiration*).
2. Paste it into Settings → Connections → Sync between devices on your computer and press **Connect**.
3. Do the same on your phone, with the same token (*Copy token for another device* helps).

Repertoires, notes, training progress and history, games, coverage results and settings sync — your
Lichess API token stays on each device. It syncs when the app opens, a few seconds after you change
something, when you switch away from the app, and every minute while it's open if another device has
synced. Changes merge record by record (the newer edit of each move/card wins; deletions carry over), so
training on both devices between syncs loses nothing. With sync on, **Restore backup** and **Delete all
data** apply to every device.

## Where the probabilities come from

| Source | Notes |
| --- | --- |
| **Lichess games at your rating** (default) | `explorer.lichess.org` — needs **Settings → Connections → Connect Lichess** (Lichess requires a login for the explorer since 2026; no permissions are requested). Filtered by rating band(s) and time controls. Requests are serialised, cached for 30 days in IndexedDB, and back off for a minute on HTTP 429, per Lichess API etiquette. |
| **Your own opponents** | Built from your imported Lichess + Chess.com games — what people actually play against *you*. Small samples are noisy, but it's very personal. |
| **Masters** | Lichess masters database. |

Chess.com doesn't publish an opening-explorer API, so Chess.com ratings are converted to the
equivalent Lichess rating (approximate formula in `src/lib/ratings.ts`) to pick explorer bands. You can
also pick bands manually in Settings, or use "your own opponents" as the source.

## Project layout

```
src/
  lib/            pure logic, unit-tested (no DOM, no DB)
    chess.ts        position keys (FEN minus clocks, legal-ep only), SAN/UCI helpers on top of chessops
    graph.ts        RepGraph: repertoire as a position graph (paths, topo order, orphans)
    pgn.ts          PGN ⇄ repertoire edges (variations, comments)
    srs.ts          FSRS wrapper, retrievability, difficulty labels
    trainer.ts      plans each training line (what to auto-play, what to ask)
    coverage.ts     "1 in N" reach-probability analysis
    prep.ts         compares games with repertoires (forgot prep / opponent left book / end of prep)
    insights.ts     mastery scores per move and per line
    mygames.ts      opening explorer built from your games
    importers/      Lichess NDJSON + Chess.com archive parsers/downloaders
    syncMerge.ts    merges two copies of the database row by row (device sync)
  db/             Dexie (IndexedDB) schema, settings, repertoire mutations, change stamps for sync
  services/       network + persistence glue: explorer cache, game sync, coverage runner, backup,
                  device sync (cloudSync.ts) over a GitHub gist (gist.ts)
  components/     chessground Board, explorer panel, small UI pieces
  pages/          one component per tab
  App.tsx         tab registry + hash router
```

### Adding a tab (e.g. engine-powered game review)

Tabs are registered in the `TABS` array in `src/App.tsx`; add a page component under `src/pages` and an
entry there. Games are stored with full move lists and, when available, clock times (`StoredGame.clocks`),
and `GameViewer` in `src/pages/Games.tsx` already replays games on a board — a Stockfish (WASM) review
would plug into that viewer or a new `review` tab.

## License & credits

Designed by oxagonal and built together with [Claude](https://claude.com/claude-code), Anthropic's AI coding
assistant.

Chess Prep is free software, licensed under the **GNU GPL v3 or later** (see `LICENSE`); the app shows the
notice, the license and a link to this repository under Settings → About & credits.

Board: [chessground](https://github.com/lichess-org/chessground); chess logic:
[chessops](https://github.com/niklasf/chessops); engine: [Stockfish](https://github.com/nmrugg/stockfish.js)
(all GPL-3.0). Piece images: Colin M.L. Burnett (GPL-2.0-or-later). Scheduling:
[ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) (MIT); storage: Dexie (Apache-2.0); UI: React (MIT);
font: Inter (OFL). Opening names: [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)
(public domain / CC0), in `src/data/openings.json` (rebuilt by `scripts/openings-from-lichess.mjs`).
