import { CORRECTNESS_THRESHOLDS } from '@/lib/feature-flags';
import { COURSE_CONTENT } from '@adaptive/shared/course';
import { callLlm, LlmError, parseUsage, type LlmResult, type OpenRouterResponseBody } from '@adaptive/shared/llm';
import { MODELS } from '@adaptive/shared/models';
import {
  buildEvaluationPrompt,
  parseEvaluationResponse,
  EvaluationParseError,
  GRADING_CALL_SETTINGS,
  type EvaluationResponse,
} from '@adaptive/shared/grading-prompt';
import { createLogger } from '@/lib/logger';
import { supabaseErrorFields } from '@/lib/supabase-error';
import type { EvaluationResult } from './types';

const logger = createLogger('evaluate-writing');
const courseFeedback = COURSE_CONTENT.feedback;

/** Cost/token accounting for the grading call(s), surfaced to the caller's structured log —
 * never to the student. Summed across both attempts when a retry happens, since the first
 * attempt's tokens were spent even if its response didn't parse. */
export interface GradingCallUsage {
  costUsd?: number;
  servedModel?: string;
  promptTokens?: number;
  completionTokens?: number;
  /** True once any of the accumulated usage above came from a call that errored (billed but
   * unusable — e.g. reasoning exhausted the token budget before content was produced), rather
   * than a call that returned successfully. */
  error?: boolean;
}

/**
 * Evaluate answer using the configured writing-evaluation model (`MODELS.writingEvaluation`)
 * Returns both the evaluation result and the model's confidence score
 */
export async function evaluateWithModel(
  question: string,
  userAnswer: string,
  correctAnswer: string | undefined,
  questionType: string,
  difficulty: string
): Promise<{ evaluation: EvaluationResult; modelConfidence?: number; parseFailure?: boolean; usage: GradingCallUsage }> {
  const prompt = buildEvaluationPrompt({
    question,
    userAnswer,
    correctAnswer,
    questionType,
    difficulty,
    correctnessThreshold: CORRECTNESS_THRESHOLDS.SEMANTIC_API_PASS,
  });

  const usage: GradingCallUsage = {};
  const addUsage = (u: LlmResult['usage'], servedModel: string | undefined, fromError: boolean): void => {
    if (u?.costUsd !== undefined) usage.costUsd = (usage.costUsd ?? 0) + u.costUsd;
    if (u?.promptTokens !== undefined) usage.promptTokens = (usage.promptTokens ?? 0) + u.promptTokens;
    if (u?.completionTokens !== undefined) usage.completionTokens = (usage.completionTokens ?? 0) + u.completionTokens;
    if (servedModel !== undefined) usage.servedModel = servedModel;
    if (fromError && u !== undefined) usage.error = true;
  };
  const recordUsage = (result: LlmResult): void => addUsage(result.usage, result.servedModel, false);
  // A model that exhausts its token budget on reasoning before producing content is still
  // billed for those reasoning tokens — callLlm's thrown LlmError carries the response body
  // (OpenRouter's own usage object) that would otherwise be lost with the failed call.
  const recordErrorUsage = (err: unknown): void => {
    if (!(err instanceof LlmError) || !err.body) return;
    const body = err.body as OpenRouterResponseBody;
    addUsage(parseUsage(body), body.model, true);
  };

  // "empty content in JSON mode" / "missing content in response" (packages/shared/src/llm.ts):
  // a reasoning model that spent its whole completion budget before emitting content. A second
  // attempt has a genuine chance of a shorter reasoning trace, so this is worth retrying like a
  // parse failure rather than falling straight to the score-50 fallback.
  const isRetryableContentError = (err: unknown): boolean =>
    err instanceof LlmError && /^(empty|missing) content/.test(err.message);

  const callAndParse = async (): Promise<EvaluationResponse> => {
    const result = await callLlm({
      model: MODELS.writingEvaluation,
      ...GRADING_CALL_SETTINGS,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });
    // Cost is incurred whether or not the response parses, so it's recorded before parsing.
    recordUsage(result);
    return parseEvaluationResponse(result.text);
  };

  try {
    let modelResponse: EvaluationResponse;
    try {
      modelResponse = await callAndParse();
    } catch (err) {
      recordErrorUsage(err);
      // A callLlm failure (network, auth, rate limit) is never retried here — only a response
      // that came back but didn't parse/validate, or came back with no content at all, is worth
      // one more attempt.
      if (!(err instanceof EvaluationParseError) && !isRetryableContentError(err)) throw err;
      logger.warn('Semantic API response failed to parse, validate, or returned no content; retrying once');
      try {
        modelResponse = await callAndParse();
      } catch (retryErr) {
        recordErrorUsage(retryErr);
        throw new EvaluationParseError(retryErr instanceof Error ? retryErr.message : 'retry failed');
      }
    }

    // Extract confidence score and remove it from the evaluation result
    const { confidenceScore, ...evaluationResult } = modelResponse;

    return {
      evaluation: evaluationResult as EvaluationResult,
      modelConfidence: confidenceScore,
      usage
    };
  } catch (error) {
    logger.error('Semantic API error', supabaseErrorFields(error));

    // Fallback evaluation
    return {
      evaluation: {
        isCorrect: false,
        score: 50,
        hasCorrectAccents: false,
        feedback: courseFeedback.evaluationApiFailed,
        corrections: {}
      },
      modelConfidence: undefined,
      parseFailure: error instanceof EvaluationParseError,
      usage
    };
  }
}
