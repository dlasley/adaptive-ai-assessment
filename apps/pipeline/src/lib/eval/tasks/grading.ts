/**
 * The grading task's `eval-run` wiring: submits a question and a submitted answer to the model
 * being evaluated through the exact production grading prompt, parses its verdict, and scores it
 * against a reviewer's reference when one is approved. Every call is independent — no shared setup
 * runs before the first one.
 */

import { buildEvaluationPrompt, parseEvaluationResponse, EvaluationParseError, GRADING_CALL_SETTINGS } from '@adaptive/shared/grading-prompt';
import type { EvalItemRow, EvalResultRow, NewEvalResultRow } from '../db';
import { createLogger } from '../../logger';
import { planInterleavedCalls, buildGradingRunSummary, GRADING_PASS_SCORE_THRESHOLD, type GradingItemOutcome, type GradingReference, type GradingRunSummary } from '../runner';
import { withRateLimitRetry } from '../run-loop';
import type { GradingLabelClass } from '../set-builder';
import { usageFromLlmResult, type ResultUsage } from '../usage';
import { MODEL_CALL_RETRY, wholeTokens, isEmptyContentError, hashText, resolveEffectiveSamplingSettings } from './shared';
import { variantKey, type EvalTaskDefinition } from './types';

const logger = createLogger('eval-run');

/** Reference is only present for an item whose `eval_items` row has been reviewed and approved. */
function gradingReferenceFromItem(item: EvalItemRow): GradingReference | undefined {
  if (item.reference_status !== 'approved' || !item.reference) return undefined;
  const reference = item.reference as Partial<GradingReference>;
  if (typeof reference.isCorrect !== 'boolean') return undefined;
  return {
    isCorrect: reference.isCorrect,
    borderline: !!reference.borderline,
    reason: reference.reason ?? null,
    keyCorrect: reference.keyCorrect ?? true,
    keyNote: reference.keyNote ?? null,
  };
}

/** Rebuilds a grading outcome from a stored eval_results row and its eval_items row — the model's
 * output is read from the row, everything else from the item's payload/reference. */
function gradingOutcomeFromRow(result: EvalResultRow, item: EvalItemRow): GradingItemOutcome {
  const p = item.payload;
  return {
    itemId: item.id,
    labelClass: p.label_class as GradingLabelClass,
    difficulty: String(p.difficulty),
    reference: gradingReferenceFromItem(item),
    output: (result.output as { isCorrect: boolean; score: number } | null) ?? undefined,
    error: result.error ?? undefined,
    latencyMs: result.latency_ms ?? undefined,
    costUsd: result.cost_usd ?? undefined,
  };
}

export const gradingTask: EvalTaskDefinition<undefined, GradingItemOutcome, GradingRunSummary> = {
  task: 'grading',

  promptHash() {
    return hashText(buildEvaluationPrompt({
      question: '',
      userAnswer: '',
      correctAnswer: undefined,
      questionType: '',
      difficulty: '',
      correctnessThreshold: GRADING_PASS_SCORE_THRESHOLD,
    }));
  },

  planCalls(items, variants, { blockSize }) {
    return planInterleavedCalls(items, variants, blockSize);
  },

  async prepareContext() {
    return undefined;
  },

  cleanupContext() {},

  async runCall({ call, run, callSettings, reasoning, callLlmFn, throttleIfMistral, samplingConstraints }) {
    const key = variantKey(call.variant);
    const outcomes: GradingItemOutcome[] = [];
    const resultRows: NewEvalResultRow[] = [];

    for (const item of call.items) {
      await throttleIfMistral(call.variant.model);
      const startedAt = Date.now();
      const p = item.payload;
      const prompt = buildEvaluationPrompt({
        question: String(p.question),
        userAnswer: String(p.submitted_answer ?? ''),
        correctAnswer: String(p.correct_answer),
        questionType: String(p.type),
        difficulty: String(p.difficulty),
        correctnessThreshold: GRADING_PASS_SCORE_THRESHOLD,
      });

      let output: { isCorrect: boolean; score: number } | undefined;
      let error: 'parse' | 'api' | 'empty' | undefined;
      let usage: ResultUsage = {};

      // Grading never disables reasoning by default (unlike mapping/transcription), so only the
      // temperature can need adjusting for a model samplingConstraints flags.
      const { temperature: effectiveTemperature } = resolveEffectiveSamplingSettings(samplingConstraints, callSettings.temperature, reasoning, reasoning !== undefined);

      try {
        const result = await withRateLimitRetry(() => callLlmFn({
          model: call.variant.model,
          temperature: effectiveTemperature,
          maxTokens: GRADING_CALL_SETTINGS.maxTokens,
          jsonMode: callSettings.jsonMode,
          reasoning,
          provider: callSettings.provider,
          sessionId: run.id,
          messages: [{ role: 'user', content: prompt }],
        }), {
          ...MODEL_CALL_RETRY,
          onRateLimited: (attempt, backoffMs) => logger.warn(`Rate limited (429) on item ${item.item_key} for ${key}. Retry ${attempt + 1}/${MODEL_CALL_RETRY.maxRetries} in ${backoffMs / 1000}s...`),
        });
        usage = usageFromLlmResult(result);
        const parsed = parseEvaluationResponse(result.text);
        output = { isCorrect: parsed.isCorrect, score: parsed.score };
      } catch (err) {
        if (err instanceof EvaluationParseError) error = 'parse';
        else if (isEmptyContentError(err)) error = 'empty';
        else error = 'api';
        logger.error(`Item ${item.item_key} failed for variant ${key} (${error}): ${err instanceof Error ? err.message : String(err)}`);
      }
      const latencyMs = Date.now() - startedAt;

      const resultRow: NewEvalResultRow = {
        run_id: run.id,
        item_id: item.id,
        output: output ?? null,
        score: output?.score ?? null,
        deterministic_checks: { json_valid: !!output },
        latency_ms: latencyMs,
        cost_usd: usage.cost_usd ?? null,
        prompt_tokens: wholeTokens(usage.prompt_tokens),
        completion_tokens: wholeTokens(usage.completion_tokens),
        reasoning_tokens: wholeTokens(usage.reasoning_tokens),
        served_model: usage.served_model ?? null,
        served_provider: usage.served_provider ?? null,
        is_byok: usage.is_byok ?? null,
        error: error ?? null,
      };
      outcomes.push(gradingOutcomeFromRow(resultRow as EvalResultRow, item));
      resultRows.push(resultRow);
    }

    return { outcomes, resultRows };
  },

  buildSummary(outcomes) {
    return buildGradingRunSummary(outcomes);
  },

  outcomeFromStoredResult(result, item) {
    return gradingOutcomeFromRow(result, item);
  },
};
