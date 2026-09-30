/**
 * Recomputes each completed run's per-item scores and `eval_runs.summary` from what's already
 * stored — no model call, no new `eval_results` rows. Exists for two situations a run-time summary
 * can't fix itself: a run whose task scores against a reviewed reference finished before that
 * reference existed (score and summary values that stayed null forever, `metric_status`'s "scored
 * before references existed"), and a summary shape that changed after the run (a new summary field
 * computed from data every stored row already carries, like grading's `byDesignLabel`). Both are
 * read-only until `--write-db`: `outcomeFromStoredResult` (`lib/eval/tasks/*.ts`) rebuilds each
 * task's outcome from its stored `eval_results` row and `eval_items` row, the same function
 * `eval-run`'s own `runCall` uses at call time, so a rescore and a fresh run compute a summary
 * through one code path rather than two that can drift apart.
 *
 * Per-item `score` is only ever touched for transcription and mapping, the two tasks whose score is
 * computed against a reference; grading's score is the model's own self-score and audit has none.
 * `status` and `finished_at` are never touched — a rescore is not a re-run.
 */

import { loadEnv } from '../lib/env';
import { createScriptSupabase } from '../lib/db-queries';
import { createSupabaseEvalStore, type EvalStore, type EvalRunRow } from '../lib/eval/db';
import { TASK_DEFINITIONS } from '../lib/eval/tasks/registry';
import { stampSummary } from '../lib/eval/summary-stamp';
import type { PrimaryMetric } from '../lib/eval/primary-metric';
import type { EvalTask } from '../lib/eval/types';
import { defineCli } from '../lib/options/define-cli';
import { dbTargetFlags, loggingFlags } from '../lib/options/groups';
import { createLogger, levelFromFlags, setLogLevel } from '../lib/logger';
import { runIfMain } from '../lib/run-if-main';

const logger = createLogger('eval-rescore');

const SUPPORTED_TASKS = ['audit', 'grading', 'mapping', 'transcription'] as const;
type SupportedTask = (typeof SUPPORTED_TASKS)[number];

function isSupportedTask(task: EvalTask): task is SupportedTask {
  return (SUPPORTED_TASKS as readonly string[]).includes(task);
}

/** Tasks whose per-item score is computed against a reference and so is worth recomputing here —
 * grading's score is the model's own self-score (never touched) and audit has no per-item score
 * at all. */
const RESCORABLE_SCORE_TASKS = ['transcription', 'mapping'] as const;

export const cli = defineCli(
  {
    ...dbTargetFlags,
    ...loggingFlags,
    run: { type: 'string', help: 'eval_runs id to rescore' },
    set: { type: 'string', help: 'eval_sets id, rescoring every completed run against this set' },
    experiment: { type: 'string', help: 'eval_experiments id or slug, rescoring every completed run attributed to it' },
  },
  {
    name: 'eval-rescore',
    description: 'Recomputes scores and summaries for completed runs from stored outputs against the current references. No model calls.',
    examples: [
      'npx tsx apps/pipeline/src/commands/eval-rescore.ts --run <run_id> --write-db',
      'npx tsx apps/pipeline/src/commands/eval-rescore.ts --set <set_id>',
      'npx tsx apps/pipeline/src/commands/eval-rescore.ts --experiment <slug> --write-db',
    ],
    validate: (o) => {
      const given = [o.run, o.set, o.experiment].filter(Boolean).length;
      if (given !== 1) return 'Error: exactly one of --run, --set, or --experiment is required';
    },
  },
);

type Options = ReturnType<typeof cli.parse>;

async function resolveTargetRuns(store: EvalStore, options: Options): Promise<EvalRunRow[]> {
  if (options.run) {
    const run = await store.getRun(options.run);
    if (!run) {
      logger.error(`No eval_runs row found for id ${options.run}.`);
      process.exit(1);
    }
    return [run];
  }
  if (options.set) {
    const set = await store.getSet(options.set);
    if (!set) {
      logger.error(`No eval_sets row found for id ${options.set}.`);
      process.exit(1);
    }
    return store.listRunsBySet(options.set);
  }
  const experiment = await store.getExperiment(options.experiment!);
  if (!experiment) {
    logger.error(`No eval_experiments row found for id or slug '${options.experiment}'.`);
    process.exit(1);
  }
  return store.listRunsByExperiment(experiment.id);
}

function formatMetric(value: number | undefined): string {
  return value === undefined ? 'none' : value.toFixed(4);
}

/** True unless `a`/`b` differ by more than float noise — the same recompute over the same stored
 * inputs should reproduce a stored score exactly, so this exists only to avoid flagging a
 * non-change over an epsilon of floating-point drift, not to tolerate a real one. */
function scoresEqual(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < 1e-9;
}

/**
 * `store` is an injection point for tests (a fake `EvalStore`) so this command's resolution,
 * skip/refuse rules, and write path are testable without a live Supabase connection. Production use
 * (`runIfMain` below) supplies neither, so both default to the real thing.
 */
export async function main(deps: { argv?: string[]; store?: EvalStore } = {}) {
  loadEnv();
  const options: Options = cli.parse(deps.argv);
  setLogLevel(levelFromFlags(options));

  const supabase = deps.store ? undefined : createScriptSupabase({ write: true });
  const store = deps.store ?? createSupabaseEvalStore(supabase!);

  const runs = await resolveTargetRuns(store, options);
  if (runs.length === 0) {
    logger.warn('No eval_runs rows matched.');
    return;
  }

  // Cached per set_id: --set targets one set for every run, and --experiment's runs often share
  // one too, so this avoids re-fetching the same round on every run.
  const reviewRoundBySetId = new Map<string, Awaited<ReturnType<EvalStore['latestReviewRound']>>>();
  async function reviewRoundFor(setId: string) {
    if (!reviewRoundBySetId.has(setId)) reviewRoundBySetId.set(setId, await store.latestReviewRound(setId));
    return reviewRoundBySetId.get(setId)!;
  }

  for (const run of runs) {
    if (run.status !== 'completed') {
      console.log(`Run ${run.id}: skipped (status is '${run.status}', not 'completed').`);
      continue;
    }
    if (!isSupportedTask(run.task)) {
      console.log(`Run ${run.id}: skipped (no eval-rescore support for task '${run.task}').`);
      continue;
    }

    const items = await store.listItems(run.set_id);
    if (items.length === 0) {
      console.log(`Run ${run.id}: refused, set ${run.set_id} has no items.`);
      continue;
    }
    const results = await store.listResults(run.id);
    if (results.length === 0) {
      console.log(`Run ${run.id}: refused, no eval_results rows for this run.`);
      continue;
    }

    const taskDef = TASK_DEFINITIONS[run.task as SupportedTask];
    const itemById = new Map(items.map((item) => [item.id, item]));
    const orphaned = results.filter((result) => !itemById.has(result.item_id));
    if (orphaned.length > 0) {
      console.log(`Run ${run.id}: refused, ${orphaned.length} result(s) reference items not in set ${run.set_id}.`);
      continue;
    }
    const outcomes = results.map((result) => taskDef.outcomeFromStoredResult(result, itemById.get(result.item_id)!));
    const builtSummary = taskDef.buildSummary(outcomes);

    const reviewRound = await reviewRoundFor(run.set_id);
    const stampedSummary = stampSummary(run.task, builtSummary, {
      scoredAt: new Date().toISOString(),
      scoringReviewRoundId: reviewRound?.id ?? null,
    });

    const scoreUpdates: Array<{ resultId: string; score: number | null }> = [];
    if ((RESCORABLE_SCORE_TASKS as readonly string[]).includes(run.task)) {
      results.forEach((result, i) => {
        // Both tasks' outcome carries its recomputed score under a different field name
        // (transcription: score; mapping: scoring.f1) — read narrowly rather than importing
        // either task's outcome type just for this one field.
        const outcome = outcomes[i] as { score?: number; scoring?: { f1: number } };
        const newScore = run.task === 'transcription' ? (outcome.score ?? null) : (outcome.scoring?.f1 ?? null);
        if (!scoresEqual(newScore, result.score)) {
          scoreUpdates.push({ resultId: result.id, score: newScore });
        }
      });
    }

    const oldMetric = (run.summary?.primary_metric as PrimaryMetric | undefined)?.value;
    const newMetric = (stampedSummary.primary_metric as PrimaryMetric | undefined)?.value;
    const label = run.variant_label ?? run.model;
    console.log(
      `Run ${run.id} (${run.task}, ${label}): primary_metric ${formatMetric(oldMetric)} -> ${formatMetric(newMetric)}, `
      + `${scoreUpdates.length} item score(s) would change.`,
    );

    if (options.writeDb) {
      for (const update of scoreUpdates) {
        await store.updateResult(update.resultId, { score: update.score });
      }
      await store.updateRun(run.id, { summary: stampedSummary });
    }
  }

  if (!options.writeDb) {
    console.log('\nDry run. Pass --write-db to persist rescored item scores and summaries.');
  }
}

runIfMain(import.meta.url, main);
