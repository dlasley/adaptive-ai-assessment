/**
 * Canonical value sets for `questions.difficulty`, `questions.type`, and
 * `questions.writing_type`. These mirror the CHECK constraints in
 * supabase/schema.sql; every TypeScript union type, CLI flag validation list,
 * or iteration over "all valid values" for these three columns should import
 * from here rather than redeclaring the values. tests/enums.test.ts parses
 * schema.sql's CHECK constraints and fails if this file drifts from them.
 */

export const DIFFICULTIES = ['beginner', 'intermediate', 'advanced'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export function isDifficulty(value: string): value is Difficulty {
  return (DIFFICULTIES as readonly string[]).includes(value);
}

export const QUESTION_TYPES = ['multiple-choice', 'true-false', 'fill-in-blank', 'writing'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const WRITING_TYPES = [
  'translation',
  'conjugation',
  'open_ended',
  'question_formation',
  'sentence_building',
] as const;
export type WritingType = (typeof WRITING_TYPES)[number];

/**
 * Value set for `question_results.graded_by`: which grading path settled a typed answer. Mirrors
 * that column's CHECK constraint in supabase/schema.sql. `variation` and `variation_swap` are
 * matches against an acceptable variation rather than the primary answer; `swap` and
 * `variation_swap` differ from what they matched by one pair of adjacent characters exchanged.
 */
export const GRADED_BY_VALUES = [
  'empty',
  'exact',
  'variation',
  'swap',
  'variation_swap',
  'noise',
  'semantic',
] as const;
export type GradedBy = (typeof GRADED_BY_VALUES)[number];

export function isGradedBy(value: string): value is GradedBy {
  return (GRADED_BY_VALUES as readonly string[]).includes(value);
}

/**
 * Value sets for the evaluation framework's CHECK constraints (`task` on eval_sets, eval_runs and
 * eval_findings, `status` on eval_runs and eval_experiments, `kind` on eval_findings,
 * `reference_status` on eval_items). The pipeline imports `EVAL_TASKS`; the other lists are drift
 * guards pinned to the schema file by the enums test.
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

export const FINDING_KINDS = ['adopt', 'reject', 'defer', 'observation'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const EXPERIMENT_STATUSES = ['proposed', 'running', 'decided', 'deferred', 'superseded'] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export const RUN_STATUSES = ['running', 'completed', 'failed', 'aborted'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const REFERENCE_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ReferenceStatus = (typeof REFERENCE_STATUSES)[number];
