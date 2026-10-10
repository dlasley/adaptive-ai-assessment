/**
 * `eval-finding`'s validation refusals, dry-run behaviour, and write path against an injected
 * in-memory `EvalStore`, the same style as `eval-compare-decide.test.ts` exercises `--decide`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/commands/eval-finding';
import type { EvalStore, EvalRunRow, EvalItemRow, EvalExperimentRow, EvalFindingRow, NewEvalFindingRow } from '../src/lib/eval/db';
import { baseFakeEvalStore, makeEvalRunRow, makeEvalItemRow, makeEvalFindingRow, makeEvalExperimentRow } from './helpers/eval-store';

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
): { store: EvalStore; insertFindingCalls: NewEvalFindingRow[]; updateExperimentCalls: Array<{ id: string; patch: Record<string, unknown> }> } {
  const runs = opts.runs ?? [];
  const items = opts.items ?? [];
  const experiments = opts.experiments ?? [];
  const findings = opts.findings ?? [];
  const insertFindingCalls: NewEvalFindingRow[] = [];
  const updateExperimentCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];

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
    async listFindings(experimentId) {
      return findings.filter((f) => f.experiment_id === experimentId);
    },
    async updateExperiment(id, patch) {
      updateExperimentCalls.push({ id, patch });
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
        decided_via: row.decided_via ?? null,
      };
    },
  };

  return { store, insertFindingCalls, updateExperimentCalls };
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

  function warnText(): string {
    return (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
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
      decided_via: null,
    });
  });

  describe('--decide', () => {
    const run = makeEvalRunRow({ id: 'run-1', set_id: 'set-1' });
    const experiment = makeEvalExperimentRow({ id: 'exp-1', slug: 'my-experiment' });
    const successor = makeEvalExperimentRow({ id: 'exp-2', slug: 'my-experiment-v2' });

    function decideStore(
      opts: { experiments?: typeof experiment[]; findings?: EvalFindingRow[] } = {},
    ) {
      return makeFakeStore({
        runs: [run],
        experiments: opts.experiments ?? [experiment, successor],
        findings: opts.findings ?? [],
      });
    }

    function decideArgv(extra: string[]): string[] {
      return ['--statement', 'A decision.', '--experiment', 'my-experiment', '--runs', 'run-1', '--decided-by', 'jsmith', ...extra];
    }

    it('refuses --decide without --write-db, writing nothing', async () => {
      const { store, insertFindingCalls, updateExperimentCalls } = decideStore();
      await expect(main({ argv: decideArgv(['--decide', 'adopt']), store })).rejects.toThrow(ProcessExitError);
      expect(errorText()).toContain('--write-db');
      expect(insertFindingCalls).toHaveLength(0);
      expect(updateExperimentCalls).toHaveLength(0);
    });

    it('refuses --decide without --experiment, writing nothing', async () => {
      const { store, insertFindingCalls, updateExperimentCalls } = decideStore();
      await expect(
        main({ argv: ['--statement', 'x', '--runs', 'run-1', '--decided-by', 'jsmith', '--decide', 'adopt', '--write-db'], store }),
      ).rejects.toThrow(ProcessExitError);
      expect(errorText()).toContain('--experiment');
      expect(insertFindingCalls).toHaveLength(0);
      expect(updateExperimentCalls).toHaveLength(0);
    });

    it('refuses --decide with neither --decided-by nor EVAL_DECIDED_BY set, writing nothing', async () => {
      const { store, insertFindingCalls, updateExperimentCalls } = decideStore();
      await expect(
        main({ argv: ['--statement', 'x', '--experiment', 'my-experiment', '--runs', 'run-1', '--decide', 'adopt', '--write-db'], store }),
      ).rejects.toThrow(ProcessExitError);
      expect(errorText()).toContain('--decided-by');
      expect(errorText()).toContain('EVAL_DECIDED_BY');
      expect(insertFindingCalls).toHaveLength(0);
      expect(updateExperimentCalls).toHaveLength(0);
    });

    it('refuses --decide citing neither --runs nor --items, writing nothing', async () => {
      const { store, insertFindingCalls, updateExperimentCalls } = decideStore();
      await expect(
        main({ argv: ['--statement', 'x', '--experiment', 'my-experiment', '--decided-by', 'jsmith', '--decide', 'defer', '--write-db'], store }),
      ).rejects.toThrow(ProcessExitError);
      expect(errorText()).toContain('--runs');
      expect(insertFindingCalls).toHaveLength(0);
      expect(updateExperimentCalls).toHaveLength(0);
    });

    it('refuses --superseded-by without --decide supersede, writing nothing', async () => {
      const { store, insertFindingCalls, updateExperimentCalls } = decideStore();
      await expect(
        main({ argv: decideArgv(['--decide', 'adopt', '--superseded-by', 'my-experiment-v2', '--write-db']), store }),
      ).rejects.toThrow(ProcessExitError);
      expect(errorText()).toContain('--superseded-by');
      expect(insertFindingCalls).toHaveLength(0);
      expect(updateExperimentCalls).toHaveLength(0);
    });

    it('refuses --decide supersede without --superseded-by, writing nothing', async () => {
      const { store, insertFindingCalls, updateExperimentCalls } = decideStore();
      await expect(
        main({ argv: decideArgv(['--decide', 'supersede', '--write-db']), store }),
      ).rejects.toThrow(ProcessExitError);
      expect(errorText()).toContain('--superseded-by');
      expect(insertFindingCalls).toHaveLength(0);
      expect(updateExperimentCalls).toHaveLength(0);
    });

    it('refuses a --superseded-by slug no experiment carries, writing nothing', async () => {
      const { store, insertFindingCalls, updateExperimentCalls } = decideStore({ experiments: [experiment] });
      await expect(
        main({ argv: decideArgv(['--decide', 'supersede', '--superseded-by', 'my-experiment-v2', '--write-db']), store }),
      ).rejects.toThrow(ProcessExitError);
      expect(errorText()).toContain('my-experiment-v2');
      expect(insertFindingCalls).toHaveLength(0);
      expect(updateExperimentCalls).toHaveLength(0);
    });

    it('refuses --superseded-by naming the experiment being superseded, writing nothing', async () => {
      const { store, insertFindingCalls, updateExperimentCalls } = decideStore();
      await expect(
        main({ argv: decideArgv(['--decide', 'supersede', '--superseded-by', 'my-experiment', '--write-db']), store }),
      ).rejects.toThrow(ProcessExitError);
      expect(errorText()).toContain('different experiment');
      expect(insertFindingCalls).toHaveLength(0);
      expect(updateExperimentCalls).toHaveLength(0);
    });

    it('refuses deciding an experiment that is already decided without --supersedes, naming its standing decision', async () => {
      const decided = makeEvalExperimentRow({ id: 'exp-1', slug: 'my-experiment', status: 'decided' });
      const standing = makeEvalFindingRow({ id: 'finding-standing', experiment_id: 'exp-1', kind: 'adopt' });
      const { store, insertFindingCalls, updateExperimentCalls } = decideStore({
        experiments: [decided, successor],
        findings: [standing],
      });
      await expect(main({ argv: decideArgv(['--decide', 'reject', '--write-db']), store })).rejects.toThrow(ProcessExitError);
      expect(errorText()).toContain('already decided');
      expect(errorText()).toContain('finding-standing');
      expect(insertFindingCalls).toHaveLength(0);
      expect(updateExperimentCalls).toHaveLength(0);
    });

    it('allows re-deciding when --supersedes names the standing decision', async () => {
      const decided = makeEvalExperimentRow({ id: 'exp-1', slug: 'my-experiment', status: 'decided' });
      const standing = makeEvalFindingRow({ id: 'finding-standing', experiment_id: 'exp-1', kind: 'adopt' });
      const { store, insertFindingCalls, updateExperimentCalls } = decideStore({
        experiments: [decided, successor],
        findings: [standing],
      });
      await main({ argv: decideArgv(['--decide', 'reject', '--supersedes', 'finding-standing', '--write-db']), store });
      expect(insertFindingCalls).toHaveLength(1);
      expect(insertFindingCalls[0]).toMatchObject({ kind: 'reject', supersedes_finding_id: 'finding-standing', decided_via: 'eval-finding' });
      expect(updateExperimentCalls).toEqual([{ id: 'exp-1', patch: expect.objectContaining({ status: 'decided' }) }]);
    });

    it('re-derives the status with a warning, and no --supersedes, when a plain observation superseded the standing decision', async () => {
      const decided = makeEvalExperimentRow({ id: 'exp-1', slug: 'my-experiment', status: 'decided' });
      const earlierDecision = makeEvalFindingRow({ id: 'finding-old', experiment_id: 'exp-1', kind: 'adopt' });
      const supersedingObservation = makeEvalFindingRow({
        id: 'finding-observation',
        experiment_id: 'exp-1',
        kind: 'observation',
        supersedes_finding_id: 'finding-old',
      });
      const { store, insertFindingCalls, updateExperimentCalls } = decideStore({
        experiments: [decided, successor],
        findings: [earlierDecision, supersedingObservation],
      });

      await main({ argv: decideArgv(['--decide', 'reject', '--write-db']), store });

      expect(warnText()).toContain('re-derived');
      expect(insertFindingCalls).toHaveLength(1);
      expect(insertFindingCalls[0]).toMatchObject({ kind: 'reject', supersedes_finding_id: undefined });
      expect(updateExperimentCalls).toEqual([{ id: 'exp-1', patch: expect.objectContaining({ status: 'decided' }) }]);
    });

    it.each([
      ['adopt', 'decided'],
      ['reject', 'decided'],
      ['defer', 'deferred'],
    ])('--decide %s inserts a %s finding of that kind and moves the experiment', async (decide, status) => {
      const { store, insertFindingCalls, updateExperimentCalls } = decideStore();
      await main({ argv: decideArgv(['--decide', decide, '--write-db']), store });

      expect(insertFindingCalls).toHaveLength(1);
      expect(insertFindingCalls[0]).toMatchObject({
        kind: decide,
        experiment_id: 'exp-1',
        run_ids: ['run-1'],
        decided_by: 'jsmith',
        external_refs: [],
        decided_via: 'eval-finding',
      });
      expect(updateExperimentCalls).toHaveLength(1);
      expect(updateExperimentCalls[0].id).toBe('exp-1');
      expect(updateExperimentCalls[0].patch.status).toBe(status);
      expect(updateExperimentCalls[0].patch.decided_at).toEqual(expect.any(String));
    });

    it('--decide supersede inserts an observation naming the successor and moves the experiment to superseded', async () => {
      const { store, insertFindingCalls, updateExperimentCalls } = decideStore();
      await main({ argv: decideArgv(['--decide', 'supersede', '--superseded-by', 'my-experiment-v2', '--write-db']), store });

      expect(insertFindingCalls).toHaveLength(1);
      expect(insertFindingCalls[0]).toMatchObject({
        kind: 'observation',
        experiment_id: 'exp-1',
        external_refs: ['experiment:my-experiment-v2'],
        decided_via: 'eval-finding',
      });
      expect(updateExperimentCalls).toEqual([{ id: 'exp-1', patch: expect.objectContaining({ status: 'superseded' }) }]);
    });

    it('treats the observation a supersede wrote as the standing decision of a superseded experiment', async () => {
      const superseded = makeEvalExperimentRow({ id: 'exp-1', slug: 'my-experiment', status: 'superseded' });
      const standing = makeEvalFindingRow({
        id: 'finding-supersede',
        experiment_id: 'exp-1',
        kind: 'observation',
        external_refs: ['experiment:my-experiment-v2'],
      });
      const { store, insertFindingCalls, updateExperimentCalls } = decideStore({
        experiments: [superseded, successor],
        findings: [standing],
      });
      await expect(main({ argv: decideArgv(['--decide', 'adopt', '--write-db']), store })).rejects.toThrow(ProcessExitError);
      expect(errorText()).toContain('finding-supersede');
      expect(insertFindingCalls).toHaveLength(0);
      expect(updateExperimentCalls).toHaveLength(0);
    });
  });
});
