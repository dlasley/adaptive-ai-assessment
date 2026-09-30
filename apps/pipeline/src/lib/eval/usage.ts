/**
 * Maps an `LlmResult`'s usage and routing fields onto the `eval_results` columns that carry them.
 * Every eval-run task that calls a model directly through `callLlm` (mapping, transcription,
 * grading) uses this same shape; audit's usage comes from `MistralAuditResult` instead, a different
 * shape built inline where it's used.
 */

import type { LlmResult } from '@adaptive/shared/llm';

export interface ResultUsage {
  cost_usd?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  served_model?: string;
  served_provider?: string;
  is_byok?: boolean;
}

export function usageFromLlmResult(result: LlmResult): ResultUsage {
  return {
    cost_usd: result.usage?.costUsd,
    prompt_tokens: result.usage?.promptTokens,
    completion_tokens: result.usage?.completionTokens,
    reasoning_tokens: result.usage?.reasoningTokens,
    served_model: result.servedModel,
    served_provider: result.servedProvider,
    is_byok: result.usage?.isByok,
  };
}
