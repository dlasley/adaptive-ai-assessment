/**
 * Runs one or more model variants against a frozen eval set (audit, grading, mapping, or
 * transcription task), through the exact production prompt builder and parser, and writes
 * per-item results plus a summary to `eval_runs`/`eval_results`. Dry run by default — projects cost
 * and prints the plan; --write-db actually calls the models and persists results.
 *
 * Audit and grading variants are interleaved in blocks of 25 items (baseline block, candidate
 * block, baseline block, ...), so time-of-day and
 * provider-routing effects land on every variant equally. Audit items within a block are further
 * grouped by `--group-size` (default 1, matching production's AUDIT_GROUP_SIZE: each question
 * audited alone); a larger value groups multiple questions into one call, to measure whether
 * questions sharing a call change each other's verdicts. Grading and transcription items are always
 * one per call, interleaved the same way. --shuffle-groups permutes item order with a seeded RNG
 * before grouping, so a repeat run can be deterministically regrouped to measure the audit's
 * group-context sensitivity rather than only its run-to-run noise. Mapping sends every item (topic)
 * in the set in a single call per variant per repeat, since that's how the production prompt works
 * (one call, the whole topic list and unit markdown). Transcription renders each slide's image once
 * per invocation (shared across every variant and repeat, since the image doesn't depend on the
 * model) and reads the production slide cache to skip a call whose exact (image, text layer, prompt,
 * model) key was already transcribed — but never writes to it, so a baseline run never mutates
 * production's own cache. A Mistral-family model is throttled to one request per second regardless
 * of interleaving.
 */

import { loadEnv } from '../lib/env';
import { createScriptSupabase } from '../lib/db-queries';
import { fetchUnitsFromDb } from '../lib/units-db';
import { createSupabaseEvalStore, type EvalStore, type EvalRunRow, type EvalExperimentRow, type EvalModelCurrentRow, type NewEvalResultRow } from '../lib/eval/db';
import { vendorForModelSlug } from '../lib/eval/model-vendor';
import { stampSummary } from '../lib/eval/summary-stamp';
import { AUDIT_GROUP_SIZE } from '../lib/pipeline-config';
import { runVariantsLoop } from '../lib/eval/run-loop';
import { mulberry32, shuffle } from '../lib/eval/sampling';
import { BUDGET_CAPS_USD, isWithinBudget, projectVariantCostUsd } from '../lib/eval/tolerances';
import { TASK_DEFINITIONS } from '../lib/eval/tasks/registry';
import { variantKey, type Variant, type EffectiveCallSettings } from '../lib/eval/tasks/types';
import { callLlm, type LlmCallOptions } from '@adaptive/shared/llm';
import { GRADING_CALL_SETTINGS } from '@adaptive/shared/grading-prompt';
import { defineCli } from '../lib/options/define-cli';
import { dbTargetFlags, loggingFlags } from '../lib/options/groups';
import { createLogger, levelFromFlags, setLogLevel } from '../lib/logger';
import { runIfMain } from '../lib/run-if-main';
import { installSigintFlag } from '../lib/sigint';

const logger = createLogger('eval-run');

const BLOCK_SIZE = 25;
const MISTRAL_MIN_INTERVAL_MS = 1000;

const REASONING_CHOICES = ['off', 'none', 'minimal', 'low', 'medium', 'high'] as const;

export const cli = defineCli(
  {
    ...dbTargetFlags,
    ...loggingFlags,
    set: { type: 'string', required: true, help: 'eval_sets id to run against' },
    task: { type: 'string', choices: ['audit', 'grading', 'mapping', 'transcription'] as const, required: true, help: 'Must match the set\'s own task' },
    models: { type: 'string', required: true, help: 'Comma-separated OpenRouter model slugs — one variant each' },
    provider: { type: 'string', help: 'Provider tag to pin every variant to (single upstream, fallbacks disabled)' },
    reasoning: { type: 'string', choices: REASONING_CHOICES, help: "'off' disables reasoning; otherwise an effort tier, for every variant" },
    temperature: { type: 'number', help: "Overrides the task's production temperature for every variant" },
    repeat: { type: 'number', default: 1, min: 1, help: 'Repeats of each model, each its own eval_runs row (repeat_index)' },
    experiment: { type: 'string', help: 'eval_experiments id or slug to attribute these runs to — resolved and stamped as experiment_id on each eval_runs row' },
    label: { type: 'string', help: 'Variant label recorded on each run (suffixed with the model slug when more than one variant runs)' },
    'max-cost': { type: 'number', min: 0, help: `Refuses to start any single variant whose projected cost exceeds this (default: $${BUDGET_CAPS_USD.candidateRun})` },
    'allow-unpriced': { type: 'boolean', default: false, help: 'Run a variant even when its model has no listed price, so its cost cannot be projected or capped' },
    'group-size': { type: 'number', default: AUDIT_GROUP_SIZE, min: 1, help: `Audit task: questions sharing one audit call (default ${AUDIT_GROUP_SIZE}, matching production; a larger value groups multiple questions into one call)` },
    'shuffle-groups': { type: 'number', help: 'Audit task: seed permuting item order before grouping, so a repeat can be deterministically regrouped' },
  },
  {
    name: 'eval-run',
    description: 'Runs one or more model variants against a frozen eval set through the production prompt builder and parser.',
    examples: [
      'npx tsx apps/pipeline/src/commands/eval-run.ts --set <id> --task audit --models mistralai/mistral-large-2512,google/gemini-2.5-flash --label baseline-vs-gemini --write-db',
      'npx tsx apps/pipeline/src/commands/eval-run.ts --set <id> --task grading --models anthropic/claude-opus-5.5,anthropic/claude-sonnet-5 --repeat 2 --label sonnet-vs-opus --write-db',
      'npx tsx apps/pipeline/src/commands/eval-run.ts --set <id> --task mapping --models anthropic/claude-sonnet-5,anthropic/claude-haiku-4.5 --repeat 3 --label baseline-vs-haiku --write-db',
    ],
  },
);

type Options = ReturnType<typeof cli.parse>;

export type { Variant, EffectiveCallSettings } from '../lib/eval/tasks/types';
export { variantKey };

export function buildVariants(models: string[], repeat: number): Variant[] {
  const variants: Variant[] = [];
  for (let repeatIndex = 1; repeatIndex <= repeat; repeatIndex++) {
    for (const model of models) variants.push({ model, repeatIndex });
  }
  return variants;
}

export function buildVariantLabel(label: string | undefined, variant: Variant, variants: Variant[]): string | null {
  if (!label) return null;
  const needsSuffix = variants.length > 1;
  if (!needsSuffix) return label;
  return variant.repeatIndex > 1 ? `${label}:${variant.model}:r${variant.repeatIndex}` : `${label}:${variant.model}`;
}

export function parseReasoningFlag(raw: string | undefined): LlmCallOptions['reasoning'] | undefined {
  if (!raw) return undefined;
  if (raw === 'off') return { enabled: false };
  return { effort: raw as 'none' | 'minimal' | 'low' | 'medium' | 'high' };
}

/** `questions-audit.ts`'s sync Mistral call (`auditMistralBatch`) always runs at temperature 0.1,
 * pinned to Mistral's own infrastructure. An audit variant with no override needs to reproduce
 * exactly that, not an unpinned, room-temperature approximation of it — a baseline run exists
 * specifically to be the reference every later comparison is read against. */
const AUDIT_PRODUCTION_TEMPERATURE = 0.1;
const AUDIT_PRODUCTION_PROVIDER: NonNullable<LlmCallOptions['provider']> = { order: ['Mistral'], allowFallbacks: false };

/**
 * The call settings a variant actually uses: the task's production default unless the user
 * overrides it with `--temperature`/`--provider`. Grading's production default is
 * `GRADING_CALL_SETTINGS`; audit's matches `questions-audit.ts`'s own sync call; mapping's and
 * transcription's both match their own production call (no temperature override, no JSON mode, no
 * provider pin — transcription's `convertPdfToMarkdown` sends none of those either).
 */
export function buildEffectiveCallSettings(
  task: 'audit' | 'grading' | 'mapping' | 'transcription',
  options: { temperature?: number; provider?: string },
): EffectiveCallSettings {
  const overrideProvider = options.provider ? { order: [options.provider], allowFallbacks: false } : undefined;
  if (task === 'audit') {
    return {
      temperature: options.temperature ?? AUDIT_PRODUCTION_TEMPERATURE,
      jsonMode: true,
      provider: overrideProvider ?? AUDIT_PRODUCTION_PROVIDER,
    };
  }
  if (task === 'mapping' || task === 'transcription') {
    return {
      temperature: options.temperature,
      jsonMode: false,
      provider: overrideProvider,
    };
  }
  return {
    temperature: options.temperature ?? GRADING_CALL_SETTINGS.temperature,
    jsonMode: GRADING_CALL_SETTINGS.jsonMode,
    provider: overrideProvider,
  };
}

/** Permutes `items` deterministically when `shuffleSeed` is given (`--shuffle-groups`); returns
 * them in their original order otherwise, matching every previous eval-run behavior. Exported so
 * --shuffle-groups's determinism is unit-testable without a live Supabase connection. */
export function orderItemsForRun<T>(items: T[], shuffleSeed: number | undefined): T[] {
  return shuffleSeed !== undefined ? shuffle(items, mulberry32(shuffleSeed)) : items;
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * `store`, `callLlmFn`, and `fetchUnitsFromDbFn` are injection points for tests (a fake `EvalStore`,
 * a stubbed `callLlm`, a stubbed units fetch for the audit task) so the wiring below — registry
 * resolution, id stamping, provider capture — is testable without a live Supabase connection or a
 * real model call. Production use (`runIfMain` below) supplies none of them, so all three default
 * to the real thing.
 */
export async function main(deps: { argv?: string[]; store?: EvalStore; callLlmFn?: typeof callLlm; fetchUnitsFromDbFn?: typeof fetchUnitsFromDb } = {}) {
  loadEnv();
  const options: Options = cli.parse(deps.argv);
  setLogLevel(levelFromFlags(options));

  const callLlmFn = deps.callLlmFn ?? callLlm;
  // eval_* tables are service-role only. Real Supabase access is skipped entirely when a store is
  // injected, so a test never needs live credentials or a network connection.
  const supabase = deps.store ? undefined : createScriptSupabase({ write: true });
  const store = deps.store ?? createSupabaseEvalStore(supabase!);

  const set = await store.getSet(options.set);
  if (!set) {
    logger.error(`No eval set found with id ${options.set}`);
    process.exit(1);
  }
  if (set.task !== options.task) {
    logger.error(`Eval set ${options.set} is task '${set.task}', not '${options.task}'`);
    process.exit(1);
  }

  const allItems = await store.listItems(options.set);
  // A rejected item has no usable input (the seeder found no valid variant for it), so calling a
  // model on it would spend money on a verdict about nothing.
  const items = allItems.filter((item) => item.reference_status !== 'rejected');
  if (allItems.length !== items.length) {
    console.log(`Skipping ${allItems.length - items.length} rejected item(s) of ${allItems.length}.`);
  }
  if (items.length === 0) {
    logger.warn('Eval set has no runnable items. Exiting.');
    return;
  }

  const models = options.models.split(',').map((s) => s.trim()).filter(Boolean);

  // Resolved before anything else starts — an unregistered model or a missing experiment is a
  // reason to refuse the whole run, the same style as the budget-cap refusal below, not something
  // to skip past per variant.
  let experiment: EvalExperimentRow | null = null;
  if (options.experiment) {
    experiment = await store.getExperiment(options.experiment);
    if (!experiment) {
      logger.error(`No eval_experiments row found for id or slug '${options.experiment}'.`);
      process.exit(1);
    }
  }

  const modelBySlug = new Map<string, EvalModelCurrentRow>();
  const missingModels: string[] = [];
  for (const slug of models) {
    const resolved = await store.getModelBySlug(slug);
    if (resolved) modelBySlug.set(slug, resolved);
    else missingModels.push(slug);
  }
  if (missingModels.length > 0) {
    logger.error(`No eval_models row found in eval_models_current for: ${missingModels.join(', ')}.`);
    logger.error('Insert a row into eval_models (family_id, slug, effective_date, source, ...) for each before running — eval-run resolves --models against eval_models_current.');
    logger.error('A family names a lineage, not a release: vendor + product line + size tier, never a version number (e.g. "Claude Sonnet", "GPT mini" — not "GPT-4.1", "Mistral Medium 3.5"). Prefer an existing family for the model\'s vendor over registering a new one.');
    const resolvedVendors = new Set<string>();
    let hasUnresolvedVendor = false;
    for (const slug of missingModels) {
      const vendor = vendorForModelSlug(slug);
      if (vendor) resolvedVendors.add(vendor);
      else hasUnresolvedVendor = true;
    }
    for (const vendor of resolvedVendors) {
      const families = await store.listFamiliesByVendor(vendor);
      logger.error(
        families.length > 0
          ? `Existing ${vendor} families: ${families.map((f) => f.family).join(', ')}.`
          : `No eval_model_families rows exist yet for vendor '${vendor}'.`,
      );
    }
    if (hasUnresolvedVendor) {
      const allFamilies = await store.listAllFamilies();
      logger.error(
        allFamilies.length > 0
          ? `Could not determine a vendor for one or more slugs. All existing families: ${allFamilies.map((f) => `${f.vendor}/${f.family}`).join(', ')}.`
          : 'Could not determine a vendor for one or more slugs, and no eval_model_families rows exist yet.',
      );
    }
    process.exit(1);
  }

  const variants = buildVariants(models, options.repeat);
  const reasoning = parseReasoningFlag(options.reasoning);
  const callSettings = buildEffectiveCallSettings(options.task, { temperature: options.temperature, provider: options.provider });
  const maxCost = options.maxCost ?? BUDGET_CAPS_USD.candidateRun;
  const groupSize = options.groupSize;
  const shuffleSeed = options.shuffleGroups;
  if (options.task !== 'audit' && groupSize !== AUDIT_GROUP_SIZE) {
    logger.warn(`--group-size has no effect on the ${options.task} task (every item goes in one call regardless).`);
  }
  // Shuffled once for the whole invocation, before blocking/grouping, so every active variant sees
  // the same permuted order — between-variant comparisons stay valid, while a different seed
  // across separate eval-run invocations regroups the same items differently.
  const orderedItems = orderItemsForRun(items, shuffleSeed);

  // Mapping's one call per variant needs the unit's whole markdown, recorded on the set at
  // creation (`eval-set-create --task mapping`) rather than derived from `items` — read once in
  // the task's own prepareContext below, once the run is confirmed to actually go ahead.
  if (options.task === 'mapping') {
    const markdownPath = (set.selection as { markdownPath?: string }).markdownPath;
    if (!markdownPath) {
      logger.error(`Eval set ${options.set} has no selection.markdownPath recorded — it wasn't created with --task mapping.`);
      process.exit(1);
    }
  }

  // Transcription needs the source PDF's path, recorded on the set at creation (`eval-set-create
  // --task transcription`) — the slide images themselves are rendered later, in the task's own
  // prepareContext, once the run is confirmed to actually go ahead.
  if (options.task === 'transcription') {
    const pdfPath = (set.selection as { pdfPath?: string }).pdfPath;
    if (!pdfPath) {
      logger.error(`Eval set ${options.set} has no selection.pdfPath recorded — it wasn't created with --task transcription.`);
      process.exit(1);
    }
  }

  console.log(`Set ${options.set}: ${items.length} items, ${variants.length} variant(s) (${models.length} model(s) × ${options.repeat} repeat(s)).`);

  const runByVariantKey = new Map<string, EvalRunRow>();
  const taskDef = TASK_DEFINITIONS[options.task];
  const promptHash = taskDef.promptHash();
  // Stamped onto every finalized run's summary: the reviewed-reference state (if any) this run's
  // scoring reflects, so a later rescore against a newer review round is distinguishable from this
  // one. Fetched before any run row exists so a failure here cannot strand a row at 'running'.
  const reviewRound = await store.latestReviewRound(options.set);

  for (const variant of variants) {
    const projected = projectVariantCostUsd(options.task, variant.model, items.length, groupSize);
    const withinBudget = isWithinBudget(projected, maxCost, options.allowUnpriced);
    const projectedLabel = projected !== undefined ? `$${projected.toFixed(4)}` : 'unknown (unpriced model)';
    let statusNote = '';
    if (projected === undefined) {
      statusNote = withinBudget
        ? ' — running unpriced (--allow-unpriced): no cost guarantee for this variant'
        : ' — refused: no listed price, so --max-cost cannot be enforced (pass --allow-unpriced to run it anyway)';
    } else if (!withinBudget) {
      statusNote = ` — exceeds --max-cost $${maxCost}, skipping`;
    }
    console.log(`  ${variantKey(variant)}: projected ${projectedLabel}${statusNote}`);
    if (!withinBudget) continue;

    if (!options.writeDb) continue;

    const settings: Record<string, unknown> = {
      temperature: callSettings.temperature,
      jsonMode: callSettings.jsonMode,
      reasoning: reasoning ?? null,
      provider: callSettings.provider ?? null,
      groupSize,
      shuffleSeed: shuffleSeed ?? null,
    };
    const run = await store.insertRun({
      set_id: options.set,
      task: options.task,
      model: variant.model,
      experiment_id: experiment?.id ?? null,
      model_version_id: modelBySlug.get(variant.model)?.id ?? null,
      variant_label: buildVariantLabel(options.label, variant, variants),
      provider_pin: callSettings.provider?.order?.[0] ?? null,
      prompt_hash: promptHash,
      settings,
      repeat_index: variant.repeatIndex,
      projected_cost_usd: projected ?? null,
      status: 'running',
    });
    runByVariantKey.set(variantKey(variant), run);
  }

  if (!options.writeDb) {
    console.log('\nDry run — pass --write-db to create eval_runs rows and call the models.');
    return;
  }

  const activeVariants = variants.filter((v) => runByVariantKey.has(variantKey(v)));
  if (activeVariants.length === 0) {
    logger.error('Every variant exceeded --max-cost. Nothing to run.');
    process.exit(1);
  }

  // Every run row created above starts 'running'; from here on, no exit path may leave one that
  // way — runVariantsLoop's per-call try/catch marks a single variant 'failed' without stopping
  // the others, the outer try/catch here is the backstop for anything that escapes that (a bug, a
  // Supabase outage between variants), and SIGINT finishes the in-flight call before marking every
  // non-errored variant 'aborted'.
  const sigint = installSigintFlag('finishing the in-flight call, then stopping...');
  const activeVariantKeys = activeVariants.map(variantKey);
  const finalizedVariantKeys = new Set<string>();
  let taskContext: unknown;

  try {
    const calls = taskDef.planCalls(orderedItems, activeVariants, { blockSize: BLOCK_SIZE, groupSize });
    taskContext = await taskDef.prepareContext({ set, items: orderedItems, supabase, fetchUnitsFromDbFn: deps.fetchUnitsFromDbFn ?? fetchUnitsFromDb });

    const outcomesByVariant = new Map<string, unknown[]>();
    const resultRowsByVariant = new Map<string, NewEvalResultRow[]>();
    for (const key of activeVariantKeys) {
      outcomesByVariant.set(key, []);
      resultRowsByVariant.set(key, []);
    }

    let lastMistralCallAt = 0;
    const throttleIfMistral = async (model: string): Promise<void> => {
      if (!model.startsWith('mistralai/')) return;
      const wait = MISTRAL_MIN_INTERVAL_MS - (Date.now() - lastMistralCallAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastMistralCallAt = Date.now();
    };

    let done = 0;
    const total = calls.reduce((sum, c) => sum + c.items.length, 0);

    const { interrupted } = await runVariantsLoop({
      calls,
      activeVariantKeys,
      variantKeyFn: variantKey,
      shouldStop: () => sigint.interrupted(),
      processCall: async (call) => {
        const key = variantKey(call.variant);
        const run = runByVariantKey.get(key)!;

        const { outcomes, resultRows } = await taskDef.runCall({
          call, context: taskContext, run, callSettings, reasoning, callLlmFn, throttleIfMistral,
        });
        outcomesByVariant.get(key)!.push(...outcomes);
        resultRowsByVariant.get(key)!.push(...resultRows);
        done += resultRows.length;
        process.stdout.write(`\r  Progress: ${done}/${total}`);
      },
      finalizeVariant: async (key, status, errorMessage) => {
        const run = runByVariantKey.get(key)!;
        const resultRows = resultRowsByVariant.get(key)!;

        try {
          await store.insertResults(resultRows);
        } catch (err) {
          const message = `Failed to write results: ${err instanceof Error ? err.message : String(err)}`;
          logger.error(`Variant ${key}: ${message}`);
          status = 'failed';
          errorMessage = errorMessage === undefined ? message : `${errorMessage}; ${message}`;
        }

        const builtSummary = taskDef.buildSummary(outcomesByVariant.get(key)!);
        const stampedSummary = stampSummary(options.task, builtSummary, {
          scoredAt: new Date().toISOString(),
          scoringReviewRoundId: reviewRound?.id ?? null,
        });
        const summary = errorMessage !== undefined ? { ...stampedSummary, error: errorMessage } : stampedSummary;

        try {
          await store.updateRun(run.id, { status, finished_at: new Date().toISOString(), summary });
          finalizedVariantKeys.add(key);
        } catch (err) {
          logger.error(`Failed to finalize run ${run.id} for variant ${key}: ${err instanceof Error ? err.message : String(err)}`);
        }
        console.log(`Variant ${key} (run ${run.id}) ${status}.`);
      },
    });
    console.log('');

    if (interrupted) {
      console.log('Stopped by SIGINT after finishing the in-flight call.');
      process.exit(1);
    }
  } catch (err) {
    // Everything runVariantsLoop's per-variant handling could reasonably catch already is; this is
    // the backstop for anything that isn't (prepareContext, planCalls, a bug in setup between
    // variants). Every run not already finalized above must not be left 'running'.
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`eval-run failed unexpectedly: ${message}`);
    for (const key of activeVariantKeys) {
      if (finalizedVariantKeys.has(key)) continue;
      const run = runByVariantKey.get(key)!;
      await store.updateRun(run.id, { status: 'failed', finished_at: new Date().toISOString(), summary: { error: message } }).catch(() => {});
    }
    process.exit(1);
  } finally {
    sigint.uninstall();
    if (taskContext !== undefined) taskDef.cleanupContext(taskContext);
  }
}

runIfMain(import.meta.url, main);
