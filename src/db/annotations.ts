import { db } from './db';
import { isEmpty, sortGlyphs, type MoveAnnotation } from '../lib/annotations';

/** Save (or with nothing left in it, remove) the annotation of move `ply` of a game. */
export async function saveAnnotation(gameId: string, ply: number, a: MoveAnnotation | undefined) {
  const value: MoveAnnotation | undefined = isEmpty(a)
    ? undefined
    : {
        ...(a!.glyphs?.length ? { glyphs: sortGlyphs(a!.glyphs) } : {}),
        ...(a!.comment?.trim() ? { comment: a!.comment.trim() } : {}),
      };
  await db.transaction('rw', db.games, async () => {
    const game = await db.games.get(gameId);
    if (!game) return;
    const annotations = { ...(game.annotations ?? {}) };
    if (value) annotations[String(ply)] = value;
    else delete annotations[String(ply)];
    await db.games.update(gameId, { annotations: Object.keys(annotations).length ? annotations : undefined });
  });
}
