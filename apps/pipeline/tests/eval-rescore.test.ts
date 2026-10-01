/**
 * Round-trip proof that `eval-rescore` and `eval-run` compute a summary through the same code path
 * (`outcomeFromStoredResult`): a rescore of a run just written by `eval-run` must reproduce that
 * run's own summary exactly, and a rescore run before its item's reference existed must fill in
 * what a fresh run would have computed had the reference existed at run time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main as runMain } from '../src/commands/eval-run';
import { main as rescoreMain } from '../src/commands/eval-rescore';
import type { EvalStore, EvalSetRow, EvalItemRow, EvalRunRow, EvalResultRow, EvalModelCurrentRow, EvalExperimentRow } from '../src/lib/eval/db';
import type { LlmCallOptions, LlmResult } from '@adaptive/shared/llm';
import { baseFakeEvalStore, makeEvalSetRow, makeEvalItemRow, makeEvalRunRow, makeEvalResultRow } from './helpers/eval-store';

// renderSlideImage shells out to pdftoppm; the transcription case stubs it with a fixed image
// buffer so it doesn't depend on that binary or a real PDF file, same as eval-run-cli-wiring.test.ts.
vi.mock('../src/lib/pdf-conversion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/pdf-conversion')>();
  return { ...actual, renderSlideImage: vi.fn(() => Buffer.from('fake-slide-image-bytes')) };
});

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe('eval-rescore round trip', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * A minimal in-memory `EvalStore` backing both `eval-run` and `eval-rescore` against the same
   * rows — this is the one test file that runs both commands against one store, so it needs the
   * surface eval-run-cli-wiring.test.ts's own fakes don't: `listResults`/`updateResult` (rescore
   * reads and rewrites results) and `listRunsBySet`/`listRunsByExperiment` (rescore's `--set`/
   * `--experiment` resolution; unused by the `--run`-targeted tests below but implemented for
   * completeness).
   */
  function makeFakeStore(opts: { set: EvalSetRow; items: EvalItemRow[]; model: EvalModelCurrentRow }) {
    const runs: EvalRunRow[] = [];
    const results: EvalResultRow[] = [];
    let nextRunId = 0;
    let nextResultId = 0;

    const store: EvalStore = {
      ...baseFakeEvalStore(),
      async getSet(id) {
        return id === opts.set.id ? opts.set : null;
      },
      async listItems(setId) {
        return setId === opts.set.id ? opts.items : [];
      },
      async latestReviewRound() {
        return null;
      },
      async getModelBySlug(slug) {
        return slug === opts.model.slug ? opts.model : null;
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
      async getRun(id) {
        return runs.find((r) => r.id === id) ?? null;
      },
      async listRunsBySet(setId) {
        return runs.filter((r) => r.set_id === setId);
      },
      async listRunsByExperiment(experimentId) {
        return runs.filter((r) => r.experiment_id === experimentId);
      },
      async insertResults(rows) {
        for (const row of rows) results.push(makeEvalResultRow({ id: `result-${++nextResultId}`, ...row }));
      },
      async listResults(runId) {
        return results.filter((r) => r.run_id === runId);
      },
      async updateResult(id, patch) {
        const result = results.find((r) => r.id === id);
        if (!result) throw new Error(`no result ${id}`);
        Object.assign(result, patch);
      },
    };

    return { store, runs, results };
  }

  it('grading: rescoring a just-completed run reproduces its own summary exactly, apart from scoredAt', async () => {
    const set = makeEvalSetRow({ id: 'set-1', task: 'grading' });
    const item = makeEvalItemRow({
      id: 'item-1',
      set_id: 'set-1',
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
    const model: EvalModelCurrentRow = { id: 'model-1', family_id: 'family-1', slug: 'openai/gpt-4.1-nano', effective_date: '2026-09-25', price_prompt_usd_per_m: '0.1', price_completion_usd_per_m: '0.4', hosts: [], reasoning: null };
    const { store, runs } = makeFakeStore({ set, items: [item], model });

    const stubResult: LlmResult = {
      text: JSON.stringify({ isCorrect: true, score: 95, hasCorrectAccents: true, feedback: 'Correct.', corrections: {} }),
      model: 'openai/gpt-4.1-nano',
      raw: {},
    };
    const callLlmFn = vi.fn(async (_options: LlmCallOptions) => stubResult);

    await runMain({
      argv: ['--set', 'set-1', '--task', 'grading', '--models', 'openai/gpt-4.1-nano', '--write-db'],
      store,
      callLlmFn,
    });

    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.status).toBe('completed');
    const { scoredAt: _runScoredAt, ...summaryAfterRun } = run.summary as Record<string, unknown>;

    await rescoreMain({ argv: ['--run', run.id, '--write-db'], store });

    const { scoredAt: _rescoreScoredAt, ...summaryAfterRescore } = run.summary as Record<string, unknown>;
    expect(summaryAfterRescore).toEqual(summaryAfterRun);
  });

  it('transcription: a run with no reference yet has meanScore undefined; rescoring after the reference is approved fills in every item score and the summary', async () => {
    const set = makeEvalSetRow({ id: 'set-1', task: 'transcription', selection: { pdfPath: 'unit-1.pdf' } });
    const item = makeEvalItemRow({
      id: 'item-1',
      set_id: 'set-1',
      item_key: 'slide-1',
      payload: { slide: 1, text_layer: 'Bonjour tout le monde', category: 'text' },
      // reference_status defaults to 'pending' (makeEvalItemRow) — not yet reviewed at run time.
    });
    const model: EvalModelCurrentRow = { id: 'model-1', family_id: 'family-1', slug: 'google/gemini-2.5-flash', effective_date: '2026-09-25', price_prompt_usd_per_m: '0.1', price_completion_usd_per_m: '0.4', hosts: [], reasoning: null };
    const { store, runs, results } = makeFakeStore({ set, items: [item], model });

    const stubResult: LlmResult = {
      text: 'Bonjour tout le monde',
      model: 'google/gemini-2.5-flash',
      servedModel: 'google/gemini-2.5-flash',
      servedProvider: 'Google AI Studio',
      usage: { promptTokens: 500, completionTokens: 30, costUsd: 0.0003, isByok: false },
      raw: {},
    };
    const callLlmFn = vi.fn(async (_options: LlmCallOptions) => stubResult);

    await runMain({
      argv: ['--set', 'set-1', '--task', 'transcription', '--models', 'google/gemini-2.5-flash', '--write-db'],
      store,
      callLlmFn,
    });

    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect((run.summary as { meanScore?: number }).meanScore).toBeUndefined();
    expect(results[0].score).toBeNull();

    // Approved after the run, the way eval-review-import would write it.
    item.reference = { markdown: 'Bonjour tout le monde' };
    item.reference_status = 'approved';

    await rescoreMain({ argv: ['--run', run.id, '--write-db'], store });

    expect(results[0].score).toBe(1); // exact match against the now-approved reference
    expect((run.summary as { meanScore?: number }).meanScore).toBe(1);
  });
});

describe('eval-rescore CLI validation', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function errorText(): string {
    return (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((args) => args.join(' '))
      .join('\n');
  }

  it('fails with the "exactly one of" message when none of --run, --set, --experiment are given', async () => {
    await expect(rescoreMain({ argv: [], store: baseFakeEvalStore() })).rejects.toThrow(ProcessExitError);

    expect(errorText()).toContain('exactly one of --run, --set, or --experiment');
  });

  it('fails with the "exactly one of" message when both --run and --set are given', async () => {
    await expect(
      rescoreMain({ argv: ['--run', 'run-1', '--set', 'set-1'], store: baseFakeEvalStore() }),
    ).rejects.toThrow(ProcessExitError);

    expect(errorText()).toContain('exactly one of --run, --set, or --experiment');
  });
});

describe('eval-rescore skip, refuse, and resolution rules', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * A bare-bones in-memory `EvalStore` for the resolution/skip/refuse paths below: `updateResult`
   * and `updateRun` are `vi.fn()` write-spies asserted on directly, and every read method filters
   * the given fixture rows the way the real Supabase-backed store's own queries would.
   */
  function makeStore(opts: {
    sets?: EvalSetRow[];
    items?: EvalItemRow[];
    runs?: EvalRunRow[];
    results?: EvalResultRow[];
    experiments?: EvalExperimentRow[];
  }) {
    const sets = opts.sets ?? [];
    const items = opts.items ?? [];
    const runs = opts.runs ?? [];
    const results = opts.results ?? [];
    const experiments = opts.experiments ?? [];

    const updateResult = vi.fn(async (id: string, patch: Partial<Pick<EvalResultRow, 'score'>>) => {
      const result = results.find((r) => r.id === id);
      if (result) Object.assign(result, patch);
    });
    const updateRun = vi.fn(async (id: string, patch: Partial<EvalRunRow>) => {
      const run = runs.find((r) => r.id === id);
      if (run) Object.assign(run, patch);
    });

    const store: EvalStore = {
      ...baseFakeEvalStore(),
      async getRun(id) {
        return runs.find((r) => r.id === id) ?? null;
      },
      async getSet(id) {
        return sets.find((s) => s.id === id) ?? null;
      },
      async listItems(setId) {
        return items.filter((i) => i.set_id === setId);
      },
      async listResults(runId) {
        return results.filter((r) => r.run_id === runId);
      },
      async latestReviewRound() {
        return null;
      },
      async listRunsBySet(setId) {
        return runs.filter((r) => r.set_id === setId);
      },
      async listRunsByExperiment(experimentId) {
        return runs.filter((r) => r.experiment_id === experimentId);
      },
      async getExperiment(idOrSlug) {
        return experiments.find((e) => e.id === idOrSlug || e.slug === idOrSlug) ?? null;
      },
      updateResult,
      updateRun,
    };

    return { store, updateResult, updateRun };
  }

  function logText(): string {
    return (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((args) => args.join(' '))
      .join('\n');
  }

  it('skips a run whose status is not completed, writing nothing', async () => {
    const run = makeEvalRunRow({ id: 'run-1', set_id: 'set-1', task: 'transcription', status: 'running' });
    const { store, updateResult, updateRun } = makeStore({ runs: [run] });

    await rescoreMain({ argv: ['--run', 'run-1', '--write-db'], store });

    expect(logText()).toContain("skipped (status is 'running'");
    expect(updateResult).not.toHaveBeenCalled();
    expect(updateRun).not.toHaveBeenCalled();
  });

  it('refuses a run whose set has zero items, writing nothing', async () => {
    const run = makeEvalRunRow({ id: 'run-1', set_id: 'set-1', task: 'transcription', status: 'completed' });
    const { store, updateResult, updateRun } = makeStore({ runs: [run], items: [] });

    await rescoreMain({ argv: ['--run', 'run-1', '--write-db'], store });

    expect(logText()).toContain('refused');
    expect(logText()).toContain('has no items');
    expect(updateResult).not.toHaveBeenCalled();
    expect(updateRun).not.toHaveBeenCalled();
  });

  it('refuses a run with zero eval_results rows, writing nothing', async () => {
    const run = makeEvalRunRow({ id: 'run-1', set_id: 'set-1', task: 'transcription', status: 'completed' });
    const item = makeEvalItemRow({ id: 'item-1', set_id: 'set-1' });
    const { store, updateResult, updateRun } = makeStore({ runs: [run], items: [item], results: [] });

    await rescoreMain({ argv: ['--run', 'run-1', '--write-db'], store });

    expect(logText()).toContain('refused');
    expect(logText()).toContain('no eval_results rows');
    expect(updateResult).not.toHaveBeenCalled();
    expect(updateRun).not.toHaveBeenCalled();
  });

  it('refuses a run with a result whose item_id is not in the set, writing nothing', async () => {
    const run = makeEvalRunRow({ id: 'run-1', set_id: 'set-1', task: 'transcription', status: 'completed' });
    const item = makeEvalItemRow({ id: 'item-1', set_id: 'set-1' });
    const orphanResult = makeEvalResultRow({ id: 'result-1', run_id: 'run-1', item_id: 'item-missing' });
    const { store, updateResult, updateRun } = makeStore({ runs: [run], items: [item], results: [orphanResult] });

    await rescoreMain({ argv: ['--run', 'run-1', '--write-db'], store });

    expect(logText()).toContain('refused');
    expect(logText()).toContain('reference items not in set');
    expect(updateResult).not.toHaveBeenCalled();
    expect(updateRun).not.toHaveBeenCalled();
  });

  it('dry run on a rescorable transcription run prints the before/after line and writes nothing', async () => {
    const run = makeEvalRunRow({ id: 'run-1', set_id: 'set-1', task: 'transcription', status: 'completed', summary: null });
    const item = makeEvalItemRow({
      id: 'item-1',
      set_id: 'set-1',
      item_key: 'slide-1',
      payload: { slide: 1, text_layer: 'Bonjour tout le monde', category: 'text' },
      reference: { markdown: 'Bonjour tout le monde' },
      reference_status: 'approved',
    });
    const result = makeEvalResultRow({
      id: 'result-1',
      run_id: 'run-1',
      item_id: 'item-1',
      output: { markdown: 'Bonjour tout le monde' },
      score: null, // stored before the reference was approved
    });
    const { store, updateResult, updateRun } = makeStore({ runs: [run], items: [item], results: [result] });

    await rescoreMain({ argv: ['--run', 'run-1'], store }); // no --write-db

    expect(logText()).toContain('primary_metric');
    expect(logText()).toContain('item score(s) would change');
    expect(updateResult).not.toHaveBeenCalled();
    expect(updateRun).not.toHaveBeenCalled();
  });

  it('resolves every run for a set through listRunsBySet and processes each', async () => {
    const set = makeEvalSetRow({ id: 'set-1' });
    const runA = makeEvalRunRow({ id: 'run-a', set_id: 'set-1', status: 'running' });
    const runB = makeEvalRunRow({ id: 'run-b', set_id: 'set-1', status: 'failed' });
    const { store, updateResult, updateRun } = makeStore({ sets: [set], runs: [runA, runB] });
    const listRunsBySetSpy = vi.spyOn(store, 'listRunsBySet');

    await rescoreMain({ argv: ['--set', 'set-1'], store });

    expect(listRunsBySetSpy).toHaveBeenCalledWith('set-1');
    expect(logText()).toContain('run-a');
    expect(logText()).toContain('run-b');
    expect(updateResult).not.toHaveBeenCalled();
    expect(updateRun).not.toHaveBeenCalled();
  });

  it('resolves an experiment through getExperiment, then every run through listRunsByExperiment', async () => {
    const experiment: EvalExperimentRow = {
      id: 'exp-1',
      slug: 'test-experiment',
      question: 'Does the candidate model transcribe as well as baseline?',
      tasks: ['transcription'],
      variants_declared: [],
      decision_rule: {},
      depends_on: [],
      status: 'proposed',
      decided_at: null,
      notes: null,
      created_at: '2026-09-29T00:00:00Z',
      updated_at: '2026-09-29T00:00:00Z',
    };
    const runA = makeEvalRunRow({ id: 'run-a', experiment_id: 'exp-1', status: 'running' });
    const runB = makeEvalRunRow({ id: 'run-b', experiment_id: 'exp-1', status: 'failed' });
    const { store, updateResult, updateRun } = makeStore({ experiments: [experiment], runs: [runA, runB] });
    const getExperimentSpy = vi.spyOn(store, 'getExperiment');
    const listRunsByExperimentSpy = vi.spyOn(store, 'listRunsByExperiment');

    await rescoreMain({ argv: ['--experiment', 'test-experiment'], store });

    expect(getExperimentSpy).toHaveBeenCalledWith('test-experiment');
    expect(listRunsByExperimentSpy).toHaveBeenCalledWith('exp-1');
    expect(logText()).toContain('run-a');
    expect(logText()).toContain('run-b');
    expect(updateResult).not.toHaveBeenCalled();
    expect(updateRun).not.toHaveBeenCalled();
  });
});
