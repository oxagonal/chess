import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { setMovePlan, setPlanStill } from '../db/repertoire';
import { moveNumberPrefix, type Color } from '../lib/chess';
import { planCover, plansByKey, type PlanRef } from '../lib/plans';
import type { RepMove, TopGame } from '../lib/types';
import { masterGames } from '../services/explorer';
import { sourcesOf } from '../lib/chapters';

/** Every plan in a color's chapters, by position (transposed lines share them). */
export function usePlans(color: Color | undefined): Map<string, PlanRef> | undefined {
  return useLiveQuery(async () => {
    if (!color) return new Map<string, PlanRef>();
    const reps = await db.repertoires.where('color').equals(color).primaryKeys();
    const moves = reps.length ? await db.moves.where('repId').anyOf(reps).filter((m) => !!m.plan?.trim()).toArray() : [];
    return plansByKey(moves);
  }, [color]);
}

/** Every plan, in all your chapters, by position (training sessions can mix colors). */
export function useAllPlans(): Map<string, PlanRef> | undefined {
  return useLiveQuery(async () => plansByKey(await db.moves.filter((m) => !!m.plan?.trim()).toArray()), []);
}

/** "after 9.Re1" — where a plan was written (`ply`: the move's index in its line). */
export function afterMove(m: { san: string }, ply: number): string {
  return `after ${moveNumberPrefix(ply, true)}${m.san}`;
}

/**
 * Write or edit the plan on a move (for the position after it). Saves when you click away (or press
 * Ctrl/⌘+Enter), with a small "Saved".
 */
export function PlanNote({ id, placeholder, autoFocus, rows = 3 }: { id: string; placeholder: string; autoFocus?: boolean; rows?: number }) {
  const stored = useLiveQuery(async () => (await db.moves.get(id))?.plan ?? '', [id]);
  const [text, setText] = useState<string>();
  const [saved, setSaved] = useState(false);
  const dirty = text !== undefined && text !== stored;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Leaving (another position, another line) saves what you typed, even without a blur.
  const unsaved = useRef<string | undefined>(undefined);
  unsaved.current = dirty ? text : undefined;
  useEffect(
    () => () => {
      if (unsaved.current !== undefined) void setMovePlan(id, unsaved.current);
    },
    [id],
  );
  const save = async () => {
    if (!dirty) return;
    await setMovePlan(id, text!);
    setText(undefined);
    setSaved(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaved(false), 1500);
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save();
    e.stopPropagation(); // board shortcuts (arrows, x) don't fire while typing
  };
  if (stored === undefined) return null;
  return (
    <div className="plan-note">
      <textarea
        rows={rows}
        value={text ?? stored}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={keys}
        ref={(el) => {
          // Grow with the text (up to a dozen lines) so a long plan isn't hidden behind a scrollbar.
          if (el) {
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight + 2, 260)}px`;
          }
        }}
      />
      {(saved || dirty) && <span className={saved ? 'badge good' : 'muted small'}>{saved ? 'Saved' : 'unsaved'}</span>}
    </div>
  );
}

const PLAN_PROMPT = 'Pawn breaks, where the pieces go, what to attack, the typical tactic…';

/**
 * The builder's plan for where you are: at a line's end, its plan — or the one further back that covers
 * it (with "Still applies" when it's more than 5 moves back) — or a box to write one, and the master
 * games from here; elsewhere, a plan if this position has one, or a link to add one.
 */
export function PlanBox({ color, path, lineEnd, fenKey }: { color: Color; path: RepMove[]; lineEnd: boolean; fenKey: string }) {
  const plans = usePlans(color);
  const [writing, setWriting] = useState(false);
  const cur = path[path.length - 1];
  useEffect(() => setWriting(false), [cur?.id]);
  if (!plans || !cur) return null;
  // In "All chapters" the line's moves are merged ones: write to the chapters' own moves.
  const ids = sourcesOf(cur);
  const own = plans.get(cur.toKey);
  const cover = planCover(path, plans);
  const where = (p: PlanRef) => {
    const i = path.findIndex((m) => m.toKey === p.move.toKey);
    return i >= 0 ? afterMove(path[i], i) : 'elsewhere';
  };

  if (own)
    return (
      <div className="plan-box filled">
        <div className="plan-head">
          <b>Plan</b>
          <span className="muted small">{ids.includes(own.move.id) ? afterMove(cur, path.length - 1) : 'shared with a transposed line'}</span>
        </div>
        <PlanNote id={own.move.id} placeholder={PLAN_PROMPT} rows={2} />
        {lineEnd && <MasterGames fenKey={fenKey} />}
      </div>
    );

  if (!lineEnd)
    return writing ? (
      <div className="plan-box">
        <div className="plan-head">
          <b>Plan {afterMove(cur, path.length - 1)}</b>
          <span className="muted small">— for the lines that go on from here</span>
        </div>
        <PlanNote id={ids[0]} placeholder={PLAN_PROMPT} autoFocus rows={2} />
      </div>
    ) : (
      <button className="linklike small plan-add" onClick={() => setWriting(true)} title="A plan here covers the lines that end within 5 moves of it">
        + Plan for this position
      </button>
    );

  // A line's end without a plan of its own.
  return (
    <div className={`plan-box ${cover.status === 'none' || cover.status === 'far' ? 'wants' : ''}`}>
      <div className="plan-head">
        <b>Plan</b>
        <span className="muted small">end of the line</span>
      </div>
      {cover.plan && (cover.status === 'near' || cover.status === 'confirmed') && !writing && (
        <div className="small">
          <span className="muted">
            {cover.status === 'near' ? `From ${where(cover.plan)} (${Math.ceil(cover.back! / 2)} moves back):` : `From ${where(cover.plan)} — you said it still applies:`}
          </span>{' '}
          {cover.plan.text}
          <div className="row" style={{ gap: 8, marginTop: 4 }}>
            <button className="linklike small" onClick={() => setWriting(true)}>
              Write one just for this line
            </button>
            {cover.status === 'confirmed' && (
              <button className="linklike small" onClick={() => void setPlanStill(ids, false)}>
                It doesn't apply after all
              </button>
            )}
          </div>
        </div>
      )}
      {cover.status === 'far' && !writing && (
        <div className="small">
          <span className="warn-text">The nearest plan is {Math.ceil(cover.back! / 2)} moves back</span>
          <span className="muted"> ({where(cover.plan!)}):</span> {cover.plan!.text}
          <div className="row" style={{ gap: 8, marginTop: 4 }}>
            <button className="small" onClick={() => void setPlanStill(ids, true)} title="Counts as this line's plan">
              Still applies
            </button>
            <button className="small" onClick={() => setWriting(true)}>
              Write a new one
            </button>
          </div>
        </div>
      )}
      {(cover.status === 'none' || writing) && (
        <>
          {cover.status === 'none' && <div className="small warn-text">No plan for this line yet — what are you aiming for once the moves run out?</div>}
          <PlanNote id={ids[0]} placeholder={PLAN_PROMPT} autoFocus={writing} rows={2} />
        </>
      )}
      <MasterGames fenKey={fenKey} />
    </div>
  );
}

/** The best-known master games through a position — how strong players went on from here. */
export function MasterGames({ fenKey, max = 5 }: { fenKey: string; max?: number }) {
  const [games, setGames] = useState<TopGame[]>();
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setGames(undefined);
    setError(false);
    masterGames(fenKey, ctrl.signal).then(setGames, () => !ctrl.signal.aborted && setError(true));
    return () => ctrl.abort();
  }, [fenKey, open]);
  useEffect(() => setOpen(false), [fenKey]);
  if (!open)
    return (
      <button className="linklike small" onClick={() => setOpen(true)} title="Master games through this position, from the Lichess masters database — for ideas">
        Master games from here
      </button>
    );
  return (
    <div className="master-games small">
      <span className="muted">Master games from here:</span>
      {error ? (
        <span className="muted"> couldn't load them (connect Lichess in Settings).</span>
      ) : !games ? (
        <span className="muted"> …</span>
      ) : !games.length ? (
        <span className="muted"> none in the masters database.</span>
      ) : (
        <ul>
          {games.slice(0, max).map((g) => (
            <li key={g.id}>
              <a href={`https://lichess.org/${g.id}`} target="_blank" rel="noreferrer">
                <span className="keep-case">{g.white.name}</span> – <span className="keep-case">{g.black.name}</span>
              </a>{' '}
              <span className="muted">
                {g.winner === 'white' ? '1–0' : g.winner === 'black' ? '0–1' : '½–½'}
                {g.year ? ` · ${g.year}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

