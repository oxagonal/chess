/**
 * One-time: the chapters' own goal went from 1 in 100 of their games to 1 in 20 (1 in 100 meant about
 * 100 lines a chapter). Settings still at the old default move to the new one; a goal you've set
 * yourself stays. Runs once — on any device, after it's up to date with the others (the note that it
 * ran syncs) — so choosing 1 in 100 again later sticks.
 */
import { db } from '../db/db';
import { getSettings, updateSettings } from '../db/settings';

const DONE_KEY = 'migration:chapterGoal20';
const OLD_DEFAULT = 100;
const NEW_DEFAULT = 20;

export async function lowerChapterGoal(): Promise<void> {
  if (await db.kv.get(DONE_KEY)) return;
  const s = await getSettings();
  if (s.chapterOneInN === OLD_DEFAULT) await updateSettings({ chapterOneInN: NEW_DEFAULT });
  await db.kv.put({ key: DONE_KEY, value: { at: Date.now() } });
}
