/**
 * Shared types for the evaluation framework's library (`lib/eval/`) and commands (`eval-*`).
 * Mirrors the `task` CHECK constraint on `eval_sets`/`eval_runs` (supabase/schema.sql).
 */

export const EVAL_TASKS = [
  'audit',
  'grading',
  'generation',
  'validation',
  'transcription',
  'mapping',
] as const;

export type EvalTask = (typeof EVAL_TASKS)[number];
