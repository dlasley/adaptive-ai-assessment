import { describe, expect, it } from 'vitest';
import {
  BUDGET_CAPS_USD,
  isWithinBudget,
  projectVariantCostUsd,
  registryPriceOf,
  projectCostUsd,
  auditCallTokenShape,
  TASK_MEAN_TOKENS,
  TASK_TOLERANCES,
  TRANSCRIPTION_MAX_SLIDE_DROP,
  resolveTolerance,
  describeToleranceSource,
} from '../src/lib/eval/tolerances';
import { pairedComparison, nonInferiorityVerdict } from '../src/lib/eval/scoring';
import { EVAL_TASKS } from '../src/lib/eval/types';

describe('TASK_TOLERANCES', () => {
  it('has an entry for every eval task', () => {
    for (const task of EVAL_TASKS) {
      expect(TASK_TOLERANCES[task]).toBeDefined();
      expect(TASK_TOLERANCES[task].tolerance).toBeGreaterThan(0);
    }
  });
});

describe('BUDGET_CAPS_USD', () => {
  it('matches the documented defaults', () => {
    expect(BUDGET_CAPS_USD).toEqual({ candidateRun: 2, baselinePair: 5, experiment: 10 });
  });
});

describe('TASK_MEAN_TOKENS', () => {
  it('has an entry for every eval task', () => {
    for (const task of EVAL_TASKS) {
      expect(TASK_MEAN_TOKENS[task]).toBeDefined();
      expect(TASK_MEAN_TOKENS[task].itemsPerCall).toBeGreaterThan(0);
    }
  });
});

describe('projectVariantCostUsd', () => {
  const mistralLarge = { prompt: 0.5, completion: 1.5 };

  it('rounds up to a whole number of calls before pricing', () => {
    // audit: 5 items per call. 6 items -> 2 calls, not 1.2.
    const cost = projectVariantCostUsd('audit', mistralLarge, 6);
    const { promptTokensPerCall, completionTokensPerCall } = TASK_MEAN_TOKENS.audit;
    const perCall = (promptTokensPerCall * 0.5 + completionTokensPerCall * 1.5) / 1_000_000;
    expect(cost).toBeCloseTo(perCall * 2, 10);
  });

  it('returns undefined when the registry carries no price for the model', () => {
    expect(projectVariantCostUsd('grading', undefined, 100)).toBeUndefined();
  });

  it('prices from the registry row', () => {
    const { promptTokensPerCall, completionTokensPerCall, itemsPerCall } = TASK_MEAN_TOKENS.grading;
    const cost = projectVariantCostUsd('grading', { prompt: 2, completion: 10 }, 100);
    const perCall = (promptTokensPerCall * 2 + completionTokensPerCall * 10) / 1_000_000;
    expect(cost).toBeCloseTo(perCall * Math.ceil(100 / itemsPerCall), 10);
  });

  it('registryPriceOf returns undefined when either price is missing on the row', () => {
    expect(registryPriceOf({ price_prompt_usd_per_m: '2', price_completion_usd_per_m: null })).toBeUndefined();
    expect(registryPriceOf(undefined)).toBeUndefined();
    expect(registryPriceOf({ price_prompt_usd_per_m: '2', price_completion_usd_per_m: '10' })).toEqual({ prompt: 2, completion: 10 });
  });
});

describe('resolveTolerance', () => {
  it('resolves to the task default with no overrides when decisionRule is omitted or empty', () => {
    for (const decisionRule of [undefined, null, {}]) {
      const resolved = resolveTolerance('grading', decisionRule);
      expect(resolved.tolerance).toBe(TASK_TOLERANCES.grading.tolerance);
      expect(resolved.precisionTolerance).toBe(TASK_TOLERANCES.grading.precisionTolerance);
      expect(resolved.maxSlideDrop).toBe(TRANSCRIPTION_MAX_SLIDE_DROP);
      expect(resolved.appliedOverrides).toEqual({});
      expect(resolved.unknownKeys).toEqual([]);
    }
  });

  it('overrides tolerance, precisionTolerance, and maxSlideDrop independently', () => {
    const resolved = resolveTolerance('audit', { tolerance: 0.1, precisionTolerance: 0.2, maxSlideDrop: 0.3 });
    expect(resolved.tolerance).toBe(0.1);
    expect(resolved.precisionTolerance).toBe(0.2);
    expect(resolved.maxSlideDrop).toBe(0.3);
    expect(resolved.appliedOverrides).toEqual({ tolerance: 0.1, precisionTolerance: 0.2, maxSlideDrop: 0.3 });
  });

  it('reports an unrecognized key and leaves every resolved value at the task default', () => {
    const resolved = resolveTolerance('audit', { toleranceTypo: 0.1, description: 'fine, known' });
    expect(resolved.unknownKeys).toEqual(['toleranceTypo']);
    expect(resolved.tolerance).toBe(TASK_TOLERANCES.audit.tolerance);
    expect(resolved.appliedOverrides).toEqual({});
  });

  it('ignores a non-numeric value for a recognized key, treating it as absent', () => {
    const resolved = resolveTolerance('grading', { tolerance: 'not a number' });
    expect(resolved.tolerance).toBe(TASK_TOLERANCES.grading.tolerance);
    expect(resolved.appliedOverrides).toEqual({});
  });
});

describe('describeToleranceSource', () => {
  it('names "task default" when no override was applied', () => {
    expect(describeToleranceSource(resolveTolerance('grading'))).toBe('task default');
  });

  it('names the overridden key(s) and their resolved value', () => {
    expect(describeToleranceSource(resolveTolerance('audit', { tolerance: 0.1 }))).toBe('experiment override: tolerance 0.1');
  });
});

describe('an experiment override flips a non-inferiority verdict the task default would not', () => {
  it('a tighter tolerance turns a pass into a fail', () => {
    // 99 agreements, 1 false negative the baseline didn't have: candidate FN rate 0.01, exactly at
    // the task default's 1pp tolerance (inclusive boundary, so the default passes).
    const outcomes = [
      ...Array.from({ length: 99 }, (_, i) => ({ itemId: `ok${i}`, baselinePass: false, candidatePass: false })),
      { itemId: 'fn', baselinePass: false, candidatePass: true },
    ];
    const comparison = pairedComparison(outcomes);

    const defaultVerdict = nonInferiorityVerdict('grading', comparison, resolveTolerance('grading'));
    expect(defaultVerdict.nonInferior).toBe(true);

    const tighterVerdict = nonInferiorityVerdict('grading', comparison, resolveTolerance('grading', { tolerance: 0.005 }));
    expect(tighterVerdict.nonInferior).toBe(false);
  });

  it('a looser tolerance turns a fail into a pass', () => {
    const outcomes = [{ itemId: 'fn', baselinePass: false, candidatePass: true }]; // 100% FN rate
    const comparison = pairedComparison(outcomes);

    const defaultVerdict = nonInferiorityVerdict('grading', comparison, resolveTolerance('grading'));
    expect(defaultVerdict.nonInferior).toBe(false);

    const looserVerdict = nonInferiorityVerdict('grading', comparison, resolveTolerance('grading', { tolerance: 1 }));
    expect(looserVerdict.nonInferior).toBe(true);
  });
});

describe('projectCostUsd', () => {
  it('computes cost from item count and mean token sizes at the given price', () => {
    const cost = projectCostUsd({ prompt: 0.5, completion: 1.5 }, 150, 6000, 400);
    const perItem = (6000 * 0.5 + 400 * 1.5) / 1_000_000;
    expect(cost).toBeCloseTo(perItem * 150, 10);
  });

  it('returns undefined without a price', () => {
    expect(projectCostUsd(undefined, 100, 1000, 100)).toBeUndefined();
  });

  it('returns 0 for zero items', () => {
    expect(projectCostUsd({ prompt: 2, completion: 10 }, 0, 1000, 100)).toBe(0);
  });
});
