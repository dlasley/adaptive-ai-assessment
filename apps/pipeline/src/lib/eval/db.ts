/**
 * Supabase-backed store for the evaluation framework's four tables (supabase/schema.sql:
 * eval_sets, eval_items, eval_runs, eval_results — all service-role only, no anon policies).
 * Commands depend on the `EvalStore` interface, not this module directly, so tests inject an
 * in-memory fake instead of a live Supabase connection — the same shape `mistral-audit.ts`'s
 * `BatchJobStore` uses for `llm_batch_jobs`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { EvalTask } from './types';

export interface EvalSetRow {
  id: string;
  task: EvalTask;
  unit_id: string | null;
  source: string;
  item_count: number;
  selection: Record<string, unknown>;
  inputs_hash: string | null;
  label: string | null;
  created_at: string;
  updated_at: string;
}

export type NewEvalSetRow = Pick<EvalSetRow, 'task' | 'source'> &
  Partial<Pick<EvalSetRow, 'unit_id' | 'item_count' | 'selection' | 'inputs_hash' | 'label'>>;

export interface EvalItemRow {
  id: string;
  set_id: string;
  item_key: string;
  payload: Record<string, unknown>;
  /** A design-time label assigned when the item was constructed (e.g. a grading label class),
   * never a reviewer verdict. Null for an item built before this column existed; readers fall back
   * to `payload.label_class` through `seededLabelClass()` in `set-builder.ts`. */
  seeded_class: string | null;
  reference: Record<string, unknown> | null;
  reference_status: 'pending' | 'approved' | 'rejected';
  reviewed_by: string | null;
  reviewed_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type NewEvalItemRow = Pick<EvalItemRow, 'set_id' | 'item_key' | 'payload'> &
  Partial<Pick<EvalItemRow, 'seeded_class' | 'reference' | 'reference_status' | 'reviewed_by' | 'reviewed_at' | 'notes'>>;

export interface EvalRunRow {
  id: string;
  set_id: string;
  task: EvalTask;
  variant_label: string | null;
  model: string;
  provider_pin: string | null;
  prompt_hash: string | null;
  settings: Record<string, unknown>;
  judge_model: string | null;
  judge_prompt_hash: string | null;
  repeat_index: number;
  projected_cost_usd: number | null;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  started_at: string;
  finished_at: string | null;
  summary: Record<string, unknown> | null;
  /** When this run's summary (and its results' scores) were last computed, at run finalisation or
   * by eval-rescore. Null only for a run that never finalised. */
  scored_at: string | null;
  /** The newest eval_review_rounds row on this run's set at the time it was scored. Null when the
   * set had no review round yet. */
  scoring_review_round_id: string | null;
  /** The eval_experiments row this run belongs to, if any (--experiment). */
  experiment_id: string | null;
  /** The eval_models row --models resolved against eval_models_current at run time. */
  model_version_id: string | null;
  created_at: string;
  updated_at: string;
}

export type NewEvalRunRow = Pick<EvalRunRow, 'set_id' | 'task' | 'model'> &
  Partial<Pick<EvalRunRow, 'variant_label' | 'provider_pin' | 'prompt_hash' | 'settings' | 'judge_model' | 'judge_prompt_hash' | 'repeat_index' | 'projected_cost_usd' | 'status' | 'experiment_id' | 'model_version_id'>>;

export interface EvalResultRow {
  id: string;
  run_id: string;
  item_id: string;
  output: Record<string, unknown> | null;
  /** Set only by `eval-judge`: { [otherRunId]: { [judgePromptHash]: JudgeVerdictEntry[] } }. Each
   * run of the command appends one entry to the list for its pairing and hash, so repeats and
   * other judge models sit side by side; an entry records the judge model, its repeat index, the
   * call settings sent and the response facts of both position-order calls (see `judge.ts`). */
  judge_verdict: Record<string, unknown> | null;
  deterministic_checks: Record<string, unknown> | null;
  score: number | null;
  latency_ms: number | null;
  cost_usd: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  served_model: string | null;
  /** The host OpenRouter's response named as having actually served this call, compared against
   * the owning run's provider_pin by eval-compare. */
  served_provider: string | null;
  is_byok: boolean | null;
  error: 'parse' | 'api' | 'empty' | null;
  /** OpenRouter response facts with no column of their own: response id, created, each choice's
   * finish_reason/native_finish_reason, and the usage sub-fields parseUsage doesn't map (cached
   * tokens, upstream cost breakdown). Never contains message content. Kept when a call
   * returned content, including content that then failed to parse (error `parse`); null when the
   * call failed or returned no content (error `api` or `empty`). One shape per task: the primary
   * call's fields at the top level; a transcription row whose slide went through --exclusion-pass
   * adds a `classifier` key holding the same fields for the classifier call plus its
   * served_model/served_provider (the row's own served_model/served_provider columns describe the
   * transcription call only). A transcription row is one of four shapes: null (no call returned a
   * response), top-level only (no exclusion pass), top-level plus classifier (both calls returned
   * a response), or classifier alone, meaning the transcription call returned nothing to record,
   * told apart by the row's `error` and `deterministic_checks.exclusion_decision`: the classifier
   * dropped the slide (no error, decision `drop`), the transcription call failed after the
   * classifier kept it (`api`/`empty`, decision `keep`), or the classifier's own response did not
   * parse (`parse`, decision null). For a grouped audit call this is the whole call's response,
   * written identically on every row in the group. Unlike the per-row token columns, which are
   * that group's split, this is not divisible and must not be summed across rows. Nothing reads
   * the column yet; it exists so a question asked later about one call can be answered from the
   * row. */
  response_meta: Record<string, unknown> | null;
  created_at: string;
}

export type NewEvalResultRow = Pick<EvalResultRow, 'run_id' | 'item_id'> &
  Partial<Omit<EvalResultRow, 'id' | 'run_id' | 'item_id' | 'created_at'>>;

export interface EvalExperimentRow {
  id: string;
  slug: string;
  question: string;
  tasks: EvalTask[];
  variants_declared: unknown[];
  decision_rule: Record<string, unknown>;
  depends_on: string[];
  status: 'proposed' | 'running' | 'decided' | 'deferred' | 'superseded';
  decided_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type NewEvalExperimentRow = Pick<EvalExperimentRow, 'slug' | 'question' | 'tasks'> &
  Partial<Pick<EvalExperimentRow, 'variants_declared' | 'decision_rule' | 'depends_on' | 'status' | 'notes'>>;

/** One row of `eval_experiment_variants`, scoped to one experiment: a declared variant's label, and
 * the eval_runs rows (count and ids) that currently match it under that view's rule.
 * `eval-experiment-create`'s `--update` path reads this to refuse an update that would orphan the
 * runs a declared variant matches today. */
export interface EvalExperimentVariantRunCountRow {
  declared_label: string | null;
  run_count: number;
  run_ids: string[];
}

/** One dated snapshot from `eval_models_current` (the latest row per slug) — the subset `eval-run`
 * needs to stamp `model_version_id` and identify the model it resolved. */
export interface EvalModelCurrentRow {
  id: string;
  family_id: string;
  slug: string;
  effective_date: string;
  /** List prices per million tokens on this dated snapshot; PostgREST returns NUMERIC as a string.
   * Null when the snapshot was registered without a price (e.g. a direct-API model). */
  price_prompt_usd_per_m: string | number | null;
  price_completion_usd_per_m: string | number | null;
  hosts: Array<{ provider_pin: string; quantization?: string; notes?: string }>;
  /** Whether and how this model supports reasoning: `mandatory` true means a request disabling
   * reasoning outright is rejected; `efforts` lists its registered effort tiers, lowest first or in
   * any order. Null when the model has no reasoning mode at all. */
  reasoning: { mandatory?: boolean; default_on?: boolean; efforts?: string[] } | null;
}

export interface EvalFindingRow {
  id: string;
  experiment_id: string | null;
  kind: 'adopt' | 'reject' | 'defer' | 'observation';
  task: EvalTask | null;
  statement: string;
  evidence_note: string | null;
  run_ids: string[];
  item_ids: string[];
  external_refs: string[];
  decided_by: string | null;
  decided_at: string;
  supersedes_finding_id: string | null;
  created_at: string;
  /** The command that recorded this row as a decision, through its own `--decide`. Null for a plain
   * observation, which decides nothing. */
  decided_via: 'eval-compare' | 'eval-finding' | null;
}

export type NewEvalFindingRow = Pick<EvalFindingRow, 'kind' | 'statement'> &
  Partial<Pick<EvalFindingRow, 'experiment_id' | 'task' | 'evidence_note' | 'run_ids' | 'item_ids' | 'external_refs' | 'decided_by' | 'supersedes_finding_id' | 'decided_via'>>;

export interface EvalReviewRoundRow {
  id: string;
  set_id: string;
  reviewer: string;
  rubric_version: string;
  rubric_hash: string | null;
  calibration_result: Record<string, unknown> | null;
  inter_rater: Record<string, unknown> | null;
  reviewed_item_count: number;
  notes: string | null;
  created_at: string;
}

export type NewEvalReviewRoundRow = Pick<EvalReviewRoundRow, 'set_id' | 'reviewer' | 'rubric_version'> &
  Partial<Pick<EvalReviewRoundRow, 'rubric_hash' | 'calibration_result' | 'inter_rater' | 'reviewed_item_count' | 'notes'>>;

export interface EvalStore {
  insertSet(row: NewEvalSetRow): Promise<EvalSetRow>;
  insertItems(rows: NewEvalItemRow[]): Promise<EvalItemRow[]>;
  getSet(id: string): Promise<EvalSetRow | null>;
  listItems(setId: string): Promise<EvalItemRow[]>;
  updateItem(id: string, patch: Partial<EvalItemRow>): Promise<void>;
  insertRun(row: NewEvalRunRow): Promise<EvalRunRow>;
  updateRun(id: string, patch: Partial<EvalRunRow>): Promise<void>;
  getRun(id: string): Promise<EvalRunRow | null>;
  /** Every eval_runs row against one set, in no particular order — eval-rescore's `--set` target. */
  listRunsBySet(setId: string): Promise<EvalRunRow[]>;
  /** Every eval_runs row attributed to one experiment, in no particular order — eval-rescore's
   * `--experiment` target. */
  listRunsByExperiment(experimentId: string): Promise<EvalRunRow[]>;
  /** Every eval_runs row for one experiment and model, in no particular order. Serves eval-run's
   * repeat_index resolution when --experiment is given: narrower than listRunsByExperiment so a
   * long-running experiment across many models doesn't fetch rows this computation never looks at. */
  listRunsByExperimentAndModel(experimentId: string, model: string): Promise<EvalRunRow[]>;
  insertResults(rows: NewEvalResultRow[]): Promise<void>;
  listResults(runId: string): Promise<EvalResultRow[]>;
  updateResult(id: string, patch: Partial<Pick<EvalResultRow, 'score'>>): Promise<void>;
  /** One eval_results row by id, or null when it does not exist. `eval-judge` re-reads a row's
   * judge_verdict through this immediately before each write. */
  getResult(id: string): Promise<EvalResultRow | null>;
  /** Replaces one eval_results row's judge_verdict column wholesale. `eval-judge` reads the row's
   * current value immediately before the write and passes the object back with one more entry
   * appended to the list for its pairing and judge prompt hash, so earlier entries are kept. */
  updateResultJudgeVerdict(id: string, verdict: Record<string, unknown>): Promise<void>;
  /** Resolves `idOrSlug` against `eval_experiments.id` first, then `.slug` — --experiment accepts either. */
  getExperiment(idOrSlug: string): Promise<EvalExperimentRow | null>;
  insertExperiment(row: NewEvalExperimentRow): Promise<EvalExperimentRow>;
  updateExperiment(id: string, patch: Partial<Pick<EvalExperimentRow, 'status' | 'decided_at' | 'notes' | 'question' | 'variants_declared' | 'decision_rule' | 'depends_on'>>): Promise<void>;
  /** Declared-variant row counts from `eval_experiment_variants` for one experiment: see
   * `EvalExperimentVariantRunCountRow`. */
  listDeclaredVariantRunCounts(experimentId: string): Promise<EvalExperimentVariantRunCountRow[]>;
  /** Resolves a --models slug against eval_models_current (the latest snapshot per slug). */
  getModelBySlug(slug: string): Promise<EvalModelCurrentRow | null>;
  /** Every eval_model_families row for one vendor, for eval-run's unregistered-model refusal: it
   * points whoever registers the model at the vendor's existing families rather than inviting a new
   * one that repeats a version number. */
  listFamiliesByVendor(vendor: string): Promise<Array<{ family: string }>>;
  /** Every eval_model_families row across all vendors, for eval-run's unregistered-model refusal
   * when a slug's vendor can't be determined (e.g. an unmapped `direct:` name) — falls back to the
   * full list rather than wrongly claiming no families exist for an unresolvable vendor. */
  listAllFamilies(): Promise<Array<{ vendor: string; family: string }>>;
  insertFinding(row: NewEvalFindingRow): Promise<EvalFindingRow>;
  /** Every eval_findings row recorded against one experiment — used to detect a decision that
   * would duplicate one already on record for the same baseline/candidate pair. */
  listFindings(experimentId: string): Promise<EvalFindingRow[]>;
  /** One eval_findings row by id — used to validate a `--supersedes` id before insert, since
   * `listFindings` is scoped to one experiment and a superseded finding may predate one or belong
   * to none. */
  getFinding(id: string): Promise<EvalFindingRow | null>;
  insertReviewRound(row: NewEvalReviewRoundRow): Promise<EvalReviewRoundRow>;
  /** The most recently created `eval_review_rounds` row for `setId`, or null when the set has never
   * been through a review round — the reviewed-reference state a rescore's summary is stamped
   * against. */
  latestReviewRound(setId: string): Promise<EvalReviewRoundRow | null>;
}

function fail(action: string, error: { message: string } | null): never {
  throw new Error(`Failed to ${action}: ${error?.message ?? 'unknown error'}`);
}

export function createSupabaseEvalStore(supabase: SupabaseClient): EvalStore {
  return {
    async insertSet(row) {
      const { data, error } = await supabase.from('eval_sets').insert(row).select().single();
      if (error || !data) fail('insert eval_sets row', error);
      return data as EvalSetRow;
    },
    async insertItems(rows) {
      if (rows.length === 0) return [];
      const { data, error } = await supabase.from('eval_items').insert(rows).select();
      if (error || !data) fail('insert eval_items rows', error);
      return data as EvalItemRow[];
    },
    async getSet(id) {
      const { data, error } = await supabase.from('eval_sets').select().eq('id', id).maybeSingle();
      if (error) fail(`fetch eval_sets row ${id}`, error);
      return (data as EvalSetRow) ?? null;
    },
    async listItems(setId) {
      const { data, error } = await supabase.from('eval_items').select().eq('set_id', setId).order('item_key');
      if (error) fail(`list eval_items for set ${setId}`, error);
      return (data as EvalItemRow[]) ?? [];
    },
    async updateItem(id, patch) {
      const { error } = await supabase.from('eval_items').update(patch).eq('id', id);
      if (error) fail(`update eval_items row ${id}`, error);
    },
    async insertRun(row) {
      const { data, error } = await supabase.from('eval_runs').insert(row).select().single();
      if (error || !data) fail('insert eval_runs row', error);
      return data as EvalRunRow;
    },
    async updateRun(id, patch) {
      const { error } = await supabase.from('eval_runs').update(patch).eq('id', id);
      if (error) fail(`update eval_runs row ${id}`, error);
    },
    async getRun(id) {
      const { data, error } = await supabase.from('eval_runs').select().eq('id', id).maybeSingle();
      if (error) fail(`fetch eval_runs row ${id}`, error);
      return (data as EvalRunRow) ?? null;
    },
    async listRunsBySet(setId) {
      const { data, error } = await supabase.from('eval_runs').select().eq('set_id', setId);
      if (error) fail(`list eval_runs for set ${setId}`, error);
      return (data as EvalRunRow[]) ?? [];
    },
    async listRunsByExperiment(experimentId) {
      const { data, error } = await supabase.from('eval_runs').select().eq('experiment_id', experimentId);
      if (error) fail(`list eval_runs for experiment ${experimentId}`, error);
      return (data as EvalRunRow[]) ?? [];
    },
    async listRunsByExperimentAndModel(experimentId, model) {
      const { data, error } = await supabase.from('eval_runs').select().eq('experiment_id', experimentId).eq('model', model);
      if (error) fail(`list eval_runs for experiment ${experimentId} and model ${model}`, error);
      return (data as EvalRunRow[]) ?? [];
    },
    async insertResults(rows) {
      if (rows.length === 0) return;
      const { error } = await supabase.from('eval_results').insert(rows);
      if (error) fail('insert eval_results rows', error);
    },
    async listResults(runId) {
      const { data, error } = await supabase.from('eval_results').select().eq('run_id', runId);
      if (error) fail(`list eval_results for run ${runId}`, error);
      return (data as EvalResultRow[]) ?? [];
    },
    async getResult(id) {
      const { data, error } = await supabase.from('eval_results').select().eq('id', id).maybeSingle();
      if (error) fail(`fetch eval_results row ${id}`, error);
      return (data as EvalResultRow) ?? null;
    },
    async updateResult(id, patch) {
      const { error } = await supabase.from('eval_results').update(patch).eq('id', id);
      if (error) fail(`update eval_results row ${id}`, error);
    },
    async updateResultJudgeVerdict(id, verdict) {
      const { error } = await supabase.from('eval_results').update({ judge_verdict: verdict }).eq('id', id);
      if (error) fail(`update eval_results judge_verdict for row ${id}`, error);
    },
    async getExperiment(idOrSlug) {
      // eval_experiments.id is a UUID column — an id.eq. clause with a non-UUID string errors in
      // Postgres, so the id half of the lookup is only attempted when idOrSlug looks like one.
      const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
      const query = supabase.from('eval_experiments').select();
      const { data, error } = looksLikeUuid
        ? await query.or(`id.eq.${idOrSlug},slug.eq.${idOrSlug}`).maybeSingle()
        : await query.eq('slug', idOrSlug).maybeSingle();
      if (error) fail(`fetch eval_experiments row ${idOrSlug}`, error);
      return (data as EvalExperimentRow) ?? null;
    },
    async insertExperiment(row) {
      const { data, error } = await supabase.from('eval_experiments').insert(row).select().single();
      if (error || !data) fail('insert eval_experiments row', error);
      return data as EvalExperimentRow;
    },
    async updateExperiment(id, patch) {
      const { error } = await supabase.from('eval_experiments').update(patch).eq('id', id);
      if (error) fail(`update eval_experiments row ${id}`, error);
    },
    async listDeclaredVariantRunCounts(experimentId) {
      const { data, error } = await supabase
        .from('eval_experiment_variants')
        .select('declared_label, run_count, run_ids')
        .eq('experiment_id', experimentId);
      if (error) fail(`list eval_experiment_variants for experiment ${experimentId}`, error);
      return (data as EvalExperimentVariantRunCountRow[]) ?? [];
    },
    async getModelBySlug(slug) {
      const { data, error } = await supabase.from('eval_models_current').select().eq('slug', slug).maybeSingle();
      if (error) fail(`fetch eval_models_current row for slug ${slug}`, error);
      return (data as EvalModelCurrentRow) ?? null;
    },
    async listFamiliesByVendor(vendor) {
      const { data, error } = await supabase.from('eval_model_families').select('family').eq('vendor', vendor).order('family');
      if (error) fail(`list eval_model_families for vendor ${vendor}`, error);
      return (data as Array<{ family: string }>) ?? [];
    },
    async listAllFamilies() {
      const { data, error } = await supabase.from('eval_model_families').select('vendor, family').order('vendor').order('family');
      if (error) fail('list eval_model_families', error);
      return (data as Array<{ vendor: string; family: string }>) ?? [];
    },
    async insertFinding(row) {
      const { data, error } = await supabase.from('eval_findings').insert(row).select().single();
      if (error || !data) fail('insert eval_findings row', error);
      return data as EvalFindingRow;
    },
    async listFindings(experimentId) {
      const { data, error } = await supabase.from('eval_findings').select().eq('experiment_id', experimentId);
      if (error) fail(`list eval_findings for experiment ${experimentId}`, error);
      return (data as EvalFindingRow[]) ?? [];
    },
    async getFinding(id) {
      const { data, error } = await supabase.from('eval_findings').select().eq('id', id).maybeSingle();
      if (error) fail(`fetch eval_findings row ${id}`, error);
      return (data as EvalFindingRow) ?? null;
    },
    async insertReviewRound(row) {
      const { data, error } = await supabase.from('eval_review_rounds').insert(row).select().single();
      if (error || !data) fail('insert eval_review_rounds row', error);
      return data as EvalReviewRoundRow;
    },
    async latestReviewRound(setId) {
      const { data, error } = await supabase
        .from('eval_review_rounds')
        .select()
        .eq('set_id', setId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail(`fetch latest eval_review_rounds row for set ${setId}`, error);
      return (data as EvalReviewRoundRow) ?? null;
    },
  };
}
