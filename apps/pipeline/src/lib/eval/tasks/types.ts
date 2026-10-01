/**
 * The run-side contract every eval-run task (audit, grading, mapping, transcription) implements:
 * one-time setup shared by every call the task makes in a run, how items are grouped into calls,
 * running one planned call, and summarizing a variant's outcomes once it finishes. `eval-run.ts`'s
 * `main()` dispatches through `TASK_DEFINITIONS` (registry.ts) at each of these points instead of
 * branching on `options.task` itself.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { callLlm, LlmCallOptions } from '@adaptive/shared/llm';
import type { fetchUnitsFromDb } from '../../units-db';
import type { EvalItemRow, EvalResultRow, EvalRunRow, EvalSetRow, NewEvalResultRow } from '../db';
import type { InterleavedCall } from '../runner';
import type { EvalTask } from '../types';

export interface Variant {
  model: string;
  repeatIndex: number;
}

export function variantKey(variant: Variant): string {
  return `${variant.model}::${variant.repeatIndex}`;
}

export interface EffectiveCallSettings {
  /** Undefined only for the mapping and transcription tasks' default (production sends no
   * temperature override for `mapExistingHeadings` or `convertPdfToMarkdown`, so the model's own
   * default applies) — every other task always resolves to a concrete number. */
  temperature: number | undefined;
  jsonMode: boolean;
  provider: LlmCallOptions['provider'] | undefined;
}

/** Everything `prepareContext` needs, resolved once per `eval-run` invocation before any task-call
 * runs. Every task reads only the subset it needs (grading reads none of it). */
export interface TaskPrepareDeps {
  set: EvalSetRow;
  /** Items in run order (after `--shuffle-groups`), already filtered to runnable (non-rejected). */
  items: EvalItemRow[];
  /** Only set when a real database connection backs this run — undefined whenever a store is
   * injected (tests), so a task that needs it must not be reached in that case without also
   * injecting `fetchUnitsFromDbFn`. */
  supabase: SupabaseClient | undefined;
  /** Audit's own database read (the unit materials an audit call cites) — an injection point so a
   * test can supply units without a live Supabase connection, the same role `callLlmFn` plays for
   * model calls. Defaults to the real `fetchUnitsFromDb`. */
  fetchUnitsFromDbFn: typeof fetchUnitsFromDb;
  /** `--render-dpi`: the resolution the transcription task renders each slide image at. Every
   * other task ignores it. */
  renderDpi?: number;
}

/** The transcription task's exclusion-pass classifier, resolved once per `eval-run` invocation
 * (`--exclusion-pass`/`--exclusion-provider`) and passed uniformly to every task's `runCall` —
 * every task other than transcription ignores it. */
export interface ExclusionPassSettings {
  model: string;
  provider: LlmCallOptions['provider'] | undefined;
  promptHash: string;
}

export interface TaskRunCallParams<TContext> {
  call: InterleavedCall<EvalItemRow, Variant>;
  context: TContext;
  run: EvalRunRow;
  callSettings: EffectiveCallSettings;
  reasoning: LlmCallOptions['reasoning'] | undefined;
  callLlmFn: typeof callLlm;
  /** Delays the call by up to one second when the variant's model is a Mistral model, so every
   * task obeys the same one-request-per-second throttle regardless of interleaving. */
  throttleIfMistral: (model: string) => Promise<void>;
  exclusionPass?: ExclusionPassSettings;
}

export interface EvalTaskDefinition<TContext, TOutcome, TSummary = Record<string, unknown>> {
  task: EvalTask;
  /** A stable hash identifying this task's prompt template, recorded on every `eval_runs` row this
   * invocation creates. */
  promptHash(): string;
  /** Splits `items` into the calls this task actually makes: one call per topic-list per variant
   * for mapping (ignores `blockSize`/`groupSize`), one call per `groupSize` questions per block for
   * audit, one call per item per block for grading and transcription. */
  planCalls(items: EvalItemRow[], variants: Variant[], options: { blockSize: number; groupSize: number }): InterleavedCall<EvalItemRow, Variant>[];
  /** One-time setup shared by every call this task makes in a run (fetch units for audit, read
   * markdown for mapping, render slide images for transcription; grading needs none). */
  prepareContext(deps: TaskPrepareDeps): Promise<TContext>;
  /** Releases whatever `prepareContext` allocated (transcription's rendered-slide temp directory);
   * a no-op for a task that allocates nothing. */
  cleanupContext(context: TContext): void;
  /** Runs one planned call (a group for audit, the whole item set for mapping, one item for
   * grading/transcription) and returns the outcomes plus the `eval_results` rows it produced. */
  runCall(params: TaskRunCallParams<TContext>): Promise<{ outcomes: TOutcome[]; resultRows: NewEvalResultRow[] }>;
  buildSummary(outcomes: TOutcome[]): TSummary;
  /** Rebuilds the outcome this task summarises from a stored eval_results row and its eval_items row.
   * runCall derives its own outcome through this same function, so a run-time summary and a rescore
   * of the same rows are one code path. */
  outcomeFromStoredResult(result: EvalResultRow, item: EvalItemRow): TOutcome;
}
