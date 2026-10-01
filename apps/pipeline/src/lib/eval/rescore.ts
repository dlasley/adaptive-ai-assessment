/**
 * The pure logic behind `eval-rescore`: resolving which runs `--run`/`--set`/`--experiment` target,
 * and comparing a recomputed score against the one already stored. No Supabase or LLM calls here —
 * `eval-rescore.ts` owns the per-run recompute loop and the write path.
 */

import { createLogger } from '../logger';
import type { EvalStore, EvalRunRow } from './db';

const logger = createLogger('eval-rescore');

export interface RescoreTargetOptions {
  run?: string;
  set?: string;
  experiment?: string;
}

/** Exactly one of `run`/`set`/`experiment` is expected to be set — enforced by the command's own
 * CLI validation before this runs. */
export async function resolveTargetRuns(store: EvalStore, options: RescoreTargetOptions): Promise<EvalRunRow[]> {
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

/** True unless `a`/`b` differ by more than float noise — the same recompute over the same stored
 * inputs should reproduce a stored score exactly, so this exists only to avoid flagging a
 * non-change over an epsilon of floating-point drift, not to tolerate a real one. */
export function scoresEqual(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < 1e-9;
}
