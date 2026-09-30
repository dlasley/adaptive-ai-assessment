/**
 * Extracts a task's primary metric from a run's stored `summary`, in the
 * `{name, value, direction}` shape `eval_runs.summary.primary_metric` and the comparison views
 * (`eval_run_scorecard`, `eval_run_model_stats`, `eval_family_history`) expect. `name` and
 * `direction` come from `TASK_TOLERANCES`; `value` is read from wherever that task's own
 * summary builder (`buildAuditRunSummary`, `buildGradingRunSummary`, `summarizeMapping...`,
 * `summarizeTranscription...`) already puts it — those shapes differ per task (nested under
 * `reference`/`overall`, or a flat key) and don't share a naming convention with each other or
 * with `TASK_TOLERANCES`'s own metric name.
 *
 * Imported by both the one-time backfill and `eval-run`/`eval-compare`'s write path, so the two
 * can't independently drift on which key means "the primary metric" for a task.
 */

import { TASK_TOLERANCES } from './tolerances';
import type { EvalTask } from './types';

export interface PrimaryMetric {
  name: string;
  value: number;
  direction: 'higher-is-better' | 'lower-is-better';
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Audit's own summary has no single "recall" field: `reference` (null until a reference item
 * exists) holds a per-criterion `{precision, recall, f1}` map, since the task's real
 * non-inferiority check is per-criterion. The primary metric backfilled here is the mean recall
 * across criteria, unweighted because each gate criterion is an independent pass/fail check that
 * counts equally regardless of how often it fires, as a single representative number for
 * cross-task views; the authoritative per-criterion comparison stays in `compare/audit-grading.ts`. */
function auditValue(summary: Record<string, unknown>): number | undefined {
  const reference = summary.reference;
  if (!reference || typeof reference !== 'object') return undefined;
  const recalls = Object.values(reference as Record<string, Record<string, unknown>>)
    .map((criterion) => finiteNumber(criterion?.recall))
    .filter((v): v is number => v !== undefined);
  if (recalls.length === 0) return undefined;
  return recalls.reduce((sum, v) => sum + v, 0) / recalls.length;
}

function gradingValue(summary: Record<string, unknown>): number | undefined {
  const overall = summary.overall as Record<string, unknown> | undefined;
  return finiteNumber(overall?.falseNegativeRate);
}

function mappingValue(summary: Record<string, unknown>): number | undefined {
  return finiteNumber(summary.meanF1);
}

function transcriptionValue(summary: Record<string, unknown>): number | undefined {
  return finiteNumber(summary.meanScore);
}

/** No runner exists yet for generation or validation, so there is no summary shape to read a
 * value from — always undefined until a runner ships and this gets a real extractor. */
function noRunnerYet(_summary: Record<string, unknown>): number | undefined {
  return undefined;
}

const PRIMARY_METRIC_VALUE_BY_TASK: Record<EvalTask, (summary: Record<string, unknown>) => number | undefined> = {
  audit: auditValue,
  grading: gradingValue,
  generation: noRunnerYet,
  validation: noRunnerYet,
  transcription: transcriptionValue,
  mapping: mappingValue,
};

/**
 * Returns `{name, value, direction}` for `task` from `summary`, or `undefined` when the
 * source value isn't present — a failed run's summary (no metric fields at all) or a
 * reference-dependent metric (audit's `reference`, grading's `overall`) with no reference item to
 * compare against yet. A missing value is never backfilled as a placeholder; the caller decides
 * how to report the gap.
 */
export function primaryMetricFor(task: EvalTask, summary: unknown): PrimaryMetric | undefined {
  if (!summary || typeof summary !== 'object') return undefined;
  const tolerance = TASK_TOLERANCES[task];
  const value = PRIMARY_METRIC_VALUE_BY_TASK[task](summary as Record<string, unknown>);
  if (value === undefined) return undefined;
  return { name: tolerance.primaryMetric, value, direction: tolerance.direction };
}
