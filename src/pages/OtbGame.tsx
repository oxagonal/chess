import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, uid } from '../db/db';
import { updateSettings, useSettings } from '../db/settings';
import { Board } from '../components/Board';
import { PositionTools } from '../components/PositionTools';
import { LineView } from '../components/ui';
import { href, navigate } from '../router';
import { playSan, playUci, startPos, type Color } from '../lib/chess';
import { draftFromPgn, draftOf, isoDay, makeOtbGame, readPgnGames, sideOf, type OtbDraft, type PgnGame } from '../lib/otb';
import type { TimeClass } from '../lib/importers/common';
import type { StoredGame } from '../lib/types';

type Outcome = 'win' | 'draw' | 'loss' | 'unknown';

function outcomeOf(result: StoredGame['result'], color: Color): Outcome {
  if (result === '1/2-1/2') return 'draw';
  if (result === '*') return 'unknown';
  return (result === '1-0') === (color === 'white') ? 'win' : 'loss';
}

function resultOf(o: Outcome, color: Color): StoredGame['result'] {
  if (o === 'draw') return '1/2-1/2';
  if (o === 'unknown') return '*';
  return (o === 'win') === (color === 'white') ? '1-0' : '0-1';
}

const TIME_CLASSES: TimeClass[] = ['classical', 'rapid', 'blitz'];

/** Add (or edit) a game played over the board: enter the moves on the board or paste PGN. */
export function OtbGameEditor({ editId, initialOpponent }: { editId?: string; initialOpponent?: string }) {
  const settings = useSettings();
  const existing = useLiveQuery(async () => (editId ? ((await db.games.get(editId)) ?? null) : null), [editId]);
  const players = useLiveQuery(() => db.players.toArray(), []);
  const pastOpponents = useLiveQuery(async () => {
    const games = await db.games.where('source').equals('otb').toArray();
    return [...new Set(games.map((g) => (g.userColor === 'white' ? g.black : g.white)))];
  }, []);
  const [draft, setDraft] = useState<OtbDraft | null>(null);
  const [cursor, setCursor] = useState(0);
  const [pgnOpen, setPgnOpen] = useState(false);
  const [pgnText, setPgnText] = useState('');
  const [pgnMsg, setPgnMsg] = useState<string | null>(null);
  const [bulk, setBulk] = useState<PgnGame[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (draft || existing === undefined || !settings.loaded) return;
    const d: OtbDraft = existing
      ? draftOf(existing)
      : {
          sans: [],
          userColor: 'white',
          opponent: initialOpponent ?? '',
          result: '*',
          playedAt: Date.now(),
          timeClass: 'classical',
          myName: settings.otbName || undefined,
        };
    setDraft(d);
    setCursor(d.sans.length);
  }, [existing, settings.loaded, settings.otbName, draft]);

  const line = useMemo(() => {
    const out: { pos: ReturnType<typeof startPos>; uci?: string }[] = [{ pos: startPos() }];
    for (const san of draft?.sans ?? []) {
      const p = playSan(out[out.length - 1].pos, san);
      if (!p) break;
      out.push({ pos: p.pos, uci: p.uci });
    }
    return out;
  }, [draft?.sans]);

  // ← / → step through the moves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement)?.closest('input, textarea, select')) return;
      if (e.key === 'ArrowLeft') setCursor((c) => Math.max(0, c - 1));
      if (e.key === 'ArrowRight') setCursor((c) => Math.min(line.length - 1, c + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [line.length]);

  if (existing === null && editId) return <div className="empty">Game not found.</div>;
  if (!draft) return null;
  const set = (patch: Partial<OtbDraft>) => setDraft({ ...draft, ...patch });
  const outcome = outcomeOf(draft.result, draft.userColor);
  const here = line[Math.min(cursor, line.length - 1)];

  const onMove = (uci: string) => {
    const played = playUci(here.pos, uci);
    if (!played) return;
    // Playing the move that's already next just steps forward; anything else replaces the rest of the game.
    const sans = draft.sans[cursor] === played.san ? draft.sans : [...draft.sans.slice(0, cursor), played.san];
    set({ sans });
    setCursor(cursor + 1);
  };

  const readPgn = () => {
    setBulk(null);
    const { games, errors } = readPgnGames(pgnText);
    if (!games.length) return setPgnMsg(errors[0] ?? 'No games found in that text.');
    if (games.length > 1) {
      setBulk(games);
      return setPgnMsg(null);
    }
    const g = games[0];
    const side = sideOf(g, draft.myName || settings.otbName);
    setDraft({ ...draftFromPgn(g, side ?? draft.userColor, draft.timeClass), id: draft.id });
    setCursor(g.sans.length);
    setPgnOpen(false);
    setPgnMsg(
      [
        side ? null : `Couldn't tell which side you played from the names (${g.white} – ${g.black}) — check “I played” below.`,
        ...errors,
      ]
        .filter(Boolean)
        .join(' ') || null,
    );
  };

  const save = async (d: OtbDraft) => {
    setSaving(true);
    if (d.myName && d.myName !== settings.otbName) await updateSettings({ otbName: d.myName.trim() });
    const g = makeOtbGame(d, uid);
    await db.games.put(g);
    navigate(`games/${encodeURIComponent(g.id)}`);
  };

  const myName = draft.myName ?? '';
  const bulkKnown = bulk?.filter((g) => sideOf(g, myName)) ?? [];
  const importBulk = async () => {
    setSaving(true);
    if (myName && myName !== settings.otbName) await updateSettings({ otbName: myName.trim() });
    await db.games.bulkPut(bulkKnown.map((g) => makeOtbGame(draftFromPgn(g, sideOf(g, myName)!, draft.timeClass), uid)));
    navigate('games');
  };

  const names = [...new Set([...(players ?? []).map((p) => p.name), ...(pastOpponents ?? [])])].sort();
  const missing = !draft.sans.length ? 'Enter the moves first.' : !draft.opponent.trim() ? 'Add your opponent’s name.' : null;

  return (
    <div className="board-layout">
      <div className="board-col col">
        <Board pos={here.pos} orientation={draft.userColor} interactive lastMove={here.uci} onMove={onMove} />
        <div className="row">
          <button onClick={() => setCursor(0)} aria-label="Start">
            ⏮
          </button>
          <button onClick={() => setCursor(Math.max(0, cursor - 1))} aria-label="Back">
            ◀
          </button>
          <button onClick={() => setCursor(Math.min(line.length - 1, cursor + 1))} aria-label="Forward">
            ▶
          </button>
          <button onClick={() => setCursor(line.length - 1)} aria-label="End">
            ⏭
          </button>
          <span className="spacer" />
          <button
            disabled={!draft.sans.length}
            onClick={() => {
              set({ sans: draft.sans.slice(0, -1) });
              setCursor(Math.min(cursor, draft.sans.length - 1));
            }}
          >
            Undo last move
          </button>
        </div>
        <PositionTools pos={here.pos} ply={Math.min(cursor, line.length - 1)} orientation={draft.userColor} />
      </div>

      <div className="col">
        <div className="panel col" style={{ gap: 10 }}>
          <div className="row">
            <a href={href('games')} className="btn small">
              ← Games
            </a>
            <h2 style={{ margin: 0 }}>{editId ? 'Edit over-the-board game' : 'Add an over-the-board game'}</h2>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            Play the moves on the board from your score sheet, or paste PGN. The game then counts in your prep stats like your online games.
          </p>
          <div className="otb-moves">
            {draft.sans.length ? (
              <LineView items={draft.sans.map((san) => ({ san }))} current={cursor} onSelect={setCursor} />
            ) : (
              <span className="muted">No moves yet — make the first move on the board.</span>
            )}
          </div>
          {cursor < draft.sans.length && (
            <div className="muted small">Viewing move {cursor}. A different move here replaces the rest of the game.</div>
          )}
          <div className="row">
            <button className="small" onClick={() => setPgnOpen(!pgnOpen)}>
              {pgnOpen ? 'Hide PGN' : 'Paste PGN instead'}
            </button>
          </div>
          {pgnOpen && (
            <div className="col" style={{ gap: 8 }}>
              <textarea rows={5} placeholder='[White "…"] [Black "…"] 1. e4 c5 2. Nf3 …' value={pgnText} onChange={(e) => setPgnText(e.target.value)} />
              <div className="row">
                <button className="primary small" disabled={!pgnText.trim()} onClick={readPgn}>
                  Read PGN
                </button>
                <span className="muted small">One game fills in this form; a file with several games can be imported at once.</span>
              </div>
            </div>
          )}
          {pgnMsg && <div className="note">{pgnMsg}</div>}
          {bulk && (
            <div className="note col" style={{ gap: 8 }}>
              <div>
                {bulk.length} games found. Your name picks out which side you played:{' '}
                <b>
                  {bulkKnown.length} of {bulk.length}
                </b>{' '}
                match{bulkKnown.length === 1 ? 'es' : ''} <i>{myName || '(enter your name below)'}</i>.
              </div>
              <label className="field">
                <span>Your name as written in the PGN</span>
                <input value={myName} onChange={(e) => set({ myName: e.target.value })} placeholder="e.g. Carlsen, Magnus" />
              </label>
              <div className="row">
                <button className="primary" disabled={!bulkKnown.length || saving} onClick={importBulk}>
                  Import {bulkKnown.length} game{bulkKnown.length === 1 ? '' : 's'}
                </button>
                <button className="ghost" onClick={() => setBulk(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="panel col" style={{ gap: 12 }}>
          <h2 style={{ margin: 0 }}>Game details</h2>
          <div className="row">
            <div className="field">
              <span>I played</span>
              <div className="segmented">
                {(['white', 'black'] as Color[]).map((c) => (
                  <button key={c} className={draft.userColor === c ? 'active' : ''} onClick={() => set({ userColor: c, result: resultOf(outcome, c) })}>
                    {c === 'white' ? 'White' : 'Black'}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span>Result</span>
              <div className="segmented">
                {(['win', 'draw', 'loss'] as Outcome[]).map((o) => (
                  <button key={o} className={outcome === o ? 'active' : ''} onClick={() => set({ result: resultOf(outcome === o ? 'unknown' : o, draft.userColor) })}>
                    {o === 'win' ? 'I won' : o === 'draw' ? 'Draw' : 'I lost'}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="row">
            <label className="field" style={{ flex: '1 1 200px' }}>
              <span>Opponent</span>
              <input list="otb-names" value={draft.opponent} onChange={(e) => set({ opponent: e.target.value })} placeholder="Name" />
              <datalist id="otb-names">
                {names.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </label>
            <label className="field" style={{ width: 110 }}>
              <span>Their rating</span>
              <input
                type="number"
                inputMode="numeric"
                value={draft.opponentElo ?? ''}
                onChange={(e) => set({ opponentElo: Number(e.target.value) || undefined })}
              />
            </label>
          </div>
          <div className="row">
            <label className="field">
              <span>Date</span>
              <input
                type="date"
                value={isoDay(draft.playedAt)}
                onChange={(e) => {
                  const [y, m, d] = e.target.value.split('-').map(Number);
                  if (y) set({ playedAt: new Date(y, m - 1, d, 12).getTime() });
                }}
              />
            </label>
            <label className="field">
              <span>Time control</span>
              <select value={draft.timeClass} onChange={(e) => set({ timeClass: e.target.value as TimeClass })}>
                {TIME_CLASSES.map((t) => (
                  <option key={t} value={t}>
                    {t[0].toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ flex: '1 1 180px' }}>
              <span>Event (optional)</span>
              <input value={draft.event ?? ''} onChange={(e) => set({ event: e.target.value })} placeholder="e.g. Club championship, round 3" />
            </label>
          </div>
          <div className="row">
            <label className="field" style={{ flex: '1 1 200px' }}>
              <span>Your name (optional)</span>
              <input value={myName} onChange={(e) => set({ myName: e.target.value })} placeholder="As written in PGN files" />
            </label>
            <label className="field" style={{ width: 110 }}>
              <span>Your rating</span>
              <input type="number" inputMode="numeric" value={draft.myElo ?? ''} onChange={(e) => set({ myElo: Number(e.target.value) || undefined })} />
            </label>
          </div>
          <div className="row">
            <button className="primary" disabled={!!missing || saving} onClick={() => save(draft)}>
              {editId ? 'Save changes' : 'Save game'}
            </button>
            {missing && <span className="muted small">{missing}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
