/**
 * Attaches the fields every finished run's `eval_runs.summary` carries on top of whatever its
 * task-specific `buildSummary` computed: `primary_metric` (via `primaryMetricFor`, the single
 * source for which key means "the primary metric" per task), `scoredAt` (when this summary was
 * computed, whether at run time or by a later rescore), and `scoringReviewRoundId` (the reviewed-
 * reference state this summary was scored against, or null when the task has no review round or
 * none has happened yet). Used by both `eval-run.ts`'s `finalizeVariant` and `eval-rescore.ts` so
 * the two never diverge on summary shape.
 */

import { primaryMetricFor } from './primary-metric';
import type { EvalTask } from './types';

export interface SummaryStampContext {
  scoredAt: string;
  scoringReviewRoundId: string | null;
}

export function stampSummary(task: EvalTask, built: Record<string, unknown>, context: SummaryStampContext): Record<string, unknown> {
  const primaryMetric = primaryMetricFor(task, built);
  return {
    ...built,
    ...(primaryMetric ? { primary_metric: primaryMetric } : {}),
    scoredAt: context.scoredAt,
    scoringReviewRoundId: context.scoringReviewRoundId,
  };
}
