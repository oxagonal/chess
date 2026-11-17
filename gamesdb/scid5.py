"""Read Lumbra's Gigabase in Scid 5 format (.si5 / .sn5 / .sg5) for gamesdb/export.ts.

Streams every game as one JSON line on stdout, in database order:

    [white, black, date, result, event, timeControl, whiteElo, blackElo, whiteFideId, blackFideId, "e2e4 e7e5 …"]

- date: "YYYY.MM.DD" with ?? for unknown parts; result: "1-0" / "0-1" / "1/2-1/2" / "*"
- the moves are the main line's first --plies plies (default 60) in UCI, castling as the king's
  two-square move (e1g1), promotions with a lowercase piece letter (e7e8q)
- games that start from a set-up position, Chess960 games, games without moves, games that fail to
  decode, and (with --since) games from before that year are left out (counted on stderr); a game
  whose year is unknown is kept

    python -I gamesdb/scid5.py <path/to/LumbrasGigaBase_OTB>   (base path, no extension)
           [--workers N] [--plies 60] [--limit N] [--verify-every 50] [--since YEAR]

Moves are read with a fast 64-square decoder; every --verify-every'th game (default 50; 1 = all) is
also decoded with python-chess, which checks every move's legality, and must agree. The decoding (namebase, index records, tag
blocks, Scid's piece-index move encoding) comes from a decoder written in another session from
Scid's source (benini/scid: codec_scid5.h, bytebuf.h, game.cpp, position.cpp); the full-tree
decode_game is kept as the fallback for games with variations or comments.
"""
import json
import multiprocessing as mp
import os
import struct
import sys
import time

import chess
import chess.pgn

# ---------------------------------------------------------------- namebase
NAME_PLAYER, NAME_EVENT, NAME_SITE, NAME_ROUND = range(4)


def load_names(base):
    names = [[], [], [], []]
    with open(base + ".sn5", "rb") as f:
        data = f.read()
    pos, n = 0, len(data)
    while pos < n:
        val = shift = 0
        while True:
            b = data[pos]
            pos += 1
            val |= (b & 127) << shift
            shift += 7
            if b < 128:
                break
        nt, ln = val & 7, val >> 3
        s = data[pos:pos + ln].decode("utf-8", errors="replace")
        pos += ln
        if nt < 4:
            names[nt].append(s)
    return names


# ---------------------------------------------------------------- tags
COMMON_TAGS = ["WhiteCountry", "BlackCountry", "Annotator", "PlyCount", "EventDate",
               "Opening", "Variation", "Setup", "Source", "SetUp"]
RATING_TYPES = ["Elo", "Rating", "Rapid", "ICCF", "USCF", "DWZ", "ECF", "Elo"]
RESULTS = ["*", "1-0", "0-1", "1/2-1/2"]


def date_str(d):
    y, m, dd = d >> 9, (d >> 5) & 15, d & 31
    return "%s.%s.%s" % ("%04d" % y if y else "????", "%02d" % m if m else "??",
                         "%02d" % dd if dd else "??")


def decode_tags(buf, p):
    """Returns (list of (tag, value), new position)."""
    tags = []
    while True:
        tl = buf[p]
        p += 1
        if tl == 0:
            return tags, p
        if tl > 240:
            tid = tl - 241
            tag = COMMON_TAGS[tid] if tid < 10 else None
        else:
            tag = buf[p:p + tl].decode("utf-8", errors="replace")
            p += tl
        vl = buf[p] if tl != 255 else 3
        if tl != 255:
            p += 1
        val = buf[p:p + vl]
        p += vl
        if tag is not None:
            tags.append((tag, val.decode("utf-8", errors="replace")))


# ---------------------------------------------------------------- moves
class DecodeError(Exception):
    pass


PAWN_DIFF = [7, 8, 9, 7, 8, 9, 7, 8, 9, 7, 8, 9, 7, 8, 9, 16]
PAWN_PROMO = [None, None, None, chess.QUEEN, chess.QUEEN, chess.QUEEN, chess.ROOK, chess.ROOK,
              chess.ROOK, chess.BISHOP, chess.BISHOP, chess.BISHOP, chess.KNIGHT, chess.KNIGHT,
              chess.KNIGHT, None]
KNIGHT_DIFF = [0, -17, -15, -10, -6, 6, 10, 15, 17, 0, 0, 0, 0, 0, 0, 0]
KING_DIFF = [0, -9, -8, -7, -1, 1, 7, 8, 9]
# Scid's fixed piece-index template for the standard starting position: [black, white]
START_LISTS = ([60, 56, 57, 58, 59, 61, 62, 63] + list(range(48, 56)),
               [4, 0, 1, 2, 3, 5, 6, 7] + list(range(8, 16)))


class State:
    """python-chess board + Scid piece lists (piece index -> square)."""

    def __init__(self, board, lists):
        self.board = board
        self.lists = lists

    def copy(self):
        return State(self.board.copy(stack=False), [self.lists[0][:], self.lists[1][:]])


def initial_lists(board):
    lists = [[], []]
    for rank in range(7, -1, -1):
        for file in range(8):
            sq = rank * 8 + file
            pc = board.piece_at(sq)
            if pc is None:
                continue
            lst = lists[pc.color]
            if pc.piece_type == chess.KING:
                if lst:
                    lst.append(lst[0])
                    lst[0] = sq
                else:
                    lst.append(sq)
            else:
                lst.append(sq)
    return lists


def apply_move(st, val, buf, p):
    """Decode the move byte val (buf[p] is the following byte). Returns (move, p)."""
    b = st.board
    color = b.turn
    idx = val >> 4
    code = val & 15
    lst = st.lists[color]
    if idx >= len(lst):
        raise DecodeError("bad piece index")
    frm = lst[idx]
    pt = b.piece_type_at(frm)
    if pt is None or b.color_at(frm) != color:
        raise DecodeError("no piece on from square")
    promo = None
    castle = 0
    if pt == chess.PAWN:
        to = frm + PAWN_DIFF[code] if color == chess.WHITE else frm - PAWN_DIFF[code]
        promo = PAWN_PROMO[code]
    elif pt == chess.BISHOP:
        fd = (code & 7) - (frm & 7)
        to = frm - 7 * fd if code >= 8 else frm + 9 * fd
    elif pt == chess.KNIGHT:
        to = frm + KNIGHT_DIFF[code]
    elif pt in (chess.QUEEN, chess.ROOK):
        if pt == chess.QUEEN and code == (frm & 7):
            to = buf[p] - 64
            p += 1
        elif code >= 8:
            to = (code - 8) * 8 + (frm & 7)
        else:
            to = (frm & ~7) + code
    else:  # king
        if code == 0:
            mv = chess.Move.null()
            b.push(mv)
            return mv, p
        if code <= 8:
            to = frm + KING_DIFF[code]
        elif code == 9:
            to, castle = frm - 2, -1
        elif code == 10:
            to, castle = frm + 2, 1
        else:
            raise DecodeError("bad king code")
    if not 0 <= to <= 63:
        raise DecodeError("target off board")
    mv = chess.Move(frm, to, promo)
    if not b.is_legal(mv):
        raise DecodeError("illegal move %s in %s" % (mv.uci(), b.fen()))
    if castle:
        rook_from = (frm & ~7) + (7 if castle > 0 else 0)
        rook_to = to - 1 if castle > 0 else to + 1
        lst[0] = to
        lst[lst.index(rook_from)] = rook_to
    else:
        cap_sq = to
        if pt == chess.PAWN and b.piece_at(to) is None and (frm & 7) != (to & 7):
            cap_sq = to - 8 if color == chess.WHITE else to + 8  # en passant
        if b.piece_at(cap_sq) is not None:
            elst = st.lists[not color]
            ci = elst.index(cap_sq)
            last = elst.pop()
            if ci < len(elst):
                elst[ci] = last
        lst[idx] = to
    b.push(mv)
    return mv, p


def decode_game(buf, std_tags, chess960):
    """Full decode (variations and comments) into a chess.pgn.Game — the fallback path."""
    if chess960:
        raise DecodeError("chess960 not supported")
    extra, p = decode_tags(buf, 0)
    flags = buf[p]
    p += 1
    fen = None
    if flags & 1:
        e = buf.index(0, p)
        fen = buf[p:e].decode("ascii")
        p = e + 1
    game = chess.pgn.Game()
    game.headers.clear()
    for k, v in std_tags:
        game.headers[k] = v
    for k, v in extra:
        game.headers[k] = v
    board = chess.Board(fen) if fen else chess.Board()
    if fen:
        game.setup(board)
    lists = initial_lists(board) if fen else [START_LISTS[0][:], START_LISTS[1][:]]
    states = {id(game): State(board, lists)}
    cur = game
    stack = []
    n = len(buf)
    depth = 0
    while True:
        if p >= n:
            raise DecodeError("missing end of game")
        v = buf[p]
        p += 1
        if v == 11:
            cur.nags.add(buf[p])
            p += 1
        elif v == 12:
            pass  # comment mark: the main line's moves don't need the text
        elif v == 13:
            if cur.parent is None:
                raise DecodeError("variation without move")
            stack.append(cur)
            cur = cur.parent
            depth += 1
        elif v == 14:
            if depth == 0:
                raise DecodeError("end marker in main line")
            depth -= 1
            cur = stack.pop()
        elif v == 15:
            if depth:
                raise DecodeError("unexpected end of game")
            break
        else:
            st = states[id(cur)].copy()
            mv, p = apply_move(st, v, buf, p)
            node = cur.add_variation(mv)
            states[id(node)] = st
            cur = node
    return game


def main_line(buf, plies):
    """The main line's first `plies` moves (UCI), straight from the move bytes. Falls back to the
    full tree decoder if a variation starts before then. Returns None for a set-up position."""
    _, p = decode_tags(buf, 0)
    flags = buf[p]
    p += 1
    if flags & 1:
        return None  # set-up position: not exported
    st = State(chess.Board(), [START_LISTS[0][:], START_LISTS[1][:]])
    out = []
    n = len(buf)
    while len(out) < plies:
        if p >= n:
            raise DecodeError("missing end of game")
        v = buf[p]
        p += 1
        if v == 11:  # NAG
            p += 1
        elif v == 12:  # comment mark
            continue
        elif v == 13:  # a variation: decode the whole tree and take its main line
            game = decode_game(buf, [], False)
            return [m.uci() for m in game.mainline_moves()][:plies]
        elif v == 14:
            raise DecodeError("end marker in main line")
        elif v == 15:
            break
        else:
            mv, p = apply_move(st, v, buf, p)
            if not mv:
                raise DecodeError("null move")
            out.append(mv.uci())
    return out


# ---------------------------------------------------------------- fast main line
# python-chess makes every move a full legal-move check; for 13 million games that's slow. This reads
# the main line with a plain 64-square board and Scid's piece lists, with sanity checks (own piece on
# the from-square, no capturing your own piece, a diagonal pawn move must capture or be en passant).
# The python-chess path above still verifies a sample of games (--verify-every) and must agree.
P, N, B, R, Q, K = 1, 2, 3, 4, 5, 6
SQ = [f + r for r in "12345678" for f in "abcdefgh"]
FAST_PROMO = [0, 0, 0, Q, Q, Q, R, R, R, B, B, B, N, N, N, 0]
PROMO_CH = {Q: "q", R: "r", B: "b", N: "n"}
START_BOARD = [0] * 64
for _f, _pt in enumerate([R, N, B, Q, K, B, N, R]):
    START_BOARD[_f], START_BOARD[8 + _f], START_BOARD[48 + _f], START_BOARD[56 + _f] = _pt, P, -P, -_pt


class Variation(Exception):
    """A variation starts before the plies we need: use the full decoder."""


def main_line_fast(buf, p, plies):
    board = START_BOARD[:]
    lists = [START_LISTS[0][:], START_LISTS[1][:]]  # [black, white]
    white = True
    ep = -1
    out = []
    while len(out) < plies:
        v = buf[p]
        p += 1
        if v == 11:  # NAG
            p += 1
            continue
        if v == 12:  # comment mark
            continue
        if v == 13:
            raise Variation()
        if v == 14:
            raise DecodeError("end marker in main line")
        if v == 15:
            break
        idx, code = v >> 4, v & 15
        lst = lists[1 if white else 0]
        if idx >= len(lst):
            raise DecodeError("bad piece index")
        frm = lst[idx]
        pc = board[frm]
        if pc == 0 or (pc > 0) != white:
            raise DecodeError("no piece on from square")
        pt = pc if pc > 0 else -pc
        promo = castle = 0
        if pt == P:
            to = frm + PAWN_DIFF[code] if white else frm - PAWN_DIFF[code]
            promo = FAST_PROMO[code]
        elif pt == B:
            fd = (code & 7) - (frm & 7)
            to = frm - 7 * fd if code >= 8 else frm + 9 * fd
        elif pt == N:
            to = frm + KNIGHT_DIFF[code]
        elif pt == Q or pt == R:
            if pt == Q and code == (frm & 7):
                to = buf[p] - 64
                p += 1
            elif code >= 8:
                to = (code - 8) * 8 + (frm & 7)
            else:
                to = (frm & ~7) + code
        else:
            if code == 0:
                raise DecodeError("null move")
            if code <= 8:
                to = frm + KING_DIFF[code]
            elif code == 9:
                to, castle = frm - 2, -1
            elif code == 10:
                to, castle = frm + 2, 1
            else:
                raise DecodeError("bad king code")
        if not 0 <= to <= 63:
            raise DecodeError("target off board")
        target = board[to]
        if target and (target > 0) == white:
            raise DecodeError("own piece on target square")
        sign = 1 if white else -1
        if castle:
            rook_from = (frm & ~7) + (7 if castle > 0 else 0)
            rook_to = to - 1 if castle > 0 else to + 1
            if board[rook_from] != R * sign or target:
                raise DecodeError("bad castling")
            board[rook_to], board[rook_from] = board[rook_from], 0
            board[to], board[frm] = board[frm], 0
            lst[0] = to
            lst[lst.index(rook_from)] = rook_to
            ep = -1
        else:
            cap_sq = to
            if pt == P and (frm & 7) != (to & 7) and not target:
                if to != ep:
                    raise DecodeError("pawn moves diagonally without capturing")
                cap_sq = to - 8 if white else to + 8
            if board[cap_sq]:
                elst = lists[0 if white else 1]
                ci = elst.index(cap_sq)
                last = elst.pop()
                if ci < len(elst):
                    elst[ci] = last
                board[cap_sq] = 0
            board[to] = (promo or pt) * sign
            board[frm] = 0
            lst[idx] = to
            ep = (frm + to) // 2 if pt == P and (to - frm == 16 or frm - to == 16) else -1
        out.append(SQ[frm] + SQ[to] + (PROMO_CH[promo] if promo else ""))
        white = not white
    return out


def main_line_quick(buf, plies):
    """main_line with the fast decoder (None for a set-up position)."""
    _, p = decode_tags(buf, 0)
    flags = buf[p]
    p += 1
    if flags & 1:
        return None
    try:
        return main_line_fast(buf, p, plies)
    except Variation:
        game = decode_game(buf, [], False)
        return [m.uci() for m in game.mainline_moves()][:plies]


# ---------------------------------------------------------------- streaming
ENTRY = 56
GBUF_SIZE = 64 << 20

_names = None
_base = None


def _init(base):
    global _names, _base
    _base = base
    _names = load_names(base)


def _work(task):
    """Decode index entries [start, end): returns (lines, stats)."""
    start, end, plies, verify_every, since = task
    names = _names
    lines = []
    stats = {"games": 0, "setup": 0, "c960": 0, "nomoves": 0, "errors": 0, "verified": 0, "mismatches": 0, "old": 0, "examples": []}
    with open(_base + ".si5", "rb") as ifile, open(_base + ".sg5", "rb") as gfile:
        ifile.seek(start * ENTRY)
        entries = list(struct.iter_unpack("<12I8x", ifile.read((end - start) * ENTRY)))
        # Read exactly the bytes these games occupy (they're stored close together), in one go.
        spans = [(((e[8] & 0x7FFF) << 32) | e[9], e[8] >> 15) for e in entries]
        lo = min(o for o, _ in spans)
        hi = max(o + n for o, n in spans)
        if hi - lo <= GBUF_SIZE:
            gfile.seek(lo)
            gbuf, gstart = gfile.read(hi - lo), lo
        else:
            gbuf, gstart = b"", 0
        for k, e in enumerate(entries):
            white = names[NAME_PLAYER][e[0] & 0x0FFFFFFF]
            black = names[NAME_PLAYER][e[1] & 0x0FFFFFFF]
            event = names[NAME_EVENT][e[2] & 0x0FFFFFFF]
            c960 = e[4] >> 31
            welo, date = e[5] >> 20, e[5] & 0xFFFFF
            belo = e[6] >> 20
            length = e[8] >> 15
            offset = ((e[8] & 0x7FFF) << 32) | e[9]
            rt = e[11] >> 16
            wrt, brt, res = (rt >> 5) & 7, (rt >> 2) & 7, rt & 3
            if c960:
                stats["c960"] += 1
                continue
            year = date >> 9
            if since and year and year < since:
                stats["old"] += 1  # skipped before any decoding
                continue
            if offset < gstart or offset + length > gstart + len(gbuf):
                gfile.seek(offset)
                gbuf = gfile.read(max(GBUF_SIZE, length))
                gstart = offset
            o = offset - gstart
            buf = gbuf[o:o + length]
            try:
                extra = dict(decode_tags(buf, 0)[0])
                moves = main_line_quick(buf, plies)
                if verify_every and (start + k) % verify_every == 0:
                    checked = main_line(buf, plies)
                    stats["verified"] += 1
                    if checked != moves:
                        stats["mismatches"] += 1
                        if len(stats["examples"]) < 5:
                            stats["examples"].append("game %d: fast decoder disagrees with python-chess" % (start + k))
                        moves = checked
            except (DecodeError, IndexError, ValueError) as ex:
                stats["errors"] += 1
                if len(stats["examples"]) < 5:
                    stats["examples"].append("game %d: %s" % (start + k, ex))
                continue
            if moves is None:
                stats["setup"] += 1
                continue
            if not moves:
                stats["nomoves"] += 1
                continue
            stats["games"] += 1
            lines.append(json.dumps([
                white, black, date_str(date), RESULTS[res], event, extra.get("TimeControl", ""),
                welo if RATING_TYPES[wrt] == "Elo" else 0, belo if RATING_TYPES[brt] == "Elo" else 0,
                extra.get("WhiteFideId", ""), extra.get("BlackFideId", ""), " ".join(moves),
            ], ensure_ascii=False, separators=(",", ":")))
    return "\n".join(lines), stats


def main():
    args = sys.argv[1:]

    def opt(name, default):
        if name in args:
            i = args.index(name)
            v = args[i + 1]
            del args[i:i + 2]
            return v
        return default

    workers = int(opt("--workers", str(max(1, (os.cpu_count() or 2) - 2))))
    plies = int(opt("--plies", "60"))
    limit = opt("--limit", None)
    verify_every = int(opt("--verify-every", "50"))
    since = int(opt("--since", "0"))
    if len(args) != 1:
        sys.exit(__doc__)
    base = args[0]
    total = os.path.getsize(base + ".si5") // ENTRY
    if limit:
        total = min(total, int(limit))
    step = 20_000
    tasks = [(s, min(s + step, total), plies, verify_every, since) for s in range(0, total, step)]
    out = sys.stdout.buffer
    sums = {"games": 0, "setup": 0, "c960": 0, "nomoves": 0, "errors": 0, "verified": 0, "mismatches": 0, "old": 0}
    examples = []
    t0 = time.time()
    done = 0
    with mp.Pool(workers, initializer=_init, initargs=(base,)) as pool:
        for lines, stats in pool.imap(_work, tasks):
            if lines:
                out.write(lines.encode("utf-8") + b"\n")
            for k in sums:
                sums[k] += stats[k]
            examples += stats["examples"][: max(0, 10 - len(examples))]
            done += 1
            if done % 50 == 0:
                print("scid5: %d / %d entries, %.0f s" % (min(done * step, total), total, time.time() - t0), file=sys.stderr, flush=True)
    out.flush()
    print("scid5: done in %.0f s: %s" % (time.time() - t0, json.dumps(sums)), file=sys.stderr, flush=True)
    for ex in examples:
        print("scid5: example error: " + ex, file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
