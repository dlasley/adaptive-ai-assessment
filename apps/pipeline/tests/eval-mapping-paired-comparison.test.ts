import { describe, expect, it } from 'vitest';
import { meanAndCi95, pairedMappingComparison, mappingNoiseFloor, type PairedMappingOutcome } from '../src/lib/eval/scoring';

describe('meanAndCi95', () => {
  it('returns undefined for an empty sample', () => {
    expect(meanAndCi95([])).toBeUndefined();
  });

  it('computes the sample mean and a zero-width CI for a single value', () => {
    const result = meanAndCi95([0.5])!;
    expect(result.mean).toBe(0.5);
    expect(result.ci95.lower).toBeCloseTo(0.5, 10);
    expect(result.ci95.upper).toBeCloseTo(0.5, 10);
  });

  it('matches a hand-computed mean and CI', () => {
    // mean 3, sample variance (Bessel-corrected) 2.5, SE = sqrt(2.5/5) ≈ 0.70710678.
    const result = meanAndCi95([1, 2, 3, 4, 5])!;
    expect(result.mean).toBe(3);
    const expectedSe = Math.sqrt(2.5 / 5);
    expect(result.ci95.lower).toBeCloseTo(3 - 1.96 * expectedSe, 8);
    expect(result.ci95.upper).toBeCloseTo(3 + 1.96 * expectedSe, 8);
  });
});

function pair(baselineF1: number, candidateF1: number, itemId = `item-${Math.random()}`): PairedMappingOutcome {
  return { itemId, baselineF1, candidateF1 };
}

describe('pairedMappingComparison', () => {
  it('throws on an empty outcome list', () => {
    expect(() => pairedMappingComparison([])).toThrow();
  });

  it('computes baseline/candidate means and their diff', () => {
    const result = pairedMappingComparison([pair(1, 1), pair(0.5, 0.75), pair(0, 0.5)]);
    expect(result.n).toBe(3);
    expect(result.baselineMeanF1).toBeCloseTo(0.5, 10);
    expect(result.candidateMeanF1).toBeCloseTo(0.75, 10);
    expect(result.diff).toBeCloseTo(0.25, 10);
  });

  it('gives p-value 1 when every item has an identical (zero) diff', () => {
    const result = pairedMappingComparison([pair(1, 1), pair(0.5, 0.5), pair(0, 0)]);
    expect(result.diff).toBe(0);
    expect(result.pValue).toBe(1);
    expect(result.ci95.lower).toBeCloseTo(0, 10);
    expect(result.ci95.upper).toBeCloseTo(0, 10);
  });

  it('scores three identical small improvements as suggestive, not significant (sign test on 3 of 3)', () => {
    const result = pairedMappingComparison([pair(0.5, 0.6), pair(0.5, 0.6), pair(0.5, 0.6)]);
    expect(result.diff).toBeCloseTo(0.1, 10);
    expect(result.candidateBetter).toBe(3);
    expect(result.baselineBetter).toBe(0);
    expect(result.ties).toBe(0);
    expect(result.pValue).toBeCloseTo(0.25, 10);
  });

  it('leaves tied items out of the sign test and counts them', () => {
    const result = pairedMappingComparison([pair(1, 1), pair(1, 1), pair(1, 1), pair(1, 1), pair(0.5, 0.6)]);
    expect(result.ties).toBe(4);
    expect(result.candidateBetter).toBe(1);
    expect(result.pValue).toBe(1);
  });

  it('reports a smaller p-value for a larger, more consistent difference than a noisy, small one', () => {
    // Same mean diff (0.1) in both cases, but the second has much higher variance.
    const consistent = pairedMappingComparison([pair(0, 0.1), pair(0, 0.1), pair(0, 0.1), pair(0, 0.1)]);
    const noisy = pairedMappingComparison([pair(0, 0.5), pair(0, -0.3), pair(0, 0.4), pair(0, -0.2)]);
    expect(consistent.diff).toBeCloseTo(noisy.diff, 6);
    expect(consistent.pValue).toBeLessThan(noisy.pValue);
  });

  it('reports diff and p-value symmetrically when baseline and candidate are swapped', () => {
    const outcomes = [pair(0.2, 0.8), pair(0.4, 0.6), pair(0.5, 0.5)];
    const swapped: PairedMappingOutcome[] = outcomes.map((o) => ({ itemId: o.itemId, baselineF1: o.candidateF1, candidateF1: o.baselineF1 }));
    const result = pairedMappingComparison(outcomes);
    const swappedResult = pairedMappingComparison(swapped);
    expect(swappedResult.diff).toBeCloseTo(-result.diff, 10);
    expect(swappedResult.pValue).toBeCloseTo(result.pValue, 10);
  });
});

describe('mappingNoiseFloor', () => {
  it('returns NaN for an empty outcome list', () => {
    expect(mappingNoiseFloor([])).toBeNaN();
  });

  it('computes the mean absolute F1 difference between two repeats', () => {
    const outcomes = [
      { itemId: 'a', f1A: 1, f1B: 0.8 },
      { itemId: 'b', f1A: 0.5, f1B: 0.5 },
      { itemId: 'c', f1A: 0, f1B: 0.3 },
    ];
    // |1-0.8| + |0.5-0.5| + |0-0.3| = 0.2 + 0 + 0.3 = 0.5, mean = 0.5/3.
    expect(mappingNoiseFloor(outcomes)).toBeCloseTo(0.5 / 3, 10);
  });

  it('is symmetric in which repeat is "A" and which is "B"', () => {
    const outcomes = [{ itemId: 'a', f1A: 0.9, f1B: 0.3 }];
    const swapped = [{ itemId: 'a', f1A: 0.3, f1B: 0.9 }];
    expect(mappingNoiseFloor(outcomes)).toBeCloseTo(mappingNoiseFloor(swapped), 10);
  });
});
