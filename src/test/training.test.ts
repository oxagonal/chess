import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/db';
import { addLine, createRepertoire, gradeAnswer, setNoTrain } from '../db/repertoire';
import { getSettings, updateSettings } from '../db/settings';
import { loadScopeGraph } from '../db/scopes';
import { loadDueCount, loadTrainCounts, trainedCards } from '../db/training';
import { isDue, Rating, State } from '../lib/srs';
import type { CoverageResult } from '../lib/types';

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

/** What a Review session of everything would take (as Train's session loader builds it). */
async function reviewQueue(): Promise<string[]> {
  const settings = await getSettings();
  const runs = await db.coverage.toArray();
  const out: string[] = [];
  for (const id of ['white', 'black']) {
    const loaded = await loadScopeGraph(id);
    if (!loaded) continue;
    const cards = await db.cards.where('color').equals(loaded.scope.color).toArray();
    out.push(...trainedCards(loaded.scope, loaded.graph, cards, settings, runs).filter((c) => isDue(c)).map((c) => c.san));
  }
  return out.sort();
}

describe('due counts match what a review trains', () => {
  it('leaves out moves taken out of training and cards no chapter has', async () => {
    const rep = await createRepertoire('Sicilian', 'black');
    await addLine(rep.id, ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4']);
    await db.cards.toCollection().modify({ state: 2, due: Date.now() - 60_000 });
    expect(await loadDueCount()).toBe(3);
    expect(await reviewQueue()).toEqual(['c5', 'cxd4', 'd6']);

    // ⊘ Don't train d6: it and cxd4 (only reached through it) leave training, their cards stay.
    const d6 = (await db.moves.toArray()).find((m) => m.san === 'd6')!;
    await setNoTrain(d6, true);
    expect(await db.cards.count()).toBe(3);
    expect(await loadDueCount()).toBe(1);
    expect((await loadTrainCounts()).black).toEqual({ due: 1, fresh: 0 });
    expect(await reviewQueue()).toEqual(['c5']);

    // A due card no chapter has as your move.
    const c5 = (await db.cards.toArray()).find((c) => c.san === 'c5')!;
    await db.cards.put({ ...c5, id: `${c5.fromKey}|g5`, san: 'g5' });
    expect(await loadDueCount()).toBe(1);
    expect(await reviewQueue()).toEqual(['c5']);
  });

  it('leaves out positions rarer than the coverage target when only likely ones are trained', async () => {
    const rep = await createRepertoire('Sicilian', 'black');
    await addLine(rep.id, ['e4', 'c5', 'Nf3', 'd6']);
    await db.cards.toCollection().modify({ state: 2, due: Date.now() - 60_000 });
    const keyOf = async (san: string) => (await db.cards.toArray()).find((c) => c.san === san)!.fromKey;
    const run = { repId: 'black', threshold: 0.1, probs: { [await keyOf('c5')]: 0.9, [await keyOf('d6')]: 0.01 } } as unknown as CoverageResult;
    await db.coverage.put(run);
    expect(await loadDueCount()).toBe(2);
    await updateSettings({ trainOnlyLikely: true });
    expect(await loadDueCount()).toBe(1);
    expect((await loadTrainCounts()).all.due).toBe(1);
    expect(await reviewQueue()).toEqual(['c5']);
  });
});

describe('grading a timed answer', () => {
  it('saves a quick answer as Easy only on a move in regular reviews not missed last time', async () => {
    const rep = await createRepertoire('Sicilian', 'black');
    await addLine(rep.id, ['e4', 'c5']);
    const id = (await db.cards.toArray())[0].id;
    const quick = { missed: false, ms: 800, limitMs: 10_000 };
    const DAY = 86_400_000;
    const asReview = () => db.cards.update(id, { state: State.Review, stability: 20, difficulty: 5, scheduledDays: 20, lastReview: Date.now() - 20 * DAY, due: Date.now() });

    // New / learning: no Easy.
    expect((await gradeAnswer(id, quick, 'learn')).rating).toBe(Rating.Good);
    // In regular reviews, last answer fine: Easy.
    await asReview();
    expect((await gradeAnswer(id, quick, 'review')).rating).toBe(Rating.Easy);
    // Missed it: the next quick answer is Good (Easy would skip relearning), and so is the first after relearning.
    await asReview();
    expect((await gradeAnswer(id, { missed: true }, 'review')).rating).toBe(Rating.Again);
    await asReview();
    expect((await gradeAnswer(id, quick, 'review')).rating).toBe(Rating.Good);
    // Slow is Hard either way.
    await asReview();
    expect((await gradeAnswer(id, { missed: false, ms: 12_000, limitMs: 10_000 }, 'review')).rating).toBe(Rating.Hard);
  });
});

describe('comparing coverage targets', () => {
  it('shows rare sidelines turning into gaps as the target gets deeper', async () => {
    const { compareTargets } = await import('../services/coverage');
    const { keysAlong } = await import('../lib/pgn');
    const { START_KEY } = await import('../lib/chess');
    const rep = await createRepertoire('Sicilian', 'black');
    await addLine(rep.id, ['e4', 'c5', 'Nf3', 'd6']);
    const stat = (moves: [string, string, number][]) => {
      const ms = moves.map(([san, uci, n]) => ({ san, uci, white: n, draws: 0, black: 0 }));
      const total = ms.reduce((a, m) => a + m.white, 0);
      return { total, white: total, draws: 0, black: 0, moves: ms };
    };
    const after = (l: string) => keysAlong(l.split(' ')).keys.at(-1)!;
    // 1.e4 85%, 1.b3 10%, 1.g3 5%; after 1.e4 c5: 2.Nf3 96%, 2.a3 4%.
    const stats: Record<string, ReturnType<typeof stat>> = {
      [START_KEY]: stat([['e4', 'e2e4', 85], ['b3', 'b2b3', 10], ['g3', 'g2g3', 5]]),
      [after('e4 c5')]: stat([['Nf3', 'g1f3', 96], ['a3', 'a2a3', 4]]),
    };
    const rows = await compareTargets('black', [10, 50], { provider: async (k) => stats[k] as never });
    const [at10, at50] = rows;
    expect(at10.n).toBe(10);
    // 1 in 10: 1.b3 (10%) is a gap; 1.g3 and 2.a3 (3.4%) are rare sidelines.
    expect(at10.notCovered).toBeCloseTo(0.1);
    expect(at10.sidelines).toBeCloseTo(0.05 + 0.85 * 0.04);
    expect(at10.open).toBe(1);
    // 1 in 50: all three are common enough — gaps, no sidelines left.
    expect(at50.notCovered).toBeCloseTo(0.1 + 0.05 + 0.85 * 0.04);
    expect(at50.sidelines).toBeCloseTo(0);
    expect(at50.open).toBe(3);
    expect(at50.moves).toBeGreaterThanOrEqual(at10.moves);
  });
});
