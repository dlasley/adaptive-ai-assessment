import { describe, expect, it } from 'vitest';
import { mulberry32, shuffle, stratifiedSample } from '../src/lib/eval/sampling';

interface Item {
  id: string;
  type: 'multiple-choice' | 'fill-in-blank';
  difficulty: 'beginner' | 'intermediate' | 'advanced';
}

function makeItems(): Item[] {
  const items: Item[] = [];
  // 60 multiple-choice (40 beginner, 20 advanced), 40 fill-in-blank (all intermediate).
  for (let i = 0; i < 40; i++) items.push({ id: `mc-beg-${i}`, type: 'multiple-choice', difficulty: 'beginner' });
  for (let i = 0; i < 20; i++) items.push({ id: `mc-adv-${i}`, type: 'multiple-choice', difficulty: 'advanced' });
  for (let i = 0; i < 40; i++) items.push({ id: `fib-int-${i}`, type: 'fill-in-blank', difficulty: 'intermediate' });
  return items;
}

const keyFn = (item: Item) => `${item.type}:${item.difficulty}`;

describe('mulberry32', () => {
  it('produces the same sequence for the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('produces a different sequence for a different seed', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });

  it('stays within [0, 1)', () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const value = rand();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('shuffle', () => {
  it('is deterministic for a given rng and preserves the item set', () => {
    const items = [1, 2, 3, 4, 5];
    const a = shuffle(items, mulberry32(9));
    const b = shuffle(items, mulberry32(9));
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual(items);
  });

  it('does not mutate the input array', () => {
    const items = [1, 2, 3];
    const copy = [...items];
    shuffle(items, mulberry32(1));
    expect(items).toEqual(copy);
  });
});

describe('stratifiedSample', () => {
  it('is deterministic given the same seed', () => {
    const items = makeItems();
    const a = stratifiedSample(items, { size: 20, keyFn, seed: 123 });
    const b = stratifiedSample(items, { size: 20, keyFn, seed: 123 });
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
    expect(a.strataCounts).toEqual(b.strataCounts);
  });

  it('records the seed it was given', () => {
    const result = stratifiedSample(makeItems(), { size: 10, keyFn, seed: 55 });
    expect(result.seed).toBe(55);
  });

  it('generates and records a seed when none is given', () => {
    const result = stratifiedSample(makeItems(), { size: 10, keyFn });
    expect(typeof result.seed).toBe('number');
  });

  it('allocates proportionally across strata (largest-remainder method)', () => {
    // 100 items: 40% mc-beginner, 20% mc-advanced, 40% fib-intermediate. Sampling 10 should give
    // exactly 4 / 2 / 4 — no remainder to distribute.
    const result = stratifiedSample(makeItems(), { size: 10, keyFn, seed: 1 });
    expect(result.strataCounts).toEqual({
      'multiple-choice:beginner': 4,
      'multiple-choice:advanced': 2,
      'fill-in-blank:intermediate': 4,
    });
    expect(result.items).toHaveLength(10);
  });

  it('sums strata counts to the requested size even when shares are not exact', () => {
    // Size 7 against a 40/20/40 split: exact shares are 2.8 / 1.4 / 2.8 -> floors 2/1/2 = 5,
    // remaining 2 seats go to the two largest remainders (0.8 and 0.8, tie broken by key order).
    const result = stratifiedSample(makeItems(), { size: 7, keyFn, seed: 1 });
    const total = Object.values(result.strataCounts).reduce((a, b) => a + b, 0);
    expect(total).toBe(7);
    expect(result.items).toHaveLength(7);
  });

  it('never allocates a stratum more items than it actually has', () => {
    const items: Item[] = [
      { id: 'rare', type: 'fill-in-blank', difficulty: 'advanced' },
      ...Array.from({ length: 99 }, (_, i) => ({ id: `common-${i}`, type: 'multiple-choice' as const, difficulty: 'beginner' as const })),
    ];
    const result = stratifiedSample(items, { size: 10, keyFn, seed: 1 });
    expect(result.strataCounts['fill-in-blank:advanced']).toBeLessThanOrEqual(1);
    expect(result.strataCounts['multiple-choice:beginner']).toBeLessThanOrEqual(99);
  });

  it('clamps to the population size when size exceeds the item count', () => {
    const items = makeItems().slice(0, 5);
    const result = stratifiedSample(items, { size: 1000, keyFn, seed: 1 });
    expect(result.items).toHaveLength(5);
  });

  it('never samples the same item twice within a stratum', () => {
    const result = stratifiedSample(makeItems(), { size: 50, keyFn, seed: 42 });
    const ids = result.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
