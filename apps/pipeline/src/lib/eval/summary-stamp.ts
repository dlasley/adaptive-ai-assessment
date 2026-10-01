/**
 * Attaches `primary_metric` (via `primaryMetricFor`, the single source for which key means "the
 * primary metric" per task) to whatever a task's `buildSummary` computed, and carries the scoring
 * provenance (when this summary was computed, and which reviewed-reference state it was scored
 * against) back to the caller alongside it rather than folding it into the summary: both belong in
 * `eval_runs.scored_at` and `eval_runs.scoring_review_round_id`, not inside `summary`. Used by both
 * `eval-run.ts`'s `finalizeVariant` and `eval-rescore.ts` so the two never write the run's scoring
 * state in different shapes.
 */

import { primaryMetricFor } from './primary-metric';
import type { EvalTask } from './types';

export interface SummaryStampContext {
  scoredAt: string;
  scoringReviewRoundId: string | null;
}

export interface StampedSummary extends SummaryStampContext {
  summary: Record<string, unknown>;
}

export function stampSummary(task: EvalTask, built: Record<string, unknown>, context: SummaryStampContext): StampedSummary {
  const primaryMetric = primaryMetricFor(task, built);
  return {
    summary: {
      ...built,
      ...(primaryMetric ? { primary_metric: primaryMetric } : {}),
    },
    scoredAt: context.scoredAt,
    scoringReviewRoundId: context.scoringReviewRoundId,
  };
}
