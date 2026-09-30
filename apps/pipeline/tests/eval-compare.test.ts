import { describe, expect, it } from 'vitest';
import {
  extractGradingPairedOutcomes,
  extractAuditPairedOutcomes,
  extractItemVerdictPairedOutcomes,
  findRejectedKeyQuestions,
  buildAuditOutcomesForRun,
  auditPerCriterionVerdict,
  auditCriterionFlips,
  auditFlagRates,
  groupingComparisonFor,
  findAuditDisagreements,
  buildCompareMarkdown,
  buildReferenceFreeCompareMarkdown,
} from '../src/lib/eval/compare/audit-grading';
import { extractMappingPairedOutcomes, mappingRunStats, buildMappingCompareMarkdown } from '../src/lib/eval/compare/mapping';
import { runCostLatency, providerPinMismatches } from '../src/lib/eval/compare/shared';
import { pairedComparison, pairedMappingComparison, mappingNoiseFloor, nonInferiorityVerdict } from '../src/lib/eval/scoring';
import type { EvalItemRow, EvalResultRow, EvalRunRow } from '../src/lib/eval/db';

function makeItem(id: string, payload: Record<string, unknown>, reference: Record<string, unknown> | null = null): EvalItemRow {
  return {
    id,
    set_id: 'set-1',
    item_key: id,
    payload,
    reference,
    reference_status: reference ? 'approved' : 'pending',
    reviewed_by: reference ? 'jsmith' : null,
    reviewed_at: null,
    notes: null,
    created_at: '',
    updated_at: '',
  };
}

function makeResult(overrides: Partial<EvalResultRow> = {}): EvalResultRow {
  return {
    id: 'r-1',
    run_id: 'run-1',
    item_id: 'item-1',
    output: null,
    judge_verdict: null,
    deterministic_checks: null,
    score: null,
    latency_ms: null,
    cost_usd: null,
    prompt_tokens: null,
    completion_tokens: null,
    reasoning_tokens: null,
    served_model: null,
    served_provider: null,
    is_byok: null,
    error: null,
    created_at: '2026-09-26T00:00:00Z',
    ...overrides,
  };
}

function makeRun(overrides: Partial<EvalRunRow> = {}): EvalRunRow {
  return {
    id: 'run-1',
    set_id: 'set-1',
    task: 'audit',
    variant_label: null,
    model: 'mistralai/mistral-large-2512',
    provider_pin: null,
    prompt_hash: null,
    settings: {},
    judge_model: null,
    judge_prompt_hash: null,
    repeat_index: 1,
    projected_cost_usd: null,
    status: 'completed',
    started_at: '2026-09-26T00:00:00Z',
    finished_at: '2026-09-26T00:01:00Z',
    summary: null,
    experiment_id: null,
    model_version_id: null,
    created_at: '2026-09-26T00:00:00Z',
    updated_at: '2026-09-26T00:01:00Z',
    ...overrides,
  };
}

const PASS_VERDICT = {
  answer_correct: true, grammar_correct: true, no_hallucination: true,
  question_coherent: true, natural_language: true, register_appropriate: true,
};

describe('providerPinMismatches', () => {
  it('returns empty when the run has no provider_pin', () => {
    const run = makeRun({ provider_pin: null });
    const results = [makeResult({ served_provider: 'Anthropic' })];
    expect(providerPinMismatches(run, results)).toEqual([]);
  });

  it('returns empty when every result matches the pin', () => {
    const run = makeRun({ provider_pin: 'Anthropic' });
    const results = [makeResult({ served_provider: 'Anthropic' }), makeResult({ served_provider: 'Anthropic' })];
    expect(providerPinMismatches(run, results)).toEqual([]);
  });

  it('flags a served_provider that differs from the pin', () => {
    const run = makeRun({ provider_pin: 'Anthropic' });
    const results = [makeResult({ served_provider: 'Anthropic' }), makeResult({ served_provider: 'Bedrock' })];
    expect(providerPinMismatches(run, results)).toEqual(['Bedrock']);
  });

  it('ignores a result with no served_provider recorded', () => {
    const run = makeRun({ provider_pin: 'Anthropic' });
    const results = [makeResult({ served_provider: null })];
    expect(providerPinMismatches(run, results)).toEqual([]);
  });

  describe('normalizes case, punctuation, and a pin\'s host-routing suffix before comparing', () => {
    it('matches a routing-suffixed pin against its bare host name (mistral/zdr vs Mistral)', () => {
      const run = makeRun({ provider_pin: 'mistral/zdr' });
      const results = [makeResult({ served_provider: 'Mistral' })];
      expect(providerPinMismatches(run, results)).toEqual([]);
    });

    it('matches a quantization-suffixed pin against its bare host name (nebius/fp8 vs Nebius)', () => {
      const run = makeRun({ provider_pin: 'nebius/fp8' });
      const results = [makeResult({ served_provider: 'Nebius' })];
      expect(providerPinMismatches(run, results)).toEqual([]);
    });

    it('matches differing capitalization with no slash (siliconflow vs SiliconFlow)', () => {
      const run = makeRun({ provider_pin: 'siliconflow' });
      const results = [makeResult({ served_provider: 'SiliconFlow' })];
      expect(providerPinMismatches(run, results)).toEqual([]);
    });

    it('matches punctuation variants naming the same host (google-ai-studio vs Google AI Studio)', () => {
      const run = makeRun({ provider_pin: 'google-ai-studio' });
      const results = [makeResult({ served_provider: 'Google AI Studio' })];
      expect(providerPinMismatches(run, results)).toEqual([]);
    });

    it('still flags a genuine mismatch after normalizing both sides', () => {
      const run = makeRun({ provider_pin: 'mistral/zdr' });
      const results = [makeResult({ served_provider: 'DeepInfra' })];
      expect(providerPinMismatches(run, results)).toEqual(['DeepInfra']);
    });
  });
});

describe('extractGradingPairedOutcomes', () => {
  it('restricts to items where reference expects correct, and marks pass=true as a false negative', () => {
    const itemReference = new Map([
      ['item-1', { isCorrect: true, borderline: false, reason: null, keyCorrect: true, keyNote: null }], // expected correct
      ['item-2', { isCorrect: false, borderline: false, reason: 'wrong verb', keyCorrect: true, keyNote: null }], // expected incorrect — excluded (FN undefined)
    ]);
    const baseline = [
      makeResult({ item_id: 'item-1', output: { isCorrect: true, score: 100 } }),
      makeResult({ item_id: 'item-2', output: { isCorrect: false, score: 10 } }),
    ];
    const candidate = [
      makeResult({ item_id: 'item-1', output: { isCorrect: false, score: 40 } }), // candidate false-negatives here
      makeResult({ item_id: 'item-2', output: { isCorrect: false, score: 10 } }),
    ];

    const outcomes = extractGradingPairedOutcomes(itemReference, baseline, candidate);
    expect(outcomes).toEqual([{ itemId: 'item-1', baselinePass: false, candidatePass: true }]);
  });

  it('skips an item where either variant errored (no output)', () => {
    const itemReference = new Map([['item-1', { isCorrect: true, borderline: false, reason: null, keyCorrect: true, keyNote: null }]]);
    const baseline = [makeResult({ item_id: 'item-1', output: { isCorrect: true, score: 100 } })];
    const candidate = [makeResult({ item_id: 'item-1', output: null, error: 'api' })];
    expect(extractGradingPairedOutcomes(itemReference, baseline, candidate)).toEqual([]);
  });
});

describe('findRejectedKeyQuestions', () => {
  const rejectedReference = { isCorrect: true, borderline: false, reason: null, keyCorrect: false, keyNote: 'should accept the plural too' };
  const acceptedReference = { isCorrect: true, borderline: false, reason: null, keyCorrect: true, keyNote: null };

  it('finds every group whose reference marks the key Incorrect, truncating the question to 80 characters', () => {
    const longQuestion = 'Q'.repeat(100);
    const items = [
      makeItem('q1-a', { question_id: 'q1', question: longQuestion }, rejectedReference),
      makeItem('q1-b', { question_id: 'q1', question: longQuestion }, rejectedReference),
      makeItem('q2-a', { question_id: 'q2', question: 'fine question' }, acceptedReference),
    ];

    const rejected = findRejectedKeyQuestions(items);
    expect(rejected).toEqual([{ questionRef: 'q1', question: longQuestion.slice(0, 80), itemIds: ['q1-a', 'q1-b'] }]);
    expect(rejected[0].question).toHaveLength(80);
  });

  it('returns nothing when every group accepts its key', () => {
    const items = [makeItem('q1-a', { question_id: 'q1', question: 'x' }, acceptedReference)];
    expect(findRejectedKeyQuestions(items)).toEqual([]);
  });
});

describe('extractAuditPairedOutcomes', () => {
  const passVerdict = {
    answer_correct: true, grammar_correct: true, no_hallucination: true,
    question_coherent: true, natural_language: true, register_appropriate: true,
  };

  it('emits one row per should-flag criterion, pass=true meaning the variant caught it', () => {
    const itemReference = new Map([
      ['item-1', { ...passVerdict, grammar_correct: false }], // should flag grammar_correct only
    ]);
    const baseline = [makeResult({ item_id: 'item-1', output: { ...passVerdict, grammar_correct: false } })]; // caught it
    const candidate = [makeResult({ item_id: 'item-1', output: passVerdict })]; // missed it

    const outcomes = extractAuditPairedOutcomes(itemReference, baseline, candidate);
    expect(outcomes).toEqual([{ itemId: 'item-1:grammar_correct', baselinePass: true, candidatePass: false }]);
  });

  it('produces no rows for an item where reference has no should-flag criteria', () => {
    const itemReference = new Map([['item-1', passVerdict]]);
    const baseline = [makeResult({ item_id: 'item-1', output: passVerdict })];
    const candidate = [makeResult({ item_id: 'item-1', output: passVerdict })];
    expect(extractAuditPairedOutcomes(itemReference, baseline, candidate)).toEqual([]);
  });
});

describe('buildAuditOutcomesForRun', () => {
  it('builds one outcome per reference item, independent of any other run', () => {
    const passVerdict = {
      answer_correct: true, grammar_correct: true, no_hallucination: true,
      question_coherent: true, natural_language: true, register_appropriate: true,
    };
    const itemReference = new Map([
      ['item-1', passVerdict],
      ['item-2', { ...passVerdict, grammar_correct: false }],
    ]);
    const results = [
      { id: 'r-1', run_id: 'run-1', item_id: 'item-1', output: passVerdict, judge_verdict: null, deterministic_checks: null, score: null, latency_ms: null, cost_usd: null, prompt_tokens: null, completion_tokens: null, reasoning_tokens: null, served_model: null, served_provider: null, is_byok: null, error: null, created_at: 'now' } as EvalResultRow,
    ];
    const outcomes = buildAuditOutcomesForRun(itemReference, results);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.find((o) => o.itemId === 'item-1')?.output).toEqual(passVerdict);
    expect(outcomes.find((o) => o.itemId === 'item-2')?.output).toBeUndefined(); // no result for this item
  });
});

describe('auditPerCriterionVerdict', () => {
  const passVerdict = {
    answer_correct: true, grammar_correct: true, no_hallucination: true,
    question_coherent: true, natural_language: true, register_appropriate: true,
  };

  it('passes every criterion when baseline and candidate recall/precision are identical', () => {
    const outcomes = [
      { itemId: '1', reference: { ...passVerdict, grammar_correct: false }, output: { ...passVerdict, grammar_correct: false } },
      { itemId: '2', reference: passVerdict, output: passVerdict },
    ];
    const verdicts = auditPerCriterionVerdict(outcomes, outcomes);
    expect(verdicts.every((v) => v.pass)).toBe(true);
  });

  it('fails a criterion whose candidate recall regresses past the 3pp tolerance', () => {
    // Baseline catches all 10 "should flag" items on grammar_correct (recall 1.0); candidate
    // catches only 9 of them (recall 0.9), an 10pp drop, well past the 3pp tolerance.
    const baselineOutcomes = Array.from({ length: 10 }, (_, i) => ({
      itemId: `${i}`,
      reference: { ...passVerdict, grammar_correct: false },
      output: { ...passVerdict, grammar_correct: false },
    }));
    const candidateOutcomes = baselineOutcomes.map((o, i) => ({
      ...o,
      output: i === 0 ? passVerdict : o.output, // misses exactly one
    }));

    const verdicts = auditPerCriterionVerdict(baselineOutcomes, candidateOutcomes);
    const grammar = verdicts.find((v) => v.criterion === 'grammar_correct')!;
    expect(grammar.recallOk).toBe(false);
    expect(grammar.pass).toBe(false);
  });

  it('passes vacuously when a criterion has no should-flag items for either variant (NaN recall/precision)', () => {
    const outcomes = [{ itemId: '1', reference: passVerdict, output: passVerdict }]; // never should-flag
    const verdicts = auditPerCriterionVerdict(outcomes, outcomes);
    expect(verdicts.every((v) => v.pass)).toBe(true);
    const grammar = verdicts.find((v) => v.criterion === 'grammar_correct')!;
    expect(Number.isNaN(grammar.baseline.recall)).toBe(true);
  });
});

describe('buildCompareMarkdown', () => {
  it('for grading, renders a table row per variant with the pooled verdict reason (grading is exact, not pooled)', () => {
    const comparison = pairedComparison([
      { itemId: '1', baselinePass: true, candidatePass: true },
      { itemId: '2', baselinePass: false, candidatePass: false },
    ]);
    const verdict = nonInferiorityVerdict('grading', comparison);

    const markdown = buildCompareMarkdown({
      task: 'grading',
      setId: 'set-1',
      baselineRunId: 'run-baseline',
      baselineModel: 'anthropic/claude-opus-5.5',
      variants: [{ candidateRunId: 'run-candidate', candidateModel: 'anthropic/claude-sonnet-5', comparison, verdict }],
      noiseFloors: [],
      generatedAt: '2026-09-26T00:00:00Z',
    });

    expect(markdown).toContain('# Eval compare — grading — set set-1');
    expect(markdown).toContain('anthropic/claude-sonnet-5');
    expect(markdown).toContain('run-candidate');
    expect(markdown).toContain(verdict.reason);
    expect(markdown).toContain('Non-inferior');
  });

  it('for audit, labels the pooled statistic as pooled and headlines the per-criterion verdict instead', () => {
    const comparison = pairedComparison([{ itemId: '1', baselinePass: true, candidatePass: true }]);
    const verdict = nonInferiorityVerdict('audit', comparison);
    const passVerdict = {
      answer_correct: true, grammar_correct: true, no_hallucination: true,
      question_coherent: true, natural_language: true, register_appropriate: true,
    };
    const baselineOutcomes = [{ itemId: '1', reference: { ...passVerdict, grammar_correct: false }, output: { ...passVerdict, grammar_correct: false } }];
    const candidateOutcomesFail = [{ itemId: '1', reference: { ...passVerdict, grammar_correct: false }, output: passVerdict }];
    const auditPerCriterion = auditPerCriterionVerdict(baselineOutcomes, candidateOutcomesFail);

    const markdown = buildCompareMarkdown({
      task: 'audit',
      setId: 'set-1',
      baselineRunId: 'run-baseline',
      baselineModel: 'mistralai/mistral-large-2512',
      variants: [{ candidateRunId: 'run-candidate', candidateModel: 'google/gemini-2.5-flash', comparison, verdict, auditPerCriterion }],
      noiseFloors: [],
      generatedAt: '2026-09-26T00:00:00Z',
    });

    expect(markdown).toContain('Pooled McNemar p (correlated pairs)');
    expect(markdown).toContain('## Per-criterion verdict (audit headline)');
    expect(markdown).toContain('Failed: grammar_correct.');
    expect(markdown).toContain('| grammar_correct |');
    // The pooled table has no "Non-inferior" yes/no column for audit — that verdict now lives
    // only in the per-criterion section.
    expect(markdown).not.toMatch(/\| Candidate \|.*\| Non-inferior \|/);
  });

  it('for audit with every criterion passing, headlines "All criteria pass"', () => {
    const comparison = pairedComparison([{ itemId: '1', baselinePass: true, candidatePass: true }]);
    const verdict = nonInferiorityVerdict('audit', comparison);
    const passVerdict = {
      answer_correct: true, grammar_correct: true, no_hallucination: true,
      question_coherent: true, natural_language: true, register_appropriate: true,
    };
    const outcomes = [{ itemId: '1', reference: passVerdict, output: passVerdict }];
    const auditPerCriterion = auditPerCriterionVerdict(outcomes, outcomes);

    const markdown = buildCompareMarkdown({
      task: 'audit',
      setId: 'set-1',
      baselineRunId: 'run-baseline',
      baselineModel: 'mistralai/mistral-large-2512',
      variants: [{ candidateRunId: 'run-candidate', candidateModel: 'google/gemini-2.5-flash', comparison, verdict, auditPerCriterion }],
      noiseFloors: [],
      generatedAt: '2026-09-26T00:00:00Z',
    });

    expect(markdown).toContain('**All criteria pass.**');
  });

  it('includes a noise-floor section only when noise floors are given', () => {
    const comparison = pairedComparison([{ itemId: '1', baselinePass: true, candidatePass: true }]);
    const withoutNoise = buildCompareMarkdown({
      task: 'grading', setId: 's', baselineRunId: 'b', baselineModel: 'm',
      variants: [], noiseFloors: [], generatedAt: 'now',
    });
    expect(withoutNoise).not.toContain('Noise floor');

    const withNoise = buildCompareMarkdown({
      task: 'grading', setId: 's', baselineRunId: 'b', baselineModel: 'm',
      variants: [], noiseFloors: [{ model: 'm', runIds: ['r1', 'r2'], comparison }], generatedAt: 'now',
    });
    expect(withNoise).toContain('Noise floor');
    expect(withNoise).toContain('r1, r2');
  });

  it('states "none" when rejectedKeys is given with no rejected questions', () => {
    const markdown = buildCompareMarkdown({
      task: 'grading', setId: 's', baselineRunId: 'b', baselineModel: 'm',
      variants: [], noiseFloors: [], generatedAt: 'now',
      rejectedKeys: { questions: [], excludedItemCount: 0, included: false },
    });
    expect(markdown).toContain('Rejected-key questions: none.');
  });

  it('lists rejected-key questions and states the excluded item count by default', () => {
    const markdown = buildCompareMarkdown({
      task: 'grading', setId: 's', baselineRunId: 'b', baselineModel: 'm',
      variants: [], noiseFloors: [], generatedAt: 'now',
      rejectedKeys: {
        questions: [{ questionRef: 'q7', question: 'Vrai ou faux: ...', itemIds: ['i-1', 'i-2'] }],
        excludedItemCount: 2,
        included: false,
      },
    });
    expect(markdown).toContain('Rejected-key questions: 1 (2 item(s) excluded from the accuracy figures below)');
    expect(markdown).toContain('--include-rejected-keys');
    expect(markdown).toContain('| q7 | Vrai ou faux: ... |');
  });

  it('says items are included, not excluded, when rejectedKeys.included is true', () => {
    const markdown = buildCompareMarkdown({
      task: 'grading', setId: 's', baselineRunId: 'b', baselineModel: 'm',
      variants: [], noiseFloors: [], generatedAt: 'now',
      rejectedKeys: {
        questions: [{ questionRef: 'q7', question: 'Vrai ou faux: ...', itemIds: ['i-1'] }],
        excludedItemCount: 0,
        included: true,
      },
    });
    expect(markdown).toContain('included in the accuracy figures below (--include-rejected-keys)');
    expect(markdown).not.toContain('excluded');
  });

  it('omits the rejected-key section entirely when rejectedKeys is not given (audit reports)', () => {
    const markdown = buildCompareMarkdown({
      task: 'audit', setId: 's', baselineRunId: 'b', baselineModel: 'm',
      variants: [], noiseFloors: [], generatedAt: 'now',
    });
    expect(markdown).not.toContain('Rejected-key questions');
  });

  it('for a reference-based audit report, adds an adjudication section per candidate', () => {
    const comparison = pairedComparison([{ itemId: '1', baselinePass: true, candidatePass: true }]);
    const verdict = nonInferiorityVerdict('audit', comparison);
    const auditPerCriterion = auditPerCriterionVerdict(
      [{ itemId: '1', reference: PASS_VERDICT, output: PASS_VERDICT }],
      [{ itemId: '1', reference: PASS_VERDICT, output: PASS_VERDICT }],
    );
    const baselineResults = [makeResult({ item_id: '1', output: { ...PASS_VERDICT, notes: 'OK' } })];
    const candidateResults = [makeResult({ item_id: '1', output: { ...PASS_VERDICT, grammar_correct: false, notes: 'awkward' } })];
    const auditDisagreements = findAuditDisagreements(baselineResults, candidateResults);

    const markdown = buildCompareMarkdown({
      task: 'audit',
      setId: 'set-1',
      baselineRunId: 'run-baseline',
      baselineModel: 'mistralai/mistral-large-2512',
      variants: [{ candidateRunId: 'run-candidate', candidateModel: 'google/gemini-2.5-flash', comparison, verdict, auditPerCriterion, auditDisagreements }],
      noiseFloors: [],
      generatedAt: '2026-09-26T00:00:00Z',
    });

    expect(markdown).toContain('## Items to adjudicate — google/gemini-2.5-flash (run run-candidate)');
    expect(markdown).toContain('grammar_correct');
    expect(markdown).toContain('awkward');
  });
});

describe('extractItemVerdictPairedOutcomes', () => {
  it('audit: pairs each run\'s own gate-pass verdict, with no reference involved', () => {
    const a = [
      makeResult({ item_id: '1', output: PASS_VERDICT }),
      makeResult({ item_id: '2', output: { ...PASS_VERDICT, grammar_correct: false } }),
    ];
    const b = [
      makeResult({ item_id: '1', output: PASS_VERDICT }),
      makeResult({ item_id: '2', output: PASS_VERDICT }),
    ];
    const outcomes = extractItemVerdictPairedOutcomes('audit', a, b);
    expect(outcomes).toEqual([
      { itemId: '1', baselinePass: true, candidatePass: true },
      { itemId: '2', baselinePass: false, candidatePass: true },
    ]);
  });

  it('grading: pairs each run\'s own isCorrect verdict', () => {
    const a = [makeResult({ item_id: '1', output: { isCorrect: true, score: 100 } })];
    const b = [makeResult({ item_id: '1', output: { isCorrect: false, score: 10 } })];
    expect(extractItemVerdictPairedOutcomes('grading', a, b)).toEqual([
      { itemId: '1', baselinePass: true, candidatePass: false },
    ]);
  });

  it('skips an item where either run has no output', () => {
    const a = [makeResult({ item_id: '1', output: null, error: 'api' })];
    const b = [makeResult({ item_id: '1', output: { isCorrect: true, score: 100 } })];
    expect(extractItemVerdictPairedOutcomes('grading', a, b)).toEqual([]);
  });
});

describe('auditCriterionFlips', () => {
  it('counts a flip only for the criterion that actually differs', () => {
    const a = [makeResult({ item_id: '1', output: PASS_VERDICT })];
    const b = [makeResult({ item_id: '1', output: { ...PASS_VERDICT, grammar_correct: false } })];
    const flips = auditCriterionFlips(a, b);
    const grammar = flips.find((f) => f.criterion === 'grammar_correct')!;
    const answer = flips.find((f) => f.criterion === 'answer_correct')!;
    expect(grammar).toEqual({ criterion: 'grammar_correct', n: 1, flips: 1, flipRate: 1 });
    expect(answer).toEqual({ criterion: 'answer_correct', n: 1, flips: 0, flipRate: 0 });
  });

  it('reports NaN flip rate for a criterion with no shared data', () => {
    const flips = auditCriterionFlips([], []);
    expect(flips.every((f) => f.n === 0 && Number.isNaN(f.flipRate))).toBe(true);
  });
});

describe('auditFlagRates', () => {
  it('computes one run\'s own flag rate per criterion, independent of any other run', () => {
    const results = [
      makeResult({ item_id: '1', output: PASS_VERDICT }),
      makeResult({ item_id: '2', output: { ...PASS_VERDICT, grammar_correct: false } }),
      makeResult({ item_id: '3', output: { ...PASS_VERDICT, grammar_correct: false } }),
    ];
    const rates = auditFlagRates(results);
    const grammar = rates.find((r) => r.criterion === 'grammar_correct')!;
    expect(grammar).toEqual({ criterion: 'grammar_correct', n: 3, flagged: 2, flagRate: 2 / 3 });
  });
});

describe('runCostLatency', () => {
  it('computes cost per item and latency percentiles from result rows', () => {
    const results = [
      makeResult({ item_id: '1', cost_usd: 0.01, latency_ms: 100 }),
      makeResult({ item_id: '2', cost_usd: 0.02, latency_ms: 200 }),
    ];
    const stats = runCostLatency(results);
    expect(stats.n).toBe(2);
    expect(stats.costPerItemUsd).toBeCloseTo(0.015, 10);
    expect(stats.latencyMsP50).toBe(100);
  });

  it('returns undefined cost/latency when no result carries them', () => {
    const stats = runCostLatency([makeResult({ cost_usd: null, latency_ms: null })]);
    expect(stats.costPerItemUsd).toBeUndefined();
    expect(stats.latencyMsP50).toBeUndefined();
  });
});

describe('groupingComparisonFor', () => {
  it('labels two runs with the same groupSize and shuffleSeed as identical-groups', () => {
    const a = makeRun({ id: 'a', settings: { groupSize: 5, shuffleSeed: 42 } });
    const b = makeRun({ id: 'b', settings: { groupSize: 5, shuffleSeed: 42 } });
    expect(groupingComparisonFor(a, b)).toBe('identical-groups');
  });

  it('labels two runs with no shuffle seed at all as identical-groups', () => {
    const a = makeRun({ id: 'a', settings: { groupSize: 5, shuffleSeed: null } });
    const b = makeRun({ id: 'b', settings: { groupSize: 5, shuffleSeed: null } });
    expect(groupingComparisonFor(a, b)).toBe('identical-groups');
  });

  it('labels two runs with different shuffle seeds as different-groupings', () => {
    const a = makeRun({ id: 'a', settings: { groupSize: 5, shuffleSeed: 1 } });
    const b = makeRun({ id: 'b', settings: { groupSize: 5, shuffleSeed: 2 } });
    expect(groupingComparisonFor(a, b)).toBe('different-groupings');
  });

  it('labels two runs with different group sizes as different-groupings', () => {
    const a = makeRun({ id: 'a', settings: { groupSize: 5, shuffleSeed: null } });
    const b = makeRun({ id: 'b', settings: { groupSize: 1, shuffleSeed: null } });
    expect(groupingComparisonFor(a, b)).toBe('different-groupings');
  });

  it('labels a run predating groupSize in settings as unknown', () => {
    const a = makeRun({ id: 'a', settings: {} });
    const b = makeRun({ id: 'b', settings: { groupSize: 5, shuffleSeed: null } });
    expect(groupingComparisonFor(a, b)).toBe('unknown');
  });
});

describe('findAuditDisagreements', () => {
  it('lists only items where at least one criterion differs, with both verdicts and notes', () => {
    const baseline = [
      makeResult({ item_id: '1', output: { ...PASS_VERDICT, notes: 'OK' } }),
      makeResult({ item_id: '2', output: { ...PASS_VERDICT, notes: 'OK' } }),
    ];
    const candidate = [
      makeResult({ item_id: '1', output: { ...PASS_VERDICT, notes: 'OK' } }), // agrees
      makeResult({ item_id: '2', output: { ...PASS_VERDICT, grammar_correct: false, notes: 'awkward' } }), // disagrees
    ];

    const disagreements = findAuditDisagreements(baseline, candidate);
    expect(disagreements).toHaveLength(1);
    expect(disagreements[0].itemId).toBe('2');
    expect(disagreements[0].baselineVerdict.grammar_correct).toBe(true);
    expect(disagreements[0].candidateVerdict.grammar_correct).toBe(false);
    expect(disagreements[0].baselineNotes).toBe('OK');
    expect(disagreements[0].candidateNotes).toBe('awkward');
  });

  it('skips an item where either run has no output', () => {
    const baseline = [makeResult({ item_id: '1', output: null, error: 'api' })];
    const candidate = [makeResult({ item_id: '1', output: { ...PASS_VERDICT, grammar_correct: false } })];
    expect(findAuditDisagreements(baseline, candidate)).toEqual([]);
  });

  it('returns nothing when every shared item agrees', () => {
    const baseline = [makeResult({ item_id: '1', output: PASS_VERDICT })];
    const candidate = [makeResult({ item_id: '1', output: PASS_VERDICT })];
    expect(findAuditDisagreements(baseline, candidate)).toEqual([]);
  });
});

describe('buildReferenceFreeCompareMarkdown', () => {
  it('labels the report as no-reference and includes item-level agreement', () => {
    const comparison = pairedComparison([{ itemId: '1', baselinePass: true, candidatePass: true }]);
    const markdown = buildReferenceFreeCompareMarkdown({
      task: 'grading',
      setId: 'set-1',
      baselineRunId: 'run-baseline',
      baselineModel: 'anthropic/claude-opus-5.5',
      baselineCostLatency: { n: 1, costPerItemUsd: 0.001, latencyMsP50: 100, latencyMsP95: 100 },
      variants: [{
        candidateRunId: 'run-candidate',
        candidateModel: 'anthropic/claude-sonnet-5',
        itemVerdictAgreement: comparison,
        candidateCostLatency: { n: 1, costPerItemUsd: 0.0005, latencyMsP50: 80, latencyMsP95: 80 },
      }],
      noiseFloors: [],
      generatedAt: '2026-09-26T00:00:00Z',
    });

    expect(markdown).toContain('no reference: stability and agreement only; no accuracy verdict');
    expect(markdown).toContain('## Item-level verdict agreement');
    expect(markdown).toContain('anthropic/claude-sonnet-5');
    expect(markdown).not.toContain('Non-inferior');
  });

  it('for audit, includes per-criterion flip counts, flag rates, and an adjudication section', () => {
    const comparison = pairedComparison([{ itemId: '1', baselinePass: true, candidatePass: false }]);
    const baselineResults = [makeResult({ item_id: '1', output: { ...PASS_VERDICT, notes: 'OK' } })];
    const candidateResults = [makeResult({ item_id: '1', output: { ...PASS_VERDICT, grammar_correct: false, notes: 'awkward' } })];

    const markdown = buildReferenceFreeCompareMarkdown({
      task: 'audit',
      setId: 'set-1',
      baselineRunId: 'run-baseline',
      baselineModel: 'mistralai/mistral-large-2512',
      baselineFlagRates: auditFlagRates(baselineResults),
      baselineCostLatency: runCostLatency(baselineResults),
      variants: [{
        candidateRunId: 'run-candidate',
        candidateModel: 'mistralai/mistral-large-2512',
        itemVerdictAgreement: comparison,
        criterionFlips: auditCriterionFlips(baselineResults, candidateResults),
        candidateFlagRates: auditFlagRates(candidateResults),
        candidateCostLatency: runCostLatency(candidateResults),
        auditDisagreements: findAuditDisagreements(baselineResults, candidateResults),
      }],
      noiseFloors: [],
      generatedAt: '2026-09-26T00:00:00Z',
    });

    expect(markdown).toContain('## Per-criterion flip counts');
    expect(markdown).toContain('## Flag rate per criterion');
    expect(markdown).toContain('## Items to adjudicate');
    expect(markdown).toContain('awkward');
  });

  it('labels a noise floor by whether the repeats used identical or different groupings', () => {
    const comparison = pairedComparison([{ itemId: '1', baselinePass: true, candidatePass: true }]);
    const markdown = buildReferenceFreeCompareMarkdown({
      task: 'audit',
      setId: 'set-1',
      baselineRunId: 'run-baseline',
      baselineModel: 'mistralai/mistral-large-2512',
      baselineCostLatency: { n: 0, costPerItemUsd: undefined, latencyMsP50: undefined, latencyMsP95: undefined },
      variants: [],
      noiseFloors: [{ model: 'mistralai/mistral-large-2512', runIds: ['run-a', 'run-b'], comparison, grouping: 'different-groupings' }],
      generatedAt: '2026-09-26T00:00:00Z',
    });

    expect(markdown).toContain('## Noise floor');
    expect(markdown).toContain('different-groupings');
  });

  it('includes no noise-floor section when none are given', () => {
    const markdown = buildReferenceFreeCompareMarkdown({
      task: 'grading',
      setId: 'set-1',
      baselineRunId: 'run-baseline',
      baselineModel: 'm',
      baselineCostLatency: { n: 0, costPerItemUsd: undefined, latencyMsP50: undefined, latencyMsP95: undefined },
      variants: [],
      noiseFloors: [],
      generatedAt: '2026-09-26T00:00:00Z',
    });
    expect(markdown).not.toContain('Noise floor');
  });
});

describe('extractMappingPairedOutcomes (mapping task)', () => {
  it('pairs items where both runs have a score, skipping items either run errored on', () => {
    const baseline = [
      makeResult({ item_id: 'item-1', score: 1 }),
      makeResult({ item_id: 'item-2', score: null, error: 'parse' }), // baseline errored — no pair
      makeResult({ item_id: 'item-3', score: 0.5 }),
    ];
    const candidate = [
      makeResult({ item_id: 'item-1', score: 0.8 }),
      makeResult({ item_id: 'item-2', score: 1 }),
      // item-3 missing from candidate entirely — no pair
    ];
    const outcomes = extractMappingPairedOutcomes(baseline, candidate);
    expect(outcomes).toEqual([{ itemId: 'item-1', baselineF1: 1, candidateF1: 0.8 }]);
  });

  it('returns no outcomes when nothing overlaps', () => {
    expect(extractMappingPairedOutcomes([], [])).toEqual([]);
  });
});

describe('mappingRunStats', () => {
  it('computes mean F1, fraction perfect, and summed deterministic checks from result rows', () => {
    const results = [
      makeResult({ item_id: 'a', score: 1, deterministic_checks: { resolved: 1, unresolved: 0, nested_duplicates: 0 } }),
      makeResult({ item_id: 'b', score: 0.5, deterministic_checks: { resolved: 1, unresolved: 1, nested_duplicates: 1 } }),
      makeResult({ item_id: 'c', score: null, error: 'api' }), // excluded from F1 mean and fraction
    ];
    const stats = mappingRunStats(results);
    expect(stats.n).toBe(2);
    expect(stats.meanF1).toBeCloseTo(0.75, 10);
    expect(stats.fractionF1Perfect).toBeCloseTo(0.5, 10);
    expect(stats.totalUnresolved).toBe(1);
    expect(stats.totalNestedDuplicates).toBe(1);
  });

  it('reports NaN stats rather than throwing when no item has a score', () => {
    const stats = mappingRunStats([makeResult({ score: null, error: 'api' })]);
    expect(stats.n).toBe(0);
    expect(Number.isNaN(stats.meanF1)).toBe(true);
    expect(Number.isNaN(stats.fractionF1Perfect)).toBe(true);
  });
});

describe('buildMappingCompareMarkdown', () => {
  const baselineStats = mappingRunStats([
    makeResult({ item_id: 'a', score: 1 }),
    makeResult({ item_id: 'b', score: 0.5 }),
  ]);

  it('renders per-run stats, the paired comparison, and a noise-floor section when repeats exist', () => {
    const candidateStats = mappingRunStats([
      makeResult({ item_id: 'a', score: 0.8 }),
      makeResult({ item_id: 'b', score: 0.8 }),
    ]);
    const paired = pairedMappingComparison([
      { itemId: 'a', baselineF1: 1, candidateF1: 0.8 },
      { itemId: 'b', baselineF1: 0.5, candidateF1: 0.8 },
    ]);
    const markdown = buildMappingCompareMarkdown({
      setId: 'set-1',
      baselineRunId: 'run-baseline',
      baselineModel: 'anthropic/claude-sonnet-5',
      baselineStats,
      variants: [{ candidateRunId: 'run-candidate', candidateModel: 'anthropic/claude-haiku-4.5', candidateStats, paired }],
      noiseFloors: [{
        model: 'anthropic/claude-sonnet-5',
        runIds: ['run-baseline', 'run-baseline-2'],
        n: 2,
        meanAbsDiff: mappingNoiseFloor([{ itemId: 'a', f1A: 1, f1B: 0.9 }, { itemId: 'b', f1A: 0.5, f1B: 0.5 }]),
      }],
      generatedAt: '2026-09-27T00:00:00Z',
    });
    expect(markdown).toContain('# Eval compare — mapping — set set-1');
    expect(markdown).toContain('## Per-run stats');
    expect(markdown).toContain('anthropic/claude-haiku-4.5');
    expect(markdown).toContain('## Paired comparison against baseline');
    expect(markdown).toContain('## Noise floor');
    expect(markdown).toContain('0.0500');
  });

  it('omits the noise-floor section when there are no repeats', () => {
    const markdown = buildMappingCompareMarkdown({
      setId: 'set-1',
      baselineRunId: 'run-baseline',
      baselineModel: 'm',
      baselineStats,
      variants: [],
      noiseFloors: [],
      generatedAt: '2026-09-27T00:00:00Z',
    });
    expect(markdown).not.toContain('Noise floor');
  });
});
