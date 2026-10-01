import { describe, expect, it } from 'vitest';
import {
  extractTranscriptionPairedOutcomes,
  pairedTranscriptionComparison,
  transcriptionRunStats,
  transcriptionNoContentAgreementVsReference,
  transcriptionNoContentAgreementBetweenRuns,
  transcriptionTableAgreementVsReference,
  extractTranscriptionAgreementScores,
  buildTranscriptionCompareMarkdown,
  buildTranscriptionReferenceFreeCompareMarkdown,
  transcriptionNonInferiorityVerdict,
} from '../src/lib/eval/compare/transcription';
import { meanAndCi95 } from '../src/lib/eval/scoring';
import { NO_CONTENT_MARKER } from '../src/lib/pdf-conversion';
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

describe('extractTranscriptionPairedOutcomes', () => {
  it('pairs items where both runs have a score, skipping items either run errored on', () => {
    const baseline = [
      makeResult({ item_id: 'p1', score: 0.9 }),
      makeResult({ item_id: 'p2', score: null, error: 'api' }), // baseline errored — no pair
      makeResult({ item_id: 'p3', score: 0.5 }),
    ];
    const candidate = [
      makeResult({ item_id: 'p1', score: 0.95 }),
      makeResult({ item_id: 'p2', score: 1 }),
      // p3 missing from candidate entirely — no pair
    ];
    const outcomes = extractTranscriptionPairedOutcomes(baseline, candidate);
    expect(outcomes).toEqual([{ itemId: 'p1', baselineScore: 0.9, candidateScore: 0.95 }]);
  });

  it('returns no outcomes when nothing overlaps', () => {
    expect(extractTranscriptionPairedOutcomes([], [])).toEqual([]);
  });
});

describe('pairedTranscriptionComparison', () => {
  it('throws on an empty outcome list', () => {
    expect(() => pairedTranscriptionComparison([])).toThrow();
  });

  it('computes baseline/candidate means, diff, and the better/worse/tied split', () => {
    const result = pairedTranscriptionComparison([
      { itemId: 'a', baselineScore: 0.5, candidateScore: 0.8 },
      { itemId: 'b', baselineScore: 1, candidateScore: 1 },
      { itemId: 'c', baselineScore: 0.9, candidateScore: 0.7 },
    ]);
    expect(result.n).toBe(3);
    expect(result.baselineMeanScore).toBeCloseTo(0.8, 10);
    expect(result.candidateMeanScore).toBeCloseTo((0.8 + 1 + 0.7) / 3, 10);
    expect(result.candidateBetter).toBe(1);
    expect(result.baselineBetter).toBe(1);
    expect(result.ties).toBe(1);
  });
});

describe('transcriptionRunStats', () => {
  it('computes mean score, worst score, and mean coverage from result rows', () => {
    const results = [
      makeResult({ item_id: 'a', score: 1, deterministic_checks: { coverage: 1, no_content_marker: false, table_rows: 0, table_cols: 0, chars: 10 } }),
      makeResult({ item_id: 'b', score: 0.4, deterministic_checks: { coverage: 0.6, no_content_marker: false, table_rows: 0, table_cols: 0, chars: 10 } }),
      makeResult({ item_id: 'c', score: null, error: 'api' }), // excluded from the score mean
    ];
    const stats = transcriptionRunStats(results);
    expect(stats.n).toBe(2);
    expect(stats.meanScore).toBeCloseTo(0.7, 10);
    expect(stats.worstScore).toBe(0.4);
    expect(stats.meanCoverage).toBeCloseTo(0.8, 10);
  });

  it('reports NaN stats rather than throwing when no item has a score', () => {
    const stats = transcriptionRunStats([makeResult({ score: null, error: 'api' })]);
    expect(stats.n).toBe(0);
    expect(Number.isNaN(stats.meanScore)).toBe(true);
  });
});

describe('transcriptionNonInferiorityVerdict', () => {
  // No reference items to check no-content agreement against — used by tests below that aren't
  // exercising the no-content condition.
  const noAgreement = { n: 0, agreementRate: NaN };

  it('is non-inferior when a repeat-like candidate tracks a baseline with a low worst slide', () => {
    // The baseline's own worst slide can sit well under any absolute floor — what matters is that
    // the candidate doesn't fall far below the baseline on the same slide.
    const baseline = transcriptionRunStats([makeResult({ item_id: 'a', score: 0.9 }), makeResult({ item_id: 'b', score: 0.7 })]);
    const candidate = transcriptionRunStats([makeResult({ item_id: 'a', score: 0.89 }), makeResult({ item_id: 'b', score: 0.69 })]);
    const outcomes = [
      { itemId: 'a', baselineScore: 0.9, candidateScore: 0.89 },
      { itemId: 'b', baselineScore: 0.7, candidateScore: 0.69 },
    ];
    const verdict = transcriptionNonInferiorityVerdict(baseline, candidate, outcomes, noAgreement);
    expect(verdict.nonInferior).toBe(true);
  });

  describe('on word measures, when the pairing carried the reference transcripts', () => {
    const stats = (scores: number[]) => transcriptionRunStats(scores.map((score, i) => makeResult({ item_id: `s${i}`, score })));

    it('passes a slide whose edit score collapsed on formatting alone, since its words all match', () => {
      const outcomes = [
        { itemId: 'a', baselineScore: 1, candidateScore: 0.66, baselineWordRecall: 1, candidateWordRecall: 1, baselineWordPrecision: 1, candidateWordPrecision: 1 },
        { itemId: 'b', baselineScore: 0.9, candidateScore: 0.9, baselineWordRecall: 0.95, candidateWordRecall: 0.95, baselineWordPrecision: 0.97, candidateWordPrecision: 0.97 },
      ];
      const verdict = transcriptionNonInferiorityVerdict(stats([1, 0.9]), stats([0.66, 0.9]), outcomes, noAgreement);
      expect(verdict.nonInferior).toBe(true);
      expect(verdict.reason).toContain('mean word recall');
    });

    it('fails when one slide loses more than 0.15 of the words the baseline captured', () => {
      const outcomes = [
        { itemId: 'a', baselineScore: 0.9, candidateScore: 0.9, baselineWordRecall: 0.97, candidateWordRecall: 0.48, baselineWordPrecision: 0.9, candidateWordPrecision: 0.9 },
        { itemId: 'b', baselineScore: 0.9, candidateScore: 0.9, baselineWordRecall: 0.95, candidateWordRecall: 0.95, baselineWordPrecision: 0.97, candidateWordPrecision: 0.97 },
        { itemId: 'c', baselineScore: 0.9, candidateScore: 0.9, baselineWordRecall: 0.95, candidateWordRecall: 0.95, baselineWordPrecision: 0.97, candidateWordPrecision: 0.97 },
      ];
      const verdict = transcriptionNonInferiorityVerdict(stats([0.9, 0.9, 0.9]), stats([0.9, 0.9, 0.9]), outcomes, noAgreement);
      expect(verdict.nonInferior).toBe(false);
      expect(verdict.reason).toContain('largest word recall drop 0.4900 on item a');
    });

    it('fails on a slide padded with words the baseline did not add, whatever the recall', () => {
      const outcomes = [
        { itemId: 'a', baselineScore: 0.9, candidateScore: 0.9, baselineWordRecall: 0.9, candidateWordRecall: 1, baselineWordPrecision: 0.97, candidateWordPrecision: 0.5 },
        { itemId: 'b', baselineScore: 0.9, candidateScore: 0.9, baselineWordRecall: 0.95, candidateWordRecall: 0.95, baselineWordPrecision: 0.97, candidateWordPrecision: 0.97 },
      ];
      const verdict = transcriptionNonInferiorityVerdict(stats([0.9, 0.9]), stats([0.9, 0.9]), outcomes, noAgreement);
      expect(verdict.nonInferior).toBe(false);
      expect(verdict.reason).toContain('largest word precision drop 0.4700 on item a');
    });

    it('computes the word measures from stored outputs when given the reference transcripts', () => {
      const reference = new Map([['item-1', '| A | ah |\n|---|---|\n| B | bé |']]);
      const a = [makeResult({ run_id: 'run-a', item_id: 'item-1', score: 1, output: { markdown: '| A | ah |\n|---|---|\n| B | bé |' } })];
      const b = [makeResult({ run_id: 'run-b', item_id: 'item-1', score: 0.6, output: { markdown: '- **A** - ah\n- **B** - bé\n- extra' } })];
      const [outcome] = extractTranscriptionPairedOutcomes(a, b, reference);
      expect(outcome.baselineWordRecall).toBe(1);
      expect(outcome.candidateWordRecall).toBe(1);
      expect(outcome.baselineWordPrecision).toBe(1);
      expect(outcome.candidateWordPrecision).toBeCloseTo(0.8, 10);
    });
  });

  it('fails when one slide drops far below the baseline\'s own score on that slide', () => {
    const baseline = transcriptionRunStats([makeResult({ item_id: 'a', score: 0.95 }), makeResult({ item_id: 'b', score: 0.9 })]);
    const candidate = transcriptionRunStats([makeResult({ item_id: 'a', score: 0.48 }), makeResult({ item_id: 'b', score: 0.89 })]);
    const outcomes = [
      { itemId: 'a', baselineScore: 0.95, candidateScore: 0.48 },
      { itemId: 'b', baselineScore: 0.9, candidateScore: 0.89 },
    ];
    const verdict = transcriptionNonInferiorityVerdict(baseline, candidate, outcomes, noAgreement);
    expect(verdict.nonInferior).toBe(false);
    expect(verdict.reason).toContain('largest drop 0.4700 on item a');
  });

  it('is non-inferior when the largest per-slide drop sits exactly at the 0.15 limit (inclusive boundary)', () => {
    // Seven unchanged slides keep the mean within its own 0.02 tolerance despite the one slide's
    // full 0.15 drop, isolating the per-slide boundary from the mean check.
    const steadySlides = Array.from({ length: 7 }, (_, i) => makeResult({ item_id: `steady-${i}`, score: 0.9 }));
    const baseline = transcriptionRunStats([...steadySlides, makeResult({ item_id: 'a', score: 0.95 })]);
    const candidate = transcriptionRunStats([...steadySlides, makeResult({ item_id: 'a', score: 0.8 })]);
    const outcomes = [
      ...steadySlides.map((s) => ({ itemId: s.item_id, baselineScore: 0.9, candidateScore: 0.9 })),
      { itemId: 'a', baselineScore: 0.95, candidateScore: 0.8 },
    ];
    const verdict = transcriptionNonInferiorityVerdict(baseline, candidate, outcomes, noAgreement);
    expect(verdict.nonInferior).toBe(true);
  });

  it('ignores slides missing from one run when checking the per-slide drop', () => {
    // 'b' only has a baseline score (candidate errored on it) — extractTranscriptionPairedOutcomes
    // already drops it from the paired outcomes, so it can't be counted as a drop here.
    const baseline = transcriptionRunStats([makeResult({ item_id: 'a', score: 0.9 }), makeResult({ item_id: 'b', score: 0.9 })]);
    const candidate = transcriptionRunStats([makeResult({ item_id: 'a', score: 0.89 })]);
    const outcomes = [{ itemId: 'a', baselineScore: 0.9, candidateScore: 0.89 }];
    const verdict = transcriptionNonInferiorityVerdict(baseline, candidate, outcomes, noAgreement);
    expect(verdict.nonInferior).toBe(true);
    expect(verdict.reason).toContain('1 slide compared');
  });

  it('fails when no slides are scored in both runs — no overlap is no evidence, not a pass', () => {
    const baseline = transcriptionRunStats([makeResult({ item_id: 'a', score: 0.9 })]);
    const candidate = transcriptionRunStats([makeResult({ item_id: 'a', score: 0.9 })]);
    const verdict = transcriptionNonInferiorityVerdict(baseline, candidate, [], noAgreement);
    expect(verdict.nonInferior).toBe(false);
    expect(verdict.reason).toContain('no slides scored in both runs');
  });

  it('is non-inferior when the mean sits exactly at baseline minus the 0.02 tolerance (inclusive boundary)', () => {
    const baseline = transcriptionRunStats([makeResult({ item_id: 'a', score: 0.9 })]);
    const candidate = transcriptionRunStats([makeResult({ item_id: 'a', score: 0.88 })]);
    const outcomes = [{ itemId: 'a', baselineScore: 0.9, candidateScore: 0.88 }];
    const verdict = transcriptionNonInferiorityVerdict(baseline, candidate, outcomes, noAgreement);
    expect(verdict.nonInferior).toBe(true);
  });

  it('fails when the mean regresses past tolerance even though every slide clears the per-slide limit', () => {
    const baseline = transcriptionRunStats([makeResult({ item_id: 'a', score: 0.95 }), makeResult({ item_id: 'b', score: 0.95 })]);
    const candidate = transcriptionRunStats([makeResult({ item_id: 'a', score: 0.9 }), makeResult({ item_id: 'b', score: 0.9 })]);
    const outcomes = [
      { itemId: 'a', baselineScore: 0.95, candidateScore: 0.9 },
      { itemId: 'b', baselineScore: 0.95, candidateScore: 0.9 },
    ];
    const verdict = transcriptionNonInferiorityVerdict(baseline, candidate, outcomes, noAgreement);
    expect(verdict.nonInferior).toBe(false);
    expect(verdict.reason).toContain('mean score');
  });

  it('fails on the mean-tolerance and per-slide checks independently, each named in the reason regardless of the other', () => {
    // Both the mean and the largest per-slide drop fail here; the reason names both rather than
    // short-circuiting on whichever is checked first.
    const baseline = transcriptionRunStats([makeResult({ item_id: 'a', score: 0.95 }), makeResult({ item_id: 'b', score: 0.9 })]);
    const candidate = transcriptionRunStats([makeResult({ item_id: 'a', score: 0.5 }), makeResult({ item_id: 'b', score: 1 })]);
    const outcomes = [
      { itemId: 'a', baselineScore: 0.95, candidateScore: 0.5 },
      { itemId: 'b', baselineScore: 0.9, candidateScore: 1 },
    ];
    const verdict = transcriptionNonInferiorityVerdict(baseline, candidate, outcomes, noAgreement);
    expect(verdict.nonInferior).toBe(false);
    expect(verdict.reason).toContain('mean score');
    expect(verdict.reason).toContain('largest drop');
  });

  it('is non-inferior when no-content agreement against reference is perfect', () => {
    const baseline = transcriptionRunStats([makeResult({ item_id: 'a', score: 0.9 })]);
    const candidate = transcriptionRunStats([makeResult({ item_id: 'a', score: 0.9 })]);
    const outcomes = [{ itemId: 'a', baselineScore: 0.9, candidateScore: 0.9 }];
    const verdict = transcriptionNonInferiorityVerdict(baseline, candidate, outcomes, { n: 30, agreementRate: 1 });
    expect(verdict.nonInferior).toBe(true);
    expect(verdict.reason).toContain('no-content agreement 30/30');
  });

  it('fails on a single no-content disagreement even with a perfect mean and no per-slide drop', () => {
    // The candidate calls a text slide empty (or transcribes a genuinely empty one) that reference
    // says is either way the no-content marker doesn't agree with — means and slides alone would pass this.
    const baseline = transcriptionRunStats([makeResult({ item_id: 'a', score: 0.9 })]);
    const candidate = transcriptionRunStats([makeResult({ item_id: 'a', score: 0.9 })]);
    const outcomes = [{ itemId: 'a', baselineScore: 0.9, candidateScore: 0.9 }];
    const verdict = transcriptionNonInferiorityVerdict(baseline, candidate, outcomes, { n: 30, agreementRate: 29 / 30 });
    expect(verdict.nonInferior).toBe(false);
    expect(verdict.reason).toContain('no-content agreement 29/30');
  });
});

describe('transcriptionNoContentAgreementVsReference', () => {
  const referenceMarkdownByItemId = new Map([
    ['a', NO_CONTENT_MARKER],
    ['b', '## Real content'],
  ]);

  it('agrees when the run correctly returned the marker on a no-content reference slide', () => {
    const results = [
      makeResult({ item_id: 'a', deterministic_checks: { coverage: 1, no_content_marker: true, table_rows: 0, table_cols: 0, chars: 10 } }),
      makeResult({ item_id: 'b', deterministic_checks: { coverage: 1, no_content_marker: false, table_rows: 0, table_cols: 0, chars: 10 } }),
    ];
    expect(transcriptionNoContentAgreementVsReference(results, referenceMarkdownByItemId)).toEqual({ n: 2, agreementRate: 1 });
  });

  it('disagrees when the run misses a no-content slide', () => {
    const results = [
      makeResult({ item_id: 'a', deterministic_checks: { coverage: 1, no_content_marker: false, table_rows: 0, table_cols: 0, chars: 300 } }),
    ];
    expect(transcriptionNoContentAgreementVsReference(results, referenceMarkdownByItemId)).toEqual({ n: 1, agreementRate: 0 });
  });

  it('reports NaN when nothing has both reference and a no-content-marker flag', () => {
    expect(transcriptionNoContentAgreementVsReference([], referenceMarkdownByItemId).agreementRate).toBeNaN();
  });
});

describe('transcriptionNoContentAgreementBetweenRuns', () => {
  it('agrees when both runs return the same no-content-marker flag on an item', () => {
    const a = [makeResult({ item_id: 'p1', deterministic_checks: { coverage: 1, no_content_marker: true, table_rows: 0, table_cols: 0, chars: 30 } })];
    const b = [makeResult({ item_id: 'p1', deterministic_checks: { coverage: 1, no_content_marker: true, table_rows: 0, table_cols: 0, chars: 30 } })];
    expect(transcriptionNoContentAgreementBetweenRuns(a, b)).toEqual({ n: 1, agreementRate: 1 });
  });

  it('disagrees when the two runs differ on the no-content-marker flag', () => {
    const a = [makeResult({ item_id: 'p1', deterministic_checks: { coverage: 1, no_content_marker: true, table_rows: 0, table_cols: 0, chars: 30 } })];
    const b = [makeResult({ item_id: 'p1', deterministic_checks: { coverage: 1, no_content_marker: false, table_rows: 0, table_cols: 0, chars: 30 } })];
    expect(transcriptionNoContentAgreementBetweenRuns(a, b)).toEqual({ n: 1, agreementRate: 0 });
  });
});

describe('transcriptionTableAgreementVsReference', () => {
  const referenceMarkdownByItemId = new Map([['a', '| A | B |\n|---|---|\n| 1 | 2 |']]);

  it('agrees when the stored table shape matches the reference\'s own table shape', () => {
    const results = [makeResult({ item_id: 'a', deterministic_checks: { coverage: 1, no_content_marker: false, table_rows: 1, table_cols: 2, chars: 30 } })];
    expect(transcriptionTableAgreementVsReference(results, referenceMarkdownByItemId)).toEqual({ n: 1, agreementRate: 1 });
  });

  it('disagrees when the stored table shape has a different row or column count', () => {
    const results = [makeResult({ item_id: 'a', deterministic_checks: { coverage: 1, no_content_marker: false, table_rows: 2, table_cols: 2, chars: 30 } })];
    expect(transcriptionTableAgreementVsReference(results, referenceMarkdownByItemId)).toEqual({ n: 1, agreementRate: 0 });
  });
});

describe('extractTranscriptionAgreementScores', () => {
  it('scores similarity between two runs\' own outputs on shared items', () => {
    const a = [makeResult({ item_id: 'p1', output: { markdown: 'Le chat noir' } })];
    const b = [makeResult({ item_id: 'p1', output: { markdown: 'Le chat noir' } })];
    expect(extractTranscriptionAgreementScores(a, b)).toEqual([1]);
  });

  it('skips items where either run has no output', () => {
    const a = [makeResult({ item_id: 'p1', output: null, error: 'api' })];
    const b = [makeResult({ item_id: 'p1', output: { markdown: 'x' } })];
    expect(extractTranscriptionAgreementScores(a, b)).toEqual([]);
  });
});

describe('buildTranscriptionCompareMarkdown', () => {
  it('renders per-run stats, the paired comparison, and a noise-floor section when given', () => {
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

    expect(markdown).toContain('# Eval compare — transcription — set set-1');
    expect(markdown).toContain('run-candidate');
    expect(markdown).toContain('Noise floor');
  });
});

describe('buildTranscriptionReferenceFreeCompareMarkdown', () => {
  it('renders the reference-free label and agreement-with-baseline stats', () => {
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

    expect(markdown).toContain('no approved reference yet: agreement with the baseline transcript only, not an accuracy figure');
    expect(markdown).toContain('run-candidate');
  });
});
