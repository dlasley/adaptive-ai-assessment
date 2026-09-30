import { describe, expect, it } from 'vitest';
import {
  planInterleavedCalls,
  planAuditGroupCalls,
  percentile,
  expectedIsCorrect,
  buildGradingRunSummary,
  buildAuditRunSummary,
  type GradingItemOutcome,
  type AuditItemOutcome,
} from '../src/lib/eval/runner';

describe('planInterleavedCalls', () => {
  it('schedules one call per model per block, in interleaved order', () => {
    const items = Array.from({ length: 55 }, (_, i) => i);
    const calls = planInterleavedCalls(items, ['baseline', 'candidate'], 25);

    expect(calls.map((c) => `${c.blockIndex}:${c.variant}`)).toEqual([
      '0:baseline', '0:candidate',
      '1:baseline', '1:candidate',
      '2:baseline', '2:candidate',
    ]);
    expect(calls[0].items).toHaveLength(25);
    expect(calls[4].items).toHaveLength(5); // last block, 55 - 50 = 5
  });

  it('produces one block when items fit within blockSize', () => {
    const calls = planInterleavedCalls([1, 2, 3], ['m1'], 25);
    expect(calls).toHaveLength(1);
    expect(calls[0].items).toEqual([1, 2, 3]);
  });

  it('returns an empty plan for no items', () => {
    expect(planInterleavedCalls([], ['m1', 'm2'], 25)).toEqual([]);
  });
});

describe('planAuditGroupCalls', () => {
  it('splits each block into groupSize-sized groups per variant, preserving item order', () => {
    const items = Array.from({ length: 7 }, (_, i) => i);
    const calls = planAuditGroupCalls(items, ['baseline'], 25, 3);

    expect(calls.map((c) => c.items)).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
    expect(calls.every((c) => c.variant === 'baseline')).toBe(true);
  });

  it('at groupSize 1, every call carries exactly one item', () => {
    const items = Array.from({ length: 4 }, (_, i) => i);
    const calls = planAuditGroupCalls(items, ['baseline'], 25, 1);

    expect(calls.map((c) => c.items)).toEqual([[0], [1], [2], [3]]);
  });

  it('interleaves variants within a block before moving to the next block, at any group size', () => {
    const items = Array.from({ length: 6 }, (_, i) => i);
    const calls = planAuditGroupCalls(items, ['a', 'b'], 3, 3); // one block of 3, one group per block

    // Block 0 (items 0-2): a's group, then b's group. Block 1 (items 3-5): a's group, then b's.
    expect(calls.map((c) => `${c.variant}:${c.items.join('')}`)).toEqual(['a:012', 'b:012', 'a:345', 'b:345']);
  });

  it('a group size larger than the block still caps at one group per block', () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const calls = planAuditGroupCalls(items, ['m'], 5, 25); // blockSize 5 < groupSize 25
    expect(calls.map((c) => c.items)).toEqual([[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]]);
  });

  it('returns an empty plan for no items', () => {
    expect(planAuditGroupCalls([], ['m1'], 25, 5)).toEqual([]);
  });
});

describe('percentile', () => {
  it('returns undefined for an empty array', () => {
    expect(percentile([], 50)).toBeUndefined();
  });

  it('computes p50 and p95 by nearest rank', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(100);
  });

  it('does not mutate the input array', () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('expectedIsCorrect', () => {
  it('reads the reviewer verdict directly', () => {
    expect(expectedIsCorrect({ isCorrect: true, borderline: false, reason: null, keyCorrect: true, keyNote: null })).toBe(true);
    expect(expectedIsCorrect({ isCorrect: false, borderline: false, reason: 'wrong gender agreement', keyCorrect: true, keyNote: null })).toBe(false);
  });

  it('ignores keyCorrect/keyNote — isCorrect is already the reviewer\'s verdict against whatever key they judged against', () => {
    expect(expectedIsCorrect({ isCorrect: true, borderline: false, reason: null, keyCorrect: false, keyNote: 'should accept plural too' })).toBe(true);
  });
});

describe('buildGradingRunSummary', () => {
  const outcomes: GradingItemOutcome[] = [
    { itemId: '1', labelClass: 'correct', difficulty: 'beginner', reference: { isCorrect: true, borderline: false, reason: null, keyCorrect: true, keyNote: null }, output: { isCorrect: true, score: 100 } },
    { itemId: '2', labelClass: 'correct', difficulty: 'beginner', reference: { isCorrect: true, borderline: false, reason: null, keyCorrect: true, keyNote: null }, output: { isCorrect: false, score: 40 } }, // false negative
    { itemId: '3', labelClass: 'wrong', difficulty: 'advanced', reference: { isCorrect: false, borderline: false, reason: 'missing verb', keyCorrect: true, keyNote: null }, output: { isCorrect: true, score: 80 } }, // false positive
    { itemId: '4', labelClass: 'wrong', difficulty: 'advanced', reference: { isCorrect: false, borderline: false, reason: 'wrong word', keyCorrect: true, keyNote: null }, output: { isCorrect: false, score: 10 } },
    { itemId: '5', labelClass: 'partially_correct', difficulty: 'intermediate', reference: { isCorrect: true, borderline: true, reason: 'accent missing but close', keyCorrect: true, keyNote: null }, output: { isCorrect: true, score: 78 } },
    { itemId: '6', labelClass: 'typo', difficulty: 'beginner', error: 'parse' },
  ];

  it('counts item and reference item totals', () => {
    const summary = buildGradingRunSummary(outcomes);
    expect(summary.itemCount).toBe(6);
    expect(summary.referenceItemCount).toBe(5);
  });

  it('computes overall agreement, false-negative, and false-positive rates', () => {
    const summary = buildGradingRunSummary(outcomes);
    // Expected-correct items (reference): 1, 2, 5 (n=3) -> 1 false negative (item 2) -> FN rate 1/3.
    // Expected-incorrect items (reference): 3, 4 (n=2) -> 1 false positive (item 3) -> FP rate 1/2.
    // Agreement: items 1,4,5 agree (3), items 2,3 disagree (2) -> 3/5.
    expect(summary.overall.n).toBe(5);
    expect(summary.overall.agreementRate).toBeCloseTo(3 / 5, 10);
    expect(summary.overall.falseNegativeRate).toBeCloseTo(1 / 3, 10);
    expect(summary.overall.falsePositiveRate).toBeCloseTo(1 / 2, 10);
  });

  it('computes parse failure rate over all items, including ungraded ones', () => {
    const summary = buildGradingRunSummary(outcomes);
    expect(summary.parseFailureRate).toBeCloseTo(1 / 6, 10);
  });

  it('breaks down by difficulty and label', () => {
    const summary = buildGradingRunSummary(outcomes);
    expect(summary.byDifficulty.beginner.n).toBe(2); // items 1, 2 (item 6 has no reference/output)
    expect(summary.byDifficulty.advanced.n).toBe(2);
    expect(summary.byLabel.wrong.n).toBe(2);
    expect(summary.byLabel.correct.n).toBe(2);
  });
});

describe('buildGradingRunSummary byDesignLabel', () => {
  // Covers every GradingLabelClass, independent of reference (none of these carry one) — the
  // block this feature exists for, since a fresh run's items are seeded before a reviewer ever
  // looks at them.
  const outcomes: GradingItemOutcome[] = [
    { itemId: '1', labelClass: 'correct', difficulty: 'beginner', output: { isCorrect: true, score: 100 } },
    { itemId: '2', labelClass: 'correct', difficulty: 'beginner', output: { isCorrect: false, score: 40 } },
    { itemId: '3', labelClass: 'wrong', difficulty: 'advanced', output: { isCorrect: false, score: 10 } },
    { itemId: '4', labelClass: 'wrong', difficulty: 'advanced', output: { isCorrect: true, score: 80 } },
    { itemId: '5', labelClass: 'typo', difficulty: 'beginner', output: { isCorrect: true, score: 95 } },
    { itemId: '6', labelClass: 'typo', difficulty: 'beginner', output: { isCorrect: true, score: 90 } },
    { itemId: '7', labelClass: 'missing_accent', difficulty: 'beginner', output: { isCorrect: false, score: 50 } },
    { itemId: '8', labelClass: 'valid_paraphrase', difficulty: 'intermediate', output: { isCorrect: true, score: 88 } },
    { itemId: '9', labelClass: 'valid_paraphrase', difficulty: 'intermediate', output: { isCorrect: false, score: 30 } },
    { itemId: '10', labelClass: 'partially_correct', difficulty: 'intermediate', output: { isCorrect: true, score: 70 } },
    { itemId: '11', labelClass: 'partially_correct', difficulty: 'intermediate', error: 'parse' }, // no output: excluded from its class's rate
  ];

  it('computes one entry per seeded class from output alone, ignoring reference entirely', () => {
    const { byDesignLabel } = buildGradingRunSummary(outcomes);
    expect(byDesignLabel.correct).toEqual({ n: 2, markedCorrectRate: 0.5 });
    expect(byDesignLabel.wrong).toEqual({ n: 2, markedCorrectRate: 0.5 });
    expect(byDesignLabel.typo).toEqual({ n: 2, markedCorrectRate: 1 });
    expect(byDesignLabel.missing_accent).toEqual({ n: 1, markedCorrectRate: 0 });
    expect(byDesignLabel.valid_paraphrase).toEqual({ n: 2, markedCorrectRate: 0.5 });
    expect(byDesignLabel.partially_correct).toEqual({ n: 1, markedCorrectRate: 1 }); // item 11 excluded (no output)
  });

  it('computes provisional rates against each class\'s designed meaning', () => {
    const { byDesignLabel } = buildGradingRunSummary(outcomes);
    expect(byDesignLabel.provisional.falsePositiveRateOnWrong).toBeCloseTo(0.5, 10); // wrong's markedCorrectRate
    expect(byDesignLabel.provisional.falseNegativeRateOnCorrect).toBeCloseTo(0.5, 10); // 1 - correct's markedCorrectRate
    expect(byDesignLabel.provisional.falseNegativeRateOnParaphrase).toBeCloseTo(0.5, 10); // 1 - valid_paraphrase's markedCorrectRate
    expect(byDesignLabel.provisional.typoMarkedCorrectRate).toBe(1); // reported, not judged
  });

  it('reports null, never NaN, for a provisional rate whose class has no output at all', () => {
    const noWrong = buildGradingRunSummary(outcomes.filter((o) => o.labelClass !== 'wrong'));
    expect(noWrong.byDesignLabel.wrong).toBeUndefined();
    expect(noWrong.byDesignLabel.provisional.falsePositiveRateOnWrong).toBeNull();
  });
});

describe('buildAuditRunSummary', () => {
  const passVerdict = {
    answer_correct: true, grammar_correct: true, no_hallucination: true,
    question_coherent: true, natural_language: true, register_appropriate: true,
  };
  const failVerdict = { ...passVerdict, grammar_correct: false };

  const outcomes: AuditItemOutcome[] = [
    { itemId: '1', reference: passVerdict, output: passVerdict },
    { itemId: '2', reference: failVerdict, output: failVerdict }, // true positive on grammar_correct
    { itemId: '3', reference: failVerdict, output: passVerdict }, // false negative on grammar_correct (variant missed it)
    { itemId: '4', reference: passVerdict, output: failVerdict }, // false positive on grammar_correct
    { itemId: '5', productionAudit: passVerdict, output: passVerdict }, // production-verdict-only, agrees
    { itemId: '6', productionAudit: failVerdict, output: passVerdict }, // production-verdict-only, disagrees
    { itemId: '7', error: 'parse' },
  ];

  it('computes precision/recall/F1 for grammar_correct against reference', () => {
    const summary = buildAuditRunSummary(outcomes);
    expect(summary.referenceItemCount).toBe(4);
    const grammar = summary.reference!.grammar_correct;
    // "should flag" (reference false) is the positive class: TP=1 (item2), FP=1 (item4), FN=1 (item3).
    expect(grammar.precision).toBeCloseTo(0.5, 10);
    expect(grammar.recall).toBeCloseTo(0.5, 10);
    expect(grammar.f1).toBeCloseTo(0.5, 10);
  });

  it('computes overall gate-pass accuracy against reference', () => {
    const summary = buildAuditRunSummary(outcomes);
    // item1: reference pass, variant pass -> agree. item2: reference fail, variant fail -> agree.
    // item3: reference fail, variant pass -> disagree. item4: reference pass, variant fail -> disagree.
    expect(summary.overallAccuracyReference).toBeCloseTo(0.5, 10);
  });

  it('computes agreement with production only for items without reference', () => {
    const summary = buildAuditRunSummary(outcomes);
    expect(summary.productionAgreement).toEqual({ n: 2, agreementRate: 0.5 });
  });

  it('computes parse failure rate over all items', () => {
    const summary = buildAuditRunSummary(outcomes);
    expect(summary.parseFailureRate).toBeCloseTo(1 / 7, 10);
  });
});
