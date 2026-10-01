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
import { combineJudgeOrders, parseJudgeVerdict, JudgeParseError, JUDGE_PROMPT, JUDGE_PROMPT_HASH, selectJudgeVerdictEntry, nextJudgeRepeat, type JudgeVerdict, type JudgeVerdictEntry } from '../src/lib/eval/judge';
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
  const entry = (judgedAt: string, repeat = 0, judgeModel = 'm'): JudgeVerdictEntry => ({
    outcome: 'win',
    judge_model: judgeModel,
    repeat,
    reasons: ['x', 'y'],
    judged_at: judgedAt,
    judge_call: { provider_pin: null, reasoning: { enabled: false }, temperature: null },
    calls: [{}, {}],
  });

  it('returns undefined for a null or empty verdicts object', () => {
    expect(selectJudgeVerdictEntry(null, 'hash-a')).toBeUndefined();
    expect(selectJudgeVerdictEntry(undefined, 'hash-a')).toBeUndefined();
    expect(selectJudgeVerdictEntry({}, 'hash-a')).toBeUndefined();
    expect(selectJudgeVerdictEntry({ 'hash-a': [] }, 'hash-a')).toBeUndefined();
  });

  it("prefers the list under the run's own hash even when a newer list exists under a different one", () => {
    const verdicts = {
      'hash-old': [entry('2026-01-01T00:00:00Z')],
      'hash-new': [entry('2026-02-01T00:00:00Z')],
    };
    expect(selectJudgeVerdictEntry(verdicts, 'hash-old')).toEqual({ hash: 'hash-old', entries: verdicts['hash-old'] });
  });

  it('returns every entry under the hash so repeats can be compared', () => {
    const verdicts = { 'hash-a': [entry('2026-01-01T00:00:00Z', 0), entry('2026-01-02T00:00:00Z', 1), entry('2026-01-03T00:00:00Z', 0, 'other-judge')] };
    expect(selectJudgeVerdictEntry(verdicts, 'hash-a')?.entries).toHaveLength(3);
  });

  it('falls back to the list with the newest entry when the hash is absent', () => {
    const verdicts = {
      'hash-a': [entry('2026-01-01T00:00:00Z')],
      'hash-b': [entry('2026-01-05T00:00:00Z'), entry('2026-03-01T00:00:00Z', 1)],
      'hash-c': [entry('2026-02-01T00:00:00Z')],
    };
    expect(selectJudgeVerdictEntry(verdicts, 'hash-missing')).toEqual({ hash: 'hash-b', entries: verdicts['hash-b'] });
    expect(selectJudgeVerdictEntry(verdicts, null)).toEqual({ hash: 'hash-b', entries: verdicts['hash-b'] });
  });
});

describe('nextJudgeRepeat', () => {
  const entryBy = (judgeModel: string): JudgeVerdictEntry => ({
    outcome: 'tie', judge_model: judgeModel, repeat: 0, reasons: [], judged_at: '2026-01-01T00:00:00Z',
    judge_call: { provider_pin: null, reasoning: { enabled: false }, temperature: null }, calls: [],
  });

  it('counts only entries from the same judge model', () => {
    expect(nextJudgeRepeat(undefined, 'a')).toBe(0);
    expect(nextJudgeRepeat([entryBy('a'), entryBy('b'), entryBy('a')], 'a')).toBe(2);
    expect(nextJudgeRepeat([entryBy('a')], 'b')).toBe(0);
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
    storedRow: (id: string) => EvalResultRow;
  } {
    const runs = opts.runs ?? [];
    const set = opts.set;
    const items = opts.items ?? [];
    const resultsByRun: Record<string, EvalResultRow[]> = Object.fromEntries(
      Object.entries(opts.resultsByRun ?? {}).map(([runId, rows]) => [runId, rows.map((row) => ({ ...row }))]),
    );
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
        return (resultsByRun[runId] ?? []).map((row) => ({ ...row }));
      },
      async getResult(id) {
        for (const rows of Object.values(resultsByRun)) {
          const row = rows.find((r) => r.id === id);
          if (row) return { ...row };
        }
        return null;
      },
      async getModelBySlug(slug) {
        return model && model.slug === slug ? model : null;
      },
      async updateResultJudgeVerdict(id, verdict) {
        judgeVerdictUpdates.push({ id, verdict });
        for (const rows of Object.values(resultsByRun)) {
          const row = rows.find((r) => r.id === id);
          if (row) row.judge_verdict = verdict;
        }
      },
      async updateRun(id, patch) {
        runUpdates.push({ id, patch });
      },
    };

    const storedRow = (id: string): EvalResultRow => {
      for (const rows of Object.values(resultsByRun)) {
        const row = rows.find((r) => r.id === id);
        if (row) return row;
      }
      throw new Error(`no stored row ${id}`);
    };

    return { store, judgeVerdictUpdates, runUpdates, storedRow };
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

  const JUDGE_SENTINEL = 'SENTINEL-NEVER-STORE-7f3a9c';

  function sequencedJudge(responses: JudgeVerdict[]) {
    let call = 0;
    return vi.fn(async (_options: LlmCallOptions) => {
      const verdict = responses[call % responses.length];
      call += 1;
      return {
        ...jsonResult(verdict),
        raw: {
          id: `gen-${call}`,
          choices: [{ message: { content: `${JUDGE_SENTINEL} ${JSON.stringify(verdict)}` }, finish_reason: 'stop' }],
        },
      };
    });
  }

  // First call (order1: A=run-a, B=run-b) says A; second call (order2: A=run-b, B=run-a) says B,
  // so run-a wins both orders under combineJudgeOrders.
  const RUN_A_WINS: JudgeVerdict[] = [{ winner: 'A', reason: 'more complete' }, { winner: 'B', reason: 'more faithful' }];

  it('--write-db appends a list entry under the judge prompt hash, without clobbering an existing key for another run', async () => {
    const resultAWithExisting = makeEvalResultRow({
      id: 'result-a',
      run_id: 'run-a',
      item_id: 'item-1',
      output: { markdown: 'Transcript A' },
      judge_verdict: { 'run-other': { 'some-other-hash': [{ outcome: 'win', judge_model: 'some/other-model', repeat: 0, reasons: ['x', 'y'], judged_at: '2026-01-01T00:00:00Z' }] } },
    });
    const { store, judgeVerdictUpdates, runUpdates } = makeFakeStore({
      runs: [runA, runB],
      set,
      items: [item],
      resultsByRun: { 'run-a': [resultAWithExisting], 'run-b': [resultB] },
    });
    const callLlmFn = sequencedJudge(RUN_A_WINS);

    await main({ argv: ['--runs', 'run-a,run-b', '--judge-model', MODEL.slug, '--write-db'], store, callLlmFn });

    expect(callLlmFn).toHaveBeenCalledTimes(2);
    expect(renderSlideImage).toHaveBeenCalledWith('unit-1.pdf', 5, expect.any(String));

    const updateForA = judgeVerdictUpdates.find((u) => u.id === 'result-a')!;
    expect(updateForA.verdict['run-other']).toEqual({ 'some-other-hash': [{ outcome: 'win', judge_model: 'some/other-model', repeat: 0, reasons: ['x', 'y'], judged_at: '2026-01-01T00:00:00Z' }] });
    const entriesForA = (updateForA.verdict['run-b'] as Record<string, unknown[]>)[JUDGE_PROMPT_HASH];
    expect(entriesForA).toHaveLength(1);
    expect(entriesForA[0]).toMatchObject({ outcome: 'win', judge_model: MODEL.slug, repeat: 0, reasons: ['more complete', 'more faithful'] });

    const updateForB = judgeVerdictUpdates.find((u) => u.id === 'result-b')!;
    expect((updateForB.verdict['run-a'] as Record<string, unknown[]>)[JUDGE_PROMPT_HASH][0]).toMatchObject({ outcome: 'loss', judge_model: MODEL.slug, repeat: 0 });

    expect(runUpdates).toHaveLength(2);
    expect(runUpdates.find((u) => u.id === 'run-a')?.patch).toMatchObject({ judge_model: MODEL.slug, judge_prompt_hash: JUDGE_PROMPT_HASH });
    expect(runUpdates.find((u) => u.id === 'run-b')?.patch).toMatchObject({ judge_model: MODEL.slug, judge_prompt_hash: JUDGE_PROMPT_HASH });
  });

  it('records the call settings sent and one response-meta object per position order', async () => {
    const { store, judgeVerdictUpdates } = makeFakeStore({
      runs: [runA, runB],
      set,
      items: [item],
      resultsByRun: { 'run-a': [resultA], 'run-b': [resultB] },
    });
    const callLlmFn = sequencedJudge(RUN_A_WINS);

    await main({ argv: ['--runs', 'run-a,run-b', '--judge-model', MODEL.slug, '--provider', 'google-ai-studio', '--write-db'], store, callLlmFn });

    const sent = callLlmFn.mock.calls[0][0];
    expect(sent.provider).toEqual({ order: ['google-ai-studio'], allowFallbacks: false });
    expect(sent.reasoning).toEqual({ enabled: false });
    const entry = (judgeVerdictUpdates.find((u) => u.id === 'result-a')!.verdict['run-b'] as Record<string, JudgeVerdictEntry[]>)[JUDGE_PROMPT_HASH][0];
    expect(entry.judge_call).toEqual({ provider_pin: 'google-ai-studio', reasoning: { enabled: false }, temperature: null });
    expect(entry.calls).toEqual([
      { id: 'gen-1', choices: [{ finish_reason: 'stop' }], served_model: MODEL.slug, served_provider: 'Google AI Studio' },
      { id: 'gen-2', choices: [{ finish_reason: 'stop' }], served_model: MODEL.slug, served_provider: 'Google AI Studio' },
    ]);
  });

  it('records a null provider pin when the call was not pinned', async () => {
    const { store, judgeVerdictUpdates } = makeFakeStore({
      runs: [runA, runB],
      set,
      items: [item],
      resultsByRun: { 'run-a': [resultA], 'run-b': [resultB] },
    });
    await main({ argv: ['--runs', 'run-a,run-b', '--judge-model', MODEL.slug, '--write-db'], store, callLlmFn: sequencedJudge(RUN_A_WINS) });
    const entry = (judgeVerdictUpdates.find((u) => u.id === 'result-a')!.verdict['run-b'] as Record<string, JudgeVerdictEntry[]>)[JUDGE_PROMPT_HASH][0];
    expect(entry.judge_call?.provider_pin).toBeNull();
  });

  it('writes the freshly read judge_verdict, so an entry stored by another process during the run is kept', async () => {
    const { store, judgeVerdictUpdates, storedRow } = makeFakeStore({
      runs: [runA, runB],
      set,
      items: [item],
      resultsByRun: { 'run-a': [resultA], 'run-b': [resultB] },
    });
    const otherProcessEntry: JudgeVerdictEntry = {
      outcome: 'tie', judge_model: MODEL.slug, repeat: 0, reasons: ['p', 'q'], judged_at: '2026-01-01T00:00:00Z',
    };
    const judge = sequencedJudge(RUN_A_WINS);
    const callLlmFn = vi.fn(async (options: LlmCallOptions) => {
      storedRow('result-a').judge_verdict = { 'run-b': { [JUDGE_PROMPT_HASH]: [otherProcessEntry] } };
      return judge(options);
    });

    await main({ argv: ['--runs', 'run-a,run-b', '--judge-model', MODEL.slug, '--write-db'], store, callLlmFn });

    const written = judgeVerdictUpdates.find((u) => u.id === 'result-a')!.verdict;
    const entries = (written['run-b'] as Record<string, JudgeVerdictEntry[]>)[JUDGE_PROMPT_HASH];
    expect(entries.map((e) => [e.outcome, e.repeat])).toEqual([['tie', 0], ['win', 1]]);
    expect((storedRow('result-a').judge_verdict as Record<string, Record<string, unknown[]>>)['run-b'][JUDGE_PROMPT_HASH]).toHaveLength(2);
  });

  it('stamps no judge_model or judge_prompt_hash on the runs when every item fails to judge', async () => {
    const { store, judgeVerdictUpdates, runUpdates } = makeFakeStore({
      runs: [runA, runB],
      set,
      items: [item],
      resultsByRun: { 'run-a': [resultA], 'run-b': [resultB] },
    });
    const callLlmFn = vi.fn(async (_options: LlmCallOptions) => {
      throw new Error('upstream failure');
    });

    await main({ argv: ['--runs', 'run-a,run-b', '--judge-model', MODEL.slug, '--write-db'], store, callLlmFn });

    expect(judgeVerdictUpdates).toHaveLength(0);
    expect(runUpdates).toHaveLength(0);
  });

  it('records the provider pin in lowercase', async () => {
    const { store, judgeVerdictUpdates } = makeFakeStore({
      runs: [runA, runB],
      set,
      items: [item],
      resultsByRun: { 'run-a': [resultA], 'run-b': [resultB] },
    });

    await main({ argv: ['--runs', 'run-a,run-b', '--judge-model', MODEL.slug, '--provider', 'Google-AI-Studio', '--write-db'], store, callLlmFn: sequencedJudge(RUN_A_WINS) });

    const entry = (judgeVerdictUpdates.find((u) => u.id === 'result-a')!.verdict['run-b'] as Record<string, JudgeVerdictEntry[]>)[JUDGE_PROMPT_HASH][0];
    expect(entry.judge_call?.provider_pin).toBe('google-ai-studio');
  });

  it('never stores message content from either transcript, the slide text or the judge response', async () => {
    const sentinelItem = makeEvalItemRow({
      id: 'item-1', set_id: 'set-1', item_key: 'unit-1.pdf:5',
      payload: { slide: 5, text_layer: `Bonjour ${JUDGE_SENTINEL}`, category: 'text' },
    });
    const sentinelA = makeEvalResultRow({ id: 'result-a', run_id: 'run-a', item_id: 'item-1', output: { markdown: `Transcript A ${JUDGE_SENTINEL}` } });
    const sentinelB = makeEvalResultRow({ id: 'result-b', run_id: 'run-b', item_id: 'item-1', output: { markdown: `Transcript B ${JUDGE_SENTINEL}` } });
    const { store, judgeVerdictUpdates } = makeFakeStore({
      runs: [runA, runB],
      set,
      items: [sentinelItem],
      resultsByRun: { 'run-a': [sentinelA], 'run-b': [sentinelB] },
    });
    const callLlmFn = sequencedJudge(RUN_A_WINS);

    await main({ argv: ['--runs', 'run-a,run-b', '--judge-model', MODEL.slug, '--write-db'], store, callLlmFn });

    const sentBody = JSON.stringify(callLlmFn.mock.calls[0][0].messages);
    expect(sentBody).toContain(JUDGE_SENTINEL);
    expect(judgeVerdictUpdates).toHaveLength(2);
    expect(JSON.stringify(judgeVerdictUpdates)).not.toContain(JUDGE_SENTINEL);
  });

  it('judging the same pair under the same hash twice keeps both entries, with repeat 0 then 1', async () => {
    const { store, judgeVerdictUpdates } = makeFakeStore({
      runs: [runA, runB],
      set,
      items: [item],
      resultsByRun: { 'run-a': [resultA], 'run-b': [resultB] },
    });
    const argv = ['--runs', 'run-a,run-b', '--judge-model', MODEL.slug, '--write-db'];

    await main({ argv, store, callLlmFn: sequencedJudge(RUN_A_WINS) });
    await main({ argv, store, callLlmFn: sequencedJudge([{ winner: 'tie', reason: 'equal' }]) });

    const lastForA = judgeVerdictUpdates.filter((u) => u.id === 'result-a').at(-1)!;
    const entries = (lastForA.verdict['run-b'] as Record<string, JudgeVerdictEntry[]>)[JUDGE_PROMPT_HASH];
    expect(entries.map((e) => [e.repeat, e.outcome])).toEqual([[0, 'win'], [1, 'tie']]);
    const lastForB = judgeVerdictUpdates.filter((u) => u.id === 'result-b').at(-1)!;
    expect((lastForB.verdict['run-a'] as Record<string, JudgeVerdictEntry[]>)[JUDGE_PROMPT_HASH].map((e) => e.repeat)).toEqual([0, 1]);
  });

  it('a different judge model under the same hash appends with its own repeat 0', async () => {
    const otherJudge: EvalModelCurrentRow = { ...MODEL, id: 'model-2', slug: 'google/gemini-other' };
    const { store, judgeVerdictUpdates } = makeFakeStore({
      runs: [runA, runB],
      set,
      items: [item],
      resultsByRun: { 'run-a': [resultA], 'run-b': [resultB] },
    });
    const storeWithBothJudges: EvalStore = { ...store, async getModelBySlug(slug) { return [MODEL, otherJudge].find((m) => m.slug === slug) ?? null; } };

    await main({ argv: ['--runs', 'run-a,run-b', '--judge-model', MODEL.slug, '--write-db'], store: storeWithBothJudges, callLlmFn: sequencedJudge(RUN_A_WINS) });
    await main({ argv: ['--runs', 'run-a,run-b', '--judge-model', otherJudge.slug, '--write-db'], store: storeWithBothJudges, callLlmFn: sequencedJudge([{ winner: 'tie', reason: 'equal' }]) });
    await main({ argv: ['--runs', 'run-a,run-b', '--judge-model', MODEL.slug, '--write-db'], store: storeWithBothJudges, callLlmFn: sequencedJudge(RUN_A_WINS) });

    const lastForA = judgeVerdictUpdates.filter((u) => u.id === 'result-a').at(-1)!;
    const entries = (lastForA.verdict['run-b'] as Record<string, JudgeVerdictEntry[]>)[JUDGE_PROMPT_HASH];
    expect(entries.map((e) => [e.judge_model, e.repeat])).toEqual([[MODEL.slug, 0], [otherJudge.slug, 0], [MODEL.slug, 1]]);
  });

  it('prints the existing entry count per judge model and the repeat index before judging', async () => {
    const existingEntry = (judgeModel: string): JudgeVerdictEntry => ({
      outcome: 'tie', judge_model: judgeModel, repeat: 0, reasons: ['a', 'b'], judged_at: '2026-01-01T00:00:00Z',
      judge_call: { provider_pin: null, reasoning: { enabled: false }, temperature: null }, calls: [{}, {}],
    });
    const resultAWithExisting = makeEvalResultRow({
      id: 'result-a', run_id: 'run-a', item_id: 'item-1', output: { markdown: 'Transcript A' },
      judge_verdict: { 'run-b': { [JUDGE_PROMPT_HASH]: [existingEntry(MODEL.slug), existingEntry('google/gemini-other')] } },
    });
    const { store } = makeFakeStore({
      runs: [runA, runB], set, items: [item],
      resultsByRun: { 'run-a': [resultAWithExisting], 'run-b': [resultB] },
    });

    await main({ argv: ['--runs', 'run-a,run-b', '--judge-model', MODEL.slug], store });

    const printed = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((args) => args.join(' ')).join('\n');
    expect(printed).toContain(`${MODEL.slug}: 1 entry on 1 of 1 item(s)`);
    expect(printed).toContain('google/gemini-other: 1 entry on 1 of 1 item(s)');
    expect(printed).toContain(`This run (${MODEL.slug}) takes repeat 1 on 1 item(s).`);
  });

  it('refuses to write over a stored entry that is not a list', async () => {
    const legacyA = makeEvalResultRow({
      id: 'result-a', run_id: 'run-a', item_id: 'item-1', output: { markdown: 'Transcript A' },
      judge_verdict: { 'run-b': { [JUDGE_PROMPT_HASH]: { outcome: 'tie', judge_model: MODEL.slug, reasons: ['a', 'b'], judged_at: '2026-01-01T00:00:00Z' } } },
    });
    const { store, judgeVerdictUpdates } = makeFakeStore({
      runs: [runA, runB], set, items: [item],
      resultsByRun: { 'run-a': [legacyA], 'run-b': [resultB] },
    });
    const callLlmFn = sequencedJudge(RUN_A_WINS);

    await expect(
      main({ argv: ['--runs', 'run-a,run-b', '--judge-model', MODEL.slug, '--write-db'], store, callLlmFn }),
    ).rejects.toThrow(ProcessExitError);
    expect(callLlmFn).not.toHaveBeenCalled();
    expect(judgeVerdictUpdates).toHaveLength(0);
    expect(errorText()).toContain('single-object entry');
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
