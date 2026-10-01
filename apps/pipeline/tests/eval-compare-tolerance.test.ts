/**
 * `eval-compare`'s resolution of an experiment's `decision_rule` into the tolerance a comparison is
 * judged against: refusing a mixed-experiment `--runs`, applying a recognized override, and
 * warning (not failing) on an unrecognized key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/commands/eval-compare';
import type { EvalStore, EvalRunRow, EvalResultRow, EvalExperimentRow } from '../src/lib/eval/db';
import { baseFakeEvalStore, makeEvalSetRow, makeEvalItemRow, makeEvalRunRow, makeEvalResultRow, makeEvalExperimentRow } from './helpers/eval-store';

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

/**
 * One grading set, one approved-reference item (expected correct), a baseline run that got it
 * right, and a candidate run that produced a false negative on it. The task default tolerance
 * (1pp) refuses this candidate outright, so a passing `--decide adopt` only happens when an
 * experiment's `decision_rule` loosens the tolerance enough to cover a 100% false-negative rate on
 * the one reviewed item.
 */
function makeFakeStore(params: {
  experiments?: Record<string, EvalExperimentRow>;
  runOverrides?: Partial<Record<'run-baseline' | 'run-candidate', Partial<EvalRunRow>>>;
} = {}): { store: EvalStore } {
  const { experiments = {}, runOverrides = {} } = params;
  const set = makeEvalSetRow();
  const item = makeEvalItemRow({
    payload: { question: 'q', submitted_answer: 'a', correct_answer: 'a', type: 'fill-in-blank', difficulty: 'easy', label_class: 'correct' },
    reference: { isCorrect: true, borderline: false, reason: null, keyCorrect: true, keyNote: null },
    reference_status: 'approved',
    reviewed_by: 'reviewer', reviewed_at: '2026-09-30T00:00:00Z',
  });

  const runsById: Record<string, EvalRunRow> = {
    'run-baseline': makeEvalRunRow({ id: 'run-baseline', model: 'baseline-model', ...runOverrides['run-baseline'] }),
    'run-candidate': makeEvalRunRow({ id: 'run-candidate', model: 'candidate-model', ...runOverrides['run-candidate'] }),
  };

  const resultsByRunId: Record<string, EvalResultRow[]> = {
    'run-baseline': [makeEvalResultRow({ id: 'r-baseline', run_id: 'run-baseline', item_id: 'item-1', output: { isCorrect: true, score: 100 }, score: 100 })],
    'run-candidate': [makeEvalResultRow({ id: 'r-candidate', run_id: 'run-candidate', item_id: 'item-1', output: { isCorrect: false, score: 0 }, score: 0 })],
  };

  const store: EvalStore = {
    ...baseFakeEvalStore(),
    async getSet(id) { return id === set.id ? set : null; },
    async listItems(setId) { return setId === set.id ? [item] : []; },
    async updateRun() {},
    async getRun(id) { return runsById[id] ?? null; },
    async listResults(runId) { return resultsByRunId[runId] ?? []; },
    async getExperiment(idOrSlug) { return experiments[idOrSlug] ?? null; },
    async listFindings() { return []; },
    async insertFinding(row) {
      return {
        id: 'finding-1', experiment_id: row.experiment_id ?? null, kind: row.kind, task: row.task ?? null,
        statement: row.statement, evidence_note: row.evidence_note ?? null, run_ids: row.run_ids ?? [],
        item_ids: row.item_ids ?? [], external_refs: row.external_refs ?? [], decided_by: row.decided_by ?? null,
        decided_at: '2026-09-30T00:00:00Z', supersedes_finding_id: row.supersedes_finding_id ?? null, created_at: '2026-09-30T00:00:00Z',
      };
    },
    async updateExperiment() {},
  };

  return { store };
}

describe('eval-compare: decision_rule tolerance resolution', () => {
  let outDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-compare-tolerance-'));
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  function argv(extra: string[] = []): string[] {
    return ['--runs', 'run-baseline,run-candidate', '--baseline', 'run-baseline', '--out', path.join(outDir, 'report.md'), ...extra];
  }

  it('refuses --runs whose candidates cite different experiments', async () => {
    const { store } = makeFakeStore({
      runOverrides: { 'run-candidate': { experiment_id: 'exp-a' } },
    });
    // run-baseline carries experiment_id 'exp-b' here, run-candidate 'exp-a': two distinct ids.
    const mixedStore: EvalStore = { ...store, async getRun(id) {
      const base = await store.getRun(id);
      if (!base) return null;
      return id === 'run-baseline' ? { ...base, experiment_id: 'exp-b' } : base;
    } };
    await expect(main({ argv: argv(), store: mixedStore })).rejects.toThrow(ProcessExitError);
  });

  it('reports the task default and refuses --decide adopt when no experiment overrides the tolerance', async () => {
    const { store } = makeFakeStore({
      runOverrides: { 'run-candidate': { experiment_id: 'exp-1' } },
      experiments: { 'exp-1': makeEvalExperimentRow({ id: 'exp-1', slug: 'exp-1', decision_rule: {} }) },
    });
    const outPath = path.join(outDir, 'report.md');
    await main({ argv: argv(['--out', outPath]), store });
    const report = fs.readFileSync(outPath, 'utf-8');
    expect(report).toContain('Tolerance: task default');

    await expect(
      main({ argv: argv(['--out', outPath, '--write-db', '--decide', 'adopt', '--statement', 'x', '--decided-by', 'jsmith']), store }),
    ).rejects.toThrow(ProcessExitError);
  });

  it('applies a recognized decision_rule override, naming it in the report and letting --decide adopt pass', async () => {
    const { store } = makeFakeStore({
      runOverrides: { 'run-candidate': { experiment_id: 'exp-1' } },
      experiments: { 'exp-1': makeEvalExperimentRow({ id: 'exp-1', slug: 'exp-1', decision_rule: { tolerance: 1 } }) },
    });
    const outPath = path.join(outDir, 'report.md');
    await main({ argv: argv(['--out', outPath]), store });
    const report = fs.readFileSync(outPath, 'utf-8');
    expect(report).toContain('experiment override: tolerance 1');

    await main({ argv: argv(['--out', outPath, '--write-db', '--decide', 'adopt', '--statement', 'x', '--decided-by', 'jsmith']), store });
  });

  it('warns about an unrecognized decision_rule key and otherwise ignores it', async () => {
    const { store } = makeFakeStore({
      runOverrides: { 'run-candidate': { experiment_id: 'exp-1' } },
      experiments: { 'exp-1': makeEvalExperimentRow({ id: 'exp-1', slug: 'exp-1', decision_rule: { toleranceTypo: 1 } }) },
    });
    await main({ argv: argv(), store });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('toleranceTypo'));

    await expect(
      main({ argv: argv(['--write-db', '--decide', 'adopt', '--statement', 'x', '--decided-by', 'jsmith']), store }),
    ).rejects.toThrow(ProcessExitError);
  });
});
