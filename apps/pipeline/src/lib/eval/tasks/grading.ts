/**
 * The grading task's `eval-run` wiring: submits a question and a submitted answer to the model
 * being evaluated through the exact production grading prompt, parses its verdict, and scores it
 * against a reviewer's reference when one is approved. Every call is independent — no shared setup
 * runs before the first one.
 */

import { buildEvaluationPrompt, parseEvaluationResponse, EvaluationParseError, GRADING_CALL_SETTINGS } from '@adaptive/shared/grading-prompt';
import type { EvalItemRow, NewEvalResultRow } from '../db';
import { createLogger } from '../../logger';
import { planInterleavedCalls, buildGradingRunSummary, GRADING_PASS_SCORE_THRESHOLD, type GradingItemOutcome, type GradingReference } from '../runner';
import { withRateLimitRetry } from '../run-loop';
import type { GradingLabelClass } from '../set-builder';
import { usageFromLlmResult, type ResultUsage } from '../usage';
import { MODEL_CALL_RETRY, wholeTokens, isEmptyContentError, hashText } from './shared';
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

export const gradingTask: EvalTaskDefinition<undefined, GradingItemOutcome> = {
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

  async runCall({ call, run, callSettings, reasoning, callLlmFn, throttleIfMistral }) {
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

      try {
        const result = await withRateLimitRetry(() => callLlmFn({
          model: call.variant.model,
          temperature: callSettings.temperature,
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

      outcomes.push({
        itemId: item.id,
        labelClass: p.label_class as GradingLabelClass,
        difficulty: String(p.difficulty),
        reference: gradingReferenceFromItem(item),
        output,
        error,
        latencyMs,
        costUsd: usage.cost_usd,
      });
      resultRows.push({
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
      });
    }

    return { outcomes, resultRows };
  },

  buildSummary(outcomes) {
    return buildGradingRunSummary(outcomes) as unknown as Record<string, unknown>;
  },
};
