/**
 * Records a plain observation as an `eval_findings` row: something worth writing down about the
 * evidence (a pattern across runs, a limitation of an eval set) that is not itself an
 * adopt/reject/defer decision on an experiment. `eval-compare --decide` is the only other CLI route
 * into this table and it always moves the cited experiment's `status`, which is wrong for an
 * observation that stands on its own. This command never touches `eval_experiments`.
 *
 * `--experiment` and `--task` are both optional: an observation can predate a numbered experiment,
 * or not relate to one at all. `--runs`/`--items` are the evidence this observation cites; each run
 * id must resolve through `store.getRun`, and each item id must belong to the set of at least one
 * of the cited runs. `--supersedes <finding_id>` names an earlier finding this one revises, since
 * `eval_findings` is append-only and a changed mind is a new row, never an edit.
 *
 * `decided_by` names who this finding is attributed to: the explicit `--decided-by` flag, else the
 * `EVAL_DECIDED_BY` environment variable. `--write-db` refuses without either, so a written row is
 * never silently attributed to a placeholder.
 *
 * Dry run by default, printing the row it would insert.
 */

import { loadEnv } from '../lib/env';
import { createScriptSupabase } from '../lib/db-queries';
import { createSupabaseEvalStore, type EvalStore, type EvalRunRow, type NewEvalFindingRow } from '../lib/eval/db';
import { resolveDecidedBy } from '../lib/eval/decided-by';
import { EVAL_TASKS } from '../lib/eval/types';
import { defineCli } from '../lib/options/define-cli';
import { dbTargetFlags, loggingFlags } from '../lib/options/groups';
import { createLogger, levelFromFlags, setLogLevel } from '../lib/logger';
import { runIfMain } from '../lib/run-if-main';

const logger = createLogger('eval-finding');

const FINDING_KINDS = ['observation'] as const;

export const cli = defineCli(
  {
    ...dbTargetFlags,
    ...loggingFlags,
    experiment: { type: 'string', help: 'eval_experiments id or slug this observation relates to' },
    task: { type: 'string', choices: EVAL_TASKS, help: 'Task this observation relates to' },
    kind: {
      type: 'string',
      choices: FINDING_KINDS,
      default: 'observation',
      help: "Finding kind. This command only records 'observation'; adopt/reject/defer are recorded through eval-compare --decide",
    },
    statement: { type: 'string', required: true, help: 'One-paragraph human-readable statement of the observation' },
    evidence: { type: 'string', help: 'Narrative detail the statement alone cannot carry' },
    runs: { type: 'string', help: 'Comma-separated eval_runs ids cited as evidence' },
    items: { type: 'string', help: 'Comma-separated eval_items ids cited as evidence, each belonging to one of the cited runs' },
    supersedes: { type: 'string', help: 'eval_findings id this observation supersedes' },
    'decided-by': { type: 'string', help: 'Who this finding is attributed to; falls back to EVAL_DECIDED_BY, required with --write-db' },
  },
  {
    name: 'eval-finding',
    description: 'Records a plain observation as an eval_findings row, citing runs and items as evidence. Never touches eval_experiments. Dry run by default; --write-db inserts the row.',
    examples: [
      'npx tsx apps/pipeline/src/commands/eval-finding.ts --statement "..." --runs run-a,run-b --items item-1,item-2',
      'npx tsx apps/pipeline/src/commands/eval-finding.ts --experiment grading-cross-vendor --task grading --statement "..." --write-db',
    ],
    validate: (o) => {
      if (o.statement.trim().length === 0) return 'Error: --statement must not be empty';
    },
  },
);

type Options = ReturnType<typeof cli.parse>;

function splitIds(value: string | undefined): string[] {
  return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * `store` is an injection point for tests (a fake `EvalStore`) so this command's validation and
 * write path are testable without a live Supabase connection. Production use (`runIfMain` below)
 * supplies neither, so both default to the real thing.
 */
export async function main(deps: { argv?: string[]; store?: EvalStore } = {}) {
  loadEnv();
  const options: Options = cli.parse(deps.argv);
  setLogLevel(levelFromFlags(options));

  const decidedBy = resolveDecidedBy(options.decidedBy, process.env);
  if (options.writeDb && !decidedBy) {
    logger.error('--write-db requires attribution: pass --decided-by <name> or set the EVAL_DECIDED_BY environment variable.');
    process.exit(1);
  }

  const supabase = deps.store ? undefined : createScriptSupabase({ write: true });
  const store = deps.store ?? createSupabaseEvalStore(supabase!);

  const runIds = splitIds(options.runs);
  const itemIds = splitIds(options.items);

  const fetchedRuns = await Promise.all(runIds.map((id) => store.getRun(id)));
  const missingRuns = runIds.filter((id, i) => !fetchedRuns[i]);
  if (missingRuns.length > 0) {
    logger.error(`No eval_runs row found for: ${missingRuns.join(', ')}`);
    process.exit(1);
  }
  const runs = fetchedRuns as EvalRunRow[];

  if (itemIds.length > 0) {
    if (runs.length === 0) {
      logger.error('--items requires --runs: each item id must belong to the set of one of the cited runs.');
      process.exit(1);
    }
    const setIds = [...new Set(runs.map((r) => r.set_id))];
    const itemsBySet = await Promise.all(setIds.map((id) => store.listItems(id)));
    const validItemIds = new Set(itemsBySet.flat().map((i) => i.id));
    const missingItems = itemIds.filter((id) => !validItemIds.has(id));
    if (missingItems.length > 0) {
      logger.error(`No eval_items row in the cited runs' sets for: ${missingItems.join(', ')}`);
      process.exit(1);
    }
  }

  if (options.supersedes) {
    const superseded = await store.getFinding(options.supersedes);
    if (!superseded) {
      logger.error(`No eval_findings row found for id '${options.supersedes}'.`);
      process.exit(1);
    }
  }

  let experimentId: string | null = null;
  if (options.experiment) {
    const experiment = await store.getExperiment(options.experiment);
    if (!experiment) {
      logger.error(`No eval_experiments row found for id or slug '${options.experiment}'.`);
      process.exit(1);
    }
    experimentId = experiment.id;
  }

  const row: NewEvalFindingRow = {
    kind: options.kind,
    statement: options.statement,
    experiment_id: experimentId,
    task: options.task ?? null,
    evidence_note: options.evidence ?? null,
    run_ids: runIds,
    item_ids: itemIds,
    decided_by: decidedBy ?? null,
    supersedes_finding_id: options.supersedes,
  };

  console.log('Would insert into eval_findings:');
  console.log(JSON.stringify(row, null, 2));
  console.log(`decided_by: ${decidedBy ?? 'unset'}`);

  if (options.writeDb) {
    const finding = await store.insertFinding(row);
    console.log(`Inserted eval_findings row ${finding.id}.`);
  } else {
    console.log('\nDry run. Pass --write-db to persist this finding.');
  }
}

runIfMain(import.meta.url, main);
