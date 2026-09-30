/**
 * Aggregation and reporting for `LlmUsage` (packages/shared/src/llm.ts), shared by every pipeline
 * command that calls an LLM. Each command keeps its own accumulator and prints it once, at the
 * end of the run, via `formatUsageSummary`.
 */

import type { LlmUsage } from '@adaptive/shared/llm';

export interface UsageTotals {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  byok_calls: number;
}

/** `UsageTotals` plus a count of responses that didn't parse — used by the two stages
 * (generation, validation) whose output is JSON parsed after the call returns. */
export interface StageUsage extends UsageTotals {
  json_failures: number;
}

export function emptyUsageTotals(): UsageTotals {
  return { calls: 0, prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cost_usd: 0, byok_calls: 0 };
}

export function emptyStageUsage(): StageUsage {
  return { ...emptyUsageTotals(), json_failures: 0 };
}

/** Records one completed LLM call into `totals`. Call this once per `callLlm()` that returned —
 * a call that threw has no usage to add and is never recorded here. */
export function recordCall(totals: UsageTotals, usage: LlmUsage | undefined): void {
  totals.calls += 1;
  if (!usage) return;
  totals.prompt_tokens += usage.promptTokens ?? 0;
  totals.completion_tokens += usage.completionTokens ?? 0;
  totals.reasoning_tokens += usage.reasoningTokens ?? 0;
  totals.cost_usd += usage.costUsd ?? 0;
  if (usage.isByok) totals.byok_calls += 1;
}

/** Adds `source`'s fields into `target` in place — for rolling per-topic or per-group totals up
 * into a run-wide total. Both arguments must be the same shape (`UsageTotals` or `StageUsage`). */
export function addUsageTotals(target: UsageTotals, source: UsageTotals): void {
  target.calls += source.calls;
  target.prompt_tokens += source.prompt_tokens;
  target.completion_tokens += source.completion_tokens;
  target.reasoning_tokens += source.reasoning_tokens;
  target.cost_usd += source.cost_usd;
  target.byok_calls += source.byok_calls;
}

export function addStageUsageTotals(target: StageUsage, source: StageUsage): void {
  addUsageTotals(target, source);
  target.json_failures += source.json_failures;
}

/** "Usage: N calls, X prompt / Y completion tokens, $Z" — printed once at the end of any pipeline
 * command that made at least one LLM call. */
export function formatUsageSummary(totals: UsageTotals): string {
  return `Usage: ${totals.calls} call${totals.calls === 1 ? '' : 's'}, ${totals.prompt_tokens} prompt / ${totals.completion_tokens} completion tokens, $${totals.cost_usd.toFixed(4)}`;
}
