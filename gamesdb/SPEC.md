# Over-the-board games database — export spec

Tabiya's **Players** tab can search a player by name and use their over-the-board games. The games
come from **Lumbra's Gigabase** (OTB, CC BY-NC 4.0), exported on your computer into static files and
deployed as a separate Cloudflare site, `https://otbdb.oxagon.workers.dev`.

The app side — `src/lib/gamesdb.ts` (format, decoder) and `src/services/gamesdb.ts` (fetching) — is
the reference: if this text and that code disagree, the code wins.

## Quick start: the exporter in this repo

`gamesdb/export.ts` implements everything below. It reads the Gigabase **PGN** download (the "OTB
database as PGN" file on the download page, extracted from its .7z):

```bash
npm ci                                                     # once
npm run export:gamesdb -- --release 2026-11-02 ~/Downloads/LumbrasGigaBase_OTB.pgn
GAMESDB_DIR=gamesdb/dist GAMESDB_PROBE="Paul Iinuma" npm run check:gamesdb
cd gamesdb && npx wrangler login && npx wrangler deploy    # login once
```

- `--release` is the Gigabase version you downloaded (it must change with every new deploy).
- Several PGN files can be given at once. `--since 1990` leaves out older games if the output turns
  out too big for Cloudflare.
- Expect about 50 minutes for 13.5 million games, roughly 7 GB of temporary files while it runs, and
  2–4 GB of output (fewer if games compress well). It prints progress every 10 seconds.

The rest of this document is the format, for checking the output or writing another exporter (e.g.
straight from the Scid files).

**Do not commit the database or upload it anywhere other than the Cloudflare deploy below.** Lumbra's
Gigabase is downloaded by hand from <https://lumbrasgigabase.com> (the site doesn't allow automated
downloads); keep its licence: non-commercial, with credit (the app credits it in About & credits).

## Input

The Gigabase OTB database in Scid 5 format (`.si5` / `.sn5` / `.sg5`), decoded game by game (main
line only — ignore variations and comments). Skip games that start from a set-up position (FEN) or
have no moves.

### Running the export

`gamesdb/export.ts` implements this spec. It reads the PGN download, or the Scid 5 download directly
through `gamesdb/scid5.py` (Python 3 with python-chess; it decodes the main line's first 60 plies
with a fast 64-square decoder and checks every 50th game against python-chess):

```bash
npm run export:gamesdb -- --release 2026-11-11 --since 2000 database/…/LumbrasGigaBase_OTB.si5
```

`--since 2000` leaves out games from before 2000 (games with an unknown year are kept); the reader
skips them before decoding. `GAMESDB_WORKERS` sets the number of decoding processes. The 2026-11-11
release took about 17 minutes: 10,471,918 games from 2000 on, 612,134 players, 9,120 files, 2.25 GB.

## Output: `gamesdb/dist/`

```
dist/
  _headers              copy of gamesdb/_headers
  manifest.json         plain JSON (not compressed)
  names/<key>.bin       gzip-compressed JSON — name index, one file per 2-character key
  games/<n>.bin         gzip-compressed JSON — games, one file per bucket n = 0 … 8191
```

All `.bin` files are **gzip of compact UTF-8 JSON**: `json.dumps(obj, ensure_ascii=False,
separators=(",", ":"))`, compressed with `gzip.compress(data, mtime=0)` so an unchanged file is
byte-identical between runs (the deploy then skips it). Omit empty buckets and empty name shards.

Cloudflare limits: at most **20,000 files**, each at most **25 MiB**. With 8,192 buckets and up to
1,297 name shards this fits; fail loudly if any file is over 20 MiB.

### manifest.json

```json
{
  "format": 1,
  "source": "Lumbra's Gigabase (OTB)",
  "sourceUrl": "https://lumbrasgigabase.com",
  "license": "CC BY-NC 4.0",
  "release": "2026-11-02",
  "games": 13450696,
  "players": 860859,
  "buckets": 8192,
  "maxPlies": 60,
  "builtAt": "2026-11-17T20:00:00Z"
}
```

`release` is the Gigabase version (date of the release you downloaded). The app appends it to every
file URL, so it **must change** whenever you deploy new data. `games` = games exported, `players` =
names with at least one game.

### Player ids

Every distinct player name string (exactly as in the database, e.g. `Iinuma, Paul Y`) gets

```python
pid = int.from_bytes(hashlib.sha1(name.encode("utf-8")).digest()[:8], "big") >> 11   # 53 bits
```

Ids must stay the same across releases (the app saves them in players' links), which this does
without any state. Assert that no two names collide (practically impossible at 53 bits).

| name | id | bucket (id % 8192) |
| --- | --- | --- |
| `Iinuma, Paul Y` | 5290257001642107 | 6267 |
| `Paul Iinuma` | 8114831744130966 | 8086 |
| `Carlsen, Magnus` | 4106698133392867 | 3555 |
| `Müller, Jörg` | 6483172313183628 | 5516 |

### games/<n>.bin — a bucket

Holds the games of every player whose `pid % 8192 == n`. Each game goes into **both** players'
lists (White's with `c = 0`, Black's with `c = 1`).

```json
{
  "events": ["Marshall CC IM Norm", "US Open"],
  "tcs": ["5400+30", "40/7200:3600"],
  "players": {
    "5290257001642107": [
      [1, "Smith, Anna", 2210, 2290, 20240500, 2, 0, 0, "DBwyIgYVMysLGyIbFRs-LQESMCg"]
    ]
  }
}
```

A game entry is `[c, opp, oppElo, myElo, date, r, ev, tc, mv]`:

| field | meaning |
| --- | --- |
| `c` | 0 = this player had White, 1 = Black |
| `opp` | opponent's name, exactly as in the database |
| `oppElo`, `myElo` | `BlackElo` / `WhiteElo` as integers, 0 when missing |
| `date` | `Date` tag as an integer `YYYYMMDD`; unknown parts are 00 (`2024.05.??` → 20240500); unknown year → 0 |
| `r` | result: 0 `*`, 1 `1-0`, 2 `0-1`, 3 `1/2-1/2` |
| `ev` | index into this bucket's `events` (the `Event` tag); −1 when missing or `?` |
| `tc` | index into this bucket's `tcs` (the `TimeControl` tag); −1 when missing, `-` or `?` |
| `mv` | the first **60 plies** (30 moves), encoded as below |

`events` and `tcs` list the distinct strings used in that bucket. Within each player's list, order
the games newest first (unknown dates last).

### Move encoding

Each ply is two bytes: the **from** square, then the **to** square with the promotion piece in the
top two bits. Squares are numbered a1 = 0, b1 = 1, … h1 = 7, a2 = 8, … h8 = 63 (python-chess's
`chess.A1 … chess.H8`). Castling is the king's two-square move (e1g1, e1c1, e8g8, e8c8 —
python-chess's standard `move.from_square` / `move.to_square`). Promotion: queen 0, knight 1,
bishop 2, rook 3 (non-promotions are 0). The byte string is **base64url without padding**.

```python
PROMO = {chess.QUEEN: 0, chess.KNIGHT: 1, chess.BISHOP: 2, chess.ROOK: 3}

def encode(moves):  # chess.Move list from the game's main line
    out = bytearray()
    for m in moves[:60]:
        out.append(m.from_square)
        out.append(m.to_square | (PROMO[m.promotion] << 6 if m.promotion else 0))
    return base64.urlsafe_b64encode(bytes(out)).rstrip(b"=").decode()
```

The exporter must reproduce these exactly (check them in a unit test before the full run):

| moves (SAN) | `mv` |
| --- | --- |
| `e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6` | `DBwyIgYVMysLGyIbFRs-LQESMCg` |
| `e4 e5 Nf3 Nc6 Bc4 Nf6 O-O Be7 d4 exd4 e5 Ne4` | `DBw0JAYVOSoFGj4tBAY9NAsbJBscJC0c` |
| `a4 h5 a5 h4 a6 h3 axb7 hxg2 bxa8=N gxh1=Q` | `CBg3JxggJx8gKB8XKDEXDjF4Dgc` |

### names/<key>.bin — the name index

A JSON array of entries `[name, id, games, firstYear, lastYear, fideId]`:

- `games` — number of games of that name (as White or Black)
- `firstYear`, `lastYear` — from the known years of those games; 0 if none known
- `fideId` — the most common `WhiteFideId` / `BlackFideId` seen for that name; 0 if none

Each name is listed in the file of **every** key its words produce. Words come from this
normalisation (it must match the app's `nameWords` in `src/lib/otb.ts` exactly):

```python
def name_words(name):
    s = unicodedata.normalize("NFD", name)
    s = re.sub("[̀-ͯ]", "", s)         # strip accents (that range only)
    s = s.lower()
    s = re.sub(r"[.,;:'\"()_\-]+", " ", s)       # punctuation → space
    return s.split()

def shard_keys(name):
    words = [w for w in name_words(name) if len(w) >= 2]   # initials aren't indexed
    return {re.sub("[^a-z0-9]", "_", (w + "__")[:2]) for w in words}
```

| name | words indexed | files |
| --- | --- | --- |
| `Iinuma, Paul Y` | iinuma, paul | `names/ii.bin`, `names/pa.bin` |
| `Müller, Jörg` | jorg, muller | `names/jo.bin`, `names/mu.bin` |
| `O'Brien, Seán` | brien, sean | `names/br.bin`, `names/se.bin` |

## Suggested approach (memory-friendly)

1. **One streaming pass** over the games. For each game write two lines (one per player) to one of
   256 temporary files chosen by `bucket % 256` — e.g. `bucket \t pid \t json(entry-with-event-and-tc-strings)`.
   At the same time keep per-name totals in memory (games, min/max year, FIDE id counts) — about
   860,000 small records.
2. **Per temporary file**: load it, group by bucket and player, build each bucket's `events` / `tcs`
   tables, sort each player's games, write `games/<n>.bin`. Delete the temporary file.
3. **Names**: build the shards from the totals; write `names/<key>.bin`.
4. Write `manifest.json`, copy `gamesdb/_headers` to `dist/_headers`.

Use several processes for the decoding if it's slow. Expect roughly 1–2 GB of output.

## Check, then deploy

From the repository root (`npm ci` once):

```bash
GAMESDB_DIR=gamesdb/dist GAMESDB_PROBE="Paul Iinuma" npm run check:gamesdb
```

It checks the file limits, samples name shards and buckets, decodes every sampled game, and looks the
probe name up. Then:

```bash
cd gamesdb
npx wrangler login      # once: opens the browser to log in to Cloudflare
npx wrangler deploy     # uploads dist/ as the "otbdb" site
curl https://otbdb.oxagon.workers.dev/manifest.json
```

The first deploy uploads everything (it can take a while on a home connection). Later deploys only
upload files that changed.

## Monthly update

Download the new Gigabase release by hand, re-run the export (ids stay the same), set the new
`release` in the manifest, check, deploy. The app notices the new release and re-downloads linked
players' games the next time you open them.
