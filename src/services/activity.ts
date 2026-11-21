/**
 * Time spent on your training, recorded as you use the app (the Plan tab's 1/3 balance): a clock runs
 * while a training page is open — counting only while it's on screen and you're using it (no input
 * for IDLE_MS stops it) — and is saved as one activity row per visit. Time away from the app is logged
 * by hand (logActivity).
 */
import { db, uid } from '../db/db';
import type { Activity, StudyTopic, Third } from '../lib/types';

export interface ActivitySpec {
  third: Third;
  topic?: StudyTopic;
  what: string;
  refId?: string;
}

const TICK_MS = 5_000;
/** No mouse, key or touch for this long: you've stepped away, the clock stops. */
export const IDLE_MS = 90_000;
/** Visits shorter than this aren't worth a row. */
const MIN_MS = 15_000;
/** Saved this often while it runs (and when you leave): rarely, so syncing isn't kept busy. */
const SAVE_EVERY_MS = 120_000;

export class ActivityClock {
  readonly id = uid();
  readonly start = Date.now();
  ms = 0;
  private last = Date.now();
  private lastInput = Date.now();
  private saved = 0;
  private timer?: ReturnType<typeof setInterval>;
  private readonly onInput = () => {
    this.lastInput = Date.now();
  };
  private readonly onVisibility = () => {
    this.tick();
    if (document.visibilityState === 'hidden') void this.save();
  };

  constructor(
    private readonly spec: ActivitySpec,
    private readonly onTick?: (ms: number) => void,
  ) {}

  begin() {
    for (const e of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) window.addEventListener(e, this.onInput, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private tick() {
    const now = Date.now();
    const dt = Math.min(now - this.last, TICK_MS * 2);
    this.last = now;
    if (document.visibilityState === 'visible' && now - this.lastInput < IDLE_MS) this.ms += dt;
    if (this.ms - this.saved >= SAVE_EVERY_MS) void this.save();
    this.onTick?.(this.ms);
  }

  private async save() {
    if (this.ms < MIN_MS || this.ms === this.saved) return;
    this.saved = this.ms;
    const row: Activity = { id: this.id, ...this.spec, start: this.start, ms: this.ms };
    await db.activity.put(row);
  }

  end() {
    this.tick();
    clearInterval(this.timer);
    for (const e of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) window.removeEventListener(e, this.onInput);
    document.removeEventListener('visibilitychange', this.onVisibility);
    void this.save();
  }
}

/** Time spent away from the app, logged by hand (a book, a course, games over the board…). */
export async function logActivity(entry: { third: Third; topic?: StudyTopic; minutes: number; at: number; note?: string }) {
  await db.activity.put({
    id: uid(),
    third: entry.third,
    topic: entry.third === 'study' ? entry.topic : undefined,
    what: 'log',
    start: entry.at,
    ms: Math.round(entry.minutes * 60_000),
    manual: true,
    note: entry.note?.trim() || undefined,
  });
}

export async function deleteActivity(id: string) {
  await db.activity.delete(id);
}
