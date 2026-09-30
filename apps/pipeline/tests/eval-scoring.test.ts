import { describe, expect, it } from 'vitest';
import {
  mcnemarExactPValue,
  pairedComparison,
  nonInferiorityVerdict,
  type PairedItemOutcome,
} from '../src/lib/eval/scoring';

/** Ten hand-computed outcomes: 4 both-pass, 2 baseline-only, 3 candidate-only, 1 both-fail. */
const HAND_COMPUTED: PairedItemOutcome[] = [
  { itemId: '1', baselinePass: true, candidatePass: true },
  { itemId: '2', baselinePass: true, candidatePass: true },
  { itemId: '3', baselinePass: true, candidatePass: true },
  { itemId: '4', baselinePass: true, candidatePass: true },
  { itemId: '5', baselinePass: true, candidatePass: false },
  { itemId: '6', baselinePass: true, candidatePass: false },
  { itemId: '7', baselinePass: false, candidatePass: true },
  { itemId: '8', baselinePass: false, candidatePass: true },
  { itemId: '9', baselinePass: false, candidatePass: true },
  { itemId: '10', baselinePass: false, candidatePass: false },
];

describe('mcnemarExactPValue', () => {
  it('returns 1 when there are no discordant pairs', () => {
    expect(mcnemarExactPValue(0, 0)).toBe(1);
  });

  it('matches a hand-computed value for b=2, c=3 (n=5)', () => {
    // sum_{i=0}^{2} C(5,i) / 2^5 = (1 + 5 + 10) / 32 = 0.5; doubled and capped at 1.
    expect(mcnemarExactPValue(2, 3)).toBeCloseTo(1, 10);
  });

  it('matches a hand-computed value for b=1, c=9 (n=10, strongly asymmetric)', () => {
    // sum_{i=0}^{1} C(10,i) / 2^10 = (1 + 10) / 1024 = 0.0107421875; doubled.
    expect(mcnemarExactPValue(1, 9)).toBeCloseTo(0.021484375, 10);
  });

  it('is symmetric in b and c', () => {
    expect(mcnemarExactPValue(2, 7)).toBeCloseTo(mcnemarExactPValue(7, 2), 10);
  });
});

describe('pairedComparison', () => {
  it('throws on an empty outcome list', () => {
    expect(() => pairedComparison([])).toThrow();
  });

  it('computes pass rates, discordant counts, and diff for the hand-computed fixture', () => {
    const result = pairedComparison(HAND_COMPUTED);
    expect(result.n).toBe(10);
    expect(result.baselinePassRate).toBeCloseTo(0.6, 10);
    expect(result.candidatePassRate).toBeCloseTo(0.7, 10);
    expect(result.diff).toBeCloseTo(0.1, 10);
    expect(result.discordant).toEqual({ baselineOnly: 2, candidateOnly: 3 });
  });

  it('computes the McNemar p-value from its own discordant counts', () => {
    const result = pairedComparison(HAND_COMPUTED);
    expect(result.mcnemarPValue).toBeCloseTo(mcnemarExactPValue(2, 3), 10);
  });

  it('computes a 95% CI on diff matching the hand-derived variance', () => {
    // d_i = candidatePass - baselinePass: four 0s from items 1-4, two -1s (5,6), three +1s
    // (7,8,9), one 0 (10). sumDiffSquared = 2*1 + 3*1 = 5, meanSq = 0.5, diff = 0.1,
    // variance = 0.5 - 0.01 = 0.49, SE = sqrt(0.49/10) ≈ 0.2213594362.
    const result = pairedComparison(HAND_COMPUTED);
    const expectedSe = Math.sqrt(0.49 / 10);
    expect(result.ci95.lower).toBeCloseTo(0.1 - 1.96 * expectedSe, 8);
    expect(result.ci95.upper).toBeCloseTo(0.1 + 1.96 * expectedSe, 8);
  });

  it('collapses to a zero-width CI and p=1 when every item agrees (zero discordant)', () => {
    const outcomes: PairedItemOutcome[] = [
      { itemId: 'a', baselinePass: true, candidatePass: true },
      { itemId: 'b', baselinePass: true, candidatePass: true },
      { itemId: 'c', baselinePass: false, candidatePass: false },
      { itemId: 'd', baselinePass: false, candidatePass: false },
    ];
    const result = pairedComparison(outcomes);
    expect(result.diff).toBe(0);
    expect(result.discordant).toEqual({ baselineOnly: 0, candidateOnly: 0 });
    expect(result.mcnemarPValue).toBe(1);
    expect(result.ci95.lower).toBeCloseTo(0, 10);
    expect(result.ci95.upper).toBeCloseTo(0, 10);
  });
});

describe('nonInferiorityVerdict', () => {
  it('passes a higher-is-better task (audit) when candidate is within tolerance below baseline', () => {
    const comparison = pairedComparison([
      { itemId: '1', baselinePass: true, candidatePass: true },
      { itemId: '2', baselinePass: true, candidatePass: false }, // one regression out of 50
      ...Array.from({ length: 48 }, (_, i) => ({ itemId: `p${i}`, baselinePass: true, candidatePass: true })),
    ]);
    // baseline 1.0, candidate 0.98 — within the 3pp audit tolerance.
    const verdict = nonInferiorityVerdict('audit', comparison);
    expect(verdict.nonInferior).toBe(true);
    expect(verdict.direction).toBe('higher-is-better');
  });

  it('fails a higher-is-better task when candidate regresses past tolerance', () => {
    const comparison = pairedComparison([
      ...Array.from({ length: 10 }, (_, i) => ({ itemId: `pass${i}`, baselinePass: true, candidatePass: true })),
      ...Array.from({ length: 5 }, (_, i) => ({ itemId: `fail${i}`, baselinePass: true, candidatePass: false })),
    ]);
    // baseline 1.0, candidate 10/15 ≈ 0.667 — well past the 3pp audit tolerance.
    const verdict = nonInferiorityVerdict('audit', comparison);
    expect(verdict.nonInferior).toBe(false);
  });

  it('passes a lower-is-better task (grading false-negative rate) when candidate is within +1pp', () => {
    // For a lower-is-better metric, "pass" means the bad event occurred (a false negative), so
    // passRate IS the metric being bounded — baseline has none, candidate has exactly 1/100 (+1pp).
    const comparison = pairedComparison([
      ...Array.from({ length: 99 }, (_, i) => ({ itemId: `ok${i}`, baselinePass: false, candidatePass: false })),
      { itemId: 'fn', baselinePass: false, candidatePass: true },
    ]);
    const verdict = nonInferiorityVerdict('grading', comparison);
    expect(verdict.nonInferior).toBe(true);
  });

  it('fails a lower-is-better task when candidate regresses past +1pp', () => {
    const comparison = pairedComparison([
      ...Array.from({ length: 97 }, (_, i) => ({ itemId: `ok${i}`, baselinePass: false, candidatePass: false })),
      ...Array.from({ length: 3 }, (_, i) => ({ itemId: `fn${i}`, baselinePass: false, candidatePass: true })),
    ]);
    const verdict = nonInferiorityVerdict('grading', comparison);
    expect(verdict.nonInferior).toBe(false);
  });
});
