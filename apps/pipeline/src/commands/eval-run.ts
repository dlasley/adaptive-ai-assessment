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
 * model) but sends every kept slide to the model on every call, never served from the production
 * slide cache: a cached transcript would record zero cost and disk latency and make repeats of a
 * baseline identical by construction, which is not the noise floor being measured. A Mistral-family
 * model is throttled to one request per second regardless of interleaving.
 *
 * Every run's `variant_label` is always `<label>:<model slug>`, whether this invocation runs one
 * variant or several; `--label` defaults to the experiment slug when `--experiment` is given, else
 * the task name, so a run is never left unlabeled. `repeat_index` is the invocation's own repeat
 * offset for an ad hoc run with no `--experiment`; with one, it continues the count already on
 * record for that experiment and model, judged by prompt hash, status (an `aborted` or `failed` run
 * never counts), and the caller-controlled settings (`temperature`, `reasoning`, `provider`,
 * `groupSize`, `shuffleSeed`, `exclusionPass`, `renderDpi`, `mode`, `grouping`). A key missing on a run's stored settings
 * compares against the value that was actually in force when it ran, not a wildcard: `temperature`
 * absent means no override was sent, `provider` absent means unpinned, `groupSize` absent means the
 * task's own default, `renderDpi` absent means the pre-flag default of 120, `mode` absent means
 * `'sync'` and `grouping` absent means `'by_order'` (this command writes neither: it has no flag for
 * either, so the absent-means rule is what every run it makes carries). A repeat launched by
 * hand in a later invocation gets the next number instead of restarting at 1. This count is resolved
 * once per distinct model before any run in the invocation is inserted, so several repeats of one
 * model in a single invocation get consecutive numbers rather than gaps.
 */

import { loadEnv } from '../lib/env';
import { createScriptSupabase } from '../lib/db-queries';
import { fetchUnitsFromDb } from '../lib/units-db';
import { createSupabaseEvalStore, type EvalStore, type EvalRunRow, type EvalExperimentRow, type EvalModelCurrentRow, type NewEvalResultRow } from '../lib/eval/db';
import { vendorForModelSlug } from '../lib/eval/model-vendor';
import { stampSummary } from '../lib/eval/summary-stamp';
import { AUDIT_GROUP_SIZE } from '../lib/pipeline-config';
import { DEFAULT_RENDER_DPI } from '../lib/pdf-conversion';
import { runVariantsLoop } from '../lib/eval/run-loop';
import { mulberry32, shuffle } from '../lib/eval/sampling';
import { BUDGET_CAPS_USD, isWithinBudget, projectCostUsd, projectVariantCostUsd, registryPriceOf, type ModelPrice } from '../lib/eval/tolerances';
import { TASK_DEFINITIONS } from '../lib/eval/tasks/registry';
import { resolveEffectiveSamplingSettings } from '../lib/eval/tasks/shared';
import { variantKey, type Variant, type EffectiveCallSettings, type ExclusionPassSettings, type ModelSamplingConstraints } from '../lib/eval/tasks/types';
import { CLASSIFY_PROMPT_HASH } from '../lib/slide-content-classifier';
import { callLlm, type LlmCallOptions } from '@adaptive/shared/llm';
import { GRADING_CALL_SETTINGS } from '@adaptive/shared/grading-prompt';
import { MODEL_CONSTRAINTS } from '@adaptive/shared/models';
import { defineCli } from '../lib/options/define-cli';
import { dbTargetFlags, loggingFlags } from '../lib/options/groups';
import { createLogger, levelFromFlags, setLogLevel } from '../lib/logger';
import { runIfMain } from '../lib/run-if-main';
import { installSigintFlag } from '../lib/sigint';
import { sleep } from '../lib/sleep';

const logger = createLogger('eval-run');

const BLOCK_SIZE = 25;
const MISTRAL_MIN_INTERVAL_MS = 1000;
/** Tasks whose own call site disables reasoning by default (`reasoning ?? { enabled: false }` in
 * `tasks/mapping.ts`/`tasks/transcription.ts`) when `--reasoning` wasn't given. Audit and grading
 * send whatever `--reasoning` resolved to, undefined included, with no default of their own. Used
 * only to compute the per-variant settings this invocation logs and records; each task module
 * applies the same default independently at call time. */
const TASKS_DISABLING_REASONING_BY_DEFAULT = new Set<string>(['mapping', 'transcription']);
export const RENDER_DPI_MIN = 72;
export const RENDER_DPI_MAX = 400;

const REASONING_CHOICES = ['off', 'none', 'minimal', 'low', 'medium', 'high'] as const;

/** Rough per-call token estimate for the `--exclusion-pass` classifier: the classify prompt, one
 * slide's text-layer hint, and the rendered slide image; completion is small — a JSON verdict plus
 * a one-sentence reason. Not yet checked against a real run's recorded usage. */
const EXCLUSION_PASS_PROMPT_TOKENS_PER_CALL = 2_500;
const EXCLUSION_PASS_COMPLETION_TOKENS_PER_CALL = 60;

/** Projects the `--exclusion-pass` classifier's own added cost for one variant's run: one
 * classifier call per item, at the classifier model's registry price. Returns undefined (same
 * convention as `projectCostUsd`) when that price isn't known. */
export function projectExclusionPassCostUsd(classifierPrice: ModelPrice | undefined, itemCount: number): number | undefined {
  return projectCostUsd(classifierPrice, itemCount, EXCLUSION_PASS_PROMPT_TOKENS_PER_CALL, EXCLUSION_PASS_COMPLETION_TOKENS_PER_CALL);
}

export const cli = defineCli(
  {
    ...dbTargetFlags,
    ...loggingFlags,
    set: { type: 'string', required: true, help: 'eval_sets id to run against' },
    task: { type: 'string', choices: ['audit', 'grading', 'mapping', 'transcription'] as const, required: true, help: 'Must match the set\'s own task' },
    models: { type: 'string', required: true, help: 'Comma-separated OpenRouter model slugs, one variant each' },
    provider: { type: 'string', help: 'Provider tag to pin every variant to (single upstream, fallbacks disabled)' },
    reasoning: { type: 'string', choices: REASONING_CHOICES, help: "'off' disables reasoning; otherwise an effort tier, for every variant" },
    temperature: { type: 'number', help: "Overrides the task's production temperature for every variant" },
    repeat: { type: 'number', default: 1, min: 1, help: 'Repeats of each model, each its own eval_runs row (repeat_index)' },
    experiment: { type: 'string', help: 'eval_experiments id or slug to attribute these runs to, resolved and stamped as experiment_id on each eval_runs row' },
    label: { type: 'string', help: 'Label recorded on each run as <label>:<model slug>; defaults to the experiment slug when --experiment is given, else the task name' },
    'max-cost': { type: 'number', min: 0, help: `Refuses to start any single variant whose projected cost exceeds this (default: $${BUDGET_CAPS_USD.candidateRun})` },
    'allow-unpriced': { type: 'boolean', default: false, help: 'Run a variant even when its model has no listed price, so its cost cannot be projected or capped' },
    'group-size': { type: 'number', default: AUDIT_GROUP_SIZE, min: 1, help: `Audit task: questions sharing one audit call (default ${AUDIT_GROUP_SIZE}, matching production; a larger value groups multiple questions into one call)` },
    'shuffle-groups': { type: 'number', help: 'Audit task: seed permuting item order before grouping, so a repeat can be deterministically regrouped' },
    'exclusion-pass': { type: 'string', help: 'Transcription task only: model slug for a separate teaching-content classifier that gates each slide before the transcription call, skipping it when the slide is judged not to teach the course language (off by default)' },
    'exclusion-provider': { type: 'string', help: 'Provider tag to pin the --exclusion-pass classifier call to, when it must differ from --provider' },
    'render-dpi': { type: 'number', default: DEFAULT_RENDER_DPI, min: RENDER_DPI_MIN, help: `Transcription task only: resolution the slide images are rendered at before being sent to the model (${RENDER_DPI_MIN} to ${RENDER_DPI_MAX}, default ${DEFAULT_RENDER_DPI})` },
  },
  {
    name: 'eval-run',
    description: 'Runs one or more model variants against a frozen eval set through the production prompt builder and parser.',
    examples: [
      'npx tsx apps/pipeline/src/commands/eval-run.ts --set <id> --task audit --models mistralai/mistral-large-2512,google/gemini-2.5-flash --label baseline-vs-gemini --write-db',
      'npx tsx apps/pipeline/src/commands/eval-run.ts --set <id> --task grading --models anthropic/claude-opus-5.5,anthropic/claude-sonnet-5 --repeat 2 --label sonnet-vs-opus --write-db',
      'npx tsx apps/pipeline/src/commands/eval-run.ts --set <id> --task mapping --models anthropic/claude-sonnet-5,anthropic/claude-haiku-4.5 --repeat 3 --label baseline-vs-haiku --write-db',
    ],
    validate: (o) => {
      if (!Number.isInteger(o.renderDpi)) return '--render-dpi must be a whole number';
      if (o.renderDpi > RENDER_DPI_MAX) return `--render-dpi must be at most ${RENDER_DPI_MAX}`;
    },
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

/** One run-label convention: always `<label>:<model slug>`, with no `:r<n>` repeat suffix. That
 * distinction lives in the `repeat_index` column instead, so a repeat launched in its own
 * invocation reads the same label as one launched alongside its baseline. */
export function buildVariantLabel(label: string, variant: Variant): string {
  return `${label}:${variant.model}`;
}

/** Resolves the label text `buildVariantLabel` suffixes with the model slug: `--label` when
 * given, else the experiment's slug when `--experiment` was given, else the task name. An
 * unlabeled run is never bare, and groups naturally with its experiment when it has one. */
export function resolveLabel(optionLabel: string | undefined, experimentSlug: string | undefined, task: string): string {
  return optionLabel ?? experimentSlug ?? task;
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
const AUDIT_PRODUCTION_PROVIDER: NonNullable<LlmCallOptions['provider']> = { order: ['mistral'], allowFallbacks: false };

/**
 * The call settings a variant actually uses: the task's production default unless the user
 * overrides it with `--temperature`/`--provider`. Grading's production default is
 * `GRADING_CALL_SETTINGS`; audit's matches `questions-audit.ts`'s own sync call; mapping's and
 * transcription's both match their own production call (no temperature override, no JSON mode, no
 * provider pin, since transcription's `convertPdfToMarkdown` sends none of those either). A
 * `--provider` value is lowercased before it's stored, so a hand-typed `--provider Anthropic` is
 * recorded the same way as `anthropic`.
 */
export function buildEffectiveCallSettings(
  task: 'audit' | 'grading' | 'mapping' | 'transcription',
  options: { temperature?: number; provider?: string },
): EffectiveCallSettings {
  const overrideProvider = options.provider ? { order: [options.provider.toLowerCase()], allowFallbacks: false } : undefined;
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

/** Recursively sorts object keys so two values built with the same content in a different key
 * order compare equal; arrays and primitives pass through unchanged. */
function canonicalizeForComparison(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForComparison);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalizeForComparison((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** The `settings` keys a repeat's identity is judged on: every flag the caller actually chose.
 * `jsonMode` is a fixed fact about the task, not a choice, so it's left out; `effectiveTemperature`/
 * `effectiveReasoning` are left out too, since they're derived from `MODEL_CONSTRAINTS` and the
 * model registry rather than requested, and either can change independently of anything the caller
 * asked for. */
/** Exported so a caller validating settings before they're written (`eval-experiment-create`'s
 * declared-variant `settings` check) checks keys against this list instead of a second, divergent
 * copy of it. */
export const REPEAT_IDENTITY_SETTINGS_KEYS = ['temperature', 'reasoning', 'provider', 'groupSize', 'shuffleSeed', 'exclusionPass', 'renderDpi', 'mode', 'grouping'] as const;
export type RepeatIdentityKey = (typeof REPEAT_IDENTITY_SETTINGS_KEYS)[number];
type RepeatIdentityTask = 'audit' | 'grading' | 'mapping' | 'transcription';

/** The values `mode` may take: how the calls of a run are made, one request at a time or through a
 * provider's batch endpoint. A run with no `mode` key is `'sync'`. */
export const RUN_MODES = ['sync', 'batch'] as const;
export const DEFAULT_RUN_MODE = 'sync';

/** The values `grouping` may take: how audit questions are put into calls. `'by_order'` is the only
 * grouping `eval-run` performs, consecutive items in the (optionally seeded) shuffled order; a run
 * with no `grouping` key is `'by_order'`. */
export const RUN_GROUPINGS = ['by_order', 'by_topic'] as const;
export const DEFAULT_RUN_GROUPING = 'by_order';

/** `temperature`'s "no override was sent" state: distinct from any number the task's own default
 * could resolve to, and from `null`. Mapping and transcription write no `temperature` key at all
 * unless `--temperature` overrides it, so this is their steady state, not a historical gap. */
const TEMPERATURE_NOT_SENT = '__temperature_not_sent__';

/** A stored `provider` value with each `order` entry lowercased, so a run recorded before provider
 * pins were lowercased still compares equal to one recorded after. `null`/absent both mean
 * unpinned. */
function normalizeStoredProvider(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const provider = value as { order?: unknown };
  if (!Array.isArray(provider.order)) return provider;
  return { ...provider, order: provider.order.map((entry) => (typeof entry === 'string' ? entry.toLowerCase() : entry)) };
}

/** The value `key` compares against when a run's settings don't carry it at all: the value that
 * was actually in force at the time, not a wildcard that matches anything. */
function normalizeRepeatIdentityValue(key: RepeatIdentityKey, value: unknown, task: RepeatIdentityTask): unknown {
  if (key === 'temperature') return value === undefined ? TEMPERATURE_NOT_SENT : value;
  if (key === 'provider') return normalizeStoredProvider(value);
  if (key === 'groupSize') return value === undefined ? (task === 'audit' ? AUDIT_GROUP_SIZE : 1) : value;
  if (key === 'renderDpi') return value === undefined ? DEFAULT_RENDER_DPI : value;
  // `eval-run` writes neither mode nor grouping (it has no flag for either), so this fill-in is what
  // every run it makes carries.
  if (key === 'mode') return value === undefined ? DEFAULT_RUN_MODE : value;
  if (key === 'grouping') return value === undefined ? DEFAULT_RUN_GROUPING : value;
  // reasoning, shuffleSeed, exclusionPass: absent means null, same as how buildSettingsForModel
  // writes them when the caller didn't ask for one.
  return value === undefined ? null : value;
}

/**
 * Normalizes one run's settings to `REPEAT_IDENTITY_SETTINGS_KEYS`' comparison form, filling in the
 * value that was in force for any key the settings don't carry at all. Exported so a verification
 * script can reproduce `resolveExistingRepeatCount`'s grouping directly against stored rows instead
 * of approximating it.
 */
export function normalizeRepeatIdentitySettings(settings: Record<string, unknown>, task: RepeatIdentityTask): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const key of REPEAT_IDENTITY_SETTINGS_KEYS) {
    normalized[key] = normalizeRepeatIdentityValue(key, settings[key], task);
  }
  return normalized;
}

/** Whether two runs' settings count as the same repeat for `resolveExistingRepeatCount`: every
 * `REPEAT_IDENTITY_SETTINGS_KEYS` entry must match once `normalizeRepeatIdentitySettings` has
 * filled in the value in force for any key either side's settings don't carry. */
function settingsEqual(a: Record<string, unknown>, b: Record<string, unknown>, task: RepeatIdentityTask): boolean {
  const normalizedA = normalizeRepeatIdentitySettings(a, task);
  const normalizedB = normalizeRepeatIdentitySettings(b, task);
  return REPEAT_IDENTITY_SETTINGS_KEYS.every(
    (key) => JSON.stringify(canonicalizeForComparison(normalizedA[key])) === JSON.stringify(canonicalizeForComparison(normalizedB[key])),
  );
}

/** One entry of `eval_experiments.variants_declared`. `model_slug` null or `'*'` names no model, so
 * the declaration matches no run. `baseline_from` is the slug of another experiment whose runs this
 * declaration draws on instead of the declaring experiment's own (valid on a baseline). */
export interface DeclaredVariant {
  label: string;
  model_slug: string | null;
  role: string;
  settings?: Record<string, unknown>;
  baseline_from?: string | null;
}

/** What `declaredVariantMatchesRun` needs to know about the experiments around a declaration:
 * the one declaring it, and every experiment's id by slug (for `baseline_from`). */
export interface VariantMatchContext {
  declaringExperimentId: string;
  experimentIdBySlug: ReadonlyMap<string, string>;
}

/** A settings `exclusionPass` value reduced to the classifier model slug: a declaration names the
 * classifier by slug while a run stores the whole object it called, so both sides compare on the
 * model alone. */
function exclusionPassModel(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return (value as { model?: unknown }).model ?? null;
  return value;
}

/**
 * Whether `run` counts as a run of `declared`: the TypeScript twin of the match rule in the
 * `eval_experiment_variants` view, and it must change with it. The run must belong to the
 * experiment the declaration draws on (the declaring experiment, or the one `baseline_from` names;
 * an unknown slug matches nothing), be neither failed nor aborted, and have `model` equal to
 * `model_slug` (null or `'*'` matches nothing). Then every settings key the declaration carries
 * must equal the run's value for it after `normalizeRepeatIdentitySettings` fills in the value in
 * force for a key the run does not carry; a key the declaration does not carry is unconstrained.
 * `exclusionPass` compares on the classifier model slug alone and a provider pin's `order` is
 * lowercased on both sides.
 */
export function declaredVariantMatchesRun(
  declared: DeclaredVariant,
  run: Pick<EvalRunRow, 'task' | 'model' | 'status' | 'settings' | 'experiment_id'>,
  context: VariantMatchContext,
): boolean {
  if (declared.model_slug === null || declared.model_slug === undefined || declared.model_slug === '*') return false;
  if (run.status === 'failed' || run.status === 'aborted') return false;
  if (run.model !== declared.model_slug) return false;

  const candidateExperimentId = declared.baseline_from == null
    ? context.declaringExperimentId
    : context.experimentIdBySlug.get(declared.baseline_from);
  if (candidateExperimentId === undefined || run.experiment_id !== candidateExperimentId) return false;

  const declaredSettings = declared.settings ?? {};
  const normalizedRun = normalizeRepeatIdentitySettings(run.settings, run.task as RepeatIdentityTask);
  return REPEAT_IDENTITY_SETTINGS_KEYS.every((key) => {
    if (!Object.prototype.hasOwnProperty.call(declaredSettings, key)) return true;
    const declaredValue = key === 'provider'
      ? normalizeStoredProvider(declaredSettings[key])
      : key === 'exclusionPass' ? exclusionPassModel(declaredSettings[key]) : declaredSettings[key];
    const runValue = key === 'exclusionPass' ? exclusionPassModel(normalizedRun[key]) : normalizedRun[key];
    return JSON.stringify(canonicalizeForComparison(declaredValue)) === JSON.stringify(canonicalizeForComparison(runValue));
  });
}

/**
 * The number of existing runs already on `experimentId` for `model`, with the same prompt hash and
 * the same caller-controlled settings (`settingsEqual`): what `repeat_index` for a new run of this
 * model continues from. A run whose status is `failed` or `aborted` never counts: neither produced a
 * usable result to compare against. Called once per distinct model before any run in this
 * invocation is inserted, so a later variant's count is never inflated by an earlier variant's own
 * insert within the same invocation.
 */
export async function resolveExistingRepeatCount(
  store: EvalStore,
  experimentId: string,
  setId: string,
  model: string,
  promptHash: string | null,
  settings: Record<string, unknown>,
  task: RepeatIdentityTask,
): Promise<number> {
  const existing = await store.listRunsByExperimentAndModel(experimentId, model);
  return existing.filter(
    (r) => r.status !== 'failed' && r.status !== 'aborted' && r.set_id === setId && r.prompt_hash === promptHash && settingsEqual(r.settings, settings, task),
  ).length;
}

/** The reasoning effort ranking a model's registered `efforts` list is read against: `minimal` is
 * lowest, `max` highest. An entry outside this list (a typo, a tier OpenRouter has since renamed)
 * is ignored rather than crashing the comparison. */
const REASONING_EFFORT_RANK = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const FALLBACK_REASONING_EFFORT_DEFAULT = 'low';

/** The lowest-ranked entry of a model's registered reasoning efforts, or undefined when the list
 * is empty or carries no entry `REASONING_EFFORT_RANK` recognizes. */
function lowestRegisteredReasoningEffort(efforts: string[] | undefined): string | undefined {
  const ranked = (efforts ?? []).filter((effort) => REASONING_EFFORT_RANK.includes(effort));
  if (ranked.length === 0) return undefined;
  return ranked.reduce((lowest, effort) => (REASONING_EFFORT_RANK.indexOf(effort) < REASONING_EFFORT_RANK.indexOf(lowest) ? effort : lowest));
}

/**
 * A model's sampling constraints: `fixedTemperature` from `MODEL_CONSTRAINTS`
 * (`@adaptive/shared/models`), whether reasoning is mandatory and which effort to fall back to from
 * the model's own registry row (`eval_models_current.reasoning`). When reasoning is mandatory but
 * the row has no efforts list `REASONING_EFFORT_RANK` recognizes, warns once and falls back to
 * `FALLBACK_REASONING_EFFORT_DEFAULT`.
 */
function resolveModelSamplingConstraints(model: string, registryRow: EvalModelCurrentRow | undefined): ModelSamplingConstraints {
  const reasoning = registryRow?.reasoning ?? null;
  const reasoningMandatory = reasoning?.mandatory === true;
  let fallbackReasoningEffort = FALLBACK_REASONING_EFFORT_DEFAULT;
  if (reasoningMandatory) {
    const lowest = lowestRegisteredReasoningEffort(reasoning?.efforts);
    if (lowest) {
      fallbackReasoningEffort = lowest;
    } else {
      logger.warn(`${model}: reasoning is mandatory but its registry row has no recognized efforts list; falling back to '${FALLBACK_REASONING_EFFORT_DEFAULT}'.`);
    }
  }
  return {
    fixedTemperature: MODEL_CONSTRAINTS[model]?.fixedTemperature ?? false,
    reasoningMandatory,
    fallbackReasoningEffort,
  };
}

/** True when every one of `resultRows` carries a non-null `error`: a variant whose loop finished
 * without an unhandled exception (the loop's own `completed` status) but whose calls all failed
 * individually, each caught and recorded by the task's own per-item error handling. */
function everyResultErrored(resultRows: NewEvalResultRow[]): boolean {
  return resultRows.length > 0 && resultRows.every((row) => row.error != null);
}

/** Describes an all-errored variant for `summary.error`: the error kind carried on each result row
 * (never the provider's own message, which isn't stored on the row), naming a single kind when
 * every row shares one and a breakdown by kind otherwise. */
function describeAllErrored(resultRows: NewEvalResultRow[]): string {
  const total = resultRows.length;
  const counts = new Map<string, number>();
  for (const row of resultRows) {
    const kind = String(row.error);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  if (counts.size === 1) {
    return `every call errored (${total} of ${total}, all '${[...counts.keys()][0]}')`;
  }
  const breakdown = [...counts.entries()].map(([kind, count]) => `${count} '${kind}'`).join(', ');
  return `every call errored (${total} of ${total}: ${breakdown})`;
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

  if (options.exclusionPass && options.task !== 'transcription') {
    logger.error(`--exclusion-pass only applies to the transcription task (got '${options.task}').`);
    process.exit(1);
  }
  if (options.exclusionProvider && !options.exclusionPass) {
    logger.error('--exclusion-provider requires --exclusion-pass.');
    process.exit(1);
  }

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

  // The exclusion-pass classifier is resolved against the registry alongside the transcription
  // models themselves — a missing row for it refuses the whole run the same way a missing
  // transcription model does, rather than running uncosted.
  const modelsToResolve = options.exclusionPass && !models.includes(options.exclusionPass)
    ? [...models, options.exclusionPass]
    : models;

  const modelBySlug = new Map<string, EvalModelCurrentRow>();
  const missingModels: string[] = [];
  for (const slug of modelsToResolve) {
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
  // The classifier call defaults to the same provider pin as the transcription variant it gates;
  // --exclusion-provider overrides that only when the classifier's own model needs a different one
  // (e.g. a transcription model pinned to Anthropic gated by a classifier model only on Google AI Studio).
  const exclusionPass: ExclusionPassSettings | undefined = options.exclusionPass
    ? {
        model: options.exclusionPass,
        provider: options.exclusionProvider ? { order: [options.exclusionProvider.toLowerCase()], allowFallbacks: false } : callSettings.provider,
        promptHash: CLASSIFY_PROMPT_HASH,
      }
    : undefined;
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
  const label = resolveLabel(options.label, experiment?.slug, options.task);
  // Stamped onto every finalized run's summary: the reviewed-reference state (if any) this run's
  // scoring reflects, so a later rescore against a newer review round is distinguishable from this
  // one. Fetched before any run row exists so a failure here cannot strand a row at 'running'.
  const reviewRound = await store.latestReviewRound(options.set);

  // Each model's sampling constraints (MODEL_CONSTRAINTS' fixedTemperature, the registry row's
  // reasoning mandate and fallback effort), resolved once per distinct model so a mandatory-
  // reasoning-with-no-efforts-list warning is logged once rather than once per call.
  const samplingConstraintsByModel = new Map<string, ModelSamplingConstraints>();
  function samplingConstraintsFor(model: string): ModelSamplingConstraints {
    let constraints = samplingConstraintsByModel.get(model);
    if (!constraints) {
      constraints = resolveModelSamplingConstraints(model, modelBySlug.get(model));
      samplingConstraintsByModel.set(model, constraints);
    }
    return constraints;
  }

  // The settings a model's calls actually use, including its sampling constraints' adjustments. The
  // same for every repeat of one model, so this is computed once per model rather than once per
  // variant, both for the repeat-count lookup below and for the row this invocation inserts.
  function buildSettingsForModel(model: string): { settings: Record<string, unknown>; adjustments: string[] } {
    const intendedReasoning = reasoning ?? (TASKS_DISABLING_REASONING_BY_DEFAULT.has(options.task) ? { enabled: false } : undefined);
    const effectiveSampling = resolveEffectiveSamplingSettings(samplingConstraintsFor(model), callSettings.temperature, intendedReasoning, reasoning !== undefined);
    const settings: Record<string, unknown> = {
      temperature: callSettings.temperature,
      jsonMode: callSettings.jsonMode,
      reasoning: reasoning ?? null,
      provider: callSettings.provider ?? null,
      groupSize,
      shuffleSeed: shuffleSeed ?? null,
      exclusionPass: exclusionPass
        ? { model: exclusionPass.model, provider: exclusionPass.provider?.order?.[0] ?? null, promptHash: exclusionPass.promptHash }
        : null,
      renderDpi: options.task === 'transcription' ? options.renderDpi : null,
      effectiveTemperature: effectiveSampling.temperature ?? null,
      effectiveReasoning: effectiveSampling.reasoning ?? null,
    };
    return { settings, adjustments: effectiveSampling.adjustments };
  }

  // Resolved once per distinct model, before any run row exists, so a later variant's count is
  // never inflated by an earlier variant's own insert within this same invocation. Empty (every
  // lookup below falls back to 0) for an ad hoc run with no --experiment, which is exactly
  // "repeat_index is just the invocation's own offset."
  const existingRepeatCountByModel = new Map<string, number>();
  if (experiment) {
    for (const model of new Set(variants.map((v) => v.model))) {
      const { settings } = buildSettingsForModel(model);
      existingRepeatCountByModel.set(model, await resolveExistingRepeatCount(store, experiment.id, options.set, model, promptHash, settings, options.task));
    }
  }

  for (const variant of variants) {
    const transcriptionProjected = projectVariantCostUsd(options.task, registryPriceOf(modelBySlug.get(variant.model)), items.length, groupSize);
    const exclusionProjected = exclusionPass
      ? projectExclusionPassCostUsd(registryPriceOf(modelBySlug.get(exclusionPass.model)), items.length)
      : 0;
    const projected = transcriptionProjected !== undefined && exclusionProjected !== undefined
      ? transcriptionProjected + exclusionProjected
      : undefined;
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

    // What this variant's model would reject as sent gets adjusted here too, purely to log and
    // record what the task module will actually send. Each task module makes the same call
    // independently, at the point it builds its own request.
    const { settings, adjustments } = buildSettingsForModel(variant.model);
    if (adjustments.length > 0) {
      logger.info(`${variantKey(variant)}: ${adjustments.join('; ')}`);
    }

    const repeatIndex = (existingRepeatCountByModel.get(variant.model) ?? 0) + variant.repeatIndex;
    const run = await store.insertRun({
      set_id: options.set,
      task: options.task,
      model: variant.model,
      experiment_id: experiment?.id ?? null,
      model_version_id: modelBySlug.get(variant.model)?.id ?? null,
      variant_label: buildVariantLabel(label, variant),
      provider_pin: callSettings.provider?.order?.[0] ?? null,
      prompt_hash: promptHash,
      settings,
      repeat_index: repeatIndex,
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
    taskContext = await taskDef.prepareContext({ set, items: orderedItems, supabase, fetchUnitsFromDbFn: deps.fetchUnitsFromDbFn ?? fetchUnitsFromDb, renderDpi: options.renderDpi });

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
      if (wait > 0) await sleep(wait);
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
          call, context: taskContext, run, callSettings, reasoning, callLlmFn, throttleIfMistral, exclusionPass,
          samplingConstraints: samplingConstraintsFor(call.variant.model),
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

        // A variant whose loop finished without an unhandled exception still isn't a usable run
        // when every one of its calls errored individually (e.g. a model that rejects the task's
        // reasoning setting, so every slide comes back an API error). That's a failed run with a
        // summary of zero scored items, not a completed one.
        if (status === 'completed' && everyResultErrored(resultRows)) {
          status = 'failed';
          errorMessage = describeAllErrored(resultRows);
        }

        const builtSummary = taskDef.buildSummary(outcomesByVariant.get(key)!);
        const { summary: stampedSummary, scoredAt, scoringReviewRoundId } = stampSummary(options.task, builtSummary, {
          scoredAt: new Date().toISOString(),
          scoringReviewRoundId: reviewRound?.id ?? null,
        });
        const summary = errorMessage !== undefined ? { ...stampedSummary, error: errorMessage } : stampedSummary;

        try {
          await store.updateRun(run.id, {
            status,
            finished_at: new Date().toISOString(),
            summary,
            scored_at: scoredAt,
            scoring_review_round_id: scoringReviewRoundId,
          });
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
