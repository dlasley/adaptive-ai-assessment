/**
 * Records an `eval_findings` row, in one of two modes.
 *
 * Without `--decide`, a plain observation: something worth writing down about the evidence (a
 * pattern across runs, a limitation of an eval set) that is not itself a decision on an experiment.
 * Nothing about `eval_experiments` changes.
 *
 * With `--decide <adopt|reject|defer|supersede>`, the row is a decision on `--experiment` and that
 * experiment's `status` moves with it: adopt and reject to `decided`, defer to `deferred`,
 * supersede to `superseded`, each stamping `decided_at`. This command and `eval-compare --decide`
 * are the two writers of that column, and the row records which one through `decided_via`.
 * `eval-compare` decides from a paired comparison of two runs and gates `adopt` on a non-inferiority
 * verdict against a reference; a decision here rests on the cited evidence alone, so `adopt` carries
 * no such verdict, and `supersede` is available only here.
 *
 * `--decide` requires `--write-db`, `--experiment`, attribution, and at least one of
 * `--runs`/`--items`, each refused before any database read. `--kind` is ignored under `--decide`:
 * adopt, reject and defer are recorded as that kind, while supersede is recorded as an
 * `observation` whose `external_refs` carries `experiment:<successor slug>`, the successor named by
 * `--superseded-by <slug>` (required with `--decide supersede`, and refused without it). An
 * experiment already `decided` or `superseded` is refused unless `--supersedes <finding_id>` names
 * the decision finding that currently stands on it: `eval_findings` is append-only, so a changed
 * mind is a new row pointing at the old one, never an edit. An experiment whose status has no
 * standing decision finding under it, because every decision on it was superseded by a plain
 * observation, needs no `--supersedes`: the status is re-derived from the new decision and a warning
 * says so, since nothing else can move a status back.
 *
 * `--experiment` and `--task` are both optional without `--decide`: an observation can predate a
 * numbered experiment, or not relate to one at all. `--runs`/`--items` are the evidence the row
 * cites; each run id must resolve through `store.getRun`, and each item id must belong to the set of
 * at least one of the cited runs.
 *
 * `decided_by` names the operator who ran this command: the explicit `--decided-by` flag, else the
 * `EVAL_DECIDED_BY` environment variable. `--write-db` refuses without either, so a written row is
 * never silently attributed to a placeholder. It is not necessarily who made the underlying
 * observation or call; `--statement`/`--evidence` is where that origin is recorded.
 *
 * Dry run by default, printing the row it would insert.
 */

import { loadEnv } from '../lib/env';
import { createScriptSupabase } from '../lib/db-queries';
import { createSupabaseEvalStore, type EvalStore, type EvalRunRow, type EvalExperimentRow, type EvalFindingRow, type NewEvalFindingRow } from '../lib/eval/db';
import { resolveDecidedBy } from '../lib/eval/decided-by';
import { experimentStatusForDecision } from '../lib/eval/decision-status';
import { EVAL_TASKS } from '../lib/eval/types';
import { defineCli } from '../lib/options/define-cli';
import { dbTargetFlags, loggingFlags } from '../lib/options/groups';
import { createLogger, levelFromFlags, setLogLevel } from '../lib/logger';
import { runIfMain } from '../lib/run-if-main';

const logger = createLogger('eval-finding');

const FINDING_KINDS = ['observation'] as const;
const DECIDE_KINDS = ['adopt', 'reject', 'defer', 'supersede'] as const;

export const cli = defineCli(
  {
    ...dbTargetFlags,
    ...loggingFlags,
    experiment: { type: 'string', help: 'eval_experiments id or slug this finding relates to; required with --decide' },
    task: { type: 'string', choices: EVAL_TASKS, help: 'Task this finding relates to' },
    kind: {
      type: 'string',
      choices: FINDING_KINDS,
      default: 'observation',
      help: "Finding kind. Without --decide this command records only 'observation'; with --decide the kind comes from the decision and this flag is ignored",
    },
    decide: {
      type: 'string',
      choices: DECIDE_KINDS,
      help: "Records this finding as a decision on --experiment and moves that experiment's status: adopt/reject to decided, defer to deferred, supersede to superseded. Requires --write-db, --experiment, attribution, and at least one of --runs/--items; supersede also requires --superseded-by. adopt here is recorded on the cited evidence alone and is not gated on a non-inferiority verdict; use eval-compare --decide adopt for a decision a paired comparison backs",
    },
    'superseded-by': { type: 'string', help: 'The experiment that supersedes --experiment, by id or slug, recorded on the row as the external_refs entry experiment:<slug>. Required with --decide supersede, and refused without it' },
    statement: { type: 'string', required: true, help: 'One-paragraph human-readable statement of the observation or decision' },
    evidence: { type: 'string', help: 'Narrative detail the statement alone cannot carry' },
    runs: { type: 'string', help: 'Comma-separated eval_runs ids cited as evidence' },
    items: { type: 'string', help: 'Comma-separated eval_items ids cited as evidence, each belonging to one of the cited runs' },
    supersedes: { type: 'string', help: 'eval_findings id this finding supersedes. Required to decide an experiment that is already decided or superseded, naming the decision finding that currently stands' },
    'decided-by': { type: 'string', help: 'The operator running this command, recorded on the row; falls back to EVAL_DECIDED_BY, required with --write-db' },
  },
  {
    name: 'eval-finding',
    description: 'Records an eval_findings row: a plain observation citing runs and items as evidence, or, with --decide, a decision that also moves its experiment to decided, deferred or superseded. Dry run by default; --write-db inserts the row.',
    examples: [
      'npx tsx apps/pipeline/src/commands/eval-finding.ts --statement "..." --runs run-a,run-b --items item-1,item-2',
      'npx tsx apps/pipeline/src/commands/eval-finding.ts --experiment grading-cross-vendor --task grading --statement "..." --write-db',
      'npx tsx apps/pipeline/src/commands/eval-finding.ts --experiment grading-cross-vendor --decide reject --runs run-a --statement "..." --decided-by jsmith --write-db',
      'npx tsx apps/pipeline/src/commands/eval-finding.ts --experiment grading-cross-vendor --decide supersede --superseded-by grading-cross-vendor-v2 --runs run-a --statement "..." --decided-by jsmith --write-db',
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
 * The findings on an experiment that record a decision rather than a standalone observation: an
 * adopt/reject/defer row, or the observation a `--decide supersede` writes, told apart from a plain
 * observation by the `experiment:` successor reference it carries.
 */
function isDecisionFinding(finding: EvalFindingRow): boolean {
  return finding.kind !== 'observation' || finding.external_refs.some((ref) => ref.startsWith('experiment:'));
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
  const runIds = splitIds(options.runs);
  const itemIds = splitIds(options.items);

  // Flag-shape validation happens before any DB lookup, so a malformed --decide invocation never
  // even looks up the runs.
  if (options.supersededBy && options.decide !== 'supersede') {
    logger.error('--superseded-by names the experiment that replaces this one and is only meaningful with --decide supersede.');
    process.exit(1);
  }
  if (options.decide) {
    if (!options.writeDb) {
      logger.error('--decide requires --write-db: recording a decision is a database write, not a report-only dry run.');
      process.exit(1);
    }
    if (!options.experiment) {
      logger.error('--decide requires --experiment <id or slug>: a decision is recorded against one experiment.');
      process.exit(1);
    }
    if (!decidedBy) {
      logger.error('--decide requires attribution: pass --decided-by <name> or set the EVAL_DECIDED_BY environment variable.');
      process.exit(1);
    }
    if (runIds.length === 0 && itemIds.length === 0) {
      logger.error('--decide requires evidence: pass --runs and/or --items citing what the decision rests on.');
      process.exit(1);
    }
    if (options.decide === 'supersede' && !options.supersededBy) {
      logger.error('--decide supersede requires --superseded-by <slug> naming the experiment that replaces this one.');
      process.exit(1);
    }
  }
  if (options.writeDb && !decidedBy) {
    logger.error('--write-db requires attribution: pass --decided-by <name> or set the EVAL_DECIDED_BY environment variable.');
    process.exit(1);
  }

  const supabase = deps.store ? undefined : createScriptSupabase({ write: options.writeDb });
  const store = deps.store ?? createSupabaseEvalStore(supabase!);

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

  let experiment: EvalExperimentRow | null = null;
  if (options.experiment) {
    experiment = await store.getExperiment(options.experiment);
    if (!experiment) {
      logger.error(`No eval_experiments row found for id or slug '${options.experiment}'.`);
      process.exit(1);
    }
  }
  const experimentId = experiment?.id ?? null;

  let successorSlug: string | undefined;
  if (options.decide && experiment) {
    if (options.decide === 'supersede') {
      const successor = await store.getExperiment(options.supersededBy!);
      if (!successor) {
        logger.error(`No eval_experiments row found for --superseded-by '${options.supersededBy}'.`);
        process.exit(1);
      }
      if (successor.id === experiment.id) {
        logger.error(`--superseded-by '${options.supersededBy}' names the experiment being superseded; a successor must be a different experiment.`);
        process.exit(1);
      }
      successorSlug = successor.slug;
    }

    const existingFindings = await store.listFindings(experiment.id);
    const alreadySuperseding = options.supersedes ? existingFindings.find((f) => f.supersedes_finding_id === options.supersedes) : undefined;
    if (alreadySuperseding) {
      logger.error(`Finding ${options.supersedes} is already superseded by finding ${alreadySuperseding.id}. Pass --supersedes naming the finding that currently stands.`);
      process.exit(1);
    }
    if (experiment.status === 'decided' || experiment.status === 'superseded') {
      // A decision that a later finding supersedes does not stand, so it is not a candidate for
      // --supersedes.
      const supersededIds = new Set(existingFindings.map((f) => f.supersedes_finding_id).filter((id): id is string => id !== null));
      const standing = existingFindings.filter((f) => isDecisionFinding(f) && !supersededIds.has(f.id));
      if (standing.length === 0) {
        logger.warn(`Experiment ${experiment.id} reads ${experiment.status} with no decision finding standing under it; its status is being re-derived from this decision.`);
      } else if (!options.supersedes || !standing.some((f) => f.id === options.supersedes)) {
        logger.error(
          `Experiment ${experiment.id} is already ${experiment.status}. `
          + `Pass --supersedes <finding_id> naming the decision this one revises (${standing.map((f) => f.id).join(', ')}).`,
        );
        process.exit(1);
      }
    }
  }

  const row: NewEvalFindingRow = {
    kind: options.decide && options.decide !== 'supersede' ? options.decide : options.kind,
    statement: options.statement,
    experiment_id: experimentId,
    task: options.task ?? null,
    evidence_note: options.evidence ?? null,
    run_ids: runIds,
    item_ids: itemIds,
    external_refs: successorSlug ? [`experiment:${successorSlug}`] : [],
    decided_by: decidedBy ?? null,
    supersedes_finding_id: options.supersedes,
    decided_via: options.decide ? 'eval-finding' : null,
  };

  console.log('Would insert into eval_findings:');
  console.log(JSON.stringify(row, null, 2));
  console.log(`decided_by: ${decidedBy ?? 'unset'}`);

  if (options.writeDb) {
    const finding = await store.insertFinding(row);
    console.log(`Inserted eval_findings row ${finding.id}.`);
    if (options.decide && experimentId) {
      const newStatus = experimentStatusForDecision(options.decide);
      await store.updateExperiment(experimentId, { status: newStatus, decided_at: new Date().toISOString() });
      console.log(`Recorded ${options.decide} finding ${finding.id} for experiment ${experimentId} (status now ${newStatus}).`);
    }
  } else {
    console.log('\nDry run. Pass --write-db to persist this finding.');
  }
}

runIfMain(import.meta.url, main);
