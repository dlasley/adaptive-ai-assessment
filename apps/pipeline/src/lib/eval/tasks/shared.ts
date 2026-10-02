/**
 * Small helpers shared by every task module in this directory.
 */

import { LlmError, type LlmCallOptions } from '@adaptive/shared/llm';
import type { ModelSamplingConstraints } from './types';

/** Six retries, 5 s doubling to 60 s — the retry policy every task's model call uses. */
export const MODEL_CALL_RETRY = { maxRetries: 6, initialBackoffMs: 5000, maxBackoffMs: 60000 };

// A group call's token counts are split evenly across its questions, so a per-item share can be
// fractional; the eval_results token columns are integers.
export function wholeTokens(value: number | undefined | null): number | null {
  return value === undefined || value === null ? null : Math.round(value);
}

export function isEmptyContentError(err: unknown): boolean {
  return err instanceof LlmError && /^(empty|missing) content/.test(err.message);
}

export interface EffectiveSamplingSettings {
  temperature: number | undefined;
  reasoning: LlmCallOptions['reasoning'] | undefined;
  /** One line per adjustment made for this model, empty when the intended settings needed none. */
  adjustments: string[];
}

/**
 * Adjusts a task's intended temperature and reasoning for a model `constraints` says cannot accept
 * them as given: drops the temperature outright when the model demands its own fixed default
 * (`fixedTemperature`), and raises a disabled-reasoning request to `constraints.fallbackReasoningEffort`
 * when the model requires reasoning (`reasoningMandatory`). `constraints` is resolved once per model
 * by `eval-run.ts`, from `MODEL_CONSTRAINTS` and the model's registry row, so no task module looks up
 * either itself. Only ever overrides a task's own default: `reasoningExplicit` (the caller passed
 * `--reasoning`) always passes `intendedReasoning` through unchanged, since an explicit choice should
 * fail loudly if the model rejects it rather than being silently rewritten.
 */
export function resolveEffectiveSamplingSettings(
  constraints: ModelSamplingConstraints,
  intendedTemperature: number | undefined,
  intendedReasoning: LlmCallOptions['reasoning'] | undefined,
  reasoningExplicit: boolean,
): EffectiveSamplingSettings {
  const adjustments: string[] = [];

  let temperature = intendedTemperature;
  if (constraints.fixedTemperature && temperature !== undefined) {
    temperature = undefined;
    adjustments.push(`dropped temperature ${intendedTemperature} (model requires its own fixed default)`);
  }

  let reasoning = intendedReasoning;
  if (!reasoningExplicit && constraints.reasoningMandatory && intendedReasoning?.enabled === false) {
    // constraints.fallbackReasoningEffort is a plain string (it's read from the model registry's
    // own effort tier names, a wider set than callLlm's typed union); cast rather than narrow the
    // registry's vocabulary to match callLlm's.
    reasoning = { effort: constraints.fallbackReasoningEffort as NonNullable<LlmCallOptions['reasoning']>['effort'] };
    adjustments.push(`sent reasoning effort '${constraints.fallbackReasoningEffort}' instead of disabling it (model requires reasoning)`);
  }

  return { temperature, reasoning, adjustments };
}
