/**
 * `eval-finding`'s validation refusals, dry-run behaviour, and write path against an injected
 * in-memory `EvalStore`, the same style as `eval-compare-decide.test.ts` exercises `--decide`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/commands/eval-finding';
import type { EvalStore, EvalRunRow, EvalItemRow, EvalExperimentRow, EvalFindingRow, NewEvalFindingRow } from '../src/lib/eval/db';
import { baseFakeEvalStore, makeEvalRunRow, makeEvalItemRow, makeEvalFindingRow } from './helpers/eval-store';

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

function makeFakeStore(
  opts: {
    runs?: EvalRunRow[];
    items?: EvalItemRow[];
    experiments?: EvalExperimentRow[];
    findings?: EvalFindingRow[];
  } = {},
): { store: EvalStore; insertFindingCalls: NewEvalFindingRow[] } {
  const runs = opts.runs ?? [];
  const items = opts.items ?? [];
  const experiments = opts.experiments ?? [];
  const findings = opts.findings ?? [];
  const insertFindingCalls: NewEvalFindingRow[] = [];

  const store: EvalStore = {
    ...baseFakeEvalStore(),
    async getRun(id) {
      return runs.find((r) => r.id === id) ?? null;
    },
    async listItems(setId) {
      return items.filter((i) => i.set_id === setId);
    },
    async getExperiment(idOrSlug) {
      return experiments.find((e) => e.id === idOrSlug || e.slug === idOrSlug) ?? null;
    },
    async getFinding(id) {
      return findings.find((f) => f.id === id) ?? null;
    },
    async insertFinding(row) {
      insertFindingCalls.push(row);
      return {
        id: `finding-${insertFindingCalls.length}`,
        experiment_id: row.experiment_id ?? null,
        kind: row.kind,
        task: row.task ?? null,
        statement: row.statement,
        evidence_note: row.evidence_note ?? null,
        run_ids: row.run_ids ?? [],
        item_ids: row.item_ids ?? [],
        external_refs: row.external_refs ?? [],
        decided_by: row.decided_by ?? null,
        decided_at: '2026-09-30T00:00:00Z',
        supersedes_finding_id: row.supersedes_finding_id ?? null,
        created_at: '2026-09-30T00:00:00Z',
      };
    },
  };

  return { store, insertFindingCalls };
}

describe('eval-finding', () => {
  beforeEach(() => {
    delete process.env.EVAL_DECIDED_BY;
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.EVAL_DECIDED_BY;
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

  it('refuses an empty statement, writing nothing', async () => {
    const { store, insertFindingCalls } = makeFakeStore();
    await expect(main({ argv: ['--statement', '   '], store })).rejects.toThrow(ProcessExitError);
    expect(insertFindingCalls).toHaveLength(0);
  });

  it('refuses a --kind other than observation', async () => {
    const { store, insertFindingCalls } = makeFakeStore();
    await expect(main({ argv: ['--statement', 'x', '--kind', 'adopt'], store })).rejects.toThrow(ProcessExitError);
    expect(insertFindingCalls).toHaveLength(0);
  });

  it('refuses an unresolvable run id, writing nothing', async () => {
    const { store, insertFindingCalls } = makeFakeStore();
    await expect(main({ argv: ['--statement', 'x', '--runs', 'run-missing'], store })).rejects.toThrow(ProcessExitError);
    expect(errorText()).toContain('run-missing');
    expect(insertFindingCalls).toHaveLength(0);
  });

  it('refuses --items without --runs, writing nothing', async () => {
    const { store, insertFindingCalls } = makeFakeStore();
    await expect(main({ argv: ['--statement', 'x', '--items', 'item-1'], store })).rejects.toThrow(ProcessExitError);
    expect(insertFindingCalls).toHaveLength(0);
  });

  it("refuses an item id not in any cited run's set, writing nothing", async () => {
    const run = makeEvalRunRow({ id: 'run-1', set_id: 'set-1' });
    const item = makeEvalItemRow({ id: 'item-1', set_id: 'set-1' });
    const { store, insertFindingCalls } = makeFakeStore({ runs: [run], items: [item] });
    await expect(
      main({ argv: ['--statement', 'x', '--runs', 'run-1', '--items', 'item-missing'], store }),
    ).rejects.toThrow(ProcessExitError);
    expect(errorText()).toContain('item-missing');
    expect(insertFindingCalls).toHaveLength(0);
  });

  it('refuses --write-db with neither --decided-by nor EVAL_DECIDED_BY set, writing nothing', async () => {
    const { store, insertFindingCalls } = makeFakeStore();
    await expect(main({ argv: ['--statement', 'x', '--write-db'], store })).rejects.toThrow(ProcessExitError);
    expect(errorText()).toContain('--decided-by');
    expect(errorText()).toContain('EVAL_DECIDED_BY');
    expect(insertFindingCalls).toHaveLength(0);
  });

  it('allows --write-db when EVAL_DECIDED_BY is set, with no --decided-by flag', async () => {
    const { store, insertFindingCalls } = makeFakeStore();
    process.env.EVAL_DECIDED_BY = 'env-operator';
    await main({ argv: ['--statement', 'x', '--write-db'], store });
    expect(insertFindingCalls).toHaveLength(1);
    expect(insertFindingCalls[0].decided_by).toBe('env-operator');
  });

  it('prefers --decided-by over EVAL_DECIDED_BY when both are given', async () => {
    const { store, insertFindingCalls } = makeFakeStore();
    process.env.EVAL_DECIDED_BY = 'env-operator';
    await main({ argv: ['--statement', 'x', '--write-db', '--decided-by', 'flag-operator'], store });
    expect(insertFindingCalls).toHaveLength(1);
    expect(insertFindingCalls[0].decided_by).toBe('flag-operator');
  });

  it('refuses a --supersedes id that does not exist, writing nothing', async () => {
    const { store, insertFindingCalls } = makeFakeStore();
    await expect(
      main({ argv: ['--statement', 'x', '--supersedes', 'finding-missing'], store }),
    ).rejects.toThrow(ProcessExitError);
    expect(insertFindingCalls).toHaveLength(0);
  });

  it('refuses an unresolvable --experiment, writing nothing', async () => {
    const { store, insertFindingCalls } = makeFakeStore();
    await expect(
      main({ argv: ['--statement', 'x', '--experiment', 'missing-slug'], store }),
    ).rejects.toThrow(ProcessExitError);
    expect(insertFindingCalls).toHaveLength(0);
  });

  it('dry run prints the row it would insert and writes nothing', async () => {
    const { store, insertFindingCalls } = makeFakeStore();
    await main({ argv: ['--statement', 'An observation worth recording.'], store });

    expect(logText()).toContain('Would insert into eval_findings');
    expect(logText()).toContain('An observation worth recording.');
    expect(logText()).toContain('Dry run');
    expect(insertFindingCalls).toHaveLength(0);
  });

  it('inserts exactly one row with the given ids on the happy path', async () => {
    const run = makeEvalRunRow({ id: 'run-1', set_id: 'set-1' });
    const item = makeEvalItemRow({ id: 'item-1', set_id: 'set-1' });
    const experiment: EvalExperimentRow = {
      id: 'exp-1',
      slug: 'my-experiment',
      legacy_code: null,
      question: 'q',
      tasks: ['grading'],
      variants_declared: [],
      decision_rule: {},
      depends_on: [],
      status: 'proposed',
      decided_at: null,
      notes: null,
      created_at: '2026-09-30T00:00:00Z',
      updated_at: '2026-09-30T00:00:00Z',
    };
    const superseded = makeEvalFindingRow({ id: 'finding-old' });
    const { store, insertFindingCalls } = makeFakeStore({
      runs: [run],
      items: [item],
      experiments: [experiment],
      findings: [superseded],
    });

    await main({
      argv: [
        '--statement', 'Models disagree on typos.',
        '--evidence', 'see byDesignLabel',
        '--experiment', 'my-experiment',
        '--task', 'grading',
        '--runs', 'run-1',
        '--items', 'item-1',
        '--supersedes', 'finding-old',
        '--decided-by', 'jsmith',
        '--write-db',
      ],
      store,
    });

    expect(insertFindingCalls).toHaveLength(1);
    expect(insertFindingCalls[0]).toMatchObject({
      kind: 'observation',
      statement: 'Models disagree on typos.',
      evidence_note: 'see byDesignLabel',
      experiment_id: 'exp-1',
      task: 'grading',
      run_ids: ['run-1'],
      item_ids: ['item-1'],
      decided_by: 'jsmith',
      supersedes_finding_id: 'finding-old',
    });
  });
});
