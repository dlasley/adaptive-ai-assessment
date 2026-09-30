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
} from '../src/lib/eval/tolerances';
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
