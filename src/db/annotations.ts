import { db } from './db';
import { cleanAnnotation, type MoveAnnotation, type SavedLine } from '../lib/annotations';

/**
 * Save (or with nothing left in it, remove) the annotation of move `ply` of a game. With none left the
 * game keeps an empty {} rather than nothing, so sync can't bring old annotations back.
 */
export async function saveAnnotation(gameId: string, ply: number, a: MoveAnnotation | undefined) {
  const value = cleanAnnotation(a);
  await db.transaction('rw', db.games, async () => {
    const game = await db.games.get(gameId);
    if (!game) return;
    const annotations = { ...(game.annotations ?? {}) };
    if (value) annotations[String(ply)] = value;
    else delete annotations[String(ply)];
    await db.games.update(gameId, { annotations });
  });
}

/** Save the game's side lines (an empty list stays [] for the same reason). */
export async function saveLines(gameId: string, lines: SavedLine[]) {
  await db.games.update(gameId, { lines });
}
