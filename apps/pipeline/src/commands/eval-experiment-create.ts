/**
 * Validates, and with `--write-db` creates or updates, one `eval_experiments` row: the declared
 * question, task list, variants, decision rule, dependencies and status a front end or a person
 * needs checked before an experiment exists to run against. Dry run by default, printing the row it
 * would insert (or the patch it would apply), plus which `eval_models_current` row each declared
 * variant's `model_slug` resolved to.
 *
 * `--update <slug>` replaces `--question`/`--variants`/`--decision-rule`/`--depends-on`/`--notes` on
 * an existing experiment, after the same validation a create runs. `--slug` cannot be combined with
 * `--update` (the slug is the public identifier and is never edited); `--tasks` and `--status`
 * cannot be changed this way either: `status` moves only through `eval-compare --decide`, and an
 * experiment's task list is fixed at creation. An update that would drop a declared variant (by its
 * `label`) that already has matching `eval_runs` rows is refused: `eval_experiment_variants` is read
 * to check, using the same match rule that view applies.
 */

import { readFileSync } from 'fs';
import { loadEnv } from '../lib/env';
import { createScriptSupabase } from '../lib/db-queries';
import {
  createSupabaseEvalStore,
  type EvalStore,
  type EvalExperimentRow,
  type NewEvalExperimentRow,
  type EvalModelCurrentRow,
} from '../lib/eval/db';
import { EVAL_TASKS, type EvalTask } from '../lib/eval/types';
import { DECISION_RULE_KNOWN_KEYS } from '../lib/eval/tolerances';
import { REPEAT_IDENTITY_SETTINGS_KEYS, RENDER_DPI_MIN, RENDER_DPI_MAX, type RepeatIdentityKey } from './eval-run';
import { defineCli } from '../lib/options/define-cli';
import { dbTargetFlags, loggingFlags } from '../lib/options/groups';
import { createLogger, levelFromFlags, setLogLevel } from '../lib/logger';
import { runIfMain } from '../lib/run-if-main';

const logger = createLogger('eval-experiment-create');

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Tasks the vocabulary recognizes but no `eval-run` runner exists for yet (its own `--task` only
 * accepts audit, grading, mapping, transcription). Naming one here is allowed (an experiment can be
 * declared before its runner exists), but warned about, since no command can attribute a run to it. */
const TASKS_WITH_NO_RUNNER = new Set<EvalTask>(['generation', 'validation']);

/** The roles `eval_experiments.variants_declared` rows use, confirmed against the test database on
 * 2026-10-01: `baseline`, `candidate`, and `exclusion_pass` plus five more in live use (`step_down`,
 * `cross_vendor`, `specialist`, `prompt_variant`, `successor`). A short descriptive word naming what
 * kind of variant this is relative to the experiment's baseline, not a free-text field. */
const KNOWN_VARIANT_ROLES = new Set([
  'baseline',
  'candidate',
  'exclusion_pass',
  'step_down',
  'cross_vendor',
  'specialist',
  'prompt_variant',
  'successor',
]);

const UPDATABLE_FIELD_HELP = '--question, --variants, --decision-rule, --depends-on, --notes';

export const cli = defineCli(
  {
    ...dbTargetFlags,
    ...loggingFlags,
    slug: {
      type: 'string',
      help: 'Lowercase letters, digits and hyphens; the public identifier (required to create; refused together with --update, since the slug is never edited after creation)',
    },
    update: { type: 'string', help: 'Slug of an existing experiment to update, instead of creating a new one' },
    question: { type: 'string', help: 'The falsifiable question this experiment answers (required to create)' },
    tasks: {
      type: 'string',
      help: `Comma-separated task(s) this experiment covers, from: ${EVAL_TASKS.join(', ')} (required to create; fixed after creation)`,
    },
    variants: { type: 'string', help: 'Path to a JSON array of {label, model_slug, role, settings?} (required to create)' },
    'decision-rule': {
      type: 'string',
      help: `Path to a JSON object of decision-rule overrides (${DECISION_RULE_KNOWN_KEYS.join(', ')})`,
    },
    'depends-on': { type: 'string', help: 'Comma-separated experiment slugs this one depends on' },
    status: {
      type: 'string',
      choices: ['proposed', 'running'] as const,
      default: 'proposed',
      help: 'Initial status; decided/deferred/superseded are set by eval-compare --decide, never here. Fixed after creation.',
    },
    notes: { type: 'string', help: 'Free text notes' },
  },
  {
    name: 'eval-experiment-create',
    description: 'Validates and creates (or updates) an eval_experiments row. Dry run by default; --write-db inserts or updates.',
    examples: [
      'npx tsx apps/pipeline/src/commands/eval-experiment-create.ts --slug my-experiment --question "..." --tasks transcription --variants variants.json --write-db',
      `npx tsx apps/pipeline/src/commands/eval-experiment-create.ts --update my-experiment --notes "..." --write-db`,
    ],
    validate: (o) => {
      if (o.update) {
        if (o.slug) return 'Error: --slug cannot be combined with --update; the slug is the public identifier and is never edited. Name the experiment to update with --update <slug>.';
        if (o.tasks) return "Error: --tasks cannot be changed with --update; an experiment's task list is fixed at creation.";
        if (o.status !== 'proposed') return 'Error: --status cannot be changed with --update; decided/deferred/superseded are set by eval-compare --decide, and proposed/running are set only at creation.';
        return;
      }
      if (!o.slug) return 'Error: --slug is required to create an experiment.';
      if (!SLUG_PATTERN.test(o.slug)) return `Error: --slug '${o.slug}' must be lowercase letters, digits and hyphens only.`;
      if (!o.question) return 'Error: --question is required to create an experiment.';
      if (!o.tasks) return 'Error: --tasks is required to create an experiment.';
      if (!o.variants) return 'Error: --variants is required to create an experiment.';
    },
  },
);

type Options = ReturnType<typeof cli.parse>;

interface DeclaredVariant {
  label: string;
  model_slug: string;
  role: string;
  settings?: Record<string, unknown>;
}

function parseCommaList(raw: string | undefined): string[] {
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/** Reads and JSON-parses `path`, failing through the command's own logger+exit convention rather
 * than an uncaught exception's raw stack trace: a malformed `--variants`/`--decision-rule` file is
 * routine user-input error here, not a bug. */
function readJsonFile(path: string, flagName: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    logger.error(`Could not read ${flagName} file '${path}': ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    logger.error(`${flagName} file '${path}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/** Whether `value` is a `provider` settings value `eval-run` could plausibly have written or a
 * declared variant could plausibly name: a bare pin string, or an object carrying an `order` array
 * (`eval_experiment_variants`' own declared-settings handling treats both shapes). */
function isValidProviderValue(value: unknown): boolean {
  if (typeof value === 'string') return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Array.isArray((value as Record<string, unknown>).order);
}

/** Validates one declared variant's `settings` object: every key must be in the repeat-identity
 * vocabulary (`REPEAT_IDENTITY_SETTINGS_KEYS`, reused from `eval-run.ts` rather than re-listed here),
 * and each key's value must match the shape `eval-run` actually writes for it. */
function validateSettingsShape(settings: Record<string, unknown>, context: string): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(settings)) {
    if (!(REPEAT_IDENTITY_SETTINGS_KEYS as readonly string[]).includes(key)) {
      problems.push(`${context}: settings key '${key}' is not in the repeat-identity vocabulary (${REPEAT_IDENTITY_SETTINGS_KEYS.join(', ')})`);
      continue;
    }
    const value = settings[key];
    switch (key as RepeatIdentityKey) {
      case 'temperature':
        if (typeof value !== 'number') problems.push(`${context}: settings.temperature must be a number`);
        break;
      case 'reasoning':
        if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
          problems.push(`${context}: settings.reasoning must be an object or null`);
        }
        break;
      case 'provider':
        if (!isValidProviderValue(value)) {
          problems.push(`${context}: settings.provider must be a pin string or an {order: [...]} object`);
        }
        break;
      case 'groupSize':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
          problems.push(`${context}: settings.groupSize must be a positive whole number`);
        }
        break;
      case 'shuffleSeed':
        if (typeof value !== 'number') problems.push(`${context}: settings.shuffleSeed must be a number`);
        break;
      case 'exclusionPass':
        if (value !== null && typeof value !== 'string') {
          problems.push(`${context}: settings.exclusionPass must be a classifier model slug or null`);
        }
        break;
      case 'renderDpi':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < RENDER_DPI_MIN || value > RENDER_DPI_MAX) {
          problems.push(`${context}: settings.renderDpi must be a whole number between ${RENDER_DPI_MIN} and ${RENDER_DPI_MAX}`);
        }
        break;
    }
  }
  return problems;
}

/** Validates one entry of a `--variants` file: `label` (non-empty; uniqueness across the file is
 * checked by the caller), `model_slug` (non-empty; resolved against the registry by the caller),
 * `role` (the known vocabulary), and `settings` (optional; see `validateSettingsShape`). */
function validateVariantShape(variant: unknown, index: number): string[] {
  const context = `variant ${index}`;
  if (typeof variant !== 'object' || variant === null || Array.isArray(variant)) {
    return [`${context}: must be an object`];
  }
  const v = variant as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof v.label !== 'string' || v.label.trim().length === 0) {
    problems.push(`${context}: label must be a non-empty string`);
  }
  if (typeof v.model_slug !== 'string' || v.model_slug.trim().length === 0) {
    problems.push(`${context}: model_slug must be a non-empty string ('*' for any model)`);
  }
  if (typeof v.role !== 'string' || !KNOWN_VARIANT_ROLES.has(v.role)) {
    problems.push(`${context}: role must be one of ${[...KNOWN_VARIANT_ROLES].join(', ')} (got ${JSON.stringify(v.role)})`);
  }
  if (v.settings !== undefined) {
    if (typeof v.settings !== 'object' || v.settings === null || Array.isArray(v.settings)) {
      problems.push(`${context}: settings must be an object`);
    } else {
      problems.push(...validateSettingsShape(v.settings as Record<string, unknown>, context));
    }
  }
  return problems;
}

function parseVariantsFile(path: string): DeclaredVariant[] {
  const raw = readJsonFile(path, '--variants');
  if (!Array.isArray(raw)) {
    logger.error(`--variants file '${path}' must contain a JSON array.`);
    process.exit(1);
  }

  const shapeProblems = raw.flatMap((v, i) => validateVariantShape(v, i));
  if (shapeProblems.length > 0) {
    logger.error(`--variants file '${path}' failed validation:`);
    for (const problem of shapeProblems) logger.error(`  ${problem}`);
    process.exit(1);
  }

  const variants = raw as DeclaredVariant[];
  const seenAt = new Map<string, number>();
  const dupProblems: string[] = [];
  variants.forEach((v, i) => {
    const prior = seenAt.get(v.label);
    if (prior !== undefined) dupProblems.push(`variant ${i}: label '${v.label}' duplicates variant ${prior}`);
    else seenAt.set(v.label, i);
  });
  if (dupProblems.length > 0) {
    logger.error(`--variants file '${path}' has duplicate labels:`);
    for (const problem of dupProblems) logger.error(`  ${problem}`);
    process.exit(1);
  }

  return variants;
}

/** Resolves every declared variant's `model_slug` against `eval_models_current`, except `'*'`
 * (matches any model, so there is nothing to resolve). Fetched once per distinct slug. */
async function resolveVariantModels(
  store: EvalStore,
  variants: DeclaredVariant[],
): Promise<{ bySlug: Map<string, EvalModelCurrentRow>; missing: string[] }> {
  const bySlug = new Map<string, EvalModelCurrentRow>();
  const missing: string[] = [];
  const distinctSlugs = [...new Set(variants.map((v) => v.model_slug).filter((slug) => slug !== '*'))];
  for (const slug of distinctSlugs) {
    const row = await store.getModelBySlug(slug);
    if (row) bySlug.set(slug, row);
    else missing.push(slug);
  }
  return { bySlug, missing };
}

function printVariantResolution(variant: DeclaredVariant, bySlug: Map<string, EvalModelCurrentRow>): void {
  if (variant.model_slug === '*') {
    console.log(`  ${variant.label}: model_slug '*' (matches any model)`);
    return;
  }
  const row = bySlug.get(variant.model_slug);
  console.log(`  ${variant.label}: model_slug '${variant.model_slug}' -> eval_models_current row ${row?.id} (effective ${row?.effective_date})`);
}

function validateTasks(raw: string): EvalTask[] {
  const tasks = parseCommaList(raw) as EvalTask[];
  if (tasks.length === 0) {
    logger.error('--tasks must name at least one task.');
    process.exit(1);
  }
  const unknown = tasks.filter((t) => !(EVAL_TASKS as readonly string[]).includes(t));
  if (unknown.length > 0) {
    logger.error(`--tasks names task(s) outside the task vocabulary (${EVAL_TASKS.join(', ')}): ${unknown.join(', ')}`);
    process.exit(1);
  }
  const noRunner = tasks.filter((t) => TASKS_WITH_NO_RUNNER.has(t));
  if (noRunner.length > 0) {
    logger.warn(`${noRunner.join(', ')}: no eval-run runner exists for this task yet; the experiment can still be declared, but no command can attribute a run to it.`);
  }
  return tasks;
}

async function resolveDependsOn(store: EvalStore, raw: string | undefined): Promise<string[]> {
  const slugs = parseCommaList(raw);
  const missing: string[] = [];
  for (const slug of slugs) {
    const dependency = await store.getExperiment(slug);
    if (!dependency) missing.push(slug);
  }
  if (missing.length > 0) {
    logger.error(`--depends-on names experiment slug(s) that do not exist: ${missing.join(', ')}`);
    process.exit(1);
  }
  return slugs;
}

function validateDecisionRule(rule: unknown): string[] {
  if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
    return ['--decision-rule file must contain a JSON object'];
  }
  const problems: string[] = [];
  for (const [key, value] of Object.entries(rule as Record<string, unknown>)) {
    if (!(DECISION_RULE_KNOWN_KEYS as readonly string[]).includes(key)) {
      problems.push(`--decision-rule key '${key}' is not recognized (known: ${DECISION_RULE_KNOWN_KEYS.join(', ')})`);
      continue;
    }
    if (key === 'description') {
      if (typeof value !== 'string') problems.push('--decision-rule.description must be a string');
    } else if (typeof value !== 'number' || value < 0 || value > 1) {
      problems.push(`--decision-rule.${key} must be a number between 0 and 1`);
    }
  }
  return problems;
}

function parseDecisionRuleFile(path: string): Record<string, unknown> {
  const raw = readJsonFile(path, '--decision-rule');
  const problems = validateDecisionRule(raw);
  if (problems.length > 0) {
    logger.error(`--decision-rule file '${path}' failed validation:`);
    for (const problem of problems) logger.error(`  ${problem}`);
    process.exit(1);
  }
  return raw as Record<string, unknown>;
}

/** Refuses an update that would drop a declared variant (one present in `experiment`'s current
 * `variants_declared` by `label`, absent from `newVariants`) which already has matching `eval_runs`
 * rows, read through `eval_experiment_variants` (the same view, the same match rule) rather than
 * reimplemented here. Dropping a variant with no runs is fine: it never ran, so nothing is orphaned. */
async function refuseDroppingVariantsWithRuns(store: EvalStore, experiment: EvalExperimentRow, newVariants: DeclaredVariant[]): Promise<void> {
  const oldLabels = (experiment.variants_declared as Array<{ label?: unknown }>)
    .map((v) => v?.label)
    .filter((label): label is string => typeof label === 'string');
  const newLabels = new Set(newVariants.map((v) => v.label));
  const droppedLabels = oldLabels.filter((label) => !newLabels.has(label));
  if (droppedLabels.length === 0) return;

  const counts = await store.listDeclaredVariantRunCounts(experiment.id);
  const runCountByLabel = new Map(counts.map((c) => [c.declared_label, c.run_count]));
  const blocked = droppedLabels.filter((label) => (runCountByLabel.get(label) ?? 0) > 0);
  if (blocked.length > 0) {
    logger.error(
      `--update would drop declared variant(s) that already have matching eval_runs rows: ${blocked.join(', ')}. Keep the label (its settings may still change) or leave --variants unset.`,
    );
    process.exit(1);
  }
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

  const supabase = deps.store ? undefined : createScriptSupabase({ write: true });
  const store = deps.store ?? createSupabaseEvalStore(supabase!);

  const isUpdate = !!options.update;

  let existing: EvalExperimentRow | null = null;
  if (isUpdate) {
    existing = await store.getExperiment(options.update!);
    if (!existing) {
      logger.error(`No eval_experiments row found for slug '${options.update}'.`);
      process.exit(1);
    }
  } else {
    const already = await store.getExperiment(options.slug!);
    if (already) {
      logger.error(`eval_experiments already has a row with slug '${options.slug}'.`);
      process.exit(1);
    }
  }

  const tasks = isUpdate ? undefined : validateTasks(options.tasks!);

  let variants: DeclaredVariant[] | undefined;
  let modelBySlug: Map<string, EvalModelCurrentRow> | undefined;
  if (options.variants) {
    variants = parseVariantsFile(options.variants);
    const resolved = await resolveVariantModels(store, variants);
    if (resolved.missing.length > 0) {
      logger.error(`No eval_models_current row found for model_slug(s): ${resolved.missing.join(', ')}.`);
      process.exit(1);
    }
    modelBySlug = resolved.bySlug;
  }

  const decisionRule = options.decisionRule ? parseDecisionRuleFile(options.decisionRule) : undefined;
  const dependsOn = options.dependsOn !== undefined ? await resolveDependsOn(store, options.dependsOn) : undefined;

  if (isUpdate && variants) {
    await refuseDroppingVariantsWithRuns(store, existing!, variants);
  }

  if (isUpdate) {
    const patch: Partial<Pick<EvalExperimentRow, 'question' | 'variants_declared' | 'decision_rule' | 'depends_on' | 'notes'>> = {};
    if (options.question !== undefined) patch.question = options.question;
    if (variants !== undefined) patch.variants_declared = variants;
    if (decisionRule !== undefined) patch.decision_rule = decisionRule;
    if (dependsOn !== undefined) patch.depends_on = dependsOn;
    if (options.notes !== undefined) patch.notes = options.notes;

    if (Object.keys(patch).length === 0) {
      logger.error(`--update given with no field to change (one of ${UPDATABLE_FIELD_HELP}).`);
      process.exit(1);
    }

    console.log(`Would update eval_experiments '${existing!.slug}':`);
    console.log(JSON.stringify(patch, null, 2));
    if (variants && modelBySlug) {
      for (const variant of variants) printVariantResolution(variant, modelBySlug);
    }

    if (options.writeDb) {
      await store.updateExperiment(existing!.id, patch);
      console.log(`Updated eval_experiments ${existing!.id} ('${existing!.slug}').`);
    } else {
      console.log('\nDry run. Pass --write-db to persist this update.');
    }
    return;
  }

  const row: NewEvalExperimentRow = {
    slug: options.slug!,
    question: options.question!,
    tasks: tasks!,
    variants_declared: variants!,
    decision_rule: decisionRule ?? {},
    depends_on: dependsOn ?? [],
    status: options.status,
    notes: options.notes ?? null,
  };

  console.log('Would insert into eval_experiments:');
  console.log(JSON.stringify(row, null, 2));
  for (const variant of variants!) printVariantResolution(variant, modelBySlug!);

  if (options.writeDb) {
    const experiment = await store.insertExperiment(row);
    console.log(`Inserted eval_experiments row ${experiment.id} ('${experiment.slug}').`);
  } else {
    console.log('\nDry run. Pass --write-db to persist this experiment.');
  }
}

runIfMain(import.meta.url, main);
