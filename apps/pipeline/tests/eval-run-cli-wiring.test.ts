import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/commands/eval-run';
import type {
  EvalStore,
  EvalRunRow,
  EvalResultRow,
  EvalExperimentRow,
  EvalModelCurrentRow,
  NewEvalFindingRow,
} from '../src/lib/eval/db';
import type { LlmCallOptions, LlmResult } from '@adaptive/shared/llm';
import type { MistralAuditResult } from '../src/lib/mistral-audit';
import { baseFakeEvalStore, makeEvalSetRow, makeEvalItemRow, makeEvalRunRow, makeEvalResultRow } from './helpers/eval-store';

// callMistralAuditGroup is the audit task's only network call; everything else in mistral-audit.ts
// (the retry wrapper, the system prompt used for prompt_hash) runs unmocked.
vi.mock('../src/lib/mistral-audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/mistral-audit')>();
  return { ...actual, callMistralAuditGroup: vi.fn() };
});
import { callMistralAuditGroup } from '../src/lib/mistral-audit';

// renderSlideImage shells out to pdftoppm; the transcription task's tests stub it with a fixed
// image buffer so they don't depend on that binary or a real PDF file.
vi.mock('../src/lib/pdf-conversion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/pdf-conversion')>();
  return { ...actual, renderSlideImage: vi.fn(() => Buffer.from('fake-slide-image-bytes')) };
});
import { renderSlideImage } from '../src/lib/pdf-conversion';

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

/**
 * A minimal in-memory `EvalStore`, seeded with one grading set/item and one registered model, for
 * exercising `eval-run`'s wiring without a live Supabase connection. `overrides` replaces
 * individual methods per test (e.g. `getModelBySlug` for the "unregistered slug" case).
 */
function makeFakeStore(overrides: Partial<EvalStore> = {}): { store: EvalStore; runs: EvalRunRow[]; results: EvalResultRow[] } {
  const runs: EvalRunRow[] = [];
  const results: EvalResultRow[] = [];
  let nextRunId = 0;

  const set = makeEvalSetRow();

  const item = makeEvalItemRow({
    payload: {
      question: 'Comment dit-on "hello"?',
      submitted_answer: 'bonjour',
      correct_answer: 'bonjour',
      type: 'fill-in-blank',
      difficulty: 'easy',
      label_class: 'correct',
    },
    reference: { isCorrect: true, borderline: false, reason: null, keyCorrect: true, keyNote: null },
    reference_status: 'approved',
  });

  const experiment: EvalExperimentRow = {
    id: 'exp-1',
    slug: 'test-experiment',
    legacy_code: null,
    question: 'Does the candidate model grade as well as baseline?',
    tasks: ['grading'],
    variants_declared: [],
    decision_rule: {},
    depends_on: [],
    status: 'proposed',
    decided_at: null,
    notes: null,
    created_at: '2026-09-29T00:00:00Z',
    updated_at: '2026-09-29T00:00:00Z',
  };

  const model: EvalModelCurrentRow = {
    id: 'model-1',
    family_id: 'family-1',
    slug: 'openai/gpt-4.1-nano',
    effective_date: '2026-09-25',
    hosts: [],
  };

  const store: EvalStore = {
    ...baseFakeEvalStore(),
    async getSet(id) {
      return id === set.id ? set : null;
    },
    async listItems(setId) {
      return setId === set.id ? [item] : [];
    },
    async latestReviewRound() {
      return null;
    },
    async listFamiliesByVendor(vendor) {
      return vendor === 'openai' ? [{ family: 'GPT mini' }, { family: 'GPT nano' }] : [];
    },
    async listAllFamilies() {
      return [
        { vendor: 'openai', family: 'GPT mini' },
        { vendor: 'openai', family: 'GPT nano' },
        { vendor: 'mistralai', family: 'Mistral OCR' },
      ];
    },
    async insertRun(row) {
      const run = makeEvalRunRow({
        id: `run-${++nextRunId}`,
        ...row,
        status: row.status ?? 'running',
      });
      runs.push(run);
      return run;
    },
    async updateRun(id, patch) {
      const run = runs.find((r) => r.id === id);
      if (!run) throw new Error(`no run ${id}`);
      Object.assign(run, patch);
    },
    async getRun(id) {
      return runs.find((r) => r.id === id) ?? null;
    },
    async insertResults(rows) {
      for (const row of rows) {
        results.push(makeEvalResultRow({ id: `result-${results.length + 1}`, ...row }));
      }
    },
    async listResults(runId) {
      return results.filter((r) => r.run_id === runId);
    },
    async getExperiment(idOrSlug) {
      return idOrSlug === experiment.id || idOrSlug === experiment.slug ? experiment : null;
    },
    async getModelBySlug(slug) {
      return slug === model.slug ? model : null;
    },
    async insertFinding(row: NewEvalFindingRow) {
      throw new Error(`not used by this test: ${row.statement}`);
    },
    async listFindings() {
      return [];
    },
    ...overrides,
  };

  return { store, runs, results };
}

describe('eval-run CLI wiring', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses to start, naming the missing eval_models row, when --models names an unregistered slug (dry run, no model call)', async () => {
    const { store } = makeFakeStore();
    const callLlmFn = vi.fn();

    await expect(
      main({
        argv: ['--set', 'set-1', '--task', 'grading', '--models', 'nobody/not-registered'],
        store,
        callLlmFn,
      }),
    ).rejects.toThrow(ProcessExitError);

    expect(callLlmFn).not.toHaveBeenCalled();
    const errorText = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((args) => args.join(' '))
      .join('\n');
    expect(errorText).toContain('nobody/not-registered');
    expect(errorText).toContain('eval_models');
  });

  it('prints the family rule and the vendor\'s existing families when refusing an unregistered slug', async () => {
    const { store } = makeFakeStore();
    const callLlmFn = vi.fn();

    await expect(
      main({
        argv: ['--set', 'set-1', '--task', 'grading', '--models', 'openai/gpt-6-luna'],
        store,
        callLlmFn,
      }),
    ).rejects.toThrow(ProcessExitError);

    const errorText = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((args) => args.join(' '))
      .join('\n');
    expect(errorText).toContain('never a version number');
    expect(errorText).toContain('Existing openai families: GPT mini, GPT nano.');
  });

  it('reports no existing families for a vendor with none registered yet', async () => {
    const { store } = makeFakeStore();
    const callLlmFn = vi.fn();

    await expect(
      main({
        argv: ['--set', 'set-1', '--task', 'grading', '--models', 'nobody/not-registered'],
        store,
        callLlmFn,
      }),
    ).rejects.toThrow(ProcessExitError);

    const errorText = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((args) => args.join(' '))
      .join('\n');
    expect(errorText).toContain("No eval_model_families rows exist yet for vendor 'nobody'.");
  });

  it('lists all families, not a claimed-empty vendor, when refusing an unmapped direct: slug', async () => {
    const { store } = makeFakeStore();
    const callLlmFn = vi.fn();

    await expect(
      main({
        argv: ['--set', 'set-1', '--task', 'grading', '--models', 'direct:unknown-thing-1'],
        store,
        callLlmFn,
      }),
    ).rejects.toThrow(ProcessExitError);

    const errorText = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((args) => args.join(' '))
      .join('\n');
    expect(errorText).toContain('Could not determine a vendor for one or more slugs.');
    expect(errorText).toContain('openai/GPT mini, openai/GPT nano, mistralai/Mistral OCR');
  });

  it('refuses to start when --experiment names an id/slug with no eval_experiments row', async () => {
    const { store } = makeFakeStore();
    const callLlmFn = vi.fn();

    await expect(
      main({
        argv: ['--set', 'set-1', '--task', 'grading', '--models', 'openai/gpt-4.1-nano', '--experiment', 'nonexistent-experiment'],
        store,
        callLlmFn,
      }),
    ).rejects.toThrow(ProcessExitError);

    expect(callLlmFn).not.toHaveBeenCalled();
  });

  it('refuses to start on an unregistered slug even with --write-db, before any model call or write', async () => {
    const { store, runs, results } = makeFakeStore();
    const callLlmFn = vi.fn();

    await expect(
      main({
        argv: ['--set', 'set-1', '--task', 'grading', '--models', 'nobody/not-registered', '--write-db'],
        store,
        callLlmFn,
      }),
    ).rejects.toThrow(ProcessExitError);

    expect(callLlmFn).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
    expect(results).toHaveLength(0);
  });

  it('refuses to start on an unknown --experiment even with --write-db, before any model call or write', async () => {
    const { store, runs, results } = makeFakeStore();
    const callLlmFn = vi.fn();

    await expect(
      main({
        argv: [
          '--set', 'set-1',
          '--task', 'grading',
          '--models', 'openai/gpt-4.1-nano',
          '--experiment', 'nonexistent-experiment',
          '--write-db',
        ],
        store,
        callLlmFn,
      }),
    ).rejects.toThrow(ProcessExitError);

    expect(callLlmFn).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
    expect(results).toHaveLength(0);
  });

  it('stamps experiment_id/model_version_id and captures served_provider via a stubbed LLM client, with --write-db', async () => {
    const { store, runs, results } = makeFakeStore();
    const stubResult: LlmResult = {
      text: JSON.stringify({ isCorrect: true, score: 95, hasCorrectAccents: true, feedback: 'Correct.', corrections: {} }),
      model: 'openai/gpt-4.1-nano',
      servedModel: 'openai/gpt-4.1-nano',
      servedProvider: 'OpenAI',
      usage: { promptTokens: 100, completionTokens: 20, costUsd: 0.0001, isByok: false },
      raw: {},
    };
    const callLlmFn = vi.fn(async (_options: LlmCallOptions) => stubResult);

    await main({
      argv: [
        '--set', 'set-1',
        '--task', 'grading',
        '--models', 'openai/gpt-4.1-nano',
        '--experiment', 'test-experiment',
        '--write-db',
      ],
      store,
      callLlmFn,
    });

    expect(callLlmFn).toHaveBeenCalledTimes(1);
    expect(runs).toHaveLength(1);
    expect(runs[0].experiment_id).toBe('exp-1');
    expect(runs[0].model_version_id).toBe('model-1');
    expect(runs[0].status).toBe('completed');

    expect(results).toHaveLength(1);
    expect(results[0].served_provider).toBe('OpenAI');
    expect(results[0].served_model).toBe('openai/gpt-4.1-nano');

    // Deliverable 3: every new run's summary carries a top-level primary_metric.
    expect(runs[0].summary?.primary_metric).toBeDefined();
  });

  it('resolves --experiment by its row id, not only its slug', async () => {
    const { store, runs } = makeFakeStore();
    const stubResult: LlmResult = {
      text: JSON.stringify({ isCorrect: true, score: 95, hasCorrectAccents: true, feedback: 'Correct.', corrections: {} }),
      model: 'openai/gpt-4.1-nano',
      raw: {},
    };
    const callLlmFn = vi.fn(async (_options: LlmCallOptions) => stubResult);

    await main({
      argv: [
        '--set', 'set-1',
        '--task', 'grading',
        '--models', 'openai/gpt-4.1-nano',
        '--experiment', 'exp-1',
        '--write-db',
      ],
      store,
      callLlmFn,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0].experiment_id).toBe('exp-1');
  });

  it('leaves experiment_id null on a run made without --experiment', async () => {
    const { store, runs } = makeFakeStore();
    const stubResult: LlmResult = {
      text: JSON.stringify({ isCorrect: true, score: 95, hasCorrectAccents: true, feedback: 'Correct.', corrections: {} }),
      model: 'openai/gpt-4.1-nano',
      raw: {},
    };
    const callLlmFn = vi.fn(async (_options: LlmCallOptions) => stubResult);

    await main({
      argv: ['--set', 'set-1', '--task', 'grading', '--models', 'openai/gpt-4.1-nano', '--write-db'],
      store,
      callLlmFn,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0].experiment_id).toBeNull();
    expect(runs[0].model_version_id).toBe('model-1');
  });

  it('omits primary_metric from the run summary when the task has no reference item to compute it from', async () => {
    const pendingItem = makeEvalItemRow({
      payload: {
        question: 'Comment dit-on "hello"?',
        submitted_answer: 'bonjour',
        correct_answer: 'bonjour',
        type: 'fill-in-blank',
        difficulty: 'easy',
        label_class: 'correct',
      },
    });
    const { store, runs } = makeFakeStore({
      async listItems(setId) {
        return setId === 'set-1' ? [pendingItem] : [];
      },
    });
    const stubResult: LlmResult = {
      text: JSON.stringify({ isCorrect: true, score: 95, hasCorrectAccents: true, feedback: 'Correct.', corrections: {} }),
      model: 'openai/gpt-4.1-nano',
      raw: {},
    };
    const callLlmFn = vi.fn(async (_options: LlmCallOptions) => stubResult);

    await main({
      argv: ['--set', 'set-1', '--task', 'grading', '--models', 'openai/gpt-4.1-nano', '--write-db'],
      store,
      callLlmFn,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0].summary).not.toHaveProperty('primary_metric');
  });
});

describe('eval-run CLI wiring: task audit', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeAuditFakeStore(): { store: EvalStore; runs: EvalRunRow[]; results: EvalResultRow[] } {
    const runs: EvalRunRow[] = [];
    const results: EvalResultRow[] = [];
    let nextRunId = 0;

    const set = makeEvalSetRow({ task: 'audit' });
    const item = makeEvalItemRow({
      item_key: 'q-1',
      payload: {
        question: 'Comment dit-on "hello"?',
        correct_answer: 'bonjour',
        type: 'fill-in-blank',
        difficulty: 'easy',
        topic: 'greetings',
        unit_id: 'unit-1',
        writing_type: null,
        options: null,
        acceptable_variations: null,
      },
      reference: {
        answer_correct: true,
        grammar_correct: true,
        no_hallucination: true,
        question_coherent: true,
        natural_language: true,
        register_appropriate: true,
      },
      reference_status: 'approved',
    });
    const model: EvalModelCurrentRow = {
      id: 'model-1',
      family_id: 'family-1',
      slug: 'mistralai/mistral-large-2512',
      effective_date: '2026-09-25',
      hosts: [],
    };

    const store: EvalStore = {
      ...baseFakeEvalStore(),
      async getSet(id) {
        return id === set.id ? set : null;
      },
      async listItems(setId) {
        return setId === set.id ? [item] : [];
      },
      async latestReviewRound() {
        return null;
      },
      async getModelBySlug(slug) {
        return slug === model.slug ? model : null;
      },
      async insertRun(row) {
        const run = makeEvalRunRow({ id: `run-${++nextRunId}`, ...row, status: row.status ?? 'running' });
        runs.push(run);
        return run;
      },
      async updateRun(id, patch) {
        const run = runs.find((r) => r.id === id);
        if (!run) throw new Error(`no run ${id}`);
        Object.assign(run, patch);
      },
      async insertResults(rows) {
        for (const row of rows) {
          results.push(makeEvalResultRow({ id: `result-${results.length + 1}`, ...row }));
        }
      },
    };

    return { store, runs, results };
  }

  const auditResult: MistralAuditResult = {
    id: 'q-1',
    topic: 'greetings',
    type: 'fill-in-blank',
    writing_type: null,
    generated_by: null,
    question: 'Comment dit-on "hello"?',
    answer: 'bonjour',
    answer_correct: true,
    grammar_correct: true,
    no_hallucination: true,
    question_coherent: true,
    natural_language: true,
    register_appropriate: true,
    difficulty_appropriate: true,
    suggested_difficulty: null,
    variations_valid: true,
    culturally_appropriate: true,
    missing_variations: [],
    invalid_variations: [],
    notes: 'Looks good.',
    severity: 'suggestion',
    usage: { prompt_tokens: 100, completion_tokens: 20, reasoning_tokens: null, cost_usd: 0.0002, is_byok: false },
    served_model: 'mistralai/mistral-large-2512',
    served_provider: 'Mistral',
    echoed_id: 'q-1',
  };

  it('writes a gate-criteria verdict, deterministic checks, and usage for a single-question audit call', async () => {
    const { store, runs, results } = makeAuditFakeStore();
    vi.mocked(callMistralAuditGroup).mockResolvedValue([auditResult]);
    const fetchUnitsFromDbFn = vi.fn(async () => []);

    await main({
      argv: ['--set', 'set-1', '--task', 'audit', '--models', 'mistralai/mistral-large-2512', '--write-db'],
      store,
      callLlmFn: vi.fn(),
      fetchUnitsFromDbFn,
    });

    expect(callMistralAuditGroup).toHaveBeenCalledTimes(1);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');

    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.output).toMatchObject({
      answer_correct: true,
      grammar_correct: true,
      no_hallucination: true,
      question_coherent: true,
      natural_language: true,
      register_appropriate: true,
      notes: 'Looks good.',
      severity: 'suggestion',
      suggested_difficulty: null,
    });
    expect(result.deterministic_checks).toEqual({ id_matched: true, gate_criteria_present: true });
    expect(result.cost_usd).toBe(0.0002);
    expect(result.prompt_tokens).toBe(100);
    expect(result.completion_tokens).toBe(20);
    expect(result.served_model).toBe('mistralai/mistral-large-2512');
    expect(result.served_provider).toBe('Mistral');
    expect(result.error).toBeNull();
  });
});

describe('eval-run CLI wiring: task mapping', () => {
  let dir: string;
  let markdownPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eval-run-mapping-'));
    markdownPath = join(dir, 'unit-1.md');
    writeFileSync(markdownPath, '# Unit 1\n\n## Greetings\n\nContent about greetings.\n\n## Numbers\n\nContent about numbers.\n');

    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeMappingFakeStore(): { store: EvalStore; runs: EvalRunRow[]; results: EvalResultRow[] } {
    const runs: EvalRunRow[] = [];
    const results: EvalResultRow[] = [];
    let nextRunId = 0;

    const set = makeEvalSetRow({ task: 'mapping', selection: { markdownPath } });
    const greetingsItem = makeEvalItemRow({
      id: 'item-greetings',
      item_key: 'item-greetings',
      payload: { topic: 'Greetings' },
      reference: { headings: [{ heading: 'Greetings', slide: null }] },
      reference_status: 'approved',
    });
    const numbersItem = makeEvalItemRow({
      id: 'item-numbers',
      item_key: 'item-numbers',
      payload: { topic: 'Numbers' },
      reference: { headings: [{ heading: 'Numbers', slide: null }] },
      reference_status: 'approved',
    });
    const model: EvalModelCurrentRow = {
      id: 'model-1',
      family_id: 'family-1',
      slug: 'anthropic/claude-haiku-4.5',
      effective_date: '2026-09-25',
      hosts: [],
    };

    const store: EvalStore = {
      ...baseFakeEvalStore(),
      async getSet(id) {
        return id === set.id ? set : null;
      },
      async listItems(setId) {
        return setId === set.id ? [greetingsItem, numbersItem] : [];
      },
      async latestReviewRound() {
        return null;
      },
      async getModelBySlug(slug) {
        return slug === model.slug ? model : null;
      },
      async insertRun(row) {
        const run = makeEvalRunRow({ id: `run-${++nextRunId}`, ...row, status: row.status ?? 'running' });
        runs.push(run);
        return run;
      },
      async updateRun(id, patch) {
        const run = runs.find((r) => r.id === id);
        if (!run) throw new Error(`no run ${id}`);
        Object.assign(run, patch);
      },
      async insertResults(rows) {
        for (const row of rows) {
          results.push(makeEvalResultRow({ id: `result-${results.length + 1}`, ...row }));
        }
      },
    };

    return { store, runs, results };
  }

  it('writes a per-topic heading result and splits one call\'s usage evenly across its topics', async () => {
    const { store, runs, results } = makeMappingFakeStore();
    const stubResult: LlmResult = {
      text: JSON.stringify({
        topics: {
          Greetings: [{ heading: 'Greetings', slide: 1 }],
          Numbers: [{ heading: 'Numbers', slide: 1 }],
        },
      }),
      model: 'anthropic/claude-haiku-4.5',
      servedModel: 'anthropic/claude-haiku-4.5',
      servedProvider: 'Anthropic',
      usage: { promptTokens: 200, completionTokens: 40, costUsd: 0.001, isByok: false },
      raw: {},
    };
    const callLlmFn = vi.fn(async (_options: LlmCallOptions) => stubResult);

    await main({
      argv: ['--set', 'set-1', '--task', 'mapping', '--models', 'anthropic/claude-haiku-4.5', '--write-db'],
      store,
      callLlmFn,
    });

    // One call carries both topics — mapExistingHeadings sends the whole topic list at once.
    expect(callLlmFn).toHaveBeenCalledTimes(1);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');

    expect(results).toHaveLength(2);
    const byItem = new Map(results.map((r) => [r.item_id, r]));
    expect(byItem.get('item-greetings')?.output).toEqual({ headings: [{ heading: 'Greetings', slide: 1 }] });
    expect(byItem.get('item-numbers')?.output).toEqual({ headings: [{ heading: 'Numbers', slide: 1 }] });

    // The one call's usage is divided evenly across its two topics.
    for (const result of results) {
      expect(result.cost_usd).toBeCloseTo(0.0005);
      expect(result.prompt_tokens).toBe(100);
      expect(result.completion_tokens).toBe(20);
      expect(result.served_model).toBe('anthropic/claude-haiku-4.5');
      expect(result.served_provider).toBe('Anthropic');
      expect(result.error).toBeNull();
    }
  });
});

describe('eval-run CLI wiring: task transcription', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeTranscriptionFakeStore(): { store: EvalStore; runs: EvalRunRow[]; results: EvalResultRow[] } {
    const runs: EvalRunRow[] = [];
    const results: EvalResultRow[] = [];
    let nextRunId = 0;

    const set = makeEvalSetRow({ task: 'transcription', selection: { pdfPath: 'unit-1.pdf' } });
    const item = makeEvalItemRow({
      item_key: 'slide-1',
      payload: { slide: 1, text_layer: 'Bonjour tout le monde', category: 'text' },
    });
    const model: EvalModelCurrentRow = {
      id: 'model-1',
      family_id: 'family-1',
      slug: 'google/gemini-2.5-flash',
      effective_date: '2026-09-25',
      hosts: [],
    };

    const store: EvalStore = {
      ...baseFakeEvalStore(),
      async getSet(id) {
        return id === set.id ? set : null;
      },
      async listItems(setId) {
        return setId === set.id ? [item] : [];
      },
      async latestReviewRound() {
        return null;
      },
      async getModelBySlug(slug) {
        return slug === model.slug ? model : null;
      },
      async insertRun(row) {
        const run = makeEvalRunRow({ id: `run-${++nextRunId}`, ...row, status: row.status ?? 'running' });
        runs.push(run);
        return run;
      },
      async updateRun(id, patch) {
        const run = runs.find((r) => r.id === id);
        if (!run) throw new Error(`no run ${id}`);
        Object.assign(run, patch);
      },
      async insertResults(rows) {
        for (const row of rows) {
          results.push(makeEvalResultRow({ id: `result-${results.length + 1}`, ...row }));
        }
      },
    };

    return { store, runs, results };
  }

  it('renders each slide once, then writes the transcript and usage for that slide', async () => {
    const { store, runs, results } = makeTranscriptionFakeStore();
    const stubResult: LlmResult = {
      text: 'Hello everyone',
      model: 'google/gemini-2.5-flash',
      servedModel: 'google/gemini-2.5-flash',
      servedProvider: 'Google AI Studio',
      usage: { promptTokens: 500, completionTokens: 30, costUsd: 0.0003, isByok: false },
      raw: {},
    };
    const callLlmFn = vi.fn(async (_options: LlmCallOptions) => stubResult);

    await main({
      argv: ['--set', 'set-1', '--task', 'transcription', '--models', 'google/gemini-2.5-flash', '--write-db'],
      store,
      callLlmFn,
    });

    expect(renderSlideImage).toHaveBeenCalledTimes(1);
    expect(renderSlideImage).toHaveBeenCalledWith('unit-1.pdf', 1, expect.any(String));
    expect(callLlmFn).toHaveBeenCalledTimes(1);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');

    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.output).toEqual({ markdown: 'Hello everyone' });
    expect(result.cost_usd).toBe(0.0003);
    expect(result.prompt_tokens).toBe(500);
    expect(result.completion_tokens).toBe(30);
    expect(result.served_model).toBe('google/gemini-2.5-flash');
    expect(result.served_provider).toBe('Google AI Studio');
    expect(result.error).toBeNull();
  });
});
