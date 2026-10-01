import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/commands/eval-compare';
import type { EvalStore, EvalRunRow, EvalResultRow, EvalFindingRow, NewEvalFindingRow } from '../src/lib/eval/db';
import { baseFakeEvalStore, makeEvalSetRow, makeEvalItemRow, makeEvalRunRow, makeEvalResultRow, makeEvalExperimentRow } from './helpers/eval-store';

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

/**
 * One grading set, one approved-reference item, a baseline run, and two candidate runs (one whose
 * output agrees with the baseline — non-inferior — one that doesn't) — enough to exercise every
 * `--decide` refusal and happy path without a live Supabase connection. `findings` seeds
 * `listFindings`'s return so the "already decided" conflict path is testable; `overrides` replaces
 * individual store methods per test.
 */
function makeFakeStore(params: {
  candidateExperimentId?: string | null;
  findings?: EvalFindingRow[];
  overrides?: Partial<EvalStore>;
} = {}): {
  store: EvalStore;
  insertFindingCalls: NewEvalFindingRow[];
  updateExperimentCalls: Array<{ id: string; patch: Record<string, unknown> }>;
} {
  const { candidateExperimentId = 'exp-1', findings = [], overrides = {} } = params;

  const set = makeEvalSetRow();

  const item = makeEvalItemRow({
    payload: { question: 'q', submitted_answer: 'a', correct_answer: 'a', type: 'fill-in-blank', difficulty: 'easy', label_class: 'correct' },
    reference: { isCorrect: true, borderline: false, reason: null, keyCorrect: true, keyNote: null },
    reference_status: 'approved',
    reviewed_by: 'reviewer', reviewed_at: '2026-09-29T00:00:00Z',
  });

  const runsById: Record<string, EvalRunRow> = {
    'run-baseline': makeEvalRunRow({ id: 'run-baseline', model: 'baseline-model' }),
    // Agrees with the baseline exactly — a non-inferior verdict.
    'run-candidate-good': makeEvalRunRow({ id: 'run-candidate-good', model: 'good-model', experiment_id: candidateExperimentId }),
    // Disagrees with the baseline (a false negative it didn't have) — not non-inferior.
    'run-candidate-bad': makeEvalRunRow({ id: 'run-candidate-bad', model: 'bad-model', experiment_id: candidateExperimentId }),
  };

  const resultsByRunId: Record<string, EvalResultRow[]> = {
    'run-baseline': [makeEvalResultRow({ id: 'r-baseline', run_id: 'run-baseline', item_id: 'item-1', output: { isCorrect: true, score: 100 }, score: 100 })],
    'run-candidate-good': [makeEvalResultRow({ id: 'r-good', run_id: 'run-candidate-good', item_id: 'item-1', output: { isCorrect: true, score: 100 }, score: 100 })],
    'run-candidate-bad': [makeEvalResultRow({ id: 'r-bad', run_id: 'run-candidate-bad', item_id: 'item-1', output: { isCorrect: false, score: 0 }, score: 0 })],
  };

  const insertFindingCalls: NewEvalFindingRow[] = [];
  const updateExperimentCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];

  const store: EvalStore = {
    ...baseFakeEvalStore(),
    async getSet(id) { return id === set.id ? set : null; },
    async listItems(setId) { return setId === set.id ? [item] : []; },
    async updateRun() {
      // eval-compare persists summary.compare here; not asserted on by these tests.
    },
    async getRun(id) { return runsById[id] ?? null; },
    async listResults(runId) { return resultsByRunId[runId] ?? []; },
    async getExperiment(idOrSlug) { return idOrSlug === candidateExperimentId ? makeEvalExperimentRow({ id: candidateExperimentId!, slug: candidateExperimentId! }) : null; },
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
        decided_at: '2026-09-29T00:00:00Z',
        supersedes_finding_id: row.supersedes_finding_id ?? null,
        created_at: '2026-09-29T00:00:00Z',
      };
    },
    async listFindings() { return findings; },
    ...overrides,
  };

  return { store, insertFindingCalls, updateExperimentCalls };
}

describe('eval-compare --decide', () => {
  let outDir: string;

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-compare-decide-'));
    delete process.env.EVAL_DECIDED_BY;
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.EVAL_DECIDED_BY;
    vi.restoreAllMocks();
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  // Every --decide happy-path test needs attribution, so the default argv carries --decided-by;
  // the refusal/resolution tests below override or omit it to exercise that path specifically.
  function argv(extra: string[]): string[] {
    return ['--runs', 'run-baseline,run-candidate-good', '--baseline', 'run-baseline', '--out', path.join(outDir, 'report.md'), '--decided-by', 'jsmith', ...extra];
  }

  it('refuses --decide without --write-db', async () => {
    const { store, insertFindingCalls } = makeFakeStore();
    await expect(main({ argv: argv(['--decide', 'adopt', '--statement', 'x']), store })).rejects.toThrow(ProcessExitError);
    expect(insertFindingCalls).toHaveLength(0);
  });

  it('refuses --decide without --statement', async () => {
    const { store, insertFindingCalls } = makeFakeStore();
    await expect(main({ argv: argv(['--write-db', '--decide', 'adopt']), store })).rejects.toThrow(ProcessExitError);
    expect(insertFindingCalls).toHaveLength(0);
  });

  it('refuses --decide with neither --decided-by nor EVAL_DECIDED_BY set', async () => {
    const { store, insertFindingCalls } = makeFakeStore();
    await expect(
      main({
        argv: [
          '--runs', 'run-baseline,run-candidate-good', '--baseline', 'run-baseline', '--out', path.join(outDir, 'report.md'),
          '--write-db', '--decide', 'adopt', '--statement', 'x',
        ],
        store,
      }),
    ).rejects.toThrow(ProcessExitError);
    expect(insertFindingCalls).toHaveLength(0);
  });

  it('resolves decided_by from EVAL_DECIDED_BY when --decided-by is not given', async () => {
    const { store, insertFindingCalls } = makeFakeStore();
    process.env.EVAL_DECIDED_BY = 'env-operator';
    await main({
      argv: [
        '--runs', 'run-baseline,run-candidate-good', '--baseline', 'run-baseline', '--out', path.join(outDir, 'report.md'),
        '--write-db', '--decide', 'adopt', '--statement', 'x',
      ],
      store,
    });
    expect(insertFindingCalls[0].decided_by).toBe('env-operator');
  });

  it('refuses --decide with several candidates and no --candidate', async () => {
    const { store, insertFindingCalls } = makeFakeStore();
    await expect(
      main({
        argv: [
          '--runs', 'run-candidate-good,run-candidate-bad', '--baseline', 'run-baseline',
          '--out', path.join(outDir, 'report.md'), '--decided-by', 'jsmith', '--write-db', '--decide', 'reject', '--statement', 'x',
        ],
        store,
      }),
    ).rejects.toThrow(ProcessExitError);
    expect(insertFindingCalls).toHaveLength(0);
  });

  it('refuses --candidate naming a run not among --runs', async () => {
    const { store, insertFindingCalls } = makeFakeStore();
    await expect(
      main({ argv: argv(['--write-db', '--decide', 'reject', '--statement', 'x', '--candidate', 'run-not-in-runs']), store }),
    ).rejects.toThrow(ProcessExitError);
    expect(insertFindingCalls).toHaveLength(0);
  });

  it('refuses when the candidate run has no experiment_id', async () => {
    const { store, insertFindingCalls } = makeFakeStore({ candidateExperimentId: null });
    await expect(main({ argv: argv(['--write-db', '--decide', 'reject', '--statement', 'x']), store })).rejects.toThrow(ProcessExitError);
    expect(insertFindingCalls).toHaveLength(0);
  });

  it('refuses --decide adopt when the verdict is not non-inferior', async () => {
    const { store, insertFindingCalls } = makeFakeStore();
    await expect(
      main({
        argv: [
          '--runs', 'run-candidate-bad', '--baseline', 'run-baseline', '--out', path.join(outDir, 'report.md'),
          '--decided-by', 'jsmith', '--write-db', '--decide', 'adopt', '--statement', 'x',
        ],
        store,
      }),
    ).rejects.toThrow(ProcessExitError);
    expect(insertFindingCalls).toHaveLength(0);
  });

  it('refuses --decide adopt on a reference-free comparison', async () => {
    const { store, insertFindingCalls } = makeFakeStore();
    // No approved-reference items — listItems returns the item unapproved, forcing the reference-free path.
    const pendingItem = makeEvalItemRow({
      payload: { question: 'q', submitted_answer: 'a', correct_answer: 'a', type: 'fill-in-blank', difficulty: 'easy', label_class: 'correct' },
    });
    const referenceFreeStore: EvalStore = { ...store, async listItems() { return [pendingItem]; } };
    await expect(
      main({ argv: argv(['--write-db', '--decide', 'adopt', '--statement', 'x']), store: referenceFreeStore }),
    ).rejects.toThrow(ProcessExitError);
    expect(insertFindingCalls).toHaveLength(0);
  });

  it('refuses a decision that would duplicate an existing finding for the same pair, without --supersedes', async () => {
    const existing: EvalFindingRow = {
      id: 'finding-old', experiment_id: 'exp-1', kind: 'adopt', task: 'grading', statement: 'earlier',
      evidence_note: null, run_ids: ['run-baseline', 'run-candidate-good'], item_ids: [], external_refs: [],
      decided_by: null, decided_at: '', supersedes_finding_id: null, created_at: '',
    };
    const { store, insertFindingCalls } = makeFakeStore({ findings: [existing] });
    await expect(main({ argv: argv(['--write-db', '--decide', 'adopt', '--statement', 'x']), store })).rejects.toThrow(ProcessExitError);
    expect(insertFindingCalls).toHaveLength(0);
  });

  it('does not treat an earlier observation citing the same pair as a conflicting decision', async () => {
    const observation: EvalFindingRow = {
      id: 'finding-obs', experiment_id: 'exp-1', kind: 'observation', task: 'grading', statement: 'measured first',
      evidence_note: null, run_ids: ['run-baseline', 'run-candidate-good'], item_ids: [], external_refs: [],
      decided_by: null, decided_at: '', supersedes_finding_id: null, created_at: '',
    };
    const { store, insertFindingCalls } = makeFakeStore({ findings: [observation] });
    await main({ argv: argv(['--write-db', '--decide', 'adopt', '--statement', 'Decided on top of the observation.']), store });
    expect(insertFindingCalls).toHaveLength(1);
    expect(insertFindingCalls[0].supersedes_finding_id).toBeUndefined();
  });

  it('does not treat a decision that a later finding supersedes as a conflict, but still refuses on a live one', async () => {
    const pair = ['run-baseline', 'run-candidate-good'];
    const deadReject: EvalFindingRow = {
      id: 'finding-dead', experiment_id: 'exp-1', kind: 'reject', task: 'grading', statement: 'earlier reject',
      evidence_note: null, run_ids: pair, item_ids: [], external_refs: [],
      decided_by: null, decided_at: '', supersedes_finding_id: null, created_at: '',
    };
    const supersedingObservation: EvalFindingRow = {
      id: 'finding-obs', experiment_id: 'exp-1', kind: 'observation', task: 'grading', statement: 'reread the evidence',
      evidence_note: null, run_ids: pair, item_ids: [], external_refs: [],
      decided_by: null, decided_at: '', supersedes_finding_id: 'finding-dead', created_at: '',
    };
    const superseded = makeFakeStore({ findings: [deadReject, supersedingObservation] });
    await main({ argv: argv(['--write-db', '--decide', 'adopt', '--statement', 'Decided after the reject was superseded.']), store: superseded.store });
    expect(superseded.insertFindingCalls).toHaveLength(1);

    const liveReject: EvalFindingRow = { ...deadReject, id: 'finding-live' };
    const live = makeFakeStore({ findings: [liveReject] });
    await expect(main({ argv: argv(['--write-db', '--decide', 'adopt', '--statement', 'x']), store: live.store })).rejects.toThrow(ProcessExitError);
    expect(live.insertFindingCalls).toHaveLength(0);
  });

  it('adopts a non-inferior candidate, writing one eval_findings row and moving the experiment to decided', async () => {
    const { store, insertFindingCalls, updateExperimentCalls } = makeFakeStore();
    await main({ argv: argv(['--write-db', '--decide', 'adopt', '--statement', 'Sonnet matches baseline recall.']), store });

    expect(insertFindingCalls).toHaveLength(1);
    expect(insertFindingCalls[0]).toMatchObject({
      experiment_id: 'exp-1',
      kind: 'adopt',
      statement: 'Sonnet matches baseline recall.',
      run_ids: ['run-baseline', 'run-candidate-good'],
      decided_by: 'jsmith',
    });
    expect(insertFindingCalls[0].evidence_note).toBeTruthy();
    expect(updateExperimentCalls).toEqual([{ id: 'exp-1', patch: expect.objectContaining({ status: 'decided' }) }]);
  });

  it('rejects a candidate regardless of its verdict', async () => {
    const { store, insertFindingCalls, updateExperimentCalls } = makeFakeStore();
    await main({
      argv: [
        '--runs', 'run-candidate-bad', '--baseline', 'run-baseline', '--out', path.join(outDir, 'report.md'),
        '--decided-by', 'jsmith', '--write-db', '--decide', 'reject', '--statement', 'Regresses on the one reviewed item.',
      ],
      store,
    });

    expect(insertFindingCalls).toHaveLength(1);
    expect(insertFindingCalls[0].kind).toBe('reject');
    expect(updateExperimentCalls).toEqual([{ id: 'exp-1', patch: expect.objectContaining({ status: 'decided' }) }]);
  });

  it('defers a candidate, moving the experiment to deferred rather than decided', async () => {
    const { store, insertFindingCalls, updateExperimentCalls } = makeFakeStore();
    await main({ argv: argv(['--write-db', '--decide', 'defer', '--statement', 'Needs a second reviewer before deciding.']), store });

    expect(insertFindingCalls).toHaveLength(1);
    expect(insertFindingCalls[0].kind).toBe('defer');
    expect(updateExperimentCalls).toEqual([{ id: 'exp-1', patch: expect.objectContaining({ status: 'deferred' }) }]);
  });

  it('allows a superseding decision that names the earlier conflicting finding', async () => {
    const existing: EvalFindingRow = {
      id: 'finding-old', experiment_id: 'exp-1', kind: 'adopt', task: 'grading', statement: 'earlier',
      evidence_note: null, run_ids: ['run-baseline', 'run-candidate-good'], item_ids: [], external_refs: [],
      decided_by: null, decided_at: '', supersedes_finding_id: null, created_at: '',
    };
    const { store, insertFindingCalls } = makeFakeStore({ findings: [existing] });
    await main({
      argv: argv(['--write-db', '--decide', 'adopt', '--statement', 'Re-decided after a rescoring fix.', '--supersedes', 'finding-old']),
      store,
    });

    expect(insertFindingCalls).toHaveLength(1);
    expect(insertFindingCalls[0].supersedes_finding_id).toBe('finding-old');
  });

  it('refuses a --supersedes value that does not name one of the conflicting findings', async () => {
    const existing: EvalFindingRow = {
      id: 'finding-old', experiment_id: 'exp-1', kind: 'adopt', task: 'grading', statement: 'earlier',
      evidence_note: null, run_ids: ['run-baseline', 'run-candidate-good'], item_ids: [], external_refs: [],
      decided_by: null, decided_at: '', supersedes_finding_id: null, created_at: '',
    };
    const { store, insertFindingCalls } = makeFakeStore({ findings: [existing] });
    await expect(
      main({
        argv: argv(['--write-db', '--decide', 'adopt', '--statement', 'x', '--supersedes', 'finding-unrelated']),
        store,
      }),
    ).rejects.toThrow(ProcessExitError);
    expect(insertFindingCalls).toHaveLength(0);
  });
  it('refuses --supersedes naming a finding that another finding already supersedes, and names that finding', async () => {
    const pair = ['run-baseline', 'run-candidate-good'];
    const first: EvalFindingRow = {
      id: 'finding-first', experiment_id: 'exp-1', kind: 'reject', task: 'grading', statement: 'earlier reject',
      evidence_note: null, run_ids: pair, item_ids: [], external_refs: [],
      decided_by: null, decided_at: '', supersedes_finding_id: null, created_at: '',
    };
    const successor: EvalFindingRow = {
      id: 'finding-successor', experiment_id: 'exp-1', kind: 'observation', task: 'grading', statement: 'reread the evidence',
      evidence_note: null, run_ids: pair, item_ids: [], external_refs: [],
      decided_by: null, decided_at: '', supersedes_finding_id: 'finding-first', created_at: '',
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, insertFindingCalls } = makeFakeStore({ findings: [first, successor] });
    await expect(
      main({
        argv: argv(['--write-db', '--decide', 'adopt', '--statement', 'x', '--supersedes', 'finding-first']),
        store,
      }),
    ).rejects.toThrow(ProcessExitError);
    expect(insertFindingCalls).toHaveLength(0);
    expect(errorSpy.mock.calls.map((args) => args.join(' ')).join('\n')).toContain('finding-successor');
  });
});
