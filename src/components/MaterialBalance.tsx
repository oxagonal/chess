import type { Position } from 'chessops/chess';
import type { Color } from '../lib/chess';
import { MATERIAL_ROLES, materialBalance, type MaterialRole } from '../lib/material';

const OUTLINE: Record<MaterialRole, string> = { queen: '♕︎', rook: '♖︎', bishop: '♗︎', knight: '♘︎', pawn: '♙︎' };

/**
 * Like Lichess beside a player: the pieces `color` is up in the position (shown as the pieces taken
 * from the other side) and +points when it's ahead. Nothing when it isn't up anything.
 */
export function MaterialBalance({ pos, color }: { pos: Position; color: Color }) {
  const m = materialBalance(pos)[color];
  if (!m.up.length && !m.plus) return null;
  return (
    <span className="material" title={m.plus ? `Up ${m.plus} in material` : 'Material'}>
      {MATERIAL_ROLES.filter((role) => m.up.includes(role)).map((role) => (
        <span key={role} className="mat-pieces" aria-hidden="true">
          {OUTLINE[role].repeat(m.up.filter((r) => r === role).length)}
        </span>
      ))}
      {m.plus > 0 && <span className="mat-plus">+{m.plus}</span>}
    </span>
  );
}
