/**
 * Golden snapshots of every markdown report `eval-compare` can produce, one per task and
 * reference/reference-free shape. Guards against an unintended formatting change when the report
 * builders move across files — a deliberate dedup (e.g. unifying the per-metric formatters) must
 * still render byte-identical markdown for the same inputs.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCompareMarkdown,
  buildReferenceFreeCompareMarkdown,
  auditPerCriterionVerdict,
  auditFlagRates,
  auditCriterionFlips,
  findAuditDisagreements,
} from '../src/lib/eval/compare/audit-grading';
import { mappingRunStats, buildMappingCompareMarkdown } from '../src/lib/eval/compare/mapping';
import {
  transcriptionRunStats,
  pairedTranscriptionComparison,
  transcriptionNonInferiorityVerdict,
  buildTranscriptionCompareMarkdown,
  buildTranscriptionReferenceFreeCompareMarkdown,
} from '../src/lib/eval/compare/transcription';
import { runCostLatency } from '../src/lib/eval/compare/shared';
import { pairedComparison, pairedMappingComparison, mappingNoiseFloor, nonInferiorityVerdict, meanAndCi95 } from '../src/lib/eval/scoring';
import type { EvalResultRow } from '../src/lib/eval/db';

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
    response_meta: null,
    created_at: '2026-09-27T00:00:00Z',
    ...overrides,
  };
}

const PASS_VERDICT = {
  answer_correct: true, grammar_correct: true, no_hallucination: true,
  question_coherent: true, natural_language: true, register_appropriate: true,
};

describe('eval-compare markdown golden snapshots', () => {
  it('grading, reference-backed, with a noise floor', () => {
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
      noiseFloors: [{ model: 'anthropic/claude-opus-5.5', runIds: ['run-baseline', 'run-baseline-2'], comparison }],
      generatedAt: '2026-09-26T00:00:00Z',
      rejectedKeys: { questions: [{ questionRef: 'q7', question: 'Vrai ou faux: ...', itemIds: ['1', '2'] }], excludedItemCount: 2, included: false },
    });
    expect(markdown).toMatchSnapshot();
  });

  it('audit, reference-backed, with a failed criterion and a disagreement', () => {
    const comparison = pairedComparison([{ itemId: '1', baselinePass: true, candidatePass: true }]);
    const verdict = nonInferiorityVerdict('audit', comparison);
    const baselineOutcomes = [{ itemId: '1', reference: { ...PASS_VERDICT, grammar_correct: false }, output: { ...PASS_VERDICT, grammar_correct: false } }];
    const candidateOutcomesFail = [{ itemId: '1', reference: { ...PASS_VERDICT, grammar_correct: false }, output: PASS_VERDICT }];
    const auditPerCriterion = auditPerCriterionVerdict(baselineOutcomes, candidateOutcomesFail);
    const baselineResults = [makeResult({ item_id: '1', output: { ...PASS_VERDICT, grammar_correct: false, notes: 'OK' } })];
    const candidateResults = [makeResult({ item_id: '1', output: { ...PASS_VERDICT, notes: 'looked fine to me' } })];

    const markdown = buildCompareMarkdown({
      task: 'audit',
      setId: 'set-1',
      baselineRunId: 'run-baseline',
      baselineModel: 'mistralai/mistral-large-2512',
      variants: [{
        candidateRunId: 'run-candidate',
        candidateModel: 'google/gemini-2.5-flash',
        comparison,
        verdict,
        auditPerCriterion,
        auditDisagreements: findAuditDisagreements(baselineResults, candidateResults),
      }],
      noiseFloors: [],
      generatedAt: '2026-09-26T00:00:00Z',
    });
    expect(markdown).toMatchSnapshot();
  });

  it('grading, reference-free', () => {
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
    expect(markdown).toMatchSnapshot();
  });

  it('audit, reference-free, with per-criterion flips and flag rates', () => {
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
      noiseFloors: [{ model: 'mistralai/mistral-large-2512', runIds: ['run-a', 'run-b'], comparison, grouping: 'different-groupings' }],
      generatedAt: '2026-09-26T00:00:00Z',
    });
    expect(markdown).toMatchSnapshot();
  });

  it('mapping, with a noise floor', () => {
    const baselineStats = mappingRunStats([makeResult({ item_id: 'a', score: 1 }), makeResult({ item_id: 'b', score: 0.5 })]);
    const candidateStats = mappingRunStats([makeResult({ item_id: 'a', score: 0.8 }), makeResult({ item_id: 'b', score: 0.8 })]);
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
    expect(markdown).toMatchSnapshot();
  });

  it('transcription, reference-backed, with a NaN agreement rate and a noise floor', () => {
    const baselineStats = transcriptionRunStats([makeResult({ item_id: 'a', score: 1 }), makeResult({ item_id: 'b', score: 0.5 })]);
    const candidateStats = transcriptionRunStats([makeResult({ item_id: 'a', score: 0.8 }), makeResult({ item_id: 'b', score: 0.8 })]);
    const outcomes = [
      { itemId: 'a', baselineScore: 1, candidateScore: 0.8 },
      { itemId: 'b', baselineScore: 0.5, candidateScore: 0.8 },
    ];
    const paired = pairedTranscriptionComparison(outcomes);
    const noAgreement = { n: 0, agreementRate: NaN };

    const markdown = buildTranscriptionCompareMarkdown({
      setId: 'set-1',
      baselineRunId: 'run-baseline',
      baselineModel: 'anthropic/claude-sonnet-5',
      baselineStats,
      baselineNoContentAgreement: noAgreement,
      baselineTableAgreement: noAgreement,
      variants: [{
        candidateRunId: 'run-candidate',
        candidateModel: 'google/gemini-2.5-flash',
        candidateStats,
        paired,
        noContentAgreement: noAgreement,
        tableAgreement: noAgreement,
        verdict: transcriptionNonInferiorityVerdict(baselineStats, candidateStats, outcomes, noAgreement),
      }],
      noiseFloors: [{ model: 'anthropic/claude-sonnet-5', runIds: ['run-baseline', 'run-baseline-2'], n: 2, meanAbsDiff: 0.05 }],
      generatedAt: '2026-09-27T00:00:00Z',
    });
    expect(markdown).toMatchSnapshot();
  });

  it('transcription, reference-free', () => {
    const markdown = buildTranscriptionReferenceFreeCompareMarkdown({
      setId: 'set-1',
      baselineRunId: 'run-baseline',
      baselineModel: 'anthropic/claude-sonnet-5',
      baselineCostLatency: { n: 2, costPerItemUsd: 0.001, latencyMsP50: 500, latencyMsP95: 900 },
      variants: [{
        candidateRunId: 'run-candidate',
        candidateModel: 'google/gemini-2.5-flash',
        agreement: meanAndCi95([0.9, 0.95])!,
        n: 2,
        noContentAgreement: { n: 2, agreementRate: 1 },
        candidateCostLatency: { n: 2, costPerItemUsd: 0.0005, latencyMsP50: 400, latencyMsP95: 800 },
      }],
      generatedAt: '2026-09-27T00:00:00Z',
    });
    expect(markdown).toMatchSnapshot();
  });
});
