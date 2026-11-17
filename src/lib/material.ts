/**
 * Material balance like Lichess shows beside the players: the pieces each side is up, and how many
 * points ahead the side with more material is (pawn 1, knight 3, bishop 3, rook 5, queen 9).
 */
import type { Position } from 'chessops/chess';

export type MaterialRole = 'queen' | 'rook' | 'bishop' | 'knight' | 'pawn';
export const MATERIAL_ROLES: MaterialRole[] = ['queen', 'rook', 'bishop', 'knight', 'pawn'];
const VALUE: Record<MaterialRole, number> = { queen: 9, rook: 5, bishop: 3, knight: 3, pawn: 1 };

export interface MaterialSide {
  /** The extra pieces this side has, most valuable first (one entry per piece). */
  up: MaterialRole[];
  /** Points ahead (0 for the side that isn't). */
  plus: number;
}

export function materialBalance(pos: Position): { white: MaterialSide; black: MaterialSide } {
  const white: MaterialRole[] = [];
  const black: MaterialRole[] = [];
  let score = 0;
  for (const role of MATERIAL_ROLES) {
    const d = pos.board.pieces('white', role).size() - pos.board.pieces('black', role).size();
    for (let i = 0; i < Math.abs(d); i++) (d > 0 ? white : black).push(role);
    score += d * VALUE[role];
  }
  return { white: { up: white, plus: Math.max(0, score) }, black: { up: black, plus: Math.max(0, -score) } };
}
