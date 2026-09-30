import { describe, expect, it } from 'vitest';
import { primaryMetricFor } from '../src/lib/eval/primary-metric';
import { EVAL_TASKS } from '../src/lib/eval/types';
import { TASK_TOLERANCES } from '../src/lib/eval/tolerances';

describe('primaryMetricFor', () => {
  it('averages per-criterion recall for an audit run with a reference', () => {
    const summary = {
      reference: {
        natural_language: { precision: 0.9, recall: 0.8, f1: 0.85 },
        register_appropriate: { precision: 1, recall: 1, f1: 1 },
      },
    };
    expect(primaryMetricFor('audit', summary)).toEqual({
      name: TASK_TOLERANCES.audit.primaryMetric,
      value: 0.9,
      direction: TASK_TOLERANCES.audit.direction,
    });
  });

  it('returns undefined for a reference-free audit run', () => {
    expect(primaryMetricFor('audit', { reference: null, productionAgreement: { n: 150, agreementRate: 0.8 } })).toBeUndefined();
  });

  it('reads grading false-negative rate from the overall bucket', () => {
    const summary = { overall: { n: 10, agreementRate: 0.9, falseNegativeRate: 0.05, falsePositiveRate: 0.02 } };
    expect(primaryMetricFor('grading', summary)).toEqual({
      name: TASK_TOLERANCES.grading.primaryMetric,
      value: 0.05,
      direction: TASK_TOLERANCES.grading.direction,
    });
  });

  it('returns undefined when grading has no reference items (rates are null/NaN)', () => {
    const summary = { overall: { n: 0, agreementRate: null, falseNegativeRate: null, falsePositiveRate: null } };
    expect(primaryMetricFor('grading', summary)).toBeUndefined();
  });

  it('reads mapping mean F1', () => {
    expect(primaryMetricFor('mapping', { meanF1: 0.82 })).toEqual({
      name: TASK_TOLERANCES.mapping.primaryMetric,
      value: 0.82,
      direction: TASK_TOLERANCES.mapping.direction,
    });
  });

  it('reads transcription mean score', () => {
    expect(primaryMetricFor('transcription', { meanScore: 0.91 })).toEqual({
      name: TASK_TOLERANCES.transcription.primaryMetric,
      value: 0.91,
      direction: TASK_TOLERANCES.transcription.direction,
    });
  });

  it('returns undefined when transcription has no reference items', () => {
    expect(primaryMetricFor('transcription', { meanCoverage: 0.98, referenceItemCount: 0 })).toBeUndefined();
  });

  it('returns undefined for a failed run whose summary carries only an operator note', () => {
    expect(primaryMetricFor('grading', { note: 'stopped by operator' })).toBeUndefined();
  });

  it('returns undefined for a non-object summary', () => {
    expect(primaryMetricFor('audit', null)).toBeUndefined();
    expect(primaryMetricFor('audit', undefined)).toBeUndefined();
  });

  it('has some extraction defined for every eval task', () => {
    // Every task must at least return undefined rather than throw on an empty summary.
    for (const task of EVAL_TASKS) {
      expect(() => primaryMetricFor(task, {})).not.toThrow();
    }
  });

  it('returns undefined for generation and validation regardless of summary content, since neither has a runner yet', () => {
    expect(primaryMetricFor('generation', { judgePassRate: 0.9 })).toBeUndefined();
    expect(primaryMetricFor('validation', { rejectRecall: 0.9 })).toBeUndefined();
  });
});
