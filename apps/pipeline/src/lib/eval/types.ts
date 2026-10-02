/**
 * Shared types for the evaluation framework's library (`lib/eval/`) and commands (`eval-*`).
 * `EVAL_TASKS` is declared in `@adaptive/shared/enums`, which mirrors the `task` CHECK constraint
 * on `eval_sets`/`eval_runs` (supabase/schema.sql).
 */

export { EVAL_TASKS, type EvalTask } from '@adaptive/shared/enums';
