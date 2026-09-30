/**
 * Per-task non-inferiority tolerances, budget caps, and list prices for the evaluation
 * framework. List prices are dated because they drift; re-check them before relying on a
 * projection. They are used only to project a run's cost before it starts and to gate it against a
 * budget cap. Actual recorded cost always comes from OpenRouter's `usage.cost` on the response,
 * never from this table.
 */

import type { EvalTask } from './types';

/** Whether a task's primary metric is better when higher (recall, pass rate, F1) or lower
 * (false-negative rate, edit distance) — the direction a non-inferior candidate must not regress
 * past its tolerance. */
type ToleranceDirection = 'higher-is-better' | 'lower-is-better';

export interface TaskTolerance {
  /** The metric this task's non-inferiority verdict is judged on. */
  primaryMetric: string;
  direction: ToleranceDirection;
  /** How far the candidate may regress from baseline (fraction, e.g. 0.03 for 3 percentage
   * points; pp for rates, absolute for F1/edit-distance). */
  tolerance: number;
  /** A second, looser tolerance for a secondary metric the primary one doesn't cover on its own —
   * currently only audit's precision-alongside-recall rule. `compare/audit-grading.ts`'s per-criterion
   * audit verdict is the one caller that reads this; every other task's rule fits in `tolerance` alone. */
  precisionTolerance?: number;
  /** Human-readable restatement of the full rule, including any secondary condition
   * `nonInferiorityVerdict()` doesn't check on its own (e.g. grading's false-positive cap). */
  description: string;
}

/** The transcription task's non-inferiority rule has a second, independent condition beyond the
 * mean-score tolerance: on any slide scored in both runs, the candidate's score may not fall this far
 * below the baseline's score on that same slide, regardless of how the mean holds up. Read by
 * `compare/transcription.ts`'s transcription verdict alongside the mean tolerance below. */
export const TRANSCRIPTION_MAX_SLIDE_DROP = 0.15;

export const TASK_TOLERANCES: Record<EvalTask, TaskTolerance> = {
  grading: {
    primaryMetric: 'false_negative_rate',
    direction: 'lower-is-better',
    tolerance: 0.01,
    description: 'FN rate <= baseline + 1pp (point estimate, not certified at this sample size); FP rate <= baseline + 2pp; not worse on any hard label class.',
  },
  audit: {
    primaryMetric: 'recall',
    direction: 'higher-is-better',
    tolerance: 0.03,
    precisionTolerance: 0.05,
    description: 'Per-criterion recall >= baseline - 3pp; precision >= baseline - 5pp.',
  },
  generation: {
    primaryMetric: 'judge_pass_rate',
    direction: 'higher-is-better',
    tolerance: 0.03,
    description: 'Judge pass rate >= baseline - 3pp; deterministic rejects and type drift <= baseline + 2pp.',
  },
  validation: {
    primaryMetric: 'reject_recall',
    direction: 'higher-is-better',
    tolerance: 0.03,
    description: 'Reject-recall against audit reference >= baseline - 3pp; invalid-variation rate <= baseline + 2pp.',
  },
  transcription: {
    primaryMetric: 'mean_transcription_score',
    direction: 'higher-is-better',
    tolerance: 0.02,
    description: `Mean slide score (1 - normalized edit distance) >= baseline - 0.02; no slide more than ${TRANSCRIPTION_MAX_SLIDE_DROP} below the baseline's score on the same slide; no-content agreement 100%.`,
  },
  mapping: {
    primaryMetric: 'mean_heading_f1',
    direction: 'higher-is-better',
    tolerance: 0.03,
    description: 'Mean per-topic heading-set F1 >= baseline - 0.03; zero unresolvable headings after one retry.',
  },
};

/** Per-run budget caps (USD). A run refuses to start if its projected cost
 * exceeds the relevant cap; `--max-cost` on `eval-run` overrides `candidateRun` for that run. */
export const BUDGET_CAPS_USD = {
  candidateRun: 2,
  baselinePair: 5,
  experiment: 10,
} as const;

/** OpenRouter list price, USD per million tokens. */
export interface ModelPrice {
  prompt: number;
  completion: number;
}

/**
 * Projects a run's total cost from item count and a mean prompt/completion size at `price`, the
 * model registry's list price for the pinned model (`registryPriceOf` on its eval_models_current
 * row). Returns undefined when no price is known so a caller must decide how to handle an unpriced
 * model (refuse, or proceed uncosted with --allow-unpriced) rather than this function silently
 * returning zero.
 */
export function projectCostUsd(
  price: ModelPrice | undefined,
  itemCount: number,
  meanPromptTokens: number,
  meanCompletionTokens: number,
): number | undefined {
  if (!price) return undefined;
  const perItemUsd = (meanPromptTokens * price.prompt + meanCompletionTokens * price.completion) / 1_000_000;
  return perItemUsd * itemCount;
}

/**
 * Rough per-call token sizes and how many eval items one call covers, for `eval-run`'s
 * before-it-starts cost projection. `audit` and `grading` are measured on the sampled unit
 * (2026-09-26: audit with Mistral Large 3 in groups of five; grading with Opus 5.5 reasoning on,
 * whose completion figure includes about 170 reasoning tokens, so a reasoning-off variant projects
 * high). `mapping` is measured on the sampled unit too (2026-09-27: `buildMapExistingPrompt` rendered
 * against its 40 topics and its full 71k-character/2,587-line markdown came to 80,064 characters;
 * tokens estimated as chars/4, the same rough conversion the framework doc uses elsewhere — about
 * 20,000 prompt tokens, not the earlier unmeasured 75,000 placeholder). Completion tokens are still
 * an estimate (one short heading list per topic); `itemsPerCall` is descriptive only for this
 * task — `projectVariantCostUsd` always projects exactly one call for `mapping`, since the
 * runner sends every item in a single call regardless of count. `transcription`'s figures match
 * production's own per-slide call (`maxTokens: 4000`; prompt size is the fixed transcription prompt
 * plus one slide's text layer and image) but haven't been checked against a real run's recorded
 * usage — there is no live per-slide usage on record to check them against yet. The remaining
 * tasks (generation, validation) are rough estimates and are not load-bearing until their
 * runners exist.
 */
export const TASK_MEAN_TOKENS: Record<EvalTask, { promptTokensPerCall: number; completionTokensPerCall: number; itemsPerCall: number }> = {
  audit: { promptTokensPerCall: 6_300, completionTokensPerCall: 1_000, itemsPerCall: 5 },
  grading: { promptTokensPerCall: 1_200, completionTokensPerCall: 650, itemsPerCall: 1 },
  generation: { promptTokensPerCall: 11_600, completionTokensPerCall: 2_000, itemsPerCall: 10 },
  validation: { promptTokensPerCall: 4_700, completionTokensPerCall: 800, itemsPerCall: 5 },
  transcription: { promptTokensPerCall: 5_400, completionTokensPerCall: 1_500, itemsPerCall: 1 },
  mapping: { promptTokensPerCall: 20_000, completionTokensPerCall: 2_000, itemsPerCall: 40 },
};

/**
 * Audit's per-call token shape at an arbitrary `groupSize`, instead of the fixed group size (5)
 * `TASK_MEAN_TOKENS.audit` was measured at. Splits the baseline call's prompt tokens into a
 * material share — the system prompt and topic excerpts, which a call carries roughly once
 * regardless of how many questions share it, so it does not shrink just because the group does —
 * and a per-question share that scales with the group size. `AUDIT_MATERIAL_SHARE` is fitted to
 * two measured points on the sampled unit with Mistral Large 3 (2026-09-26): about 6,300 prompt tokens per
 * five-question call and about 3,560 per single-question call (0.45 projects 3,530), so a group of
 * 1 projects to roughly 2.8 times the baseline's per-item prompt tokens, and the shape reproduces
 * `TASK_MEAN_TOKENS.audit` exactly at `groupSize === 5`. Completion tokens have no shared
 * component (each question's verdict is independent output), so they scale linearly with group
 * size instead.
 */
const AUDIT_MATERIAL_SHARE = 0.45;

export function auditCallTokenShape(groupSize: number): { promptTokensPerCall: number; completionTokensPerCall: number } {
  const baseline = TASK_MEAN_TOKENS.audit;
  const materialTokens = baseline.promptTokensPerCall * AUDIT_MATERIAL_SHARE;
  const perQuestionPromptTokens = (baseline.promptTokensPerCall * (1 - AUDIT_MATERIAL_SHARE)) / baseline.itemsPerCall;
  const perQuestionCompletionTokens = baseline.completionTokensPerCall / baseline.itemsPerCall;
  return {
    promptTokensPerCall: materialTokens + perQuestionPromptTokens * groupSize,
    completionTokensPerCall: perQuestionCompletionTokens * groupSize,
  };
}

/**
 * Projects one variant's total cost for `itemCount` items on `task`, at `model`'s list price.
 * `groupSize` overrides the audit task's default call shape (`TASK_MEAN_TOKENS.audit`, sized
 * for a 5-item call) via `auditCallTokenShape` — ignored for every other task, since only
 * audit's runner groups multiple items into one call with shared material.
 *
 * The mapping task always sends every item (topic) in a single call — `eval-run` never chunks
 * it — so it projects one call at `TASK_MEAN_TOKENS.mapping`'s shape regardless of `itemCount`,
 * rather than the "chunk into itemsPerCall-sized calls" model every other task uses.
 */
export function projectVariantCostUsd(task: EvalTask, price: ModelPrice | undefined, itemCount: number, groupSize?: number): number | undefined {
  const shape = TASK_MEAN_TOKENS[task];
  if (task === 'mapping') {
    return projectCostUsd(price, 1, shape.promptTokensPerCall, shape.completionTokensPerCall);
  }
  const useCustomShape = task === 'audit' && groupSize !== undefined;
  const effectiveItemsPerCall = useCustomShape ? groupSize : shape.itemsPerCall;
  const { promptTokensPerCall, completionTokensPerCall } = useCustomShape ? auditCallTokenShape(groupSize) : shape;
  const calls = Math.ceil(itemCount / effectiveItemsPerCall);
  return projectCostUsd(price, calls, promptTokensPerCall, completionTokensPerCall);
}

/** The `ModelPrice` a registry row carries, or undefined when either price is missing on it. */
export function registryPriceOf(row: { price_prompt_usd_per_m: number | string | null; price_completion_usd_per_m: number | string | null } | undefined): ModelPrice | undefined {
  if (!row || row.price_prompt_usd_per_m == null || row.price_completion_usd_per_m == null) return undefined;
  return { prompt: Number(row.price_prompt_usd_per_m), completion: Number(row.price_completion_usd_per_m) };
}

/**
 * Whether a projected cost clears a budget cap. An unpriced model (`projectCostUsd` returned
 * undefined, meaning its registry snapshot carries no price) is refused by default — the whole
 * point of the cap is a guarantee about spend, and an unknown price can't back that guarantee.
 * `allowUnpriced` opts into running it anyway (the caller's `--allow-unpriced` flag); the caller is
 * responsible for logging that the run is proceeding without a cost guarantee.
 */
export function isWithinBudget(projectedCostUsd: number | undefined, capUsd: number, allowUnpriced = false): boolean {
  if (projectedCostUsd === undefined) return allowUnpriced;
  return projectedCostUsd <= capUsd;
}
