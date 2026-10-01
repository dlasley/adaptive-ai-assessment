/**
 * `eval-judge`'s run-pair validation, the position-swap combination rule, and the dry-run/write-db
 * paths against an injected in-memory `EvalStore` and a stubbed `callLlmFn`, the same style as
 * `eval-run-cli-wiring.test.ts` exercises the transcription task.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// renderSlideImage shells out to pdftoppm; stubbed so these tests don't depend on that binary or a
// real PDF file.
vi.mock('../src/lib/pdf-conversion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/pdf-conversion')>();
  return { ...actual, renderSlideImage: vi.fn(() => Buffer.from('fake-slide-image-bytes')) };
});
import { renderSlideImage } from '../src/lib/pdf-conversion';

import { main } from '../src/commands/eval-judge';
import { combineJudgeOrders, parseJudgeVerdict, JudgeParseError, JUDGE_PROMPT, JUDGE_PROMPT_HASH, selectJudgeVerdictEntry, type JudgeVerdict, type JudgeVerdictEntry } from '../src/lib/eval/judge';
import type { EvalStore, EvalRunRow, EvalItemRow, EvalResultRow, EvalModelCurrentRow, EvalSetRow } from '../src/lib/eval/db';
import type { LlmCallOptions, LlmResult } from '@adaptive/shared/llm';
import { baseFakeEvalStore, makeEvalSetRow, makeEvalItemRow, makeEvalRunRow, makeEvalResultRow } from './helpers/eval-store';

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const MODEL: EvalModelCurrentRow = {
  id: 'model-1',
  family_id: 'family-1',
  slug: 'google/gemini-3.1-flash-lite',
  effective_date: '2026-09-25',
  price_prompt_usd_per_m: '0.25',
  price_completion_usd_per_m: '1.5',
  hosts: [],
  reasoning: null,
};

function jsonResult(verdict: JudgeVerdict, costUsd = 0.001): LlmResult {
  return {
    text: JSON.stringify(verdict),
    model: MODEL.slug,
    servedModel: MODEL.slug,
    servedProvider: 'Google AI Studio',
    usage: { promptTokens: 4000, completionTokens: 40, costUsd, isByok: false },
    raw: {},
  };
}

describe('JUDGE_PROMPT', () => {
  it('names the exercise and answer-key subsection conventions the transcription prompt mandates, so a transcript is not penalised for following them', () => {
    expect(JUDGE_PROMPT.includes('### Exercices') && JUDGE_PROMPT.includes('### Réponses')).toBe(true);
  });
});

describe('combineJudgeOrders', () => {
  it('a run that wins both orders wins the item', () => {
    const order1: JudgeVerdict = { winner: 'A', reason: 'more complete' };
    const order2: JudgeVerdict = { winner: 'B', reason: 'more complete' }; // B slot holds run A in order2
    expect(combineJudgeOrders(order1, order2)).toBe('a');
  });

  it('the other run winning both orders wins the item for it', () => {
    const order1: JudgeVerdict = { winner: 'B', reason: 'more faithful' };
    const order2: JudgeVerdict = { winner: 'A', reason: 'more faithful' }; // A slot holds run B in order2
    expect(combineJudgeOrders(order1, order2)).toBe('b');
  });

  it('a split decision is a tie', () => {
    const order1: JudgeVerdict = { winner: 'A', reason: 'x' };
    const order2: JudgeVerdict = { winner: 'A', reason: 'y' }; // same label both times = split, not a repeat win
    expect(combineJudgeOrders(order1, order2)).toBe('tie');
  });

  it('either order returning tie makes the item a tie', () => {
    const order1: JudgeVerdict = { winner: 'tie', reason: 'equally complete' };
    const order2: JudgeVerdict = { winner: 'B', reason: 'more complete' };
    expect(combineJudgeOrders(order1, order2)).toBe('tie');
  });
});

describe('selectJudgeVerdictEntry', () => {
  const entryUnder = (hash: string, judgedAt: string): JudgeVerdictEntry => ({
    outcome: 'win', judge_model: 'm', reasons: ['x', 'y'], judged_at: judgedAt,
  });

  it('returns undefined for a null or empty verdicts object', () => {
    expect(selectJudgeVerdictEntry(null, 'hash-a')).toBeUndefined();
    expect(selectJudgeVerdictEntry(undefined, 'hash-a')).toBeUndefined();
    expect(selectJudgeVerdictEntry({}, 'hash-a')).toBeUndefined();
  });

  it("prefers the entry under the run's own hash even when a newer entry exists under a different one", () => {
    const verdicts = {
      'hash-old': entryUnder('hash-old', '2026-01-01T00:00:00Z'),
      'hash-new': entryUnder('hash-new', '2026-02-01T00:00:00Z'),
    };
    expect(selectJudgeVerdictEntry(verdicts, 'hash-old')).toEqual({ hash: 'hash-old', entry: verdicts['hash-old'] });
  });

  it('falls back to the newest entry by judged_at when the hash is absent', () => {
    const verdicts = {
      'hash-a': entryUnder('hash-a', '2026-01-01T00:00:00Z'),
      'hash-b': entryUnder('hash-b', '2026-03-01T00:00:00Z'),
      'hash-c': entryUnder('hash-c', '2026-02-01T00:00:00Z'),
    };
    expect(selectJudgeVerdictEntry(verdicts, 'hash-missing')).toEqual({ hash: 'hash-b', entry: verdicts['hash-b'] });
    expect(selectJudgeVerdictEntry(verdicts, null)).toEqual({ hash: 'hash-b', entry: verdicts['hash-b'] });
  });
});

describe('parseJudgeVerdict', () => {
  it('parses a well-formed verdict', () => {
    expect(parseJudgeVerdict('{"winner":"A","reason":"more complete"}')).toEqual({ winner: 'A', reason: 'more complete' });
  });

  it('strips a code fence the model added despite the prompt', () => {
    expect(parseJudgeVerdict('```json\n{"winner":"tie","reason":"equal"}\n```')).toEqual({ winner: 'tie', reason: 'equal' });
  });

  it('throws JudgeParseError on invalid JSON', () => {
    expect(() => parseJudgeVerdict('not json')).toThrow(JudgeParseError);
  });

  it('throws JudgeParseError when winner is not A/B/tie', () => {
    expect(() => parseJudgeVerdict('{"winner":"C","reason":"x"}')).toThrow(JudgeParseError);
  });

  it('throws JudgeParseError when reason is missing', () => {
    expect(() => parseJudgeVerdict('{"winner":"A"}')).toThrow(JudgeParseError);
  });
});

describe('eval-judge main()', () => {
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

  function makeFakeStore(opts: {
    runs?: EvalRunRow[];
    set?: EvalSetRow;
    items?: EvalItemRow[];
    resultsByRun?: Record<string, EvalResultRow[]>;
    model?: EvalModelCurrentRow | null;
  } = {}): {
    store: EvalStore;
    judgeVerdictUpdates: Array<{ id: string; verdict: Record<string, unknown> }>;
    runUpdates: Array<{ id: string; patch: Partial<EvalRunRow> }>;
  } {
    const runs = opts.runs ?? [];
    const set = opts.set;
    const items = opts.items ?? [];
    const resultsByRun = opts.resultsByRun ?? {};
    const model = opts.model === undefined ? MODEL : opts.model;
    const judgeVerdictUpdates: Array<{ id: string; verdict: Record<string, unknown> }> = [];
    const runUpdates: Array<{ id: string; patch: Partial<EvalRunRow> }> = [];

    const store: EvalStore = {
      ...baseFakeEvalStore(),
      async getRun(id) {
        return runs.find((r) => r.id === id) ?? null;
      },
      async getSet(id) {
        return set && set.id === id ? set : null;
      },
      async listItems(setId) {
        return items.filter((i) => i.set_id === setId);
      },
      async listResults(runId) {
        return resultsByRun[runId] ?? [];
      },
      async getModelBySlug(slug) {
        return model && model.slug === slug ? model : null;
      },
      async updateResultJudgeVerdict(id, verdict) {
        judgeVerdictUpdates.push({ id, verdict });
      },
      async updateRun(id, patch) {
        runUpdates.push({ id, patch });
      },
    };

    return { store, judgeVerdictUpdates, runUpdates };
  }

  const set = makeEvalSetRow({ id: 'set-1', task: 'transcription', selection: { pdfPath: 'unit-1.pdf' } });
  const item = makeEvalItemRow({
    id: 'item-1',
    set_id: 'set-1',
    item_key: 'unit-1.pdf:5',
    payload: { slide: 5, text_layer: 'Bonjour', category: 'text' },
  });
  const runA = makeEvalRunRow({ id: 'run-a', set_id: 'set-1', task: 'transcription', status: 'completed', model: 'anthropic/claude-sonnet-5' });
  const runB = makeEvalRunRow({ id: 'run-b', set_id: 'set-1', task: 'transcription', status: 'completed', model: 'anthropic/claude-sonnet-5.5' });
  const resultA = makeEvalResultRow({ id: 'result-a', run_id: 'run-a', item_id: 'item-1', output: { markdown: 'Transcript A' } });
  const resultB = makeEvalResultRow({ id: 'result-b', run_id: 'run-b', item_id: 'item-1', output: { markdown: 'Transcript B' } });

  it('refuses when --runs does not name exactly two distinct ids', async () => {
    const { store } = makeFakeStore();
    await expect(main({ argv: ['--runs', 'run-a', '--judge-model', MODEL.slug], store })).rejects.toThrow(ProcessExitError);
    await expect(main({ argv: ['--runs', 'run-a,run-a', '--judge-model', MODEL.slug], store })).rejects.toThrow(ProcessExitError);
    await expect(main({ argv: ['--runs', 'run-a,run-b,run-c', '--judge-model', MODEL.slug], store })).rejects.toThrow(ProcessExitError);
  });

  it('refuses an unresolvable run id', async () => {
    const { store } = makeFakeStore({ runs: [runA] });
    await expect(main({ argv: ['--runs', 'run-a,run-missing', '--judge-model', MODEL.slug], store })).rejects.toThrow(ProcessExitError);
    expect(errorText()).toContain('run-missing');
  });

  it("refuses when a run's task is not transcription", async () => {
    const gradingRun = makeEvalRunRow({ id: 'run-b', set_id: 'set-1', task: 'grading', status: 'completed' });
    const { store } = makeFakeStore({ runs: [runA, gradingRun] });
    await expect(main({ argv: ['--runs', 'run-a,run-b', '--judge-model', MODEL.slug], store })).rejects.toThrow(ProcessExitError);
    expect(errorText()).toContain('run-b');
    expect(errorText()).toContain('transcription');
  });

  it('refuses when the runs are on different sets', async () => {
    const otherSetRun = makeEvalRunRow({ id: 'run-b', set_id: 'set-2', task: 'transcription', status: 'completed' });
    const { store } = makeFakeStore({ runs: [runA, otherSetRun] });
    await expect(main({ argv: ['--runs', 'run-a,run-b', '--judge-model', MODEL.slug], store })).rejects.toThrow(ProcessExitError);
    expect(errorText()).toContain('same eval set');
  });

  it('refuses when a run is not completed', async () => {
    const runningRun = makeEvalRunRow({ id: 'run-b', set_id: 'set-1', task: 'transcription', status: 'running' });
    const { store } = makeFakeStore({ runs: [runA, runningRun] });
    await expect(main({ argv: ['--runs', 'run-a,run-b', '--judge-model', MODEL.slug], store })).rejects.toThrow(ProcessExitError);
    expect(errorText()).toContain("status 'running'");
  });

  it('dry run makes no calls and no writes', async () => {
    const { store, judgeVerdictUpdates, runUpdates } = makeFakeStore({
      runs: [runA, runB],
      set,
      items: [item],
      resultsByRun: { 'run-a': [resultA], 'run-b': [resultB] },
    });
    const callLlmFn = vi.fn(async (_options: LlmCallOptions) => {
      throw new Error('dry run must not call the model');
    });

    await main({ argv: ['--runs', 'run-a,run-b', '--judge-model', MODEL.slug], store, callLlmFn });

    expect(callLlmFn).not.toHaveBeenCalled();
    expect(renderSlideImage).not.toHaveBeenCalled();
    expect(judgeVerdictUpdates).toHaveLength(0);
    expect(runUpdates).toHaveLength(0);
  });

  it('--write-db nests the verdict under the judge prompt hash, without clobbering an existing key for another run', async () => {
    const resultAWithExisting = makeEvalResultRow({
      id: 'result-a',
      run_id: 'run-a',
      item_id: 'item-1',
      output: { markdown: 'Transcript A' },
      judge_verdict: { 'run-other': { 'some-other-hash': { outcome: 'win', judge_model: 'some/other-model', reasons: ['x', 'y'], judged_at: '2026-01-01T00:00:00Z' } } },
    });
    const { store, judgeVerdictUpdates, runUpdates } = makeFakeStore({
      runs: [runA, runB],
      set,
      items: [item],
      resultsByRun: { 'run-a': [resultAWithExisting], 'run-b': [resultB] },
    });

    let call = 0;
    const callLlmFn = vi.fn(async (_options: LlmCallOptions) => {
      call += 1;
      // First call (order1: A=run-a, B=run-b) says A; second call (order2: A=run-b, B=run-a) says B —
      // run-a wins both orders under combineJudgeOrders.
      return jsonResult(call === 1 ? { winner: 'A', reason: 'more complete' } : { winner: 'B', reason: 'more faithful' });
    });

    await main({ argv: ['--runs', 'run-a,run-b', '--judge-model', MODEL.slug, '--write-db'], store, callLlmFn });

    expect(callLlmFn).toHaveBeenCalledTimes(2);
    expect(renderSlideImage).toHaveBeenCalledWith('unit-1.pdf', 5, expect.any(String));

    const updateForA = judgeVerdictUpdates.find((u) => u.id === 'result-a')!;
    expect(updateForA.verdict['run-other']).toEqual({ 'some-other-hash': { outcome: 'win', judge_model: 'some/other-model', reasons: ['x', 'y'], judged_at: '2026-01-01T00:00:00Z' } });
    expect(updateForA.verdict['run-b']).toMatchObject({ [JUDGE_PROMPT_HASH]: { outcome: 'win', judge_model: MODEL.slug, reasons: ['more complete', 'more faithful'] } });

    const updateForB = judgeVerdictUpdates.find((u) => u.id === 'result-b')!;
    expect(updateForB.verdict['run-a']).toMatchObject({ [JUDGE_PROMPT_HASH]: { outcome: 'loss', judge_model: MODEL.slug } });

    expect(runUpdates).toHaveLength(2);
    expect(runUpdates.find((u) => u.id === 'run-a')?.patch).toMatchObject({ judge_model: MODEL.slug });
    expect(runUpdates.find((u) => u.id === 'run-b')?.patch).toMatchObject({ judge_model: MODEL.slug });
  });

  it('a re-judge of the same pair under a different judge prompt hash appends rather than overwrites', async () => {
    const resultAWithExisting = makeEvalResultRow({
      id: 'result-a',
      run_id: 'run-a',
      item_id: 'item-1',
      output: { markdown: 'Transcript A' },
      judge_verdict: { 'run-b': { 'an-older-hash': { outcome: 'tie', judge_model: MODEL.slug, reasons: ['a', 'b'], judged_at: '2026-01-01T00:00:00Z' } } },
    });
    const resultBWithExisting = makeEvalResultRow({
      id: 'result-b',
      run_id: 'run-b',
      item_id: 'item-1',
      output: { markdown: 'Transcript B' },
      judge_verdict: { 'run-a': { 'an-older-hash': { outcome: 'tie', judge_model: MODEL.slug, reasons: ['a', 'b'], judged_at: '2026-01-01T00:00:00Z' } } },
    });
    const { store, judgeVerdictUpdates } = makeFakeStore({
      runs: [runA, runB],
      set,
      items: [item],
      resultsByRun: { 'run-a': [resultAWithExisting], 'run-b': [resultBWithExisting] },
    });
    const callLlmFn = vi.fn(async (_options: LlmCallOptions) => jsonResult({ winner: 'tie', reason: 'equal' }));

    await main({ argv: ['--runs', 'run-a,run-b', '--judge-model', MODEL.slug, '--write-db'], store, callLlmFn });

    const updateForA = judgeVerdictUpdates.find((u) => u.id === 'result-a')!;
    expect(updateForA.verdict['run-b']).toMatchObject({
      'an-older-hash': { outcome: 'tie', judge_model: MODEL.slug, judged_at: '2026-01-01T00:00:00Z' },
      [JUDGE_PROMPT_HASH]: { outcome: 'tie', judge_model: MODEL.slug },
    });
  });

  it('refuses to re-judge the same pair under the same judge prompt hash without --overwrite', async () => {
    const resultAWithExisting = makeEvalResultRow({
      id: 'result-a',
      run_id: 'run-a',
      item_id: 'item-1',
      output: { markdown: 'Transcript A' },
      judge_verdict: { 'run-b': { [JUDGE_PROMPT_HASH]: { outcome: 'tie', judge_model: MODEL.slug, reasons: ['a', 'b'], judged_at: '2026-01-01T00:00:00Z' } } },
    });
    const { store, judgeVerdictUpdates } = makeFakeStore({
      runs: [runA, runB],
      set,
      items: [item],
      resultsByRun: { 'run-a': [resultAWithExisting], 'run-b': [resultB] },
    });
    const callLlmFn = vi.fn(async (_options: LlmCallOptions) => jsonResult({ winner: 'tie', reason: 'equal' }));

    await expect(
      main({ argv: ['--runs', 'run-a,run-b', '--judge-model', MODEL.slug, '--write-db'], store, callLlmFn }),
    ).rejects.toThrow(ProcessExitError);
    expect(callLlmFn).not.toHaveBeenCalled();
    expect(judgeVerdictUpdates).toHaveLength(0);
    expect(errorText()).toContain('--overwrite');
  });

  it('--overwrite re-judges a pair already carrying an entry under the current hash', async () => {
    const resultAWithExisting = makeEvalResultRow({
      id: 'result-a',
      run_id: 'run-a',
      item_id: 'item-1',
      output: { markdown: 'Transcript A' },
      judge_verdict: { 'run-b': { [JUDGE_PROMPT_HASH]: { outcome: 'tie', judge_model: MODEL.slug, reasons: ['old', 'old'], judged_at: '2026-01-01T00:00:00Z' } } },
    });
    const { store, judgeVerdictUpdates } = makeFakeStore({
      runs: [runA, runB],
      set,
      items: [item],
      resultsByRun: { 'run-a': [resultAWithExisting], 'run-b': [resultB] },
    });
    let call = 0;
    const callLlmFn = vi.fn(async (_options: LlmCallOptions) => {
      call += 1;
      return jsonResult(call === 1 ? { winner: 'A', reason: 'more complete' } : { winner: 'B', reason: 'more faithful' });
    });

    await main({ argv: ['--runs', 'run-a,run-b', '--judge-model', MODEL.slug, '--write-db', '--overwrite'], store, callLlmFn });

    expect(callLlmFn).toHaveBeenCalledTimes(2);
    const updateForA = judgeVerdictUpdates.find((u) => u.id === 'result-a')!;
    expect(updateForA.verdict['run-b']).toMatchObject({ [JUDGE_PROMPT_HASH]: { outcome: 'win' } });
  });

  it('refuses --write-db against an unpriced judge model without --allow-unpriced', async () => {
    const { store, judgeVerdictUpdates } = makeFakeStore({
      runs: [runA, runB],
      set,
      items: [item],
      resultsByRun: { 'run-a': [resultA], 'run-b': [resultB] },
      model: null,
    });
    const callLlmFn = vi.fn(async (_options: LlmCallOptions) => jsonResult({ winner: 'tie', reason: 'equal' }));

    await expect(
      main({ argv: ['--runs', 'run-a,run-b', '--judge-model', 'unregistered/model', '--write-db'], store, callLlmFn }),
    ).rejects.toThrow(ProcessExitError);
    expect(callLlmFn).not.toHaveBeenCalled();
    expect(judgeVerdictUpdates).toHaveLength(0);
  });
});
