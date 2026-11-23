# Tabiya

A local-first opening trainer in the spirit of Chessbook / Chessable / ChessReps:

- **Chapters and repertoires** — your openings are *chapters* (one color's move tree from move 1, e.g.
  "Italian" or "Caro-Kann, Exchange"). Training progress belongs to positions, not chapters: a move that's in
  several chapters is one card, learned once. A *repertoire* is a saved set of chapters (say an Exchange
  Caro-Kann and an Italian for one tournament) that you can train, measure and check — it says where its
  chapters give you different moves in the same position. Train all of a color, a repertoire or one chapter.
- **Repertoire tab** — all your opening stuff in one place: your chapters, training them and where you
  stand, for all of a color, a repertoire or one chapter, organized by the questions it answers. *Today*, across everything: what's due, what's new within your
  daily limit, what you learned today, Review / Learn all of it, and "only train likely positions". *How ready am I?* One bar of all your games: your lines by how well you know their weakest move
  (not learned, missed last time, learning, growing, solid), the games your lines don't cover (they leave
  them while still more common than your coverage target), and the *rare sidelines* (opponent moves rarer
  than the target that leave your lines before they reach your target depth, which stay outside your prep
  even with every gap filled; games that reach your target depth count as your lines) — with the Coverage run's
  target and Run button under it. *What next?* To-dos with one action each: review what's due, prepare the
  gaps, drill your weakest moves. *Where?* Each chapter as a strip of its lines, as wide as they come up
  (hover a line for its position and status, and practice it), with its Review / Learn / Drill buttons and a
  ⋯ menu to edit, split, merge, import into, export, rename or delete it; plus New chapter, Import, Open all
  (a color's chapters as one tree in the builder) and your repertoires. *Details*, on demand: how the coverage
  numbers come about, the positions worth knowing cold, and your lines as a tree with accuracy, recall and
  slips in games. How well you know something is always the same strength bands.
- **Plan tab: the 1/3 rule** (Noël Studer) — training time split evenly between tactics, your games (playing
  and reviewing them) and study (one topic at a time; openings at most a third — a warning says when they take
  more). Time is recorded as you use the app (training, the builder, game review, puzzles — only while it's on
  screen and you're using it), games you play count from their clocks (the speeds you choose), and time away
  from the app is logged by hand. Today, this week, last week or 30 days against your weekly hours (today:
  against what your week plan has for today, by third, else a seventh of the week), what's furthest
  behind with a button to it, and your week's plan: slots with a day, time, third and the exact task. The
  games bar shows playing and reviewing side by side, with how many of your games you've reviewed (the goal
  is all of them), a link to the latest one that isn't, and a warning once 3 are waiting.
- **Split into chapters** — a chapter's ⋯ menu suggests chapters from the opening names of its lines (by
  position, so transposed move orders land together); rename, merge or leave out suggestions first.
- **Import wizard** — Repertoire → *Import a Lichess study or PGN*: study chapters become chapters (or go into
  existing ones), opponent replies rarer than 1 in N can be trimmed, and every position where the study gives
  you more than one move — or a different move from one of your other chapters (a clash with your prep, found
  by position, transpositions too) — is shown on a board, with explorer stats, to keep one, some or all.
- **Repertoire builder** — build White and Black repertoires move by move on the board, with the Lichess
  opening explorer (at *your* rating), the masters database and your own games alongside. Positions are
  merged by FEN, so transpositions are handled automatically — and when a line you add to one chapter goes
  into another chapter's own part of the tree (a transposition, or simply the wrong chapter), the builder
  asks whether to carry on in that chapter instead, and says so while you're on such a position. A live **coverage score** shows, for the
  position you're on (the start position or any move you click), the share of games reaching it that stay
  inside your prep until positions get rarer than 1 in N games — with a score per reply, recalculated as
  you edit. Import PGN (with variations and comments),
  `.pgn` files or public Lichess studies; export back to PGN.
- **Game review** — each game opens in the same dockable studio as the builder: board with both clocks,
  Stockfish, the game's moves as a scoresheet (always the game itself, with each move's clock), and a
  computer review (eval graph, your three biggest mistakes and your opponent's, and the missed tactics:
  a winning move that stood out above the second best — it looks at two lines per position — that you
  didn't play, and your blunders they let you off). Right-click a move — or
  long-press it on a phone or iPad — to annotate it like a Lichess study (!!, !, !?, ?!, ?, ??, □, ±, N…, a
  comment) — or, on a line you tried, to delete it and what follows (in the builder, the same menu deletes a
  move from your repertoire). Annotations and the analysis are saved with the game (an interrupted analysis
  continues). What the Stockfish box finds as you go through the game is kept too: where it searched deeper
  than the computer review, its evaluation replaces the review's — the move list, the ?/?? marks, the
  graph and the biggest mistakes then match it — and without a computer review, the positions you've looked
  at get evaluations all the same (its second line too). "Done reviewing" turns your mistakes — the crucial
  swings, the missed tactics, your blunders they let you off, and the moves you marked ? or ?? yourself —
  into puzzles that come back spaced (see Puzzles).
- **On a phone** the builder and the game review work like the Lichess and Chess.com apps: Stockfish sits
  at the top (switch it on or off there — phones keep their own engine settings, e.g. fewer lines), the
  board stays on screen, the moves, explorer, computer review and the rest are tabs under it (each
  scrolling in its own box), and the move buttons sit at the bottom. Drag the grip under the board to make it
  smaller (an evaluation bar appears beside it); in a review, where the game left your prep pops up at that move.
  Training and puzzles on a phone have the same grip under the board. Settings → Right thumb puts the main
  buttons of the bottom row on the right (Continue, Show move, Check, Next; the arrows in the builder).
  Arrows and circles work as in the Lichess app: keep one finger on the board and drag another (a tap with
  it draws a circle; a tap on an empty square clears them; it can be turned off in Settings).
- **Players** — a tab next to the explorer in the builder for scouting opponents: save a player with their
  Lichess / Chess.com usernames (their games since a date you choose, or all of them, in the time controls you pick, are downloaded and cached on the device) or just a name
  (your over-the-board games against them, plus any PGN you paste), or find them by name in the
  **over-the-board games database** (13 million games from Lumbra's Gigabase, exported and deployed as a
  separate static site — see `gamesdb/SPEC.md`), and see what they play in the position you're on.
- **Explorer columns** — the explorer's ⚙ picks its columns (games, %, 1 in N, Stockfish eval, result, last
  played; saved with your settings, so they sync). In *My games* and *Players* each move shows when it was
  last played, and 🔍 lists the games behind a move or the position (any move order) on the Games tab.
  Badges: ⚡ on a reply after which only one or two of your moves hold (a sharp line), and ↻ on your usual
  move — what you answer their last move with elsewhere (…Bg4 → h3), else a move you play in several
  other positions — when it's about as good as the best here.
- **Plans at line ends** — what you're aiming for once the moves run out (pawn breaks, where the pieces go,
  the typical tactic). At the end of a line the builder asks for one under the moves (with the master games
  from there, for ideas); a plan written earlier on the line covers the ends within 5 moves of it, and one
  further back can be confirmed with "Still applies". Moves with a plan get a ◆. The Repertoire tab lists
  the line ends still without a plan, likeliest first. Training: Learn shows where a new line is going up
  front, and at a line's end you say the plan to yourself before "Show the plan" (the line waits for
  Continue; ⚙ Recall plans turns it off) — or write one if it has none. Plans are found by position, so
  transposed lines share them, and go into PGN exports as "[Plan] …" comments (and come back on import).
- **Spaced repetition** — every one of your moves is a card scheduled with [FSRS](https://github.com/open-spaced-repetition/ts-fsrs),
  trained from the Repertoire tab (everything, a color, a repertoire or a chapter's row: Review, Learn, Drill).
  *Learn* shows new lines and then has you replay them from memory; *Review* plays each due position out
  from the starting position to the end of the branch (opponent moves are played for you; your other moves you
  play, ungraded) and grades only the due moves. A move on the way you haven't learned yet is taught right
  there — shown with an arrow, then replayed from memory once the line ends, like Learn. A wrong move snaps back and you retry **right there** — the line never restarts. A
  second miss shows the answer as an arrow. An **answer timer** (⚙ in a session, or Settings → Training; 10 s by
  default, 0 turns it off) grades how quickly you find each move in reviews and drills: in time is Good, slower
  Hard — so ones you dig for come back sooner. Easy (which FSRS rewards with a much longer interval) is kept for
  moves you play at once — in the first quarter of the time, 2 s at most — that are already in regular reviews
  and that you didn't miss last time; never right after a miss or while a move is still being learned.
- **Coverage — "1 in N games"** (on the Repertoire tab) — assuming you play your prep and opponents answer like players
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
- **Weakest moves** (on the Repertoire tab) — your learned moves ranked by strength band and, within one, by a blend
  of training accuracy, FSRS recall and difficulty, and slips in real games; *Drill* practices any line or
  your weakest moves on demand.

- **Puzzles** — Lichess puzzles, the tactics third of the 1/3 rule (openings · games and their review ·
  tactics): a healthy mix, from your own openings, or by theme, at the difficulty you pick. Set a time per
  puzzle (5 min by default) and pick puzzles hard enough that you solve about 70% within it (Nate Solon:
  5–10 minutes and ~70%; Noël Studer: go easier past 15 minutes or under 60%) — a quiet clock shows it,
  past it a nudge (never a penalty), and each block ends with how many you solved in time and a step easier
  or harder when that's off. By default you write your line to the end before anything is checked, without
  moving the pieces (Studer: "any solution not written down until the end is not correct"): the board stays
  on the puzzle while you tap or drag a move as things stand in your line, or type it; your line shows as
  numbered arrows; other replies are optional branches ("same answer to every king move / every other
  reply" in two clicks). If Lichess's line goes another way, it's played to that reply and you answer it on
  the board: find the rest and it's a soft pass (✓~), a wrong move a miss. Unchecking "Write the line first"
  gives move-by-move solving. Afterwards the puzzle is a small study: the game from move 1 with the players'
  names, titles and ratings, Stockfish, any move you like. After a miss: one tap for why (didn't see the
  move · missed their defence · miscalculated · misjudged the end · rushed), then you replay the solution
  yourself — your moves, their replies played for you, a hint arrow when you go wrong — before the next
  puzzle; doing it sticks better than watching it. The missed puzzle then comes back to solve again cold,
  spaced (the next day, then 3, 7 and 30 days), mixed into your blocks and never rated; solved twice in a
  row within your time, it's done. Your own games' mistakes join them (Nate Solon's spaced review of the
  positions where you went wrong): "Done reviewing" a game turns your mistakes into the same cards, of two
  kinds. A missed tactic — one move stood out (above the second best), or you were clearly better — asks
  "what should you have played?": the engine's move or any other that Stockfish says holds up. A blunder
  where many moves held asks for their punishment instead: the position after your move, solved from your
  side of the board (practice seeing their resources), then a better move than yours — both right counts.
  Afterwards: what you played in the game (and whether they punished it), with a link to it. The Puzzles page
  shows why you miss most often, with what to do about it, and how many cards are coming back. Blocks (pick the size before you start — 10 by default, or just one) guard against tilt: your rating stays hidden
  until the block ends; three misses in a row, or a quick miss right after a miss, bring up a breather. With Lichess connected they're picked around your
  Lichess puzzle rating and, if you let them, count toward it. Every puzzle is kept in your history with
  the time it took (synced), for the balance of the three. On a phone it's one screen, like training: the
  block's bar, the board as big as the screen allows (your clock in your player strip), a box with what to
  do and your line, and the buttons at the bottom — what to solve, your rating and history behind ⚙.
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
the app icon*): iPhone and iPad only show a web app's number once it may send notifications — Tabiya
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

Tabiya is free software, licensed under the **GNU GPL v3 or later** (see `LICENSE`); the app shows the
notice, the license and a link to this repository under Settings → About & credits.

Board: [chessground](https://github.com/lichess-org/chessground); chess logic:
[chessops](https://github.com/niklasf/chessops); engine: [Stockfish](https://github.com/nmrugg/stockfish.js)
(all GPL-3.0). Piece images: Colin M.L. Burnett (GPL-2.0-or-later). Scheduling:
[ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) (MIT); storage: Dexie (Apache-2.0); UI: React (MIT);
font: Inter (OFL). Opening names: [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)
(public domain / CC0), in `src/data/openings.json` (rebuilt by `scripts/openings-from-lichess.mjs`).
