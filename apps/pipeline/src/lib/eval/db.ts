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
  reference: Record<string, unknown> | null;
  reference_status: 'pending' | 'approved' | 'rejected';
  reviewed_by: string | null;
  reviewed_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type NewEvalItemRow = Pick<EvalItemRow, 'set_id' | 'item_key' | 'payload'> &
  Partial<Pick<EvalItemRow, 'reference' | 'reference_status' | 'reviewed_by' | 'reviewed_at' | 'notes'>>;

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
  created_at: string;
}

export type NewEvalResultRow = Pick<EvalResultRow, 'run_id' | 'item_id'> &
  Partial<Omit<EvalResultRow, 'id' | 'run_id' | 'item_id' | 'created_at'>>;

export interface EvalExperimentRow {
  id: string;
  slug: string;
  legacy_code: string | null;
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

/** One dated snapshot from `eval_models_current` (the latest row per slug) — the subset `eval-run`
 * needs to stamp `model_version_id` and identify the model it resolved. */
export interface EvalModelCurrentRow {
  id: string;
  family_id: string;
  slug: string;
  effective_date: string;
  hosts: Array<{ provider_pin: string; quantization?: string; notes?: string }>;
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
}

export type NewEvalFindingRow = Pick<EvalFindingRow, 'kind' | 'statement'> &
  Partial<Pick<EvalFindingRow, 'experiment_id' | 'task' | 'evidence_note' | 'run_ids' | 'item_ids' | 'external_refs' | 'decided_by' | 'supersedes_finding_id'>>;

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
  insertResults(rows: NewEvalResultRow[]): Promise<void>;
  listResults(runId: string): Promise<EvalResultRow[]>;
  /** Resolves `idOrSlug` against `eval_experiments.id` first, then `.slug` — --experiment accepts either. */
  getExperiment(idOrSlug: string): Promise<EvalExperimentRow | null>;
  updateExperiment(id: string, patch: Partial<Pick<EvalExperimentRow, 'status' | 'decided_at' | 'notes'>>): Promise<void>;
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
  insertReviewRound(row: NewEvalReviewRoundRow): Promise<EvalReviewRoundRow>;
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
    async updateExperiment(id, patch) {
      const { error } = await supabase.from('eval_experiments').update(patch).eq('id', id);
      if (error) fail(`update eval_experiments row ${id}`, error);
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
    async insertReviewRound(row) {
      const { data, error } = await supabase.from('eval_review_rounds').insert(row).select().single();
      if (error || !data) fail('insert eval_review_rounds row', error);
      return data as EvalReviewRoundRow;
    },
  };
}
