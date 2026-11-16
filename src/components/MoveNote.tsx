import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { setMoveComment } from '../db/repertoire';

/**
 * View and edit the note on a repertoire move. Reads the latest note from the database, saves when
 * you click away (or press Ctrl/⌘+Enter), and shows a small "Saved" confirmation.
 */
export function MoveNote({
  id,
  san,
  label,
  compact = false,
  autoFocus = false,
  prompt = false,
}: {
  id: string;
  san: string;
  /** Shown after the move, e.g. "(missed)". */
  label?: string;
  compact?: boolean;
  autoFocus?: boolean;
  /** You just got this move wrong: if it has no note yet, ask for one and put the cursor in the box. */
  prompt?: boolean;
}) {
  const stored = useLiveQuery(async () => (await db.moves.get(id))?.comment ?? '', [id]);
  const [text, setText] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const dirty = text !== undefined && text !== stored;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const save = async () => {
    if (!dirty) return;
    await setMoveComment(id, text!);
    setText(undefined);
    setSaved(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaved(false), 1500);
  };

  if (stored === undefined) return null;
  const asking = prompt && !stored && text === undefined;
  return (
    <div className={`${compact ? 'movenote compact' : 'panel movenote'}${asking ? ' prompt' : ''}`}>
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h3 style={{ margin: 0 }}>
          Note on <span className="keep-case">{san}</span>
          {label ? ` ${label}` : ''}
        </h3>
        <span className="spacer" />
        {saved && <span className="badge good">Saved</span>}
        {dirty && <span className="muted small">unsaved</span>}
      </div>
      {asking && (
        <div className="small" style={{ marginTop: 6, color: 'var(--warn)' }}>
          No note yet — write down why <b className="keep-case">{san}</b> is the move (the idea, the plan, the trap), so it sticks next time.
        </div>
      )}
      <textarea
        rows={compact ? 2 : 3}
        value={text ?? stored}
        autoFocus={autoFocus || (prompt && !stored)}
        placeholder="Why this move? Plans, traps, ideas… (shown during training)"
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save();
          e.stopPropagation(); // don't let board shortcuts (arrows, f) fire while typing
        }}
        style={{ marginTop: 6 }}
      />
    </div>
  );
}
