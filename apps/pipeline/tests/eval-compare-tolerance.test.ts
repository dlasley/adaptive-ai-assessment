/**
 * `eval-compare`'s resolution of an experiment's `decision_rule` into the tolerance a comparison is
 * judged against: resolving it from the candidate's own experiment (never the baseline's),
 * refusing only when candidates themselves span more than one experiment with nothing to
 * disambiguate, applying a recognized override, warning (not failing) on an unrecognized key, and
 * reporting prompt_hash/provider_pin agreement per candidate.
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

type RunKey = 'run-baseline' | 'run-candidate' | 'run-candidate-2';

/**
 * One grading set, one approved-reference item (expected correct), a baseline run that got it
 * right, and a candidate run that produced a false negative on it. The task default tolerance
 * (1pp) refuses this candidate outright, so a passing `--decide adopt` only happens when an
 * experiment's `decision_rule` loosens the tolerance enough to cover a 100% false-negative rate on
 * the one reviewed item. `includeSecondCandidate` adds a third run, `run-candidate-2`, that scores
 * correctly (so it never confounds the non-inferiority tests); used only by the multi-experiment
 * refusal test.
 */
function makeFakeStore(params: {
  experiments?: Record<string, EvalExperimentRow>;
  runOverrides?: Partial<Record<RunKey, Partial<EvalRunRow>>>;
  includeSecondCandidate?: boolean;
  /** `served_provider` to stamp on each listed run's result rows (absent means not recorded). */
  servedProviderByRun?: Partial<Record<RunKey, string>>;
} = {}): { store: EvalStore } {
  const { experiments = {}, runOverrides = {}, includeSecondCandidate = false, servedProviderByRun = {} } = params;
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
    ...(includeSecondCandidate
      ? { 'run-candidate-2': makeEvalRunRow({ id: 'run-candidate-2', model: 'candidate-model-2', ...runOverrides['run-candidate-2'] }) }
      : {}),
  };

  const resultsByRunId: Record<string, EvalResultRow[]> = {
    'run-baseline': [makeEvalResultRow({ id: 'r-baseline', run_id: 'run-baseline', item_id: 'item-1', output: { isCorrect: true, score: 100 }, score: 100, served_provider: servedProviderByRun['run-baseline'] ?? null })],
    'run-candidate': [makeEvalResultRow({ id: 'r-candidate', run_id: 'run-candidate', item_id: 'item-1', output: { isCorrect: false, score: 0 }, score: 0, served_provider: servedProviderByRun['run-candidate'] ?? null })],
    ...(includeSecondCandidate
      ? { 'run-candidate-2': [makeEvalResultRow({ id: 'r-candidate-2', run_id: 'run-candidate-2', item_id: 'item-1', output: { isCorrect: true, score: 100 }, score: 100 })] }
      : {}),
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
        decided_via: row.decided_via ?? null,
      };
    },
    async updateExperiment() {},
  };

  return { store };
}

describe('eval-compare: decision_rule tolerance resolution', () => {
  let outDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-compare-tolerance-'));
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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

  it("resolves the decision_rule from the candidate's own experiment, even when the baseline cites a different one", async () => {
    const { store } = makeFakeStore({
      runOverrides: { 'run-baseline': { experiment_id: 'exp-b' }, 'run-candidate': { experiment_id: 'exp-a' } },
      experiments: {
        'exp-a': makeEvalExperimentRow({ id: 'exp-a', slug: 'exp-a', decision_rule: { tolerance: 1 } }),
        'exp-b': makeEvalExperimentRow({ id: 'exp-b', slug: 'exp-b', decision_rule: {} }),
      },
    });
    const outPath = path.join(outDir, 'report.md');
    await main({ argv: argv(['--out', outPath]), store });
    const report = fs.readFileSync(outPath, 'utf-8');
    // exp-a's override applied, not exp-b's (empty) decision_rule: the baseline's experiment never
    // supplies the rule.
    expect(report).toContain("experiment override: tolerance 1 (from experiment 'exp-a')");

    await main({ argv: argv(['--out', outPath, '--write-db', '--decide', 'adopt', '--statement', 'x', '--decided-by', 'jsmith']), store });
  });

  it('refuses when candidates in --runs cite different experiments and nothing disambiguates, naming them', async () => {
    const { store } = makeFakeStore({
      includeSecondCandidate: true,
      runOverrides: { 'run-candidate': { experiment_id: 'exp-a' }, 'run-candidate-2': { experiment_id: 'exp-b' } },
    });
    await expect(
      main({ argv: ['--runs', 'run-baseline,run-candidate,run-candidate-2', '--baseline', 'run-baseline', '--out', path.join(outDir, 'report.md')], store }),
    ).rejects.toThrow(ProcessExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('exp-a'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('exp-b'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--candidate'));
  });

  it('resolves the rule from --candidate when candidates span different experiments', async () => {
    const { store } = makeFakeStore({
      includeSecondCandidate: true,
      runOverrides: { 'run-candidate': { experiment_id: 'exp-a' }, 'run-candidate-2': { experiment_id: 'exp-b' } },
      experiments: {
        'exp-a': makeEvalExperimentRow({ id: 'exp-a', slug: 'exp-a', decision_rule: { tolerance: 1 } }),
        'exp-b': makeEvalExperimentRow({ id: 'exp-b', slug: 'exp-b', decision_rule: {} }),
      },
    });
    const outPath = path.join(outDir, 'report.md');
    await main({
      argv: ['--runs', 'run-baseline,run-candidate,run-candidate-2', '--baseline', 'run-baseline', '--candidate', 'run-candidate', '--out', outPath],
      store,
    });
    const report = fs.readFileSync(outPath, 'utf-8');
    expect(report).toContain("experiment override: tolerance 1 (from experiment 'exp-a')");
  });

  it('warns when an ad hoc candidate with no experiment_id is mixed with one that has one, naming the rule it will be judged by', async () => {
    const { store } = makeFakeStore({
      includeSecondCandidate: true,
      runOverrides: { 'run-candidate': { experiment_id: 'exp-a' } }, // run-candidate-2 keeps the default null experiment_id
      experiments: { 'exp-a': makeEvalExperimentRow({ id: 'exp-a', slug: 'exp-a', decision_rule: {} }) },
    });
    await main({
      argv: ['--runs', 'run-baseline,run-candidate,run-candidate-2', '--baseline', 'run-baseline', '--out', path.join(outDir, 'report.md')],
      store,
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('run-candidate-2'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("exp-a"));
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

  it('prints matching prompt_hash and provider_pin for a candidate that shares both with the baseline', async () => {
    const { store } = makeFakeStore({
      runOverrides: {
        'run-baseline': { prompt_hash: 'hash-1', provider_pin: 'anthropic' },
        'run-candidate': { prompt_hash: 'hash-1', provider_pin: 'Anthropic' },
      },
    });
    const outPath = path.join(outDir, 'report.md');
    await main({ argv: argv(['--out', outPath]), store });
    const report = fs.readFileSync(outPath, 'utf-8');
    expect(report).toContain('prompt_hash matches; provider_pin agrees');
    expect(report).not.toContain('Warning: prompt_hash differs');
    expect(report).not.toContain('Warning: provider_pin differs');
  });

  it('reports served hosts instead of pin agreement when either run is unpinned', async () => {
    const { store } = makeFakeStore({
      runOverrides: {
        'run-baseline': { prompt_hash: 'hash-1', provider_pin: 'anthropic' },
        'run-candidate': { prompt_hash: 'hash-1', provider_pin: null },
      },
      servedProviderByRun: { 'run-baseline': 'Anthropic', 'run-candidate': 'Claude Platform on AWS' },
    });
    const outPath = path.join(outDir, 'report.md');
    await main({ argv: argv(['--out', outPath]), store });
    const report = fs.readFileSync(outPath, 'utf-8');
    expect(report).toContain('candidate unpinned');
    expect(report).toContain('served by anthropic vs. claudeplatformonaws');
    expect(report).toContain('Warning: served hosts differ');
    expect(report).not.toContain('provider_pin agrees');
  });

  it('says served hosts are not recorded when an unpinned run has no served_provider on its results', async () => {
    const { store } = makeFakeStore({
      runOverrides: {
        'run-baseline': { prompt_hash: 'hash-1', provider_pin: null },
        'run-candidate': { prompt_hash: 'hash-1', provider_pin: null },
      },
    });
    const outPath = path.join(outDir, 'report.md');
    await main({ argv: argv(['--out', outPath]), store });
    const report = fs.readFileSync(outPath, 'utf-8');
    expect(report).toContain('both unpinned');
    expect(report).toContain('served hosts not recorded');
    expect(report).not.toContain('provider_pin agrees');
  });

  it('warns when a candidate differs from the baseline on prompt_hash or provider_pin', async () => {
    const { store } = makeFakeStore({
      runOverrides: {
        'run-baseline': { prompt_hash: 'hash-1', provider_pin: 'anthropic' },
        'run-candidate': { prompt_hash: 'hash-2', provider_pin: 'google-ai-studio' },
      },
    });
    const outPath = path.join(outDir, 'report.md');
    await main({ argv: argv(['--out', outPath]), store });
    const report = fs.readFileSync(outPath, 'utf-8');
    expect(report).toContain('prompt_hash differs; provider_pin differs');
    expect(report).toContain('Warning: prompt_hash differs');
    expect(report).toContain('Warning: provider_pin differs');
  });
});
