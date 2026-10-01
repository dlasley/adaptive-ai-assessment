/**
 * `eval-experiment-create`'s validation refusals, dry-run output, insert, update, and the
 * variant-drop-with-runs refusal, against an injected in-memory `EvalStore`, the same style as
 * `eval-finding.test.ts` exercises `eval-finding`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/commands/eval-experiment-create';
import type {
  EvalStore,
  EvalExperimentRow,
  EvalModelCurrentRow,
  NewEvalExperimentRow,
  EvalExperimentVariantRunCountRow,
} from '../src/lib/eval/db';
import { baseFakeEvalStore, makeEvalExperimentRow } from './helpers/eval-store';

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

function makeModelRow(overrides: Partial<EvalModelCurrentRow> = {}): EvalModelCurrentRow {
  return {
    id: 'model-1',
    family_id: 'family-1',
    slug: 'anthropic/claude-sonnet-5',
    effective_date: '2026-09-01',
    price_prompt_usd_per_m: '3',
    price_completion_usd_per_m: '15',
    hosts: [],
    reasoning: null,
    ...overrides,
  };
}

function makeFakeStore(
  opts: {
    experiments?: EvalExperimentRow[];
    models?: EvalModelCurrentRow[];
    variantRunCounts?: EvalExperimentVariantRunCountRow[];
  } = {},
): {
  store: EvalStore;
  insertExperimentCalls: NewEvalExperimentRow[];
  updateExperimentCalls: Array<{ id: string; patch: Record<string, unknown> }>;
} {
  const experiments = opts.experiments ?? [];
  const models = opts.models ?? [];
  const variantRunCounts = opts.variantRunCounts ?? [];
  const insertExperimentCalls: NewEvalExperimentRow[] = [];
  const updateExperimentCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];

  const store: EvalStore = {
    ...baseFakeEvalStore(),
    async getExperiment(idOrSlug) {
      return experiments.find((e) => e.id === idOrSlug || e.slug === idOrSlug) ?? null;
    },
    async getModelBySlug(slug) {
      return models.find((m) => m.slug === slug) ?? null;
    },
    async insertExperiment(row) {
      insertExperimentCalls.push(row);
      return {
        id: 'new-exp-1',
        slug: row.slug,
        question: row.question,
        tasks: row.tasks,
        variants_declared: row.variants_declared ?? [],
        decision_rule: row.decision_rule ?? {},
        depends_on: row.depends_on ?? [],
        status: row.status ?? 'proposed',
        decided_at: null,
        notes: row.notes ?? null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      };
    },
    async updateExperiment(id, patch) {
      updateExperimentCalls.push({ id, patch });
    },
    async listDeclaredVariantRunCounts() {
      return variantRunCounts;
    },
  };

  return { store, insertExperimentCalls, updateExperimentCalls };
}

describe('eval-experiment-create', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eval-experiment-create-'));
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function logText(): string {
    return (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((args) => args.join(' '))
      .join('\n');
  }

  function errorText(): string {
    return (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((args) => args.join(' '))
      .join('\n');
  }

  function writeJson(name: string, value: unknown): string {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  }

  function oneVariant(overrides: Partial<{ label: string; model_slug: string; role: string; settings: Record<string, unknown> }> = {}) {
    return {
      label: 'baseline',
      model_slug: 'anthropic/claude-sonnet-5',
      role: 'baseline',
      ...overrides,
    };
  }

  const baseCreateArgs = (variantsPath: string) => [
    '--slug', 'my-experiment',
    '--question', 'Does X hold up?',
    '--tasks', 'transcription',
    '--variants', variantsPath,
  ];

  it('refuses a slug with uppercase letters', async () => {
    const variantsPath = writeJson('variants.json', [oneVariant()]);
    const { store, insertExperimentCalls } = makeFakeStore({ models: [makeModelRow()] });
    await expect(
      main({ argv: ['--slug', 'My-Experiment', '--question', 'q', '--tasks', 'transcription', '--variants', variantsPath], store }),
    ).rejects.toThrow(ProcessExitError);
    expect(insertExperimentCalls).toHaveLength(0);
  });

  it('refuses a slug that already exists', async () => {
    const variantsPath = writeJson('variants.json', [oneVariant()]);
    const existing = makeEvalExperimentRow({ id: 'exp-1', slug: 'my-experiment' });
    const { store, insertExperimentCalls } = makeFakeStore({ experiments: [existing], models: [makeModelRow()] });
    await expect(main({ argv: baseCreateArgs(variantsPath), store })).rejects.toThrow(ProcessExitError);
    expect(errorText()).toContain('my-experiment');
    expect(insertExperimentCalls).toHaveLength(0);
  });

  it('refuses a task outside the task vocabulary', async () => {
    const variantsPath = writeJson('variants.json', [oneVariant()]);
    const { store, insertExperimentCalls } = makeFakeStore({ models: [makeModelRow()] });
    await expect(
      main({ argv: ['--slug', 'my-experiment', '--question', 'q', '--tasks', 'not-a-task', '--variants', variantsPath], store }),
    ).rejects.toThrow(ProcessExitError);
    expect(insertExperimentCalls).toHaveLength(0);
  });

  it('warns but accepts a task with no runner (generation/validation)', async () => {
    const variantsPath = writeJson('variants.json', [oneVariant()]);
    const { store, insertExperimentCalls } = makeFakeStore({ models: [makeModelRow()] });
    await main({ argv: ['--slug', 'my-experiment', '--question', 'q', '--tasks', 'generation', '--variants', variantsPath, '--write-db'], store });
    expect(insertExperimentCalls).toHaveLength(1);
  });

  it('refuses a variant with a role outside the known vocabulary', async () => {
    const variantsPath = writeJson('variants.json', [oneVariant({ role: 'made-up-role' })]);
    const { store, insertExperimentCalls } = makeFakeStore({ models: [makeModelRow()] });
    await expect(main({ argv: baseCreateArgs(variantsPath), store })).rejects.toThrow(ProcessExitError);
    expect(insertExperimentCalls).toHaveLength(0);
  });

  it('refuses duplicate variant labels within the file', async () => {
    const variantsPath = writeJson('variants.json', [oneVariant(), oneVariant()]);
    const { store, insertExperimentCalls } = makeFakeStore({ models: [makeModelRow()] });
    await expect(main({ argv: baseCreateArgs(variantsPath), store })).rejects.toThrow(ProcessExitError);
    expect(errorText()).toContain('duplicate');
    expect(insertExperimentCalls).toHaveLength(0);
  });

  it('refuses a variant naming a model_slug absent from the registry', async () => {
    const variantsPath = writeJson('variants.json', [oneVariant({ model_slug: 'nobody/no-such-model' })]);
    const { store, insertExperimentCalls } = makeFakeStore({ models: [] });
    await expect(main({ argv: baseCreateArgs(variantsPath), store })).rejects.toThrow(ProcessExitError);
    expect(errorText()).toContain('nobody/no-such-model');
    expect(insertExperimentCalls).toHaveLength(0);
  });

  it("allows a variant naming model_slug '*'", async () => {
    const variantsPath = writeJson('variants.json', [oneVariant({ model_slug: '*' })]);
    const { store, insertExperimentCalls } = makeFakeStore({ models: [] });
    await main({ argv: [...baseCreateArgs(variantsPath), '--write-db'], store });
    expect(insertExperimentCalls).toHaveLength(1);
    expect(logText()).toContain("matches any model");
  });

  it('refuses a settings key outside the repeat-identity vocabulary', async () => {
    const variantsPath = writeJson('variants.json', [oneVariant({ settings: { mode: 'sync' } })]);
    const { store, insertExperimentCalls } = makeFakeStore({ models: [makeModelRow()] });
    await expect(main({ argv: baseCreateArgs(variantsPath), store })).rejects.toThrow(ProcessExitError);
    expect(errorText()).toContain('mode');
    expect(insertExperimentCalls).toHaveLength(0);
  });

  it('refuses a renderDpi outside 72 to 400', async () => {
    const variantsPath = writeJson('variants.json', [oneVariant({ settings: { renderDpi: 40 } })]);
    const { store, insertExperimentCalls } = makeFakeStore({ models: [makeModelRow()] });
    await expect(main({ argv: baseCreateArgs(variantsPath), store })).rejects.toThrow(ProcessExitError);
    expect(insertExperimentCalls).toHaveLength(0);
  });

  it('accepts a renderDpi of 200 and an exclusionPass slug or null', async () => {
    const variantsPath = writeJson('variants.json', [
      oneVariant({ label: 'candidate', settings: { renderDpi: 200 } }),
      oneVariant({ label: 'gated', settings: { exclusionPass: 'anthropic/claude-sonnet-5' } }),
      oneVariant({ label: 'ungated', settings: { exclusionPass: null } }),
    ]);
    const { store, insertExperimentCalls } = makeFakeStore({ models: [makeModelRow()] });
    await main({ argv: [...baseCreateArgs(variantsPath), '--write-db'], store });
    expect(insertExperimentCalls).toHaveLength(1);
  });

  it('accepts a provider as a bare pin string or an {order} object', async () => {
    const variantsPath = writeJson('variants.json', [
      oneVariant({ label: 'pinned-string', settings: { provider: 'mistral' } }),
      oneVariant({ label: 'pinned-object', settings: { provider: { order: ['mistral'], allowFallbacks: false } } }),
    ]);
    const { store, insertExperimentCalls } = makeFakeStore({ models: [makeModelRow()] });
    await main({ argv: [...baseCreateArgs(variantsPath), '--write-db'], store });
    expect(insertExperimentCalls).toHaveLength(1);
  });

  it('refuses an unknown decision-rule key', async () => {
    const variantsPath = writeJson('variants.json', [oneVariant()]);
    const rulePath = writeJson('rule.json', { notARecognizedKey: 0.5 });
    const { store, insertExperimentCalls } = makeFakeStore({ models: [makeModelRow()] });
    await expect(
      main({ argv: [...baseCreateArgs(variantsPath), '--decision-rule', rulePath], store }),
    ).rejects.toThrow(ProcessExitError);
    expect(errorText()).toContain('notARecognizedKey');
    expect(insertExperimentCalls).toHaveLength(0);
  });

  it('refuses a decision-rule numeric value outside 0 to 1', async () => {
    const variantsPath = writeJson('variants.json', [oneVariant()]);
    const rulePath = writeJson('rule.json', { tolerance: 1.5 });
    const { store, insertExperimentCalls } = makeFakeStore({ models: [makeModelRow()] });
    await expect(
      main({ argv: [...baseCreateArgs(variantsPath), '--decision-rule', rulePath], store }),
    ).rejects.toThrow(ProcessExitError);
    expect(insertExperimentCalls).toHaveLength(0);
  });

  it('refuses a --depends-on slug that does not exist', async () => {
    const variantsPath = writeJson('variants.json', [oneVariant()]);
    const { store, insertExperimentCalls } = makeFakeStore({ models: [makeModelRow()] });
    await expect(
      main({ argv: [...baseCreateArgs(variantsPath), '--depends-on', 'no-such-experiment'], store }),
    ).rejects.toThrow(ProcessExitError);
    expect(errorText()).toContain('no-such-experiment');
    expect(insertExperimentCalls).toHaveLength(0);
  });

  it('dry run prints the row it would insert and the variant resolution, writing nothing', async () => {
    const variantsPath = writeJson('variants.json', [oneVariant()]);
    const { store, insertExperimentCalls } = makeFakeStore({ models: [makeModelRow()] });
    await main({ argv: baseCreateArgs(variantsPath), store });
    expect(logText()).toContain('Would insert into eval_experiments');
    expect(logText()).toContain('baseline');
    expect(logText()).toContain('eval_models_current row model-1');
    expect(logText()).toContain('Dry run');
    expect(insertExperimentCalls).toHaveLength(0);
  });

  it('inserts exactly one row on --write-db', async () => {
    const variantsPath = writeJson('variants.json', [oneVariant()]);
    const { store, insertExperimentCalls } = makeFakeStore({ models: [makeModelRow()] });
    await main({ argv: [...baseCreateArgs(variantsPath), '--write-db'], store });
    expect(insertExperimentCalls).toHaveLength(1);
    expect(insertExperimentCalls[0]).toMatchObject({
      slug: 'my-experiment',
      question: 'Does X hold up?',
      tasks: ['transcription'],
      status: 'proposed',
    });
    expect(logText()).toContain('Inserted eval_experiments row new-exp-1');
  });

  it("reproduces transcription-render-dpi-200's variants, decision rule and dependency on a dry run", async () => {
    const variantsPath = writeJson('variants.json', [
      { label: 'dpi200:anthropic/claude-sonnet-5', model_slug: 'anthropic/claude-sonnet-5', role: 'candidate', settings: { renderDpi: 200 } },
      { label: 'dpi200:google/gemini-3.1-flash-lite', model_slug: 'google/gemini-3.1-flash-lite', role: 'candidate', settings: { renderDpi: 200 } },
    ]);
    const rulePath = writeJson('rule.json', {
      description: "Paired per slide against the same model's 120 dpi run with no exclusion pass.",
    });
    const dependency = makeEvalExperimentRow({ id: 'exp-dep', slug: 'transcription-cheaper-vision-2026-09' });
    const { store, insertExperimentCalls } = makeFakeStore({
      experiments: [dependency],
      models: [makeModelRow({ slug: 'anthropic/claude-sonnet-5' }), makeModelRow({ id: 'model-2', slug: 'google/gemini-3.1-flash-lite' })],
    });
    await main({
      argv: [
        '--slug', 'transcription-render-dpi-200',
        '--question', 'Does rendering slides at 200 dpi instead of 120 change how completely Sonnet 5 and Gemini 3.1 Flash-Lite transcribe the 30 sampled slides?',
        '--tasks', 'transcription',
        '--variants', variantsPath,
        '--decision-rule', rulePath,
        '--depends-on', 'transcription-cheaper-vision-2026-09',
      ],
      store,
    });
    expect(insertExperimentCalls).toHaveLength(0);
    expect(logText()).toContain('Would insert into eval_experiments');
  });

  it('refuses --slug combined with --update', async () => {
    const { store } = makeFakeStore();
    await expect(
      main({ argv: ['--update', 'my-experiment', '--slug', 'my-experiment', '--notes', 'x'], store }),
    ).rejects.toThrow(ProcessExitError);
  });

  it('refuses --tasks combined with --update', async () => {
    const { store } = makeFakeStore();
    await expect(
      main({ argv: ['--update', 'my-experiment', '--tasks', 'grading'], store }),
    ).rejects.toThrow(ProcessExitError);
  });

  it('refuses --status combined with --update', async () => {
    const { store } = makeFakeStore();
    await expect(
      main({ argv: ['--update', 'my-experiment', '--status', 'running'], store }),
    ).rejects.toThrow(ProcessExitError);
  });

  it('refuses --update naming an experiment that does not exist', async () => {
    const { store, updateExperimentCalls } = makeFakeStore();
    await expect(main({ argv: ['--update', 'no-such-experiment', '--notes', 'x'], store })).rejects.toThrow(ProcessExitError);
    expect(updateExperimentCalls).toHaveLength(0);
  });

  it('refuses --update with no field to change', async () => {
    const existing = makeEvalExperimentRow({ id: 'exp-1', slug: 'my-experiment' });
    const { store, updateExperimentCalls } = makeFakeStore({ experiments: [existing] });
    await expect(main({ argv: ['--update', 'my-experiment'], store })).rejects.toThrow(ProcessExitError);
    expect(updateExperimentCalls).toHaveLength(0);
  });

  it('updates notes on --write-db', async () => {
    const existing = makeEvalExperimentRow({ id: 'exp-1', slug: 'my-experiment' });
    const { store, updateExperimentCalls } = makeFakeStore({ experiments: [existing] });
    await main({ argv: ['--update', 'my-experiment', '--notes', 'revised understanding', '--write-db'], store });
    expect(updateExperimentCalls).toEqual([{ id: 'exp-1', patch: { notes: 'revised understanding' } }]);
    expect(logText()).toContain('Updated eval_experiments exp-1');
  });

  it('refuses dropping a declared variant that already has matching runs', async () => {
    const existing = makeEvalExperimentRow({
      id: 'exp-1',
      slug: 'my-experiment',
      variants_declared: [oneVariant({ label: 'baseline' }), oneVariant({ label: 'candidate' })],
    });
    const variantsPath = writeJson('variants.json', [oneVariant({ label: 'baseline' })]);
    const { store, updateExperimentCalls } = makeFakeStore({
      experiments: [existing],
      models: [makeModelRow()],
      variantRunCounts: [
        { declared_label: 'baseline', run_count: 3 },
        { declared_label: 'candidate', run_count: 2 },
      ],
    });
    await expect(
      main({ argv: ['--update', 'my-experiment', '--variants', variantsPath], store }),
    ).rejects.toThrow(ProcessExitError);
    expect(errorText()).toContain('candidate');
    expect(updateExperimentCalls).toHaveLength(0);
  });

  it('allows dropping a declared variant with zero matching runs', async () => {
    const existing = makeEvalExperimentRow({
      id: 'exp-1',
      slug: 'my-experiment',
      variants_declared: [oneVariant({ label: 'baseline' }), oneVariant({ label: 'candidate' })],
    });
    const variantsPath = writeJson('variants.json', [oneVariant({ label: 'baseline' })]);
    const { store, updateExperimentCalls } = makeFakeStore({
      experiments: [existing],
      models: [makeModelRow()],
      variantRunCounts: [
        { declared_label: 'baseline', run_count: 3 },
        { declared_label: 'candidate', run_count: 0 },
      ],
    });
    await main({ argv: ['--update', 'my-experiment', '--variants', variantsPath, '--write-db'], store });
    expect(updateExperimentCalls).toHaveLength(1);
    expect(updateExperimentCalls[0].patch).toMatchObject({ variants_declared: [oneVariant({ label: 'baseline' })] });
  });
});
