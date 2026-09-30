import { describe, expect, it } from 'vitest';
import {
  BUDGET_CAPS_USD,
  isWithinBudget,
  MODEL_PRICES_USD_PER_MILLION,
  projectVariantCostUsd,
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
  it('rounds up to a whole number of calls before pricing', () => {
    // audit: 5 items per call. 6 items -> 2 calls, not 1.2.
    const cost = projectVariantCostUsd('audit', 'mistralai/mistral-large-2512', 6);
    const { promptTokensPerCall, completionTokensPerCall } = TASK_MEAN_TOKENS.audit;
    const perCall = (promptTokensPerCall * 0.5 + completionTokensPerCall * 1.5) / 1_000_000;
    expect(cost).toBeCloseTo(perCall * 2, 10);
  });

  it('returns undefined for an unpriced model', () => {
    expect(projectVariantCostUsd('grading', 'some-vendor/unlisted-model', 100)).toBeUndefined();
  });

  it('with no groupSize given, matches the fixed TASK_MEAN_TOKENS.audit shape exactly', () => {
    const withGroupSize = projectVariantCostUsd('audit', 'mistralai/mistral-large-2512', 20, 5);
    const withoutGroupSize = projectVariantCostUsd('audit', 'mistralai/mistral-large-2512', 20);
    expect(withGroupSize).toBeCloseTo(withoutGroupSize!, 10);
  });

  it('at groupSize 1, projects a per-item cost above the five-question baseline but well under five times it', () => {
    // Single-question calls repeat the system prompt and carry one topic's material, so the
    // measured premium is a fraction of the call, not a fivefold repeat of it.
    const model = 'mistralai/mistral-large-2512';
    const baselinePerItem = projectVariantCostUsd('audit', model, 100, 5)! / 100;
    const singleQuestionPerItem = projectVariantCostUsd('audit', model, 100, 1)! / 100;
    const ratio = singleQuestionPerItem / baselinePerItem;
    expect(ratio).toBeGreaterThan(1.2);
    expect(ratio).toBeLessThan(3);
  });

  it('a smaller groupSize needs more calls for the same item count, at higher cost', () => {
    const model = 'mistralai/mistral-large-2512';
    const groupOf5 = projectVariantCostUsd('audit', model, 100, 5)!;
    const groupOf1 = projectVariantCostUsd('audit', model, 100, 1)!;
    expect(groupOf1).toBeGreaterThan(groupOf5);
  });

  it('groupSize has no effect on a non-audit task', () => {
    const model = 'anthropic/claude-opus-5.5';
    const withGroupSize = projectVariantCostUsd('grading', model, 50, 5);
    const withoutGroupSize = projectVariantCostUsd('grading', model, 50);
    expect(withGroupSize).toBeCloseTo(withoutGroupSize!, 10);
  });
});

describe('auditCallTokenShape', () => {
  it('reproduces TASK_MEAN_TOKENS.audit exactly at the baseline group size', () => {
    const shape = auditCallTokenShape(TASK_MEAN_TOKENS.audit.itemsPerCall);
    expect(shape.promptTokensPerCall).toBeCloseTo(TASK_MEAN_TOKENS.audit.promptTokensPerCall, 6);
    expect(shape.completionTokensPerCall).toBeCloseTo(TASK_MEAN_TOKENS.audit.completionTokensPerCall, 6);
  });

  it('scales completion tokens per call linearly with group size (no shared component)', () => {
    const perQuestion = TASK_MEAN_TOKENS.audit.completionTokensPerCall / TASK_MEAN_TOKENS.audit.itemsPerCall;
    expect(auditCallTokenShape(1).completionTokensPerCall).toBeCloseTo(perQuestion, 6);
    expect(auditCallTokenShape(3).completionTokensPerCall).toBeCloseTo(perQuestion * 3, 6);
  });

  it('prompt tokens per call shrink with group size but never to zero (the material floor)', () => {
    const atOne = auditCallTokenShape(1).promptTokensPerCall;
    const atFive = auditCallTokenShape(5).promptTokensPerCall;
    expect(atOne).toBeLessThan(atFive);
    expect(atOne).toBeGreaterThan(0);
  });
});

describe('isWithinBudget', () => {
  it('allows a projected cost at or below the cap', () => {
    expect(isWithinBudget(2, 2)).toBe(true);
    expect(isWithinBudget(1.5, 2)).toBe(true);
  });

  it('refuses a projected cost above the cap', () => {
    expect(isWithinBudget(2.01, 2)).toBe(false);
  });

  it('refuses an unpriced model by default', () => {
    expect(isWithinBudget(undefined, 2)).toBe(false);
  });

  it('allows an unpriced model through only when allowUnpriced is set', () => {
    expect(isWithinBudget(undefined, 2, true)).toBe(true);
    expect(isWithinBudget(undefined, 2, false)).toBe(false);
  });

  it('still enforces the cap for a priced model even when allowUnpriced is set', () => {
    expect(isWithinBudget(2.01, 2, true)).toBe(false);
  });
});

describe('projectCostUsd', () => {
  it('computes cost from item count and mean token sizes at list price', () => {
    // Mistral Large 3: $0.5/M prompt, $1.5/M completion. 150 items, 6000 prompt tokens (5
    // questions/group audit prompt with material), 400 completion tokens.
    const cost = projectCostUsd('mistralai/mistral-large-2512', 150, 6000, 400);
    const perItem = (6000 * 0.5 + 400 * 1.5) / 1_000_000;
    expect(cost).toBeCloseTo(perItem * 150, 10);
  });

  it('returns undefined for a model with no listed price', () => {
    expect(projectCostUsd('some-vendor/unlisted-model', 100, 1000, 100)).toBeUndefined();
  });

  it('returns 0 for zero items', () => {
    expect(projectCostUsd('anthropic/claude-sonnet-5', 0, 1000, 100)).toBe(0);
  });

  it('has a price entry for every model referenced in the catalog\'s candidate pool', () => {
    const expectedModels = [
      'anthropic/claude-opus-5.5',
      'anthropic/claude-sonnet-5',
      'anthropic/claude-haiku-4.5',
      'mistralai/mistral-large-2512',
      'mistralai/mistral-medium-3-5',
      'mistralai/mistral-small-2603',
      'mistralai/ministral-8b-2512',
      'google/gemini-2.5-flash',
      'google/gemini-2.5-flash-lite',
      'google/gemini-3.1-flash-lite',
      'openai/gpt-4.1-mini',
      'openai/gpt-4.1-nano',
      'openai/gpt-6-luna',
    ];
    for (const model of expectedModels) {
      expect(MODEL_PRICES_USD_PER_MILLION[model]).toBeDefined();
    }
  });
});
