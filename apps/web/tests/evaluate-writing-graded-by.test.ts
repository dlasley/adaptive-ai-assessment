import { describe, expect, it } from 'vitest';
import { gradedByForTier } from '@/lib/evaluate-writing/graded-by';
import { GRADED_BY_VALUES } from '@adaptive/shared/enums';

describe('gradedByForTier', () => {
  it.each([
    ['empty_check', 'empty'],
    ['exact_match', 'exact'],
    ['noise_check', 'noise'],
    ['semantic', 'semantic'],
  ] as const)('maps the %s tier to %s', (tier, expected) => {
    expect(gradedByForTier(tier)).toBe(expected);
  });

  it.each([
    ['empty_check', 'empty'],
    ['exact_match', 'exact'],
    ['noise_check', 'noise'],
    ['semantic', 'semantic'],
  ] as const)('ignores match info for the %s tier', (tier, expected) => {
    expect(gradedByForTier(tier, { matchedAgainst: 'acceptable_variation', matchKind: 'adjacent_swap' })).toBe(expected);
  });

  it.each([
    ['exact', 'primary_answer', 'exact'],
    ['exact', 'acceptable_variation', 'variation'],
    ['adjacent_swap', 'primary_answer', 'swap'],
    ['adjacent_swap', 'acceptable_variation', 'variation_swap'],
  ] as const)('maps a fuzzy %s match against the %s to %s', (matchKind, matchedAgainst, expected) => {
    expect(gradedByForTier('fuzzy_match', { matchKind, matchedAgainst })).toBe(expected);
  });

  it('counts an undescribed fuzzy match as a swap', () => {
    expect(gradedByForTier('fuzzy_match')).toBe('swap');
    expect(gradedByForTier('fuzzy_match', { matchedAgainst: 'primary_answer' })).toBe('swap');
    expect(gradedByForTier('fuzzy_match', { matchedAgainst: 'acceptable_variation' })).toBe('variation_swap');
  });

  it('never returns a value outside the stored enum', () => {
    const produced = [
      gradedByForTier('empty_check'),
      gradedByForTier('exact_match'),
      gradedByForTier('noise_check'),
      gradedByForTier('semantic'),
      gradedByForTier('fuzzy_match', { matchKind: 'exact', matchedAgainst: 'primary_answer' }),
      gradedByForTier('fuzzy_match', { matchKind: 'exact', matchedAgainst: 'acceptable_variation' }),
      gradedByForTier('fuzzy_match', { matchKind: 'adjacent_swap', matchedAgainst: 'primary_answer' }),
      gradedByForTier('fuzzy_match', { matchKind: 'adjacent_swap', matchedAgainst: 'acceptable_variation' }),
    ];

    expect(new Set(produced)).toEqual(new Set(GRADED_BY_VALUES));
  });
});
