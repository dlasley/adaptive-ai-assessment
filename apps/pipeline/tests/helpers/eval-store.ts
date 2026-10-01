/**
 * Shared `EvalStore` test fake and row fixture builders, used by every eval command's test file
 * instead of each hand-rolling its own full 18-method fake. `baseFakeEvalStore()` throws on every
 * method by default, so a test spreads it and overrides only the methods it actually exercises — a
 * call to a method the test didn't expect fails loudly instead of returning `undefined` or silently
 * succeeding. The fixture builders return a fully-populated row with sensible defaults, overridable
 * per field through a partial argument.
 */

import type { EvalStore, EvalSetRow, EvalItemRow, EvalRunRow, EvalResultRow, EvalFindingRow, EvalExperimentRow } from '../../src/lib/eval/db';

const DEFAULT_TIMESTAMP = '2026-09-29T00:00:00Z';

export function baseFakeEvalStore(): EvalStore {
  return {
    async insertSet() {
      throw new Error('not used by this test');
    },
    async insertItems() {
      throw new Error('not used by this test');
    },
    async getSet() {
      throw new Error('not used by this test');
    },
    async listItems() {
      throw new Error('not used by this test');
    },
    async updateItem() {
      throw new Error('not used by this test');
    },
    async insertRun() {
      throw new Error('not used by this test');
    },
    async updateRun() {
      throw new Error('not used by this test');
    },
    async getRun() {
      throw new Error('not used by this test');
    },
    async listRunsBySet() {
      throw new Error('not used by this test');
    },
    async listRunsByExperiment() {
      throw new Error('not used by this test');
    },
    async listRunsByExperimentAndModel() {
      throw new Error('not used by this test');
    },
    async insertResults() {
      throw new Error('not used by this test');
    },
    async listResults() {
      throw new Error('not used by this test');
    },
    async updateResult() {
      throw new Error('not used by this test');
    },
    async updateResultJudgeVerdict() {
      throw new Error('not used by this test');
    },
    async getExperiment() {
      throw new Error('not used by this test');
    },
    async insertExperiment() {
      throw new Error('not used by this test');
    },
    async updateExperiment() {
      throw new Error('not used by this test');
    },
    async listDeclaredVariantRunCounts() {
      throw new Error('not used by this test');
    },
    async getModelBySlug() {
      throw new Error('not used by this test');
    },
    async listFamiliesByVendor() {
      throw new Error('not used by this test');
    },
    async listAllFamilies() {
      throw new Error('not used by this test');
    },
    async insertFinding() {
      throw new Error('not used by this test');
    },
    async listFindings() {
      throw new Error('not used by this test');
    },
    async getFinding() {
      throw new Error('not used by this test');
    },
    async insertReviewRound() {
      throw new Error('not used by this test');
    },
    async latestReviewRound() {
      throw new Error('not used by this test');
    },
  };
}

export function makeEvalSetRow(overrides: Partial<EvalSetRow> = {}): EvalSetRow {
  return {
    id: 'set-1',
    task: 'grading',
    unit_id: null,
    source: 'test',
    item_count: 1,
    selection: {},
    inputs_hash: null,
    label: null,
    created_at: DEFAULT_TIMESTAMP,
    updated_at: DEFAULT_TIMESTAMP,
    ...overrides,
  };
}

export function makeEvalItemRow(overrides: Partial<EvalItemRow> = {}): EvalItemRow {
  return {
    id: 'item-1',
    set_id: 'set-1',
    item_key: 'item-1',
    payload: {},
    seeded_class: null,
    reference: null,
    reference_status: 'pending',
    reviewed_by: null,
    reviewed_at: null,
    notes: null,
    created_at: DEFAULT_TIMESTAMP,
    updated_at: DEFAULT_TIMESTAMP,
    ...overrides,
  };
}

export function makeEvalRunRow(overrides: Partial<EvalRunRow> = {}): EvalRunRow {
  return {
    id: 'run-1',
    set_id: 'set-1',
    task: 'grading',
    variant_label: null,
    model: 'model',
    provider_pin: null,
    prompt_hash: null,
    settings: {},
    judge_model: null,
    judge_prompt_hash: null,
    repeat_index: 1,
    projected_cost_usd: null,
    status: 'completed',
    started_at: DEFAULT_TIMESTAMP,
    finished_at: null,
    summary: null,
    scored_at: null,
    scoring_review_round_id: null,
    experiment_id: null,
    model_version_id: null,
    created_at: DEFAULT_TIMESTAMP,
    updated_at: DEFAULT_TIMESTAMP,
    ...overrides,
  };
}

export function makeEvalExperimentRow(overrides: Partial<EvalExperimentRow> = {}): EvalExperimentRow {
  return {
    id: 'exp-1',
    slug: 'exp-1',
    question: 'question',
    tasks: ['grading'],
    variants_declared: [],
    decision_rule: {},
    depends_on: [],
    status: 'running',
    decided_at: null,
    notes: null,
    created_at: DEFAULT_TIMESTAMP,
    updated_at: DEFAULT_TIMESTAMP,
    ...overrides,
  };
}

export function makeEvalFindingRow(overrides: Partial<EvalFindingRow> = {}): EvalFindingRow {
  return {
    id: 'finding-1',
    experiment_id: null,
    kind: 'observation',
    task: null,
    statement: 'statement',
    evidence_note: null,
    run_ids: [],
    item_ids: [],
    external_refs: [],
    decided_by: null,
    decided_at: DEFAULT_TIMESTAMP,
    supersedes_finding_id: null,
    created_at: DEFAULT_TIMESTAMP,
    ...overrides,
  };
}

export function makeEvalResultRow(overrides: Partial<EvalResultRow> = {}): EvalResultRow {
  return {
    id: 'result-1',
    run_id: 'run-1',
    item_id: 'item-1',
    output: null,
    judge_verdict: null,
    deterministic_checks: null,
    score: null,
    latency_ms: null,
    cost_usd: null,
    prompt_tokens: null,
    completion_tokens: null,
    reasoning_tokens: null,
    served_model: null,
    served_provider: null,
    is_byok: null,
    error: null,
    response_meta: null,
    created_at: DEFAULT_TIMESTAMP,
    ...overrides,
  };
}
