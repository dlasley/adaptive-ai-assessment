/**
 * Small helpers shared by every task module in this directory.
 */

import crypto from 'crypto';
import { LlmError, type LlmCallOptions } from '@adaptive/shared/llm';
import { MODEL_CONSTRAINTS } from '@adaptive/shared/models';

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

/** sha256 (16 hex) — same convention as questions-audit.ts's prompt hashing. */
export function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').substring(0, 16);
}

/** The reasoning effort sent to a `reasoningRequired` model instead of disabling reasoning
 * outright: OpenRouter's lowest effort tier that still counts as reasoning enabled. */
const LOWEST_REASONING_EFFORT = 'minimal';

export interface EffectiveSamplingSettings {
  temperature: number | undefined;
  reasoning: LlmCallOptions['reasoning'] | undefined;
  /** One line per adjustment made for this model, empty when the intended settings needed none. */
  adjustments: string[];
}

/**
 * Adjusts a task's intended temperature and reasoning for a model `MODEL_CONSTRAINTS`
 * (`@adaptive/shared/models`) says cannot accept them as given: drops the temperature outright
 * when the model demands its own fixed default (`fixedTemperature`), and raises a disabled-
 * reasoning request to the lowest effort tier that still counts as enabled when the model requires
 * reasoning (`reasoningRequired`). Only ever overrides a task's own default: `reasoningExplicit`
 * (the caller passed `--reasoning`) always passes `intendedReasoning` through unchanged, since an
 * explicit choice should fail loudly if the model rejects it rather than being silently rewritten.
 */
export function resolveEffectiveSamplingSettings(
  model: string,
  intendedTemperature: number | undefined,
  intendedReasoning: LlmCallOptions['reasoning'] | undefined,
  reasoningExplicit: boolean,
): EffectiveSamplingSettings {
  const constraints = MODEL_CONSTRAINTS[model];
  const adjustments: string[] = [];

  let temperature = intendedTemperature;
  if (constraints?.fixedTemperature && temperature !== undefined) {
    temperature = undefined;
    adjustments.push(`dropped temperature ${intendedTemperature} (model requires its own fixed default)`);
  }

  let reasoning = intendedReasoning;
  if (!reasoningExplicit && constraints?.reasoningRequired && intendedReasoning?.enabled === false) {
    reasoning = { effort: LOWEST_REASONING_EFFORT };
    adjustments.push(`sent reasoning effort '${LOWEST_REASONING_EFFORT}' instead of disabling it (model requires reasoning)`);
  }

  return { temperature, reasoning, adjustments };
}
